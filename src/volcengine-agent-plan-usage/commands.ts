export const preferenceCommands = [
	{
		name: "volcengine-agent-plan-usage-reset-window",
		description: "Toggle Volcengine Agent Plan reset countdown window, or set it explicitly: 5h | daily | weekly | monthly",
		key: "refreshWindow",
		choices: ["5h", "daily", "weekly", "monthly"],
	},
] as const;

export type PreferenceCommand = typeof preferenceCommands[number];

export function parseChoice<T extends string>(args: string, choices: readonly T[], current: T): T | null {
	const token = args.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
	if (!token || token === "toggle") return choices[(choices.indexOf(current) + 1) % choices.length] ?? current;
	return (choices as readonly string[]).includes(token) ? token as T : null;
}

export function completions(choices: readonly string[], prefix: string) {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const items = [...choices, "toggle"].map(value => ({
		value,
		label: value,
		description: value === "toggle" ? "Toggle current value" : `Set to ${value}`,
	}));
	const matches = normalizedPrefix ? items.filter(item => item.value.startsWith(normalizedPrefix)) : items;
	return matches.length ? matches : null;
}
