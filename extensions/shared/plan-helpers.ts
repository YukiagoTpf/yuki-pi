/**
 * Pure, dependency-free helpers for the plan-flow extension.
 *
 * Kept here (rather than inline in plan-flow/index.ts) so they can be unit
 * tested without importing the extension, which pulls in the Pi runtime.
 */

/** Slugify a title into a filesystem- and id-safe segment. */
export function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 60);
	return slug || "plan";
}

/**
 * Whether a grilling answer counts as a concrete, executable decision.
 *
 * Rejects explicit non-answers regardless of length; a short but concrete
 * answer ("no", "v2", "用 A") is a valid decision and must count as resolved.
 */
export function isExecutableResolution(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return false;
	// Require at least one letter/number/ideograph so punctuation-only
	// "answers" (e.g. "。", "？？") aren't recorded as decisions.
	if (!/[\p{L}\p{N}]/u.test(normalized)) return false;
	if (/^(随便|都行|看情况|之后再说|到时候再说|无所谓|不知道|不清楚|不确定|whatever|up to you|later|tbd|idk|dunno)$/.test(normalized)) {
		return false;
	}
	return true;
}

export interface ParsedPlanCommand {
	request: string;
	contextToken?: string;
	help: boolean;
	unknownFlags: string[];
}

/** Parse `/plan [--context <token>] <request>`.
 *
 * The `--context` token references a one-shot handoff file (consumed by the /plan
 * command handler) carrying structured planning constraints, so callers like /ta-dev
 * do not have to serialize those constraints into the visible /plan prompt text.
 * Everything else forms the request string. Quoted segments are preserved. */
export function parsePlanCommandArgs(raw: string): ParsedPlanCommand {
	const tokens = tokenizePlanArgs(raw);
	let contextToken: string | undefined;
	const requestParts: string[] = [];
	const unknownFlags: string[] = [];
	let help = false;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--help" || token === "-h") {
			help = true;
			continue;
		}
		if (token === "--context") {
			const next = tokens[i + 1];
			if (!next || next.startsWith("--")) {
				unknownFlags.push("--context (missing token)");
			} else {
				contextToken = next;
				i += 1;
			}
			continue;
		}
		if (token.startsWith("--")) {
			unknownFlags.push(token);
			continue;
		}
		requestParts.push(token);
	}
	return { request: requestParts.join(" ").trim(), contextToken, help, unknownFlags };
}

/** Quote-aware whitespace tokenizer for /plan argument parsing. */
export function tokenizePlanArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}
