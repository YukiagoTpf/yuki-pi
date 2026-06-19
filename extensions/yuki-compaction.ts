import { complete } from "@earendil-works/pi-ai";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { COMPACTION_STATE_CUSTOM_TYPE, PLAN_STATE_CUSTOM_TYPE } from "./shared/constants.ts";
import { reconstructTodoStates, type TodoState } from "./todo/index.ts";

type DecisionStatus = "candidate" | "accepted" | "rejected";

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
type CompactionEvent = SessionBeforeCompactEvent;

type ToolResultEventLike = {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	details: unknown;
	isError: boolean;
};

interface BudgetAllocation {
	pinnedGoal: number;
	pinnedConstraints: number;
	planStatus: number;
	decisions: number;
	projectContext: number;
	summary: number;
	workingMemory: number;
	fileIndex: number;
	recentTail: number;
}

interface GoalPin {
	text: string;
	source: "user" | "plan" | "summary" | "heuristic";
	updatedAt: string;
}

interface Decision {
	id: string;
	turn: number;
	text: string;
	rationale?: string;
	category: "architecture" | "implementation" | "process" | "constraint" | "unknown";
	status: DecisionStatus;
	createdAt: string;
}

interface Constraint {
	id: string;
	text: string;
	scope: "session" | "task";
	createdAt: string;
}

interface YukiCompactionState {
	version: 1;
	generation: number;
	epoch: number;
	lastCompactAt?: string;
	lastCompactTokens?: number;
	goal?: GoalPin;
	decisions: Decision[];
	constraints: Constraint[];
	workingMemory: string[];
	previousLLMSummary?: string;
	updatedAt: string;
}

interface YukiCompactionDeltaRecord {
	version: 1;
	kind: "delta";
	reason: "goal" | "candidates" | "manual";
	createdAt: string;
	goal?: GoalPin;
	decisions?: Decision[];
	constraints?: Constraint[];
	workingMemory?: string[];
}

interface YukiCompactionConfig {
	version: 1;
	enabled: boolean;
	proactive: boolean;
	triggerRatio: number;
	targetFreeRatio: number;
	minCompactIntervalMs: number;
	preStoreArchiveChars: number;
	runtimeToolTextChars: number;
	summarizerModel?: string;
	/** Reuse the live conversation prefix (system prompt + real history) for the summary call (oh-my-pi handoff style). */
	cacheAwareSummary: boolean;
	/** Gate proactive compaction behind a cache-aware net-benefit model (pi-better-compact DP style). */
	economicGate: boolean;
	/** Always compact above this usage ratio regardless of the economic model. */
	forceRatio: number;
	/** Uncached input price ($/MTok) used by the economic model. */
	priceInputPerM: number;
	/** Cached input price ($/MTok). */
	priceCachePerM: number;
	/** Output price ($/MTok). */
	priceOutputPerM: number;
	/** Expected remaining user turns; amortizes future savings of compacting now. */
	expectedTurns: number;
	updatedAt?: string;
}

interface YukiCompactionConfigRecord {
	version: 1;
	kind: "config";
	createdAt: string;
	config: YukiCompactionConfig;
}

interface YukiCompactionDetails {
	kind: "yuki-compaction-snapshot";
	version: 1;
	epoch: number;
	state: YukiCompactionState;
	budget: BudgetAllocation;
	archive?: { epoch: number; queued: boolean; messages: number };
	trigger: "yuki" | "pi" | "manual";
}

interface ActivePlanState {
	planId: string;
	phase: string;
	active: boolean;
	title?: string;
	request?: string;
	steps?: Array<{ id: string; content: string; activeForm: string }>;
	todoListId?: string;
}

interface ArchiveRef {
	path: string;
	sha256: string;
	bytes: number;
	toolName: string;
	toolCallId: string;
	createdAt: string;
}

const DEFAULT_CONFIG: YukiCompactionConfig = {
	version: 1,
	enabled: true,
	proactive: true,
	triggerRatio: 0.85,
	targetFreeRatio: 0.4,
	minCompactIntervalMs: 60_000,
	preStoreArchiveChars: 12_000,
	runtimeToolTextChars: 4_000,
	cacheAwareSummary: true,
	economicGate: true,
	forceRatio: 0.92,
	priceInputPerM: 3.0,
	priceCachePerM: 0.3,
	priceOutputPerM: 15.0,
	expectedTurns: 8,
};

const INTERNAL = {
	preStoreKeepHeadChars: 2_000,
	preStoreKeepTailChars: 2_000,
	summaryMaxRatio: 0.05,
	minSummaryTokens: 4_000,
	maxSummaryTokens: 16_000,
	maxDecisions: 40,
	maxConstraints: 30,
	maxWorkingMemory: 12,
};

const YUKI_COMPACT_HELP = [
	"Usage: /yuki-compact [command]",
	"",
	"Commands:",
	"  show | status                 Show current config, state, and live dp-eval",
	"  now                           Trigger compaction now",
	"  on | off                      Enable/disable Yuki override for built-in /compact",
	"  proactive on | off            Enable/disable proactive ctx.compact()",
	"  cache-summary on | off        Reuse live conversation prefix for the summary call",
	"  economic on | off             Gate proactive compaction behind the net-benefit model",
	"  model auto | <provider/model>  Set summarizer model preference",
	"  set trigger <0..1>             Set proactive trigger ratio (default 0.85)",
	"  set force <0..1>               Always compact above this usage ratio (default 0.92)",
	"  set target-free <0..1>         Set target free ratio after compact (default 0.40)",
	"  set min-interval-ms <ms>       Set proactive min interval (default 60000)",
	"  set archive-chars <chars>      Set pre-store archive threshold (default 12000)",
	"  set runtime-chars <chars>      Set runtime prune threshold (default 4000)",
	"  set expected-turns <n>         Remaining-turns estimate for economics (default 8)",
	"  set price-input <$/MTok>       Uncached input price (default 3.0)",
	"  set price-cache <$/MTok>       Cached input price (default 0.3)",
	"  set price-output <$/MTok>      Output price (default 15.0)",
	"  reset                         Restore defaults",
].join("\n");

