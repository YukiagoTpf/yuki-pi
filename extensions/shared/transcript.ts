/**
 * Pure transcript/snapshot helpers shared by the recap and btw extensions.
 *
 * Previously duplicated verbatim in both extensions; centralised here so the
 * budget logic has a single tested implementation.
 */

/**
 * Select a tail of `items` that fits within `budget` characters (each item
 * costs its length + 2 for the joining separator), preserving the original
 * chronological order. Always keeps at least the most recent item even if it
 * alone exceeds the budget.
 */
export function takeTailWithinBudget(items: string[], budget: number): string {
	const selected: string[] = [];
	let used = 0;

	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		const cost = item.length + 2;
		if (selected.length > 0 && used + cost > budget) break;
		selected.unshift(item);
		used += cost;
	}

	return selected.join("\n\n");
}
