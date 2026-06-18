import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { asObject, type JsonObject, type Preferences } from "./domain.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");

/** File holding opencode-go scraping credentials (workspace id + auth cookie). */
export const CREDENTIALS_FILE = path.join(agentDir, "opencode-go-credentials.json");

/** Settings key for display preferences, stored alongside other pi settings. */
export const SETTINGS_KEY = "pi-opencode-go-usage";
export const SETTINGS_FILE = path.join(agentDir, "settings.json");

export type Credentials = {
	workspaceId: string;
	authCookie: string;
};

export async function readJsonObject(file: string): Promise<JsonObject> {
	try {
		return asObject(JSON.parse(await fs.readFile(file, "utf8"))) ?? {};
	} catch (error) {
		if (asObject(error)?.code === "ENOENT") return {};
		throw error;
	}
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function asTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve opencode-go scraping credentials.
 *
 * Precedence: environment variables > credentials file. The cookie is a
 * browser session cookie (`Fe26.2**...`) that expires periodically; when it
 * does, refresh it and overwrite the file.
 */
export async function loadCredentials(): Promise<Credentials> {
	const envWorkspace = asTrimmedString(process.env.OPENCODE_GO_WORKSPACE_ID);
	const envCookie = asTrimmedString(process.env.OPENCODE_GO_AUTH_COOKIE);
	if (envWorkspace && envCookie) return { workspaceId: envWorkspace, authCookie: envCookie };

	const file = await readJsonObject(CREDENTIALS_FILE);
	const workspaceId = asTrimmedString(file.workspaceId);
	const authCookie = asTrimmedString(file.authCookie);
	if (workspaceId && authCookie) return { workspaceId, authCookie };

	throw new Error(
		`Missing opencode-go credentials. Set OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE env vars, or write { "workspaceId": "wrk_...", "authCookie": "Fe26.2**..." } to ${CREDENTIALS_FILE}`,
	);
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
	await writeJson(CREDENTIALS_FILE, credentials);
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
	return typeof value === "string" && (choices as readonly string[]).includes(value);
}

export function normalizePreferences(value: unknown, defaults: Preferences): Preferences {
	const settings = asObject(value);
	return {
		usageMode: isOneOf(settings?.usageMode, ["left", "used"] as const) ? settings.usageMode : defaults.usageMode,
		refreshWindow: isOneOf(settings?.refreshWindow, ["rolling", "weekly", "monthly"] as const)
			? settings.refreshWindow
			: defaults.refreshWindow,
	};
}

export async function loadPreferences(defaults: Preferences): Promise<Preferences> {
	const settings = await readJsonObject(SETTINGS_FILE);
	const preferences = normalizePreferences(settings[SETTINGS_KEY], defaults);
	const persisted = asObject(settings[SETTINGS_KEY]);
	if (
		!persisted ||
		persisted.usageMode !== preferences.usageMode ||
		persisted.refreshWindow !== preferences.refreshWindow
	) {
		settings[SETTINGS_KEY] = preferences;
		await writeJson(SETTINGS_FILE, settings);
	}
	return preferences;
}

export async function savePreferences(preferences: Preferences): Promise<void> {
	const settings = await readJsonObject(SETTINGS_FILE);
	settings[SETTINGS_KEY] = preferences;
	await writeJson(SETTINGS_FILE, settings);
}