export default function yukiCompactionExtension(pi: ExtensionAPI) {
	let compactInFlight = false;
	let lastRequestedAt = 0;
	let lastTrigger: "yuki" | "pi" | "manual" = "pi";
	let archiveQueue: Promise<void> = Promise.resolve();

	const enqueueArchive = (task: () => Promise<void>) => {
		const next = archiveQueue.then(task, task);
		archiveQueue = next.catch(() => undefined);
		return next;
	};

	const triggerManualCompact = (ctx: ExtensionContext) => {
		lastTrigger = "manual";
		compactInFlight = true;
		ctx.compact({
			customInstructions: "Manual yuki structured compaction requested.",
			onComplete: () => {
				compactInFlight = false;
				ctx.ui.notify("Yuki compaction complete.", "info");
			},
			onError: (error) => {
				compactInFlight = false;
				ctx.ui.notify(`Yuki compaction failed: ${error.message}`, "error");
			},
		});
		ctx.ui.notify("Yuki compaction requested.", "info");
	};

	pi.registerCommand("yuki-compact", {
		description: "Open yuki compaction settings",
		handler: async (args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const config = reconstructConfig(branch);
			const words = args.trim().split(/\s+/).filter(Boolean);
			const [cmd, key, ...rest] = words;
			if (!cmd) {
				if (ctx.hasUI && ctx.mode !== "print" && ctx.mode !== "json") {
					await openYukiCompactSettings(pi, ctx, config, triggerManualCompact);
				} else {
					ctx.ui.notify(formatConfigStatus(ctx, reconstructCompactionState(branch), config), "info");
				}
				return;
			}
			if (cmd === "show" || cmd === "status") {
				ctx.ui.notify(formatConfigStatus(ctx, reconstructCompactionState(branch), config), "info");
				return;
			}
			if (cmd === "help") {
				ctx.ui.notify(YUKI_COMPACT_HELP, "info");
				return;
			}
			if (cmd === "now") {
				triggerManualCompact(ctx);
				return;
			}
			let next: YukiCompactionConfig | undefined;
			if (cmd === "on" || cmd === "enable") next = { ...config, enabled: true };
			else if (cmd === "off" || cmd === "disable") next = { ...config, enabled: false };
			else if (cmd === "reset") next = { ...DEFAULT_CONFIG };
			else if (cmd === "proactive" && (key === "on" || key === "enable")) next = { ...config, proactive: true };
			else if (cmd === "proactive" && (key === "off" || key === "disable")) next = { ...config, proactive: false };
			else if (cmd === "cache-summary") next = setConfigValue(config, "cache-summary", key);
			else if (cmd === "economic" || cmd === "dp") next = setConfigValue(config, "economic", key);
			else if (cmd === "model") next = setConfigValue(config, "model", key);
			else if (cmd === "set" && key) next = setConfigValue(config, key, rest.join(" "));
			else next = setConfigValue(config, cmd, [key, ...rest].filter(Boolean).join(" "));

			if (!next) {
				ctx.ui.notify(`Unknown yuki-compact command.\n\n${YUKI_COMPACT_HELP}`, "warning");
				return;
			}
			persistConfig(pi, next);
			ctx.ui.notify(formatConfigStatus(ctx, reconstructCompactionState(branch), next), "info");
		},
	});

	pi.registerCommand("yuki-compact-now", {
		description: "Trigger yuki structured compaction now",
		handler: async (_args, ctx) => triggerManualCompact(ctx),
	});

	pi.registerCommand("yuki-compact-status", {
		description: "Show yuki compaction state for the current branch",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			ctx.ui.notify(formatConfigStatus(ctx, reconstructCompactionState(branch), reconstructConfig(branch)), "info");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const config = reconstructConfig(branch);
		if (!config.enabled) return;
		const state = reconstructCompactionState(branch);
		if (!state.goal && event.prompt.trim()) {
			const goal: GoalPin = { text: event.prompt.trim().slice(0, 1_000), source: "user", updatedAt: new Date().toISOString() };
			pi.appendEntry(COMPACTION_STATE_CUSTOM_TYPE, { version: 1, kind: "delta", reason: "goal", createdAt: goal.updatedAt, goal } satisfies YukiCompactionDeltaRecord);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const config = reconstructConfig(ctx.sessionManager.getBranch());
		if (!config.enabled) return;
		return pruneToolResult(event as ToolResultEventLike, ctx, enqueueArchive, config);
	});

	pi.on("context", async (event, ctx) => {
		const config = reconstructConfig(ctx.sessionManager.getBranch());
		if (!config.enabled) return;
		return { messages: event.messages.map((message) => pruneRuntimeMessage(message, config)) };
	});

	pi.on("turn_end", async (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const config = reconstructConfig(branch);
		if (!config.enabled) return;
		// Record zero-cost decision/constraint candidates every turn so nothing is lost
		// between compactions, but do NOT trigger proactive compaction here. Triggering on
		// turn_end interrupts an in-flight task mid-run (a long task is many turns); proactive
		// compaction only fires at agent_end, the natural task boundary. Hard context-limit
		// overflow is still covered by Pi's native auto-compact path.
		const turnMessages = [event.message, ...(event.toolResults as unknown as AgentMessage[])];
		const candidates = extractCandidatesFromTurn(event.turnIndex, turnMessages);
		if (candidates.decisions.length > 0 || candidates.constraints.length > 0) {
			const now = new Date().toISOString();
			pi.appendEntry(COMPACTION_STATE_CUSTOM_TYPE, {
				version: 1,
				kind: "delta",
				reason: "candidates",
				createdAt: now,
				decisions: candidates.decisions,
				constraints: candidates.constraints,
			} satisfies YukiCompactionDeltaRecord);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const config = reconstructConfig(branch);
		if (!config.enabled) return;
		maybeTriggerCompaction(ctx, reconstructCompactionState(branch), config);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const compactEvent = event as CompactionEvent;
		const config = reconstructConfig(compactEvent.branchEntries);
		if (!config.enabled) return;
		const trigger = lastTrigger;
		lastTrigger = "pi";
		try {
			const branchState = reconstructCompactionState(compactEvent.branchEntries);
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? Math.max(compactEvent.preparation.tokensBefore, 128_000);
			const maxOutputTokens = ctx.model?.maxTokens ?? compactEvent.preparation.settings.reserveTokens ?? 16_384;
			const budget = allocateBudget(contextWindow, maxOutputTokens);
			const targetTokens = usableWindow(contextWindow, maxOutputTokens) * (1 - config.targetFreeRatio);

			if (trigger === "yuki" && compactEvent.preparation.tokensBefore <= targetTokens) {
				compactInFlight = false;
				return { cancel: true };
			}

			const epoch = branchState.epoch + 1;
			const discardedMessages = [...compactEvent.preparation.messagesToSummarize, ...compactEvent.preparation.turnPrefixMessages];
			const plan = reconstructPlanState(compactEvent.branchEntries);
			const todos = reconstructTodoStates(ctx);
			const nextState = enrichStateFromPlanAndTodos(branchState, plan, todos);
			const result = await buildCompactionResult(compactEvent, ctx, nextState, budget, trigger, config);
			nextState.generation += 1;
			nextState.epoch = epoch;
			nextState.lastCompactAt = new Date().toISOString();
			nextState.lastCompactTokens = compactEvent.preparation.tokensBefore;
			nextState.previousLLMSummary = extractVolatileSummary(result.summary);
			nextState.updatedAt = nextState.lastCompactAt;
			result.details = {
				kind: "yuki-compaction-snapshot",
				version: 1,
				epoch,
				state: nextState,
				budget,
				archive: { epoch, queued: true, messages: discardedMessages.length },
				trigger,
			} satisfies YukiCompactionDetails;

			void archiveCompaction(ctx, enqueueArchive, epoch, discardedMessages, nextState).catch((error) => {
				ctx.ui.notify(`Yuki compaction archive failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});

			return { compaction: result };
		} finally {
			compactInFlight = false;
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		if (event.fromExtension) ctx.ui.setStatus("yuki-compact", `compacted ${new Date().toLocaleTimeString()}`);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		await Promise.race([archiveQueue, delay(1_500)]);
	});

	function maybeTriggerCompaction(ctx: ExtensionContext, state: YukiCompactionState, config: YukiCompactionConfig) {
		if (!config.enabled || !config.proactive) return;
		// Proactive compaction fires only from agent_end (the natural task boundary), never
		// mid-task from turn_end, so an in-flight task is not interrupted and the prompt-cache
		// prefix is reset far less often.
		// Phase 0 showed ctx.compact() from agent_end in print/json mode can enter
		// session_before_compact and then abort before append because the one-shot run is
		// tearing down. Proactive compaction is for long-lived interactive/RPC sessions;
		// native auto-compact/manual commands still cover other modes.
		if (ctx.mode === "print" || ctx.mode === "json") return;
		const usage = ctx.getContextUsage();
		if (!usage?.tokens || !usage.contextWindow || compactInFlight) return;
		const maxOutputTokens = ctx.model?.maxTokens ?? 16_384;
		const threshold = usableWindow(usage.contextWindow, maxOutputTokens) * config.triggerRatio;
		const now = Date.now();
		if (usage.tokens <= threshold) return;
		if (now - lastRequestedAt < config.minCompactIntervalMs) return;
		if (state.lastCompactAt && now - Date.parse(state.lastCompactAt) < config.minCompactIntervalMs) return;

		// Economic gate (pi-better-compact DP style): the hysteresis threshold above only says
		// "the context is large enough to consider compacting". Whether compacting now actually
		// pays off depends on the prompt-cache economics: compacting buys cheaper future requests
		// but costs one cache-prefix reset plus the summary call. Below forceRatio we only compact
		// when the modeled net benefit is positive; above forceRatio the context is close enough
		// to the wall that we compact regardless.
		const forceThreshold = usableWindow(usage.contextWindow, maxOutputTokens) * config.forceRatio;
		if (config.economicGate && usage.tokens <= forceThreshold) {
			const decision = evaluateCompactionEconomics(usage.tokens, usage.contextWindow, maxOutputTokens, config);
			if (decision.netBenefit <= 0) {
				ctx.ui.setStatus("yuki-compact", undefined);
				return;
			}
		}

		compactInFlight = true;
		lastRequestedAt = now;
		lastTrigger = "yuki";
		ctx.ui.setStatus("yuki-compact", "compacting…");
		ctx.compact({
			customInstructions: "Yuki proactive structured compaction triggered by hysteresis.",
			onComplete: () => {
				compactInFlight = false;
				ctx.ui.setStatus("yuki-compact", undefined);
			},
			onError: (error) => {
				compactInFlight = false;
				ctx.ui.setStatus("yuki-compact", undefined);
				ctx.ui.notify(`Yuki proactive compaction failed: ${error.message}`, "warning");
			},
		});
	}
}

/**
 * Cache-aware net-benefit model for "should we compact now?" (pi-better-compact DP style).
 *
 * All terms are in dollars over the expected remaining turns. We compare keeping the current
 * large context against compacting down to the post-compact target size.
 *
 * - futureSavings: each remaining turn re-sends the prefix. With prompt caching the prefix is
 *   billed at the cache price, so the saving per turn is the freed token count × cache price.
 * - cacheInvalidation: compacting rewrites the prefix, so the first request after compaction
 *   re-pays full (uncached) input price on the kept context.
 * - summaryCost: the summary LLM call. With cacheAwareSummary the input is mostly a cache hit,
 *   so its input is priced at the cache rate; otherwise full input price.
 */
function evaluateCompactionEconomics(
	currentTokens: number,
	contextWindow: number,
	maxOutputTokens: number,
	config: YukiCompactionConfig,
): { netBenefit: number; futureSavings: number; cacheInvalidation: number; summaryCost: number; freedTokens: number } {
	const usable = usableWindow(contextWindow, maxOutputTokens);
	const targetTokens = usable * (1 - config.targetFreeRatio);
	const keptTokens = Math.max(0, Math.min(currentTokens, targetTokens));
	const freedTokens = Math.max(0, currentTokens - keptTokens);
	const turns = Math.max(1, config.expectedTurns);

	const perM = (tokens: number, pricePerM: number) => (tokens / 1_000_000) * pricePerM;

	// Without compaction the freed tokens ride along (cache-priced) every remaining turn.
	// After compaction they are gone, so this is the recurring saving.
	const futureSavings = perM(freedTokens, config.priceCachePerM) * turns;

	// The summary itself becomes part of the new prefix; its tokens also recur, partially
	// offsetting the saving. Treat the summary output as recurring cache-priced input.
	const summaryTokens = INTERNAL.minSummaryTokens;
	const recurringSummaryDrag = perM(summaryTokens, config.priceCachePerM) * turns;

	// Compaction resets the cache: the kept context is re-billed once at the uncached rate.
	const cacheInvalidation = perM(keptTokens, config.priceInputPerM - config.priceCachePerM);

	// The summary generation call. Cache-aware summary reuses the live prefix (cache price);
	// otherwise the whole conversation is uncached input.
	const summaryInputPrice = config.cacheAwareSummary ? config.priceCachePerM : config.priceInputPerM;
	const summaryCost = perM(currentTokens, summaryInputPrice) + perM(summaryTokens, config.priceOutputPerM);

	const netBenefit = futureSavings - recurringSummaryDrag - cacheInvalidation - summaryCost;
	return { netBenefit, futureSavings, cacheInvalidation, summaryCost: summaryCost + recurringSummaryDrag, freedTokens };
}

async function pruneToolResult(
	event: ToolResultEventLike,
	ctx: ExtensionContext,
	enqueueArchive: (task: () => Promise<void>) => Promise<void>,
	config: YukiCompactionConfig,
) {
	const text = contentToText(event.content);
	if (text.length <= config.preStoreArchiveChars) return;

	const sha256 = createHash("sha256").update(text).digest("hex");
	const fileName = `${safeFilePart(event.toolCallId)}-${sha256.slice(0, 16)}.txt`;
	const absolutePath = join(ctx.cwd, ".pi", "yuki", "tool-output", fileName);
	const relPath = relative(ctx.cwd, absolutePath).replaceAll("\\", "/");
	const ref: ArchiveRef = {
		path: relPath,
		sha256,
		bytes: Buffer.byteLength(text),
		toolName: event.toolName,
		toolCallId: event.toolCallId,
		createdAt: new Date().toISOString(),
	};

	try {
		await enqueueArchive(async () => {
			await mkdir(join(ctx.cwd, ".pi", "yuki", "tool-output"), { recursive: true });
			await writeFile(absolutePath, text, "utf8");
		});
	} catch {
		const truncated = truncateMiddle(text, INTERNAL.preStoreKeepHeadChars, INTERNAL.preStoreKeepTailChars);
		return { content: [{ type: "text" as const, text: `[Yuki pre-store prune: archive failed]\n${truncated}` }] };
	}

	const pruned = [
		`[Yuki pre-store prune] ${event.toolName} output was ${ref.bytes} bytes and was archived before storing.`,
		`Archive: ${ref.path}`,
		`sha256: ${ref.sha256}`,
		"",
		"<head>",
		text.slice(0, INTERNAL.preStoreKeepHeadChars),
		"</head>",
		"<tail>",
		text.slice(-INTERNAL.preStoreKeepTailChars),
		"</tail>",
	].join("\n");

	return {
		content: [{ type: "text" as const, text: pruned }],
		details: mergeDetails(event.details, { yukiArchiveRef: ref }),
	};
}

function pruneRuntimeMessage(message: AgentMessage, config: YukiCompactionConfig): AgentMessage {
	const msg = message as unknown as Record<string, unknown>;
	if (msg.role !== "tool" && msg.role !== "toolResult") return message;
	const text = messageToText(message);
	if (text.length <= config.runtimeToolTextChars) return message;
	return withTextContent(message, `[Yuki runtime prune]\n${truncateMiddle(text, 1_500, 1_500)}`);
}

async function buildCompactionResult(
	event: CompactionEvent,
	ctx: ExtensionContext,
	state: YukiCompactionState,
	budget: BudgetAllocation,
	trigger: "yuki" | "pi" | "manual",
	config: YukiCompactionConfig,
): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown }> {
	const { preparation } = event;
	const noLlm = trigger === "pi" && preparation.tokensBefore < preparation.settings.keepRecentTokens * 1.5;
	const stateSections = buildStateSections(state, ctx, budget);
	if (noLlm) {
		return {
			summary: `${stateSections}\n\n## Critical Context\n- No-LLM compaction path used; recent tail retained from ${preparation.firstKeptEntryId}.\n`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		};
	}

	const volatile = await generateVolatileSummary(event, ctx, stateSections, budget, config);
	return {
		summary: `${stateSections}\n\n${volatile}`.trim(),
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
	};
}

async function generateVolatileSummary(event: CompactionEvent, ctx: ExtensionContext, stateSections: string, budget: BudgetAllocation, config: YukiCompactionConfig): Promise<string> {
	const configured = findConfiguredModel(ctx, config.summarizerModel);
	const preferred = configured ?? ctx.modelRegistry.find("google", "gemini-2.5-flash");
	const candidates = [preferred, ctx.model].filter((model, index, all): model is NonNullable<typeof model> => {
		return Boolean(model) && all.findIndex((other) => other?.provider === model?.provider && other?.id === model?.id) === index;
	});
	if (candidates.length === 0) return fallbackVolatileSummary(event, "No summarization model available.");

	let selected: (typeof candidates)[number] | undefined;
	let selectedAuth: { apiKey?: string; headers?: Record<string, string> } | undefined;
	const authErrors: string[] = [];
	for (const candidate of candidates) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate);
		if (auth.ok && auth.apiKey) {
			selected = candidate;
			selectedAuth = { apiKey: auth.apiKey, headers: auth.headers };
			break;
		}
		authErrors.push(auth.ok ? `No API key for ${candidate.provider}/${candidate.id}` : `${candidate.provider}/${candidate.id}: ${auth.error}`);
	}
	if (!selected || !selectedAuth?.apiKey) return fallbackVolatileSummary(event, authErrors.join("; ") || "No usable summarization auth.");

	const previous = event.preparation.previousSummary ? `\n\nPrevious summary:\n${event.preparation.previousSummary}` : "";
	const custom = event.customInstructions ? `\n\nCustom instructions:\n${event.customInstructions}` : "";
	const maxTokens = Math.max(INTERNAL.minSummaryTokens, Math.min(INTERNAL.maxSummaryTokens, budget.summary));

	// The summary instruction is identical in both paths so it can live at the very END
	// of the request, after the cached prefix, without changing earlier tokens.
	const instruction = `Create ONLY the volatile parts of a Yuki-Pi compaction summary.\n\nState-driven sections below are authoritative and must not be rewritten; use them only for context.\n\n${stateSections}${previous}${custom}\n\nSummarize the conversation above (the portion that will be discarded) into these markdown sections only:\n\n## Critical Context\n- facts needed to continue, including files, APIs, commands, errors, and constraints not already in state sections\n\n## Work Progress\n### Done\n- completed work\n### In Progress\n- active partial work\n### Blocked\n- blockers or none\n\n## Next Steps\n1. concrete next action\n\nKeep it concise and recovery-oriented. Do not invent facts.`;

	// Cache-aware (handoff) path: reuse the live conversation prefix so the summarizer
	// request shares the prompt-cache prefix with the main conversation. We send the
	// active system prompt + the real (converted) message history, then append a single
	// instruction message at the end. Only the tiny trailing message is uncached; the
	// large history prefix is a cache hit. This only pays off when the summarizer is the
	// same model as the conversation (no Gemini key), since cache is per-model/provider.
	const sameModelAsConversation = Boolean(ctx.model && selected.provider === ctx.model.provider && selected.id === ctx.model.id);
	if (config.cacheAwareSummary && sameModelAsConversation) {
		try {
			const historyMessages = convertToLlm([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]);
			const response = await complete(
				selected,
				{
					systemPrompt: ctx.getSystemPrompt(),
					messages: [
						...historyMessages,
						{ role: "user" as const, content: [{ type: "text" as const, text: instruction }], timestamp: Date.now() },
					],
				},
				{ apiKey: selectedAuth.apiKey, headers: selectedAuth.headers, maxTokens, cacheRetention: "short", signal: event.signal },
			);
			const text = extractText(response);
			if (text) return text;
			// Empty result: fall through to the self-contained path below.
		} catch (error) {
			if (isAbortError(error) || isAborted(event.signal)) throw error;
			// Provider rejected the reused prefix (e.g. tool-call/result pairing); fall back.
		}
	}

	// Self-contained path: embed the serialized conversation inside one user message.
	const conversationText = serializeConversation(convertToLlm([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]));
	const response = await complete(
		selected,
		{
			messages: [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `${instruction}\n\n<conversation>\n${conversationText}\n</conversation>`,
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: selectedAuth.apiKey, headers: selectedAuth.headers, maxTokens, signal: event.signal },
	);

	return extractText(response) || fallbackVolatileSummary(event, "LLM returned empty summary.");
}

function extractText(response: { content: Array<{ type: string }> }): string {
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function fallbackVolatileSummary(event: CompactionEvent, reason: string): string {
	const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
	const lines = messages.slice(-12).map((message) => `- ${messageToText(message).replace(/\s+/g, " ").slice(0, 240)}`);
	return [`## Critical Context`, `- Fallback no-LLM summary used: ${reason}`, ``, `## Work Progress`, `### Done`, ...lines, `### In Progress`, `- See retained recent tail from ${event.preparation.firstKeptEntryId}.`, `### Blocked`, `- Unknown.`, ``, `## Next Steps`, `1. Inspect retained recent tail and continue.`].join("\n");
}

function buildStateSections(state: YukiCompactionState, ctx: ExtensionContext, budget: BudgetAllocation): string {
	const plan = reconstructPlanState(ctx.sessionManager.getBranch());
	const todos = reconstructTodoStates(ctx);
	return [
		"## Goal",
		truncateToTokenBudget(state.goal?.text ?? inferGoalFromPlan(plan) ?? "No pinned goal captured yet.", budget.pinnedGoal),
		"",
		"## Constraints & Preferences",
		formatConstraints(state.constraints, budget.pinnedConstraints),
		"",
		"## Plan Progress",
		formatPlanProgress(plan, todos, budget.planStatus),
		"",
		"## Key Decisions",
		formatDecisions(state.decisions, budget.decisions),
		"",
		"## Working Memory",
		formatWorkingMemory(state.workingMemory, budget.workingMemory),
	].join("\n");
}

function reconstructCompactionState(branch: SessionEntry[]): YukiCompactionState {
	let state = createInitialState();
	let sawSnapshot = false;
	for (const entry of branch) {
		if (entry.type === "compaction") {
			const details = (entry as { details?: YukiCompactionDetails }).details;
			if (details?.kind === "yuki-compaction-snapshot" && details.state) {
				state = normalizeState(details.state);
				sawSnapshot = true;
			}
			continue;
		}
		if (entry.type === "custom" && "customType" in entry && entry.customType === COMPACTION_STATE_CUSTOM_TYPE) {
			const record = (entry as { data?: YukiCompactionDeltaRecord }).data;
			if (record?.kind === "delta") state = applyDelta(state, record);
		}
	}
	return sawSnapshot ? normalizeState(state) : normalizeState(state);
}

function createInitialState(): YukiCompactionState {
	return {
		version: 1,
		generation: 0,
		epoch: 0,
		decisions: [],
		constraints: [],
		workingMemory: [],
		updatedAt: new Date().toISOString(),
	};
}

function reconstructConfig(branch: SessionEntry[]): YukiCompactionConfig {
	let config = { ...DEFAULT_CONFIG };
	for (const entry of branch) {
		if (entry.type !== "custom" || !("customType" in entry) || entry.customType !== COMPACTION_STATE_CUSTOM_TYPE) continue;
		const record = (entry as { data?: YukiCompactionConfigRecord }).data;
		if (record?.kind === "config" && record.config) config = normalizeConfig(record.config);
	}
	return config;
}

function normalizeConfig(config: Partial<YukiCompactionConfig>): YukiCompactionConfig {
	return {
		...DEFAULT_CONFIG,
		...config,
		version: 1,
		enabled: config.enabled !== false,
		proactive: config.proactive !== false,
		triggerRatio: clampNumber(config.triggerRatio, 0.1, 0.98, DEFAULT_CONFIG.triggerRatio),
		targetFreeRatio: clampNumber(config.targetFreeRatio, 0.1, 0.9, DEFAULT_CONFIG.targetFreeRatio),
		minCompactIntervalMs: clampNumber(config.minCompactIntervalMs, 0, 3_600_000, DEFAULT_CONFIG.minCompactIntervalMs),
		preStoreArchiveChars: Math.floor(clampNumber(config.preStoreArchiveChars, 1_000, 1_000_000, DEFAULT_CONFIG.preStoreArchiveChars)),
		runtimeToolTextChars: Math.floor(clampNumber(config.runtimeToolTextChars, 1_000, 1_000_000, DEFAULT_CONFIG.runtimeToolTextChars)),
		summarizerModel: config.summarizerModel || undefined,
		cacheAwareSummary: config.cacheAwareSummary !== false,
		economicGate: config.economicGate !== false,
		forceRatio: clampNumber(config.forceRatio, 0.5, 0.99, DEFAULT_CONFIG.forceRatio),
		priceInputPerM: clampNumber(config.priceInputPerM, 0, 1_000, DEFAULT_CONFIG.priceInputPerM),
		priceCachePerM: clampNumber(config.priceCachePerM, 0, 1_000, DEFAULT_CONFIG.priceCachePerM),
		priceOutputPerM: clampNumber(config.priceOutputPerM, 0, 1_000, DEFAULT_CONFIG.priceOutputPerM),
		expectedTurns: Math.floor(clampNumber(config.expectedTurns, 1, 1_000, DEFAULT_CONFIG.expectedTurns)),
		updatedAt: config.updatedAt,
	};
}

function normalizeState(state: YukiCompactionState): YukiCompactionState {
	return {
		version: 1,
		generation: Number.isFinite(state.generation) ? state.generation : 0,
		epoch: Number.isFinite(state.epoch) ? state.epoch : 0,
		lastCompactAt: state.lastCompactAt,
		lastCompactTokens: state.lastCompactTokens,
		goal: state.goal,
		decisions: dedupeByText(state.decisions ?? []).slice(-INTERNAL.maxDecisions),
		constraints: dedupeByText(state.constraints ?? []).slice(-INTERNAL.maxConstraints),
		workingMemory: (state.workingMemory ?? []).filter(Boolean).slice(-INTERNAL.maxWorkingMemory),
		previousLLMSummary: state.previousLLMSummary,
		updatedAt: state.updatedAt ?? new Date().toISOString(),
	};
}

function applyDelta(state: YukiCompactionState, record: YukiCompactionDeltaRecord): YukiCompactionState {
	return normalizeState({
		...state,
		goal: record.goal ?? state.goal,
		decisions: [...state.decisions, ...(record.decisions ?? [])],
		constraints: [...state.constraints, ...(record.constraints ?? [])],
		workingMemory: record.workingMemory ?? state.workingMemory,
		updatedAt: record.createdAt,
	});
}

function enrichStateFromPlanAndTodos(state: YukiCompactionState, plan: ActivePlanState | undefined, todos: Map<string, TodoState>): YukiCompactionState {
	const next = normalizeState({ ...state });
	if (!next.goal && plan?.active && plan.phase === "executing") {
		const text = plan.request ?? plan.title;
		if (text) next.goal = { text, source: "plan", updatedAt: new Date().toISOString() };
	}
	const activeTodo = plan?.todoListId ? todos.get(plan.todoListId)?.todos.find((todo) => todo.status === "in_progress") : undefined;
	next.workingMemory = activeTodo ? [`Active plan todo ${activeTodo.id}: ${activeTodo.activeForm}`] : next.workingMemory;
	return next;
}

function reconstructPlanState(branch: SessionEntry[]): ActivePlanState | undefined {
	let plan: ActivePlanState | undefined;
	for (const entry of branch) {
		if (entry.type === "custom" && "customType" in entry && entry.customType === PLAN_STATE_CUSTOM_TYPE) {
			const data = (entry as { data?: { state?: unknown } }).data;
			plan = readPlanState(data?.state ?? data) ?? plan;
			continue;
		}
		if (entry.type === "message") {
			const message = entry.message as { role?: string; toolName?: string; details?: { state?: unknown } };
			if (message.role === "toolResult") plan = readPlanState(message.details?.state) ?? plan;
		}
	}
	return plan;
}

function readPlanState(value: unknown): ActivePlanState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as { planId?: unknown; phase?: unknown; active?: unknown; title?: unknown; request?: unknown; todoListId?: unknown; steps?: unknown };
	if (typeof data.planId !== "string" || typeof data.phase !== "string") return undefined;
	return {
		planId: data.planId,
		phase: data.phase,
		active: data.active === true,
		title: typeof data.title === "string" ? data.title : undefined,
		request: typeof data.request === "string" ? data.request : undefined,
		todoListId: typeof data.todoListId === "string" ? data.todoListId : undefined,
		steps: Array.isArray(data.steps) ? (data.steps as ActivePlanState["steps"]) : undefined,
	};
}

function extractCandidatesFromTurn(turn: number, messages: AgentMessage[]): { decisions: Decision[]; constraints: Constraint[] } {
	const now = new Date().toISOString();
	const text = messages.map(messageToText).join("\n");
	const decisions: Decision[] = [];
	const constraints: Constraint[] = [];
	const decisionRegex = /(?:decided|decision|we will|we'll|choose|chosen|选择|决定|采用|使用)[:：]?\s*([^\n。.!?]{6,180})/gi;
	const constraintRegex = /(?:must|requirement|constraint|do not|don't|必须|不要|不能|需要|约束|要求)[:：]?\s*([^\n。.!?]{6,180})/gi;
	for (const match of text.matchAll(decisionRegex)) {
		decisions.push({ id: stableId(`d:${match[1]}`), turn, text: match[1].trim(), category: classifyDecision(match[1]), status: "candidate", createdAt: now });
	}
	for (const match of text.matchAll(constraintRegex)) {
		constraints.push({ id: stableId(`c:${match[1]}`), text: match[1].trim(), scope: "task", createdAt: now });
	}
	return { decisions: dedupeByText(decisions).slice(-6), constraints: dedupeByText(constraints).slice(-6) };
}

function classifyDecision(text: string): Decision["category"] {
	const lower = text.toLowerCase();
	if (/(api|architecture|schema|database|render|pipeline|架构|数据库)/.test(lower)) return "architecture";
	if (/(implement|function|class|file|代码|实现)/.test(lower)) return "implementation";
	if (/(phase|plan|process|流程|计划)/.test(lower)) return "process";
	if (/(must|constraint|require|必须|约束)/.test(lower)) return "constraint";
	return "unknown";
}

function formatConstraints(constraints: Constraint[], budget: number): string {
	if (constraints.length === 0) return "- None captured.";
	return truncateToTokenBudget(constraints.map((c) => `- ${c.scope}: ${c.text}`).join("\n"), budget);
}

function formatDecisions(decisions: Decision[], budget: number): string {
	const accepted = decisions.filter((decision) => decision.status !== "rejected");
	if (accepted.length === 0) return "- None captured.";
	return truncateToTokenBudget(
		accepted
			.slice(-INTERNAL.maxDecisions)
			.reverse()
			.map((decision) => `- [Turn ${decision.turn}] **${decision.text}** (${decision.category}, ${decision.status})`)
			.join("\n"),
		budget,
	);
}

function formatWorkingMemory(items: string[], budget: number): string {
	if (items.length === 0) return "- None.";
	return truncateToTokenBudget(items.map((item) => `- ${item}`).join("\n"), budget);
}

function formatPlanProgress(plan: ActivePlanState | undefined, todos: Map<string, TodoState>, budget: number): string {
	if (!plan?.active) return "- No active yuki plan.";
	const todoState = plan.todoListId ? todos.get(plan.todoListId) : undefined;
	const lines = [`- Plan ${plan.planId}: ${plan.title ?? plan.request ?? "untitled"} (${plan.phase})`];
	if (!todoState) return truncateToTokenBudget(lines.join("\n"), budget);
	const completed = todoState.todos.filter((todo) => todo.status === "completed");
	const inProgress = todoState.todos.find((todo) => todo.status === "in_progress");
	const pending = todoState.todos.filter((todo) => todo.status === "pending");
	lines.push(`### Completed (${completed.length})`);
	lines.push(...completed.slice(-8).map((todo) => `- [x] ${todo.id}: ${todo.content}${todo.evidence ? ` — ${todo.evidence}` : ""}`));
	lines.push("### In Progress");
	lines.push(inProgress ? `- [>] ${inProgress.id}: ${inProgress.activeForm}` : "- None");
	lines.push(`### Remaining (${pending.length})`);
	lines.push(...pending.slice(0, 8).map((todo) => `- [ ] ${todo.id}: ${todo.content}`));
	return truncateToTokenBudget(lines.join("\n"), budget);
}

function allocateBudget(contextWindow: number, maxOutputTokens: number): BudgetAllocation {
	const usable = usableWindow(contextWindow, maxOutputTokens);
	const ratio = contextWindow <= 150_000 ? 0.3 : 0.25;
	const total = Math.floor(usable * ratio * 0.9);
	const fixed = {
		pinnedGoal: 500,
		pinnedConstraints: 500,
		planStatus: 1000,
		decisions: 1500,
		projectContext: 2500,
		workingMemory: 800,
		fileIndex: 500,
	};
	const fixedTotal = Object.values(fixed).reduce((sum, value) => sum + value, 0);
	const summary = Math.min(Math.floor(usable * INTERNAL.summaryMaxRatio), INTERNAL.maxSummaryTokens);
	const recentTail = Math.max(0, total - fixedTotal - summary);
	return { ...fixed, summary, recentTail };
}

function usableWindow(contextWindow: number, maxOutputTokens: number) {
	return Math.max(16_000, contextWindow - 8_000 - maxOutputTokens);
}

async function archiveCompaction(
	ctx: ExtensionContext,
	enqueueArchive: (task: () => Promise<void>) => Promise<void>,
	epoch: number,
	discardedMessages: AgentMessage[],
	state: YukiCompactionState,
) {
	return enqueueArchive(async () => {
		const dir = join(ctx.cwd, ".pi", "yuki", "compaction-history");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `epoch-${String(epoch).padStart(4, "0")}.json`);
		await writeFile(path, JSON.stringify({ epoch, createdAt: new Date().toISOString(), state, discardedMessages }, null, 2), "utf8");
		await appendFile(join(dir, "index.md"), `\n- epoch ${epoch}: ${discardedMessages.length} message(s), generation ${state.generation}, ${new Date().toISOString()}\n`, "utf8");
	});
}

function contentToText(content: (TextContent | ImageContent)[]): string {
	return content
		.map((part) => (part.type === "text" ? part.text : `[${part.type} content]`))
		.join("\n");
}

function messageToText(message: unknown): string {
	const msg = message as Record<string, unknown>;
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) return contentToText(msg.content as (TextContent | ImageContent)[]);
	if (typeof msg.summary === "string") return msg.summary;
	if (typeof msg.output === "string") return msg.output;
	return JSON.stringify(msg).slice(0, 2_000);
}

function withTextContent<T extends AgentMessage>(message: T, text: string): T {
	const msg = message as unknown as Record<string, unknown>;
	if (Array.isArray(msg.content)) return { ...(message as object), content: [{ type: "text", text }] } as T;
	if (typeof msg.content === "string") return { ...(message as object), content: text } as T;
	if (typeof msg.output === "string") return { ...(message as object), output: text } as T;
	return message;
}

function mergeDetails(details: unknown, patch: Record<string, unknown>) {
	return details && typeof details === "object" && !Array.isArray(details) ? { ...details, ...patch } : patch;
}

function truncateMiddle(text: string, head: number, tail: number) {
	if (text.length <= head + tail) return text;
	return `${text.slice(0, head)}\n\n... [${text.length - head - tail} chars pruned by yuki] ...\n\n${text.slice(-tail)}`;
}

function truncateToTokenBudget(text: string, budget: number) {
	const approx = Math.max(1, Math.floor(budget * 4));
	if (text.length <= approx) return text;
	return `${text.slice(0, approx)}\n- ... truncated to ${budget} token budget`;
}

function extractVolatileSummary(summary: string) {
	const marker = "## Critical Context";
	const idx = summary.indexOf(marker);
	return idx >= 0 ? summary.slice(idx).trim() : summary.slice(-8_000);
}

function inferGoalFromPlan(plan: ActivePlanState | undefined) {
	if (!plan?.active || plan.phase !== "executing") return undefined;
	return plan.request ?? plan.title;
}

async function openYukiCompactSettings(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: YukiCompactionConfig,
	triggerManualCompact: (ctx: ExtensionContext) => void,
) {
	const currentModel = getCurrentModelSetting(ctx);
	const choice = await ctx.ui.select("Yuki Compaction Settings", [
		`Builtin /compact override: ${config.enabled ? "Yuki ON" : "Yuki OFF"}`,
		`Proactive: ${config.proactive ? "Enabled" : "Disabled"}`,
		`Cache-aware summary: ${config.cacheAwareSummary ? "Enabled" : "Disabled"}`,
		`Economic gate: ${config.economicGate ? "Enabled" : "Disabled"}`,
		`Summarizer model: ${config.summarizerModel ?? "Auto"}`,
		`Trigger ratio: ${config.triggerRatio}`,
		`Force ratio: ${config.forceRatio}`,
		`Target free ratio: ${config.targetFreeRatio}`,
		`Expected turns: ${config.expectedTurns}`,
		`Archive threshold: ${config.preStoreArchiveChars} chars`,
		`Runtime prune threshold: ${config.runtimeToolTextChars} chars`,
		`Minimum interval: ${config.minCompactIntervalMs} ms`,
		"Run /compact now",
		"Reset to defaults",
		"Show details",
	]);
	if (!choice) return;

	let next: YukiCompactionConfig | undefined;
	if (choice.startsWith("Builtin /compact override:")) next = { ...config, enabled: !config.enabled };
	else if (choice.startsWith("Proactive:")) next = { ...config, proactive: !config.proactive };
	else if (choice.startsWith("Cache-aware summary:")) next = { ...config, cacheAwareSummary: !config.cacheAwareSummary };
	else if (choice.startsWith("Economic gate:")) next = { ...config, economicGate: !config.economicGate };
	else if (choice.startsWith("Summarizer model:")) next = await promptSummarizerModel(ctx, config, currentModel);
	else if (choice.startsWith("Trigger ratio:")) next = await promptNumericSetting(ctx, config, "trigger", String(config.triggerRatio));
	else if (choice.startsWith("Force ratio:")) next = await promptNumericSetting(ctx, config, "force", String(config.forceRatio));
	else if (choice.startsWith("Target free ratio:")) next = await promptNumericSetting(ctx, config, "target-free", String(config.targetFreeRatio));
	else if (choice.startsWith("Expected turns:")) next = await promptNumericSetting(ctx, config, "expected-turns", String(config.expectedTurns));
	else if (choice.startsWith("Archive threshold:")) next = await promptNumericSetting(ctx, config, "archive-chars", String(config.preStoreArchiveChars));
	else if (choice.startsWith("Runtime prune threshold:")) next = await promptNumericSetting(ctx, config, "runtime-chars", String(config.runtimeToolTextChars));
	else if (choice.startsWith("Minimum interval:")) next = await promptNumericSetting(ctx, config, "min-interval-ms", String(config.minCompactIntervalMs));
	else if (choice === "Run /compact now") {
		triggerManualCompact(ctx);
		return;
	} else if (choice === "Reset to defaults") {
		const ok = await ctx.ui.confirm("Reset Yuki Compaction", "Restore all yuki compaction settings to defaults?");
		if (!ok) return;
		next = { ...DEFAULT_CONFIG };
	} else if (choice === "Show details") {
		ctx.ui.notify(formatConfigStatus(ctx, reconstructCompactionState(ctx.sessionManager.getBranch()), config), "info");
		return;
	}

	if (!next) return;
	persistConfig(pi, next);
	ctx.ui.notify(formatConfigStatus(ctx, reconstructCompactionState(ctx.sessionManager.getBranch()), next), "info");
}

async function promptSummarizerModel(ctx: ExtensionContext, config: YukiCompactionConfig, currentModel: string | undefined) {
	const options = ["Auto (Gemini Flash, then current model)"];
	if (currentModel) options.push(`Current model (${currentModel})`);
	options.push("Custom provider/model", "Cancel");
	const selected = await ctx.ui.select("Yuki Compaction Summarizer", options);
	if (!selected || selected === "Cancel") return undefined;
	if (selected.startsWith("Auto")) return { ...config, summarizerModel: undefined };
	if (selected.startsWith("Current") && currentModel) return { ...config, summarizerModel: currentModel };
	const value = await ctx.ui.input("Custom summarizer model", "provider/model");
	if (!value) return undefined;
	return setConfigValue(config, "model", value.trim());
}

async function promptNumericSetting(ctx: ExtensionContext, config: YukiCompactionConfig, key: string, current: string) {
	const value = await ctx.ui.input(`Yuki compaction: ${key}`, current);
	if (!value) return undefined;
	return setConfigValue(config, key, value.trim());
}

function persistConfig(pi: ExtensionAPI, config: YukiCompactionConfig) {
	const updatedAt = new Date().toISOString();
	const next = normalizeConfig({ ...config, updatedAt });
	pi.appendEntry(COMPACTION_STATE_CUSTOM_TYPE, { version: 1, kind: "config", createdAt: updatedAt, config: next } satisfies YukiCompactionConfigRecord);
}

function getCurrentModelSetting(ctx: ExtensionContext) {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	if (!model?.provider || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}

function setConfigValue(config: YukiCompactionConfig, key: string, value: string | undefined): YukiCompactionConfig | undefined {
	const normalized = key.replace(/^--/, "").toLowerCase();
	const numeric = value ? Number(value) : NaN;
	switch (normalized) {
		case "trigger":
		case "trigger-ratio":
			if (!Number.isFinite(numeric)) return undefined;
			return { ...config, triggerRatio: clampNumber(numeric, 0.1, 0.98, config.triggerRatio) };
		case "target":
		case "target-free":
		case "target-free-ratio":
			if (!Number.isFinite(numeric)) return undefined;
			return { ...config, targetFreeRatio: clampNumber(numeric, 0.1, 0.9, config.targetFreeRatio) };
		case "min-interval":
		case "min-interval-ms":
			if (!Number.isFinite(numeric)) return undefined;
			return { ...config, minCompactIntervalMs: Math.floor(clampNumber(numeric, 0, 3_600_000, config.minCompactIntervalMs)) };
		case "archive":
		case "archive-chars":
		case "prestore":
		case "prestore-chars":
			if (!Number.isFinite(numeric)) return undefined;
			return { ...config, preStoreArchiveChars: Math.floor(clampNumber(numeric, 1_000, 1_000_000, config.preStoreArchiveChars)) };
		case "runtime":
		case "runtime-chars":
			if (!Number.isFinite(numeric)) return undefined;
			return { ...config, runtimeToolTextChars: Math.floor(clampNumber(numeric, 1_000, 1_000_000, config.runtimeToolTextChars)) };
		case "cache-summary":
		case "cache-aware-summary":
			if (value === "on" || value === "true") return { ...config, cacheAwareSummary: true };
			if (value === "off" || value === "false") return { ...config, cacheAwareSummary: false };
			return undefined;
		case "economic":
		case "economic-gate":
		case "dp":
			if (value === "on" || value === "true") return { ...config, economicGate: true };
			if (value === "off" || value === "false") return { ...config, economicGate: false };
			return undefined;
		case "force":
		case "force-ratio":
			if (!Number.isFinite(numeric)) return undefined;
			return { ...config, forceRatio: clampNumber(numeric, 0.5, 0.99, config.forceRatio) };
		case "turns":
		case "expected-turns":
			if (!Number.isFinite(numeric)) return undefined;
			return { ...config, expectedTurns: Math.floor(clampNumber(numeric, 1, 1_000, config.expectedTurns)) };
		case "price-input":
			if (!Number.isFinite(numeric)) return undefined;
			return { ...config, priceInputPerM: clampNumber(numeric, 0, 1_000, config.priceInputPerM) };
		case "price-cache":
			if (!Number.isFinite(numeric)) return undefined;
			return { ...config, priceCachePerM: clampNumber(numeric, 0, 1_000, config.priceCachePerM) };
		case "price-output":
			if (!Number.isFinite(numeric)) return undefined;
			return { ...config, priceOutputPerM: clampNumber(numeric, 0, 1_000, config.priceOutputPerM) };
		case "model":
		case "summarizer-model":
			if (!value || value === "auto") return { ...config, summarizerModel: undefined };
			if (!value.includes("/")) return undefined;
			return { ...config, summarizerModel: value };
		default:
			return undefined;
	}
}

function formatConfigStatus(ctx: ExtensionContext, state: YukiCompactionState, config: YukiCompactionConfig) {
	const usage = ctx.getContextUsage();
	const lines = [
		`Yuki compaction: ${config.enabled ? "on (/compact overridden)" : "off (/compact uses Pi default)"}, proactive=${config.proactive ? "on" : "off"}`,
		`model=${config.summarizerModel ?? "auto (gemini-2.5-flash, then current model)"}`,
		`trigger=${config.triggerRatio}, targetFree=${config.targetFreeRatio}, minIntervalMs=${config.minCompactIntervalMs}`,
		`archiveChars=${config.preStoreArchiveChars}, runtimeChars=${config.runtimeToolTextChars}`,
		`cacheAwareSummary=${config.cacheAwareSummary ? "on" : "off"}, economicGate=${config.economicGate ? "on" : "off"}, forceRatio=${config.forceRatio}`,
		`economics: prices(in/cache/out)=${config.priceInputPerM}/${config.priceCachePerM}/${config.priceOutputPerM} $/MTok, expectedTurns=${config.expectedTurns}`,
		`state: gen=${state.generation}, epoch=${state.epoch}, decisions=${state.decisions.length}, constraints=${state.constraints.length}`,
		`usage=${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"}`,
	];
	if (config.economicGate && usage?.tokens && usage.contextWindow) {
		const maxOutputTokens = ctx.model?.maxTokens ?? 16_384;
		const e = evaluateCompactionEconomics(usage.tokens, usage.contextWindow, maxOutputTokens, config);
		lines.push(
			`dp-eval: freed≈${Math.round(e.freedTokens)} tok, futureSavings=$${e.futureSavings.toFixed(4)}, cacheReset=$${e.cacheInvalidation.toFixed(4)}, summaryCost=$${e.summaryCost.toFixed(4)} → net=$${e.netBenefit.toFixed(4)} (${e.netBenefit > 0 ? "compact" : "wait"})`,
		);
	}
	return lines.join("\n");
}

function findConfiguredModel(ctx: ExtensionContext, setting: string | undefined) {
	if (!setting || setting === "auto") return undefined;
	const slash = setting.indexOf("/");
	if (slash <= 0 || slash >= setting.length - 1) return undefined;
	return ctx.modelRegistry.find(setting.slice(0, slash), setting.slice(slash + 1));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
	const num = Number(value);
	if (!Number.isFinite(num)) return fallback;
	return Math.min(max, Math.max(min, num));
}

function dedupeByText<T extends { id: string; text: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const item of items) {
		const key = item.text.toLowerCase().replace(/\s+/g, " ").trim();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(item);
	}
	return result;
}

function stableId(text: string) {
	return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function safeFilePart(text: string) {
	return text.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "tool-result";
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return (
			error.name === "AbortError" ||
			error.message === "aborted" ||
			error.message.toLowerCase().includes("abort")
		);
	}
	return String(error).toLowerCase().includes("abort");
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted ?? false;
}
