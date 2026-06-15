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
