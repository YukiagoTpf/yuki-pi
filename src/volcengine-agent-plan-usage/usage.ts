import { createHash, createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	asObject,
	finiteNumber,
	windowNames,
	windows,
	type JsonObject,
	type UsageSnapshot,
	type UsageWindow,
	type WindowName,
} from "./domain.ts";

const ACTION = "GetAFPUsage";
const API_VERSION = "2024-01-01";
/**
 * GetAFPUsage is a control-plane OpenAPI. It must hit the Volcengine global
 * OpenAPI gateway (open.volcengineapi.com), NOT the ark inference host
 * (ark.cn-beijing.volces.com), which only serves chat/completions and rejects
 * HMAC-SHA256 signed requests with 401.
 */
const CONTROL_PLANE_HOST = "open.volcengineapi.com";
const CONTROL_PLANE_ENDPOINT = `https://${CONTROL_PLANE_HOST}/?Action=${ACTION}&Version=${API_VERSION}`;
const SERVICE = "ark";
const DEFAULT_REGION = "cn-beijing";
const USER_AGENT = "yuki-pi-volcengine-agent-plan-usage/0.1";
const VOLC_CONFIG_FILE = path.join(os.homedir(), ".volc", "config");

export const MISSING_AUTH_ERROR = "Missing Volcengine Agent Plan AK/SK (control-plane GetAFPUsage requires AK/SK signing, not a Bearer Ark API key)";

type AkskCredentials = {
	accessKeyId: string;
	secretKey: string;
	sessionToken?: string;
};

/**
 * GetAFPUsage always targets the global OpenAPI gateway. The model's baseUrl
 * (an ark inference host) is intentionally ignored: that host does not serve
 * control-plane actions and rejects AK/SK-signed requests.
 */
function usageEndpoint(): URL {
	return new URL(CONTROL_PLANE_ENDPOINT);
}

function asTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function headerExists(headers: Record<string, string>, name: string): boolean {
	const normalized = name.toLowerCase();
	return Object.keys(headers).some(key => key.toLowerCase() === normalized);
}

async function readJsonObject(file: string): Promise<JsonObject> {
	try {
		return asObject(JSON.parse(await fs.readFile(file, "utf8"))) ?? {};
	} catch (error) {
		if (asObject(error)?.code === "ENOENT") return {};
		throw error;
	}
}

async function loadAkskCredentials(): Promise<AkskCredentials | null> {
	const envAccessKey = asTrimmedString(process.env.VOLC_ACCESSKEY)
		?? asTrimmedString(process.env.VOLC_ACCESS_KEY)
		?? asTrimmedString(process.env.VOLC_ACCESS_KEY_ID);
	const envSecretKey = asTrimmedString(process.env.VOLC_SECRETKEY)
		?? asTrimmedString(process.env.VOLC_SECRET_KEY)
		?? asTrimmedString(process.env.VOLC_SECRET_ACCESS_KEY);
	const envSessionToken = asTrimmedString(process.env.VOLC_SESSION_TOKEN)
		?? asTrimmedString(process.env.VOLC_SECURITY_TOKEN);
	if (envAccessKey && envSecretKey) return { accessKeyId: envAccessKey, secretKey: envSecretKey, sessionToken: envSessionToken };

	const config = await readJsonObject(VOLC_CONFIG_FILE);
	const accessKeyId = asTrimmedString(config.VOLC_ACCESSKEY)
		?? asTrimmedString(config.VOLC_ACCESS_KEY)
		?? asTrimmedString(config.VOLC_ACCESS_KEY_ID);
	const secretKey = asTrimmedString(config.VOLC_SECRETKEY)
		?? asTrimmedString(config.VOLC_SECRET_KEY)
		?? asTrimmedString(config.VOLC_SECRET_ACCESS_KEY);
	const sessionToken = asTrimmedString(config.VOLC_SESSION_TOKEN)
		?? asTrimmedString(config.VOLC_SECURITY_TOKEN);
	return accessKeyId && secretKey ? { accessKeyId, secretKey, sessionToken } : null;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
	return createHmac("sha256", key).update(value, "utf8").digest();
}

