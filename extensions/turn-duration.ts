import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "yuki-turn-duration";
const IDLE_RETRY_DELAY_MS = 50;
const MAX_IDLE_RETRIES = 20;

type DurationDetails = {
	startedAt: number;
	endedAt: number;
	elapsedMs: number;
	turnCount: number;
};

export default function yukiTurnDurationExtension(pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let turnCount = 0;

	// Live working-message timer (TUI only). Appends elapsed time to the "Working..." row
	// shown above the input while the agent is running.
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let workingCtx: ExtensionContext | undefined;

	pi.registerMessageRenderer<DurationDetails>(CUSTOM_TYPE, (message, _options, theme) => {
		const text = typeof message.content === "string" ? message.content : formatDurationLine(message.details?.elapsedMs ?? 0);
		return new Text(theme.fg("dim", text), 1, 0);
	});

	// Keep display-only duration messages out of the next LLM request.
	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => !isDurationMessage(message)),
	}));

	const renderWorking = () => {
		const ctx = workingCtx;
		if (!ctx) return;
		const elapsedMs = Math.max(0, Date.now() - (startedAt ?? Date.now()));
		ctx.ui.setWorkingMessage(`Working... ${formatDuration(elapsedMs)} · turn ${turnCount}`);
	};

	const stopWorkingTimer = (ctx: ExtensionContext) => {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
		workingCtx = undefined;
		ctx.ui.setWorkingMessage(); // restore pi's default working message
	};

	pi.on("agent_start", (_event, ctx) => {
		startedAt = Date.now();
		turnCount = 0;

		if (ctx.mode !== "tui") return;

		workingCtx = ctx;
		renderWorking();

		// Refresh the working message once per second while streaming/working.
		workingTimer = setInterval(renderWorking, 1000);
		workingTimer.unref?.();
	});

	pi.on("turn_end", () => {
		turnCount += 1;
		renderWorking();
	});

	pi.on("agent_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if ((event as { willRetry?: boolean }).willRetry) return; // keep the live timer running across retries

		const endedAt = Date.now();
		const actualStartedAt = startedAt ?? endedAt;
		const elapsedMs = Math.max(0, endedAt - actualStartedAt);
		const details: DurationDetails = {
			startedAt: actualStartedAt,
			endedAt,
			elapsedMs,
			turnCount,
		};

		stopWorkingTimer(ctx);
		startedAt = undefined;
		turnCount = 0;
		sendWhenIdle(pi, ctx, formatDurationLine(elapsedMs), details);
	});
}

function sendWhenIdle(pi: ExtensionAPI, ctx: ExtensionContext, content: string, details: DurationDetails, attempt = 0): void {
	const timer = setTimeout(() => {
		if (!ctx.isIdle()) {
			if (attempt < MAX_IDLE_RETRIES) {
				sendWhenIdle(pi, ctx, content, details, attempt + 1);
			}
			return;
		}

		try {
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content,
				display: true,
				details,
			});
		} catch {
			// The extension may have been reloaded or the session shut down before the timer fired.
		}
	}, attempt === 0 ? 0 : IDLE_RETRY_DELAY_MS);
	timer.unref?.();
}

function isDurationMessage(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === CUSTOM_TYPE;
}

function formatDurationLine(elapsedMs: number): string {
	return `Elapsed: ${formatDuration(elapsedMs)}`;
}

function formatDuration(elapsedMs: number): string {
	const ms = Math.max(0, Math.round(elapsedMs));
	if (ms < 1_000) return `${ms}ms`;
	if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;

	const totalSeconds = Math.round(ms / 1_000);
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m${seconds.toString().padStart(2, "0")}s`;

	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return `${hours}h${minutes.toString().padStart(2, "0")}m${seconds.toString().padStart(2, "0")}s`;
}
