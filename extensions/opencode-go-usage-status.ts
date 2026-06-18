import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completions, parseChoice, preferenceCommands, type PreferenceCommand } from "../src/opencode-go-usage/commands.ts";
import { formatStatus, unavailableStatus } from "../src/opencode-go-usage/format.ts";
import { loadPreferences, savePreferences, SETTINGS_FILE } from "../src/opencode-go-usage/preferences.ts";
import {
	DEFAULT_PREFERENCES,
	errorMessage,
	isOpenCodeGoProvider,
	type Preferences,
	type UsageSnapshot,
} from "../src/opencode-go-usage/domain.ts";
import { getUsage } from "../src/opencode-go-usage/usage.ts";

const EXTENSION_ID = "opencode-go-usage";
const REFRESH_INTERVAL_MS = 60_000;

class OpenCodeGoUsageStatus {
	private ctx?: ExtensionContext;
	private generation = 0;
	private timer?: ReturnType<typeof setInterval>;
	private inFlight = false;
	private queued?: { ctx: ExtensionContext; generation: number };
	private lastUsage?: UsageSnapshot;
	private preferences: Preferences = { ...DEFAULT_PREFERENCES };
	private preferenceRevision = 0;
	private preferenceQueue: Promise<void> = Promise.resolve();

	public constructor(private readonly pi: ExtensionAPI) {
		pi.on("session_start", (_event, ctx) => this.start(ctx));
		pi.on("turn_end", (_event, ctx) => void this.refresh(ctx));
		pi.on("model_select", (event, ctx) => void this.onModelSelect(ctx, event.model));
		pi.on("session_shutdown", (_event, ctx) => this.stop(ctx));

		for (const command of preferenceCommands) this.registerPreferenceCommand(command);
	}

	private isCurrent(generation: number): boolean {
		return this.ctx !== undefined && this.generation === generation;
	}

	private start(ctx: ExtensionContext): void {
		this.generation++;
		this.ctx = ctx;
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
		this.timer.unref?.();

		const generation = this.generation;
		void (async () => {
			await this.loadPreferences(ctx, generation);
			await this.refresh(ctx, generation);
		})();
	}

	private stop(ctx: ExtensionContext): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.queued = undefined;
		this.ctx = undefined;
		this.generation++;
		if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
	}

	private enqueuePreferenceOperation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.preferenceQueue.then(operation);
		this.preferenceQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async loadPreferences(ctx: ExtensionContext, generation: number): Promise<void> {
		const revision = this.preferenceRevision;
		try {
			const preferences = await this.enqueuePreferenceOperation(() => loadPreferences(DEFAULT_PREFERENCES));
			if (this.isCurrent(generation) && this.preferenceRevision === revision) this.preferences = preferences;
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			const changedDuringLoad = this.preferenceRevision !== revision;
			if (!changedDuringLoad) this.preferences = { ...DEFAULT_PREFERENCES };
			if (ctx.hasUI) {
				const action = changedDuringLoad ? "keeping current preferences" : "using defaults";
				ctx.ui.notify(`pi-opencode-go-usage: failed to load ${SETTINGS_FILE}, ${action}: ${errorMessage(error)}`, "warning");
			}
		}
	}

	private onModelSelect(ctx: ExtensionContext, model: { id: string; provider: string }): void {
		if (!isOpenCodeGoProvider(model.provider)) {
			if (this.timer) clearInterval(this.timer);
			this.timer = undefined;
			this.lastUsage = undefined;
			if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
			return;
		}
		// Re-arm the timer when switching back to an opencode-go model.
		if (!this.timer) {
			this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
			this.timer.unref?.();
		}
		void this.refresh(ctx);
	}

	private async refresh(ctx = this.ctx, generation = this.generation): Promise<void> {
		if (!isOpenCodeGoProvider(ctx?.model?.provider)) return;
		if (!ctx?.hasUI || !this.isCurrent(generation)) return;

		if (this.inFlight) {
			this.queued = { ctx, generation };
			return;
		}

		this.inFlight = true;
		try {
			const usage = await getUsage();
			if (!this.isCurrent(generation)) return;
			this.lastUsage = usage;
			ctx.ui.setStatus(EXTENSION_ID, formatStatus(ctx, usage, this.preferences));
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			const message = errorMessage(error);
			// Missing credentials: stay quiet instead of flashing "unavailable".
			if (message.includes("Missing opencode-go credentials")) {
				this.lastUsage = undefined;
				ctx.ui.setStatus(EXTENSION_ID, undefined);
				return;
			}
			// Auth expired or parse failure: surface it so the user knows to refresh.
			ctx.ui.setStatus(EXTENSION_ID, unavailableStatus(ctx));
			if (ctx.hasUI && /auth failed|Could not parse/.test(message)) {
				ctx.ui.notify(`pi-opencode-go-usage: ${message}`, "warning");
			}
		} finally {
			this.inFlight = false;
			const queued = this.queued;
			this.queued = undefined;
			if (queued && this.isCurrent(queued.generation)) void this.refresh(queued.ctx, queued.generation);
		}
	}

	private renderLast(ctx: ExtensionContext): boolean {
		if (!ctx.hasUI || !this.lastUsage || !isOpenCodeGoProvider(ctx.model?.provider)) return false;
		ctx.ui.setStatus(EXTENSION_ID, formatStatus(ctx, this.lastUsage, this.preferences));
		return true;
	}

	private savePreferences(ctx: ExtensionContext, generation = this.generation): void {
		const preferences = { ...this.preferences };
		const result = this.enqueuePreferenceOperation(() => savePreferences(preferences));
		void result.catch(error => {
			const notifyContext = this.ctx ?? ctx;
			if (this.isCurrent(generation) && notifyContext.hasUI) {
				notifyContext.ui.notify(`pi-opencode-go-usage: failed to write ${SETTINGS_FILE}: ${errorMessage(error)}`, "warning");
			}
		});
	}

	private registerPreferenceCommand(command: PreferenceCommand): void {
		this.pi.registerCommand(command.name, {
			description: command.description,
			getArgumentCompletions: prefix => completions(command.choices, prefix),
			handler: async (args, ctx) => {
				const current = this.preferences[command.key];
				const next = parseChoice(args, command.choices, current);
				if (!next) return;

				this.preferenceRevision++;
				this.preferences = { ...this.preferences, [command.key]: next } as Preferences;
				this.savePreferences(ctx);
				if (!this.renderLast(ctx)) await this.refresh(ctx);
			},
		});
	}
}

export default function (pi: ExtensionAPI) {
	new OpenCodeGoUsageStatus(pi);
}
