export const preferenceCommands = [
	{
		name: "opencode-go-usage-mode",
		description: "Toggle opencode-go usage display mode, or set it explicitly: left | used",
		key: "usageMode",
		choices: ["left", "used"],
	},
	{
		name: "opencode-go-usage-reset-window",
		description: "Toggle reset countdown window, or set it explicitly: rolling | weekly | monthly",
		key: "refreshWindow",
		choices: ["rolling", "weekly", "monthly"],
	},
] as const;

export type PreferenceCommand = (typeof preferenceCommands)[number];

export function parseChoice<T extends string>(args: string, choices: readonly T[], current: T): T | null {
	const token = args.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
	if (!token || token === "toggle") return choices[(choices.indexOf(current) + 1) % choices.length] ?? current;
	return (choices as readonly string[]).includes(token) ? (token as T) : null;
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
