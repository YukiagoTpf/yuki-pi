import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completions, parseChoice, preferenceCommands, type PreferenceCommand } from "../src/volcengine-agent-plan-usage/commands.ts";
import { DEFAULT_PREFERENCES, errorMessage, isVolcengineAgentPlanModel, type Preferences, type UsageSnapshot } from "../src/volcengine-agent-plan-usage/domain.ts";
import { formatStatus, unavailableStatus } from "../src/volcengine-agent-plan-usage/format.ts";
import { loadPreferences, savePreferences, SETTINGS_FILE } from "../src/volcengine-agent-plan-usage/preferences.ts";
import { getUsage, MISSING_AUTH_ERROR } from "../src/volcengine-agent-plan-usage/usage.ts";

const EXTENSION_ID = "volcengine-agent-plan-usage";
const REFRESH_INTERVAL_MS = 60_000;

class VolcengineAgentPlanUsageStatus {
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

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private start(ctx: ExtensionContext): void {
		this.generation++;
		this.ctx = ctx;
		if (isVolcengineAgentPlanModel(ctx.model)) this.ensureTimer();

		const generation = this.generation;
		void (async () => {
			await this.loadPreferences(ctx, generation);
			await this.refresh(ctx, generation);
		})();
	}

	private stop(ctx: ExtensionContext): void {
		this.clearTimer();
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
			const preferences = await this.enqueuePreferenceOperation(() => loadPreferences());
			if (this.isCurrent(generation) && this.preferenceRevision === revision) this.preferences = preferences;
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			const changedDuringLoad = this.preferenceRevision !== revision;
			if (!changedDuringLoad) this.preferences = { ...DEFAULT_PREFERENCES };
			if (ctx.hasUI) {
				const action = changedDuringLoad ? "keeping current preferences" : "using defaults";
				ctx.ui.notify(`pi-volcengine-agent-plan-usage: failed to load ${SETTINGS_FILE}, ${action}: ${errorMessage(error)}`, "warning");
			}
		}
	}

	private onModelSelect(ctx: ExtensionContext, model: { provider: string; baseUrl?: string }): void {
		if (!isVolcengineAgentPlanModel(model)) {
			this.clearTimer();
			this.lastUsage = undefined;
			if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
			return;
		}
		this.ensureTimer();
		void this.refresh(ctx);
	}

	private async refresh(ctx = this.ctx, generation = this.generation): Promise<void> {
		if (!isVolcengineAgentPlanModel(ctx?.model)) return;
		if (!ctx?.hasUI || !this.isCurrent(generation)) return;

		if (this.inFlight) {
			this.queued = { ctx, generation };
			return;
		}

		this.inFlight = true;
		try {
			const usage = await getUsage(ctx);
			if (!this.isCurrent(generation)) return;
			this.lastUsage = usage;
			ctx.ui.setStatus(EXTENSION_ID, formatStatus(ctx, usage, this.preferences));
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			if (errorMessage(error).includes(MISSING_AUTH_ERROR)) {
				this.lastUsage = undefined;
				ctx.ui.setStatus(EXTENSION_ID, undefined);
			} else {
				ctx.ui.setStatus(EXTENSION_ID, unavailableStatus(ctx));
			}
		} finally {
			this.inFlight = false;
			const queued = this.queued;
			this.queued = undefined;
			if (queued && this.isCurrent(queued.generation)) void this.refresh(queued.ctx, queued.generation);
		}
	}

	private renderLast(ctx: ExtensionContext): boolean {
		if (!ctx.hasUI || !this.lastUsage || !isVolcengineAgentPlanModel(ctx.model)) return false;
		ctx.ui.setStatus(EXTENSION_ID, formatStatus(ctx, this.lastUsage, this.preferences));
		return true;
	}

	private savePreferences(ctx: ExtensionContext, generation = this.generation): void {
		const preferences = { ...this.preferences };
		const result = this.enqueuePreferenceOperation(() => savePreferences(preferences));
		void result.catch(error => {
			const notifyContext = this.ctx ?? ctx;
			if (this.isCurrent(generation) && notifyContext.hasUI) {
				notifyContext.ui.notify(`pi-volcengine-agent-plan-usage: failed to write ${SETTINGS_FILE}: ${errorMessage(error)}`, "warning");
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
	new VolcengineAgentPlanUsageStatus(pi);
}