function formatXDate(date: Date): string {
	return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodeRfc3986(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQueryString(searchParams: URLSearchParams): string {
	return [...searchParams.entries()]
		.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
		.map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
		.join("&");
}

function regionFromHost(host: string): string {
	return /^ark\.([^.]+)\./.exec(host)?.[1] ?? process.env.VOLC_REGION?.trim() ?? DEFAULT_REGION;
}

function signedHeadersFor(url: URL, body: string, credentials: AkskCredentials): Record<string, string> {
	const payloadHash = sha256Hex(body);
	const xDate = formatXDate(new Date());
	const shortDate = xDate.slice(0, 8);
	const region = regionFromHost(url.hostname);
	const credentialScope = `${shortDate}/${region}/${SERVICE}/request`;
	const signedHeaderValues: Record<string, string> = {
		host: url.host,
		"x-content-sha256": payloadHash,
		"x-date": xDate,
	};
	if (credentials.sessionToken) signedHeaderValues["x-security-token"] = credentials.sessionToken;

	const signedHeaders = Object.keys(signedHeaderValues).sort().join(";");
	const canonicalHeaders = Object.entries(signedHeaderValues)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}:${value.trim()}\n`)
		.join("");
	const canonicalRequest = [
		"POST",
		url.pathname || "/",
		canonicalQueryString(url.searchParams),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");
	const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
	const kDate = hmacSha256(credentials.secretKey, shortDate);
	const kRegion = hmacSha256(kDate, region);
	const kService = hmacSha256(kRegion, SERVICE);
	const kSigning = hmacSha256(kService, "request");
	const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
	const authorization = `HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	return {
		Authorization: authorization,
		"X-Content-Sha256": payloadHash,
		"X-Date": xDate,
		...(credentials.sessionToken ? { "X-Security-Token": credentials.sessionToken } : {}),
	};
}

type AuthChoice = {
	headers: Record<string, string>;
	source: "api-key" | "aksk";
};

async function authHeaders(ctx: ExtensionContext, endpoint: URL, body: string): Promise<AuthChoice> {
	// GetAFPUsage is a Volcengine control-plane API on the global OpenAPI gateway,
	// which requires HMAC-SHA256 AK/SK signing and REJECTS Bearer Ark API keys
	// with 400 InvalidAuthorization. Prefer AK/SK first; fall back to the model's
	// configured API key only when no AK/SK is available (it will fail, but keeps
	// the error path informative for users who haven't set up AK/SK yet).
	const credentials = await loadAkskCredentials();
	if (credentials) return { headers: signedHeadersFor(endpoint, body, credentials), source: "aksk" };

	const model = ctx.model;
	if (!model) throw new Error(MISSING_AUTH_ERROR);
	const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (resolved.ok) {
		const headers = { ...(resolved.headers ?? {}) };
		const apiKey = asTrimmedString(resolved.apiKey);
		if (apiKey && !headerExists(headers, "authorization")) headers.Authorization = `Bearer ${apiKey}`;
		if (apiKey || headerExists(headers, "authorization")) return { headers, source: "api-key" };
	}

	const detail = resolved.ok ? "" : `: ${resolved.error}`;
	throw new Error(`${MISSING_AUTH_ERROR}${detail}`);
}

async function sendUsageRequest(endpoint: URL, body: string, auth: AuthChoice): Promise<Response> {
	const headers = {
		accept: "application/json",
		"content-type": "application/json; charset=UTF-8",
		"user-agent": USER_AGENT,
		...auth.headers,
	};
	return await fetch(endpoint, { method: "POST", headers, body });
}

async function requestUsage(ctx: ExtensionContext): Promise<unknown> {
	const endpoint = usageEndpoint();
	const body = "{}";
	const auth = await authHeaders(ctx, endpoint, body);
	const response = await sendUsageRequest(endpoint, body, auth);
	if (!response.ok) {
		const detail = await response.text().catch(() => response.statusText);
		const hint = response.status === 401 || response.status === 403
			? "; check the Agent Plan API key or VOLC_ACCESSKEY/VOLC_SECRETKEY credentials"
			: "";
		throw new Error(`Volcengine Agent Plan usage request failed (${response.status})${hint}: ${truncate(detail)}`);
	}
	return await response.json();
}

function truncate(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

function parseWindow(value: unknown): UsageWindow | null {
	const window = asObject(value);
	if (!window) return null;

	const parsed = {
		quota: finiteNumber(window.Quota),
		used: finiteNumber(window.Used),
		subscribeTime: finiteNumber(window.SubscribeTime),
		resetTime: finiteNumber(window.ResetTime),
	} satisfies UsageWindow;
	return Object.values(parsed).some(item => item !== null) ? parsed : null;
}

function isWindowLimited(window: UsageWindow | null): boolean {
	return !!window && window.quota !== null && window.used !== null && window.quota > 0 && window.used >= window.quota;
}

function emptyWindows(): Record<WindowName, UsageWindow | null> {
	return { "5h": null, daily: null, weekly: null, monthly: null };
}

export function parseUsageSnapshot(data: unknown): UsageSnapshot {
	const root = asObject(data);
	const result = asObject(root?.Result) ?? root;
	if (!result) throw new Error("Volcengine Agent Plan usage response missing Result");

	const parsedWindows = emptyWindows();
	for (const name of windowNames) parsedWindows[name] = parseWindow(result[windows[name].responseField]);
	if (!Object.values(parsedWindows).some(Boolean)) throw new Error("Volcengine Agent Plan usage response has no AFP usage windows");

	const planType = asTrimmedString(result.PlanType) ?? null;
	return {
		planType,
		windows: parsedWindows,
		isLimited: Object.values(parsedWindows).some(isWindowLimited),
	};
}

export async function getUsage(ctx: ExtensionContext): Promise<UsageSnapshot> {
	return parseUsageSnapshot(await requestUsage(ctx));
}
