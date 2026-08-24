/**
 * dsh-quota-panel — provider quota card for the dsh web surface.
 *
 * Dual-face plugin:
 *
 *  - Host half (compiled from src/index.ts into lib/index.js; zero runtime
 *    dependencies — the schema library is vendored under src/vendor/):
 *    registers one loopback-only Connection RPC channel `/dsh-quota-panel`
 *    with two endpoints. API keys are resolved through `ctx.credentials`
 *    and never reach the browser; upstream quota endpoints are called host-side
 *    with `Authorization: Bearer <key>`, optionally through a configured
 *    HTTP proxy (CONNECT tunnel for https targets, absolute-URI forward for
 *    http targets).
 *      - `specs`     → provider row specs + default refreshMs (render hints)
 *      - `fetch-all` → per-provider normalized row view (or per-row error);
 *                       payload `{ proxy?: { [id]: url } }` overrides each
 *                       row's proxy from the browser settings panel
 *                       (validated http/https; wins over profile config)
 *
 *    v0.5: `fetch-all` no longer passes upstream JSON through — every known
 *    format is normalized host-side into one of three view models
 *    (`balance` / `usage` / `info`), so the browser half renders generic
 *    rows and upstream schema details stay host-side like the credentials.
 *
 *  - Built-in provider catalog + auto discovery: catalog entries name the
 *    standard credential references of well-known providers; entries whose
 *    key resolves through `ctx.credentials` appear automatically. Explicit
 *    `providers` config entries still work (same-id entries replace the
 *    catalog row wholesale) and gain formats the catalog cannot guess
 *    (`openai-billing` for one-api/new-api compatible aggregators).
 *
 *  - Client half (`lib/client.js`, served at /plugins/dsh-quota-panel/client.js
 *    through the `dsh.client` manifest): a `shell.overlay` slot entry that
 *    renders the collapsed capsule / expanded card / settings panel with
 *    React, talking to this half over `ctx.connection.rpc`.
 *
 * Providers are config-driven (validated by the exported `Config` schema,
 * so the profile patch may omit every defaulted field). Config keys:
 *
 *   refreshMs:  auto-refresh interval, default 60000 (>= 5000)
 *   auto:       probe the built-in catalog for configured keys, default true
 *   hide:       row ids to drop from the panel (catalog and explicit alike)
 *   proxies:    { <name>: "http://user:pass@host:port" } proxy definitions;
 *               HTTP/HTTPS proxies only (CONNECT tunnel for https targets)
 *   catalog:    { <catalog-id>: { label?, endpoint?, format?, proxy?, refs?,
 *               balanceTiers?, warnPercent?, errorPercent?, windowLabels? } }
 *               partial overrides applied to auto-discovered rows
 *   providers:  explicit rows; an entry whose id matches a catalog entry
 *               replaces it. Fields per entry:
 *
 *   id:          row key; ^[a-z0-9-]+$ (unique)
 *   label:       provider name, e.g. "DeepSeek"
 *   credential:  credential reference, e.g. "DEEPSEEK_API_KEY"
 *   endpoint:    quota/balance JSON endpoint (GET, Bearer auth), http(s) URL;
 *                for format "openai-billing" this is the aggregator base URL
 *   format:      row adapter, see FORMATS below, default "deepseek-balance"
 *   proxy:       name of an entry in `proxies`; omit for direct connection
 *   currency:    (balance kinds) currency symbol override, e.g. "$" for a
 *                format that defaults to ¥ (catalog rows set it per site:
 *                siliconflow = $, siliconflow-cn = ¥)
 *   balanceTiers: (balance kinds) { critical, warn, healthy }, defaults
 *                { 10, 20, 50 }; must satisfy critical <= warn <= healthy
 *   lowBalance:  legacy alias for balanceTiers.warn
 *   windowLabels: (opencode-usage) { rolling, weekly, monthly } labels,
 *                defaults { 滚, 周, 月 }
 *   warnPercent / errorPercent: (usage kinds) thresholds, defaults 70 / 90
 *
 * Schema library is vendored under src/vendor/ (schemastery 3.18.1 +
 * cosmokit, both MIT; zero further runtime dependencies) and imported by
 * relative path, so the package resolves with or without node_modules —
 * required because `dsh plugin add link:` installs resolve imports from the
 * repo's real path, which cannot walk up to dsh's bundled packages.
 */
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import z from './vendor/schemastery.mjs';

export const name = 'quota-panel';

export const inject = ['connection', 'credentials'];

/** Loopback-only Connection RPC channel this plugin owns. */
export const RPC_CHANNEL = '/dsh-quota-panel';

/** Upstream fetch timeout per provider row. */
const UPSTREAM_TIMEOUT_MS = 15000;

/** Upper bound on one upstream response body kept in memory (bytes). */
const MAX_BODY_BYTES = 1024 * 1024;

const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;
const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const HTTP_URL_PATTERN = /^https?:\/\//;

// ── Volcengine Ark (火山方舟) OpenAPI signing ───────────────
//
// Volcengine's OpenAPI (open.volcengineapi.com) authenticates with an
// AccessKey ID / SecretAccessKey pair using an AWS-SigV4-variant HMAC
// signature rather than a Bearer token. The two deltas from standard
// SigV4 that bite naive ports:
//   1. SignedHeaders use a FIXED order `host;x-date;x-content-sha256;
//      content-type` (NOT alphabetical);
//   2. Algorithm string is bare `HMAC-SHA256` (no `AWS4` prefix),
//      credential scope ends in `/request` (not `/aws4_request`), and
//      the first signing key is HMAC(SK, date) with the raw SK (no
//      `AWS4` prefix).
// Algorithm cross-checked against the official volc-openapi demos and
// the cc-switch implementation (src-tauri/src/services/coding_plan.rs).
const VOLCENGINE_HOST = 'open.volcengineapi.com';
const VOLCENGINE_SERVICE = 'ark';
const VOLCENGINE_VERSION = '2024-01-01';
const VOLCENGINE_CONTENT_TYPE = 'application/json; charset=utf-8';
const VOLCENGINE_SIGNED_HEADERS = 'host;x-date;x-content-sha256;content-type';

function volcHmac(key: Buffer, data: string): Buffer {
	return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function volcSha256Hex(data: string | Buffer): string {
	return crypto.createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 unreserved-only percent encoding over UTF-8 bytes (used for canonical query). */
function volcUriEncode(input: string): string {
	let out = '';
	for (const b of Buffer.from(input, 'utf8')) {
		if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e) {
			out += String.fromCharCode(b);
		} else {
			out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
		}
	}
	return out;
}

/** Canonical query string, sorted by key (the same string is used for signing and for the request URL). */
function volcCanonicalQuery(action: string, region: string): string {
	const pairs: Array<[string, string]> = [
		['Action', action],
		['Region', region],
		['Version', VOLCENGINE_VERSION]
	];
	pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return pairs.map(([k, v]) => `${volcUriEncode(k)}=${volcUriEncode(v)}`).join('&');
}

/** Build the signed headers for a Volcengine OpenAPI POST (empty body). */
function volcengineSignedHeaders(ak: string, sk: string, region: string, action: string, now: Date): Record<string, string> {
	const xDate = now.toISOString().replace(/[:-]/g, '').slice(0, 15) + 'Z';
	const shortDate = xDate.slice(0, 8);
	const body = '';
	const payloadHash = volcSha256Hex(body);
	const canonicalQuery = volcCanonicalQuery(action, region);
	// Canonical headers in fixed (non-alphabetical) order.
	const canonicalHeaders =
		`host:${VOLCENGINE_HOST}\n` +
		`x-date:${xDate}\n` +
		`x-content-sha256:${payloadHash}\n` +
		`content-type:${VOLCENGINE_CONTENT_TYPE}\n`;
	const canonicalRequest = [
		'POST',
		'/',
		canonicalQuery,
		canonicalHeaders,
		VOLCENGINE_SIGNED_HEADERS,
		payloadHash
	].join('\n');
	const credentialScope = `${shortDate}/${region}/${VOLCENGINE_SERVICE}/request`;
	const stringToSign = [
		'HMAC-SHA256',
		xDate,
		credentialScope,
		volcSha256Hex(canonicalRequest)
	].join('\n');
	const kDate = volcHmac(Buffer.from(sk, 'utf8'), shortDate);
	const kRegion = volcHmac(kDate, region);
	const kService = volcHmac(kRegion, VOLCENGINE_SERVICE);
	const kSigning = volcHmac(kService, 'request');
	const signature = volcHmac(kSigning, stringToSign).toString('hex');
	return {
		'Host': VOLCENGINE_HOST,
		'X-Date': xDate,
		'X-Content-Sha256': payloadHash,
		'Content-Type': VOLCENGINE_CONTENT_TYPE,
		'Authorization': `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${VOLCENGINE_SIGNED_HEADERS}, Signature=${signature}`
	};
}

// ── ChatGPT subscription (Codex OAuth) usage ────────────────
//
// ChatGPT Plus/Pro/Business plans have no public usage API, but the
// official open-source Codex CLI authenticates against an EXPERIMENTAL
// internal endpoint that returns the current plan's rate-limit windows:
//
//   GET https://chatgpt.com/backend-api/wham/usage
//   Authorization: Bearer <ChatGPT OAuth access_token>
//   ChatGPT-Account-Id: <account_id>
//
// Two login methods are supported (resolveChatGPTToken tries them in order):
//
//   1. DSH-managed device-code login (no Codex CLI needed): the plugin
//      runs the same OAuth 2.0 device-authorization flow Codex uses and
//      persists tokens to $DSH_HOME/dsh-quota-panel/chatgpt-auth.json.
//      The settings panel has a "Log in to ChatGPT" button that shows a
//      one-time code + verification URL; the host polls and exchanges
//      the authorization code (with PKCE) for tokens.
//
//   2. Codex CLI auth.json fallback: if the user has already logged in
//      via `codex login`, tokens are read from ~/.codex/auth.json (or
//      $CODEX_HOME/auth.json). This path never writes back to the file
//      (Codex CLI owns it); refreshed tokens stay in process memory.
//
// Either way, the access token is refreshed host-side via the standard
// OAuth token endpoint using the refresh_token; tokens never reach the
// browser (rowSpec only forwards display fields).
//
// This adapter is explicitly experimental: the endpoint/shape are not
// a public contract and may drift. Field names are verified against
// live responses (2026-08) and the openai/codex client.
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CHATGPT_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const CHATGPT_DEVICETOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const CHATGPT_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const CHATGPT_DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device';
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Directory containing the Codex auth.json; honors CODEX_HOME like the Codex CLI. */
function chatgptCodexHome(): string {
	const override = process.env.CODEX_HOME;
	return override && override.length > 0 ? override : path.join(os.homedir(), '.codex');
}
/** Absolute path to the Codex auth.json. Resolved lazily so tests can steer via CODEX_HOME. */
function chatgptAuthJsonPath(): string {
	return path.join(chatgptCodexHome(), 'auth.json');
}

/**
 * Directory for the DSH-managed ChatGPT token store. Honors DSH_HOME
 * (set by the harness), falling back to ~/.dsh. The file mode is
 * restricted to the current user where the platform supports it.
 */
function chatgptDshStoreDir(): string {
	const home = process.env.DSH_HOME;
	return home && home.length > 0 ? home : path.join(os.homedir(), '.dsh');
}
function chatgptDshStorePath(): string {
	return path.join(chatgptDshStoreDir(), 'dsh-quota-panel', 'chatgpt-auth.json');
}
/** Returns true when the Codex auth.json exists (distinct from DSH store). */
async function codexAuthFileExists(): Promise<boolean> {
	try {
		await fsp.access(chatgptAuthJsonPath());
		return true;
	} catch {
		return false;
	}
}

/** Returns true when either a DSH-managed token or the Codex auth file exists (row auto-discovery probe). */
async function chatgptAuthExists(): Promise<boolean> {
	const dsh = await readChatGPTDshStore();
	if (dsh) return true;
	try {
		await fsp.access(chatgptAuthJsonPath());
		return true;
	} catch {
		return false;
	}
}

interface ChatGPTTokenBundle {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	account_id?: string;
	plan_type?: string;
	/** epoch ms when the access token expires (if known). */
	expires_at_ms?: number;
}

/** In-memory token cache; refreshed on expiry or on auth failure. */
let chatgptTokenCache: { bundle: ChatGPTTokenBundle } | null = null;

async function readChatGPTAuthFile(): Promise<ChatGPTTokenBundle> {
	const authJson = chatgptAuthJsonPath();
	let raw: string;
	try {
		raw = await fsp.readFile(authJson, 'utf8');
	} catch (err) {
		throw new Error(`ChatGPT: cannot read ${authJson} (run "codex login" first): ${(err as Error).message}`);
	}
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`ChatGPT: ${authJson} is not valid JSON`);
	}
	const tokens = parsed?.tokens;
	if (!tokens || typeof tokens !== 'object' || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
		throw new Error(`ChatGPT: ${authJson} has no tokens.access_token (run "codex login")`);
	}
	let expires_at_ms: number | undefined;
	if (typeof tokens.expires_at === 'number' && Number.isFinite(tokens.expires_at) && tokens.expires_at > 0) {
		// Codex writes epoch seconds; tolerate ms.
		expires_at_ms = tokens.expires_at > 1e12 ? tokens.expires_at : tokens.expires_at * 1000;
	}
	return {
		access_token: tokens.access_token,
		refresh_token: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
		id_token: typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
		account_id: typeof tokens.account_id === 'string' ? tokens.account_id : undefined,
		expires_at_ms
	};
}

/**
 * Read the DSH-managed ChatGPT token store (written by the in-plugin
 * device-code login). Shape: { source:'dsh', account_id?, plan_type?,
 * tokens:{access_token,refresh_token,id_token,expires_at_ms} }.
 * Returns null (not throws) when absent/unreadable so the caller can
 * fall through to the Codex auth.json source.
 */
async function readChatGPTDshStore(): Promise<(ChatGPTTokenBundle & { source: 'dsh'; plan_type?: string }) | null> {
	const file = chatgptDshStorePath();
	let raw: string;
	try {
		raw = await fsp.readFile(file, 'utf8');
	} catch {
		return null;
	}
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const t = parsed?.tokens;
	if (!t || typeof t.access_token !== 'string' || t.access_token.length === 0) return null;
	return {
		source: 'dsh',
		access_token: t.access_token,
		refresh_token: typeof t.refresh_token === 'string' ? t.refresh_token : undefined,
		id_token: typeof t.id_token === 'string' ? t.id_token : undefined,
		account_id: typeof parsed.account_id === 'string' ? parsed.account_id : undefined,
		plan_type: typeof parsed.plan_type === 'string' ? parsed.plan_type : undefined,
		expires_at_ms: typeof t.expires_at_ms === 'number' ? t.expires_at_ms : undefined
	};
}

/** Atomically persist a token bundle to the DSH-managed store (0600 perms). */
async function writeChatGPTDshStore(bundle: ChatGPTTokenBundle & { plan_type?: string }): Promise<void> {
	const file = chatgptDshStorePath();
	await fsp.mkdir(path.dirname(file), { recursive: true });
	const payload = JSON.stringify({
		source: 'dsh',
		account_id: bundle.account_id,
		plan_type: bundle.plan_type,
		tokens: {
			access_token: bundle.access_token,
			refresh_token: bundle.refresh_token,
			id_token: bundle.id_token,
			expires_at_ms: bundle.expires_at_ms
		}
	}, null, 2);
	await fsp.writeFile(file, payload, { encoding: 'utf8', mode: 0o600 });
}

async function deleteChatGPTDshStore(): Promise<void> {
	try {
		await fsp.unlink(chatgptDshStorePath());
	} catch {
		// already absent
	}
	chatgptTokenCache = null;
}

/**
 * Call one Volcengine Ark OpenAPI action (POST with empty body, signed).
 * Volcengine returns business errors as 200 + ResponseMetadata.Error, so
 * those are surfaced as thrown errors with the upstream code.
 */
async function volcengineCall(action: string, region: string, ak: string, sk: string, timeoutMs: number): Promise<any> {
	const canonicalQuery = volcCanonicalQuery(action, region);
	const url = `https://${VOLCENGINE_HOST}/?${canonicalQuery}`;
	const headers = volcengineSignedHeaders(ak, sk, region, action, new Date());
	const res = await fetch(url, { method: 'POST', headers, body: '', signal: AbortSignal.timeout(timeoutMs) });
	// Same response-size ceiling as the streaming providers: buffer the raw
	// bytes first and refuse oversized bodies before parsing.
	const raw = await res.arrayBuffer();
	if (raw.byteLength > MAX_BODY_BYTES) throw new Error(`upstream body exceeds ${MAX_BODY_BYTES} bytes`);
	let body: any = null;
	try {
		body = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		body = null;
	}
	if (body === null) throw new Error(`HTTP ${res.status}: non-JSON response`);
	const err = body?.ResponseMetadata?.Error;
	if (err) {
		const code = err.Code || 'Unknown';
		const msg = err.Message || 'unknown error';
		throw new Error(`volcengine ${code}: ${msg}`);
	}
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return body;
}

/**
 * Extract a human-readable error string from an OAuth/API error body.
 * OpenAI's auth endpoints return a NESTED error object
 * ({error:{code,message,type}}) while the token endpoints use flat
 * OAuth2 fields (error/error_description) — handle both, never render a
 * raw object (which stringifies to "[object Object]").
 */
function chatgptErrorText(json: any, fallback: string): string {
	if (typeof json?.error_description === 'string' && json.error_description) return json.error_description;
	const err = json?.error;
	if (typeof err === 'string' && err) return err;
	if (err && typeof err === 'object') {
		const msg = typeof err.message === 'string' && err.message ? err.message : '';
		const code = typeof err.code === 'string' && err.code ? err.code : '';
		if (msg && code) return `${msg} (${code})`;
		if (msg) return msg;
		if (code) return code;
	}
	if (typeof json?.detail === 'string' && json.detail) return json.detail;
	return fallback;
}

/**
 * Exchange a refresh_token for a fresh access token at the OpenAI OAuth
 * endpoint. Form-urlencoded as required by the OAuth2 token endpoint.
 */
async function refreshChatGPTToken(refreshToken: string, timeoutMs: number, proxyUrl?: string): Promise<ChatGPTTokenBundle> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: CHATGPT_CLIENT_ID
	}).toString();
	const res = await getJson(CHATGPT_TOKEN_URL, {
		'Content-Type': 'application/x-www-form-urlencoded'
	}, proxyUrl, timeoutMs, 'POST', body);
	const json: any = await res.json().catch(() => null);
	if (!res.ok || json === null) {
		throw new Error(`ChatGPT token refresh failed: ${chatgptErrorText(json, `HTTP ${res.status}`)}`);
	}
	if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
		throw new Error('ChatGPT token refresh response missing access_token');
	}
	const expiresIn = Number(json.expires_in);
	return {
		access_token: json.access_token,
		refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : refreshToken,
		id_token: typeof json.id_token === 'string' ? json.id_token : undefined,
		expires_at_ms: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined
	};
}

/** PKCE verifier (high-entropy random string) and S256 challenge. */
function chatgptPkce(): { verifier: string; challenge: string } {
	const verifier = crypto.randomBytes(48).toString('base64url');
	const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

/**
 * In-flight device-code login. The host drives the OAuth device-authorization
 * flow: it requests a one-time user code, the UI shows it with the
 * verification URL, and the host polls until the user authorizes (or it
 * times out / is cancelled). `abort` is set when the user cancels so the
 * polling loop terminates and the next start can replace it.
 */
let chatgptLogin: {
	startedAt: number;
	verificationUrl: string;
	userCode: string;
	intervalMs: number;
	expiresAt: number;
	abort: boolean;
} | null = null;
/**
 * Terminal error of the last in-flight device login (timeout / denied /
 * expired), recorded instead of thrown: the poll promise is deliberately
 * fire-and-forget, and an unhandled rejection would kill the whole DSH
 * host process under Node's default --unhandled-rejections=throw.
 * Surfaced to the UI via chatgpt-auth-status and cleared on a new start.
 */
let chatgptLoginError: string | null = null;

/** Step 1: request a one-time code from the device-authorization endpoint. */
async function chatgptDeviceStart(timeoutMs: number, proxyUrl?: string): Promise<{ verificationUrl: string; userCode: string; intervalMs: number; expiresAt: number }> {
	const res = await getJson(CHATGPT_USERCODE_URL, {
		'Content-Type': 'application/json',
		'Accept': 'application/json'
	}, proxyUrl, timeoutMs, 'POST', JSON.stringify({ client_id: CHATGPT_CLIENT_ID }));
	const json: any = await res.json().catch(() => null);
	if (!res.ok || json === null) {
		throw new Error(`ChatGPT device code request failed: ${chatgptErrorText(json, `HTTP ${res.status}`)}`);
	}
	const userCode = json.user_code ?? json.usercode;
	const deviceAuthId = json.device_auth_id;
	if (typeof userCode !== 'string' || !userCode || typeof deviceAuthId !== 'string') {
		throw new Error('ChatGPT device code response missing user_code / device_auth_id');
	}
	const intervalSec = Number(json.interval);
	const intervalMs = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec * 1000 : 5000;
	// The one-time code expires in 15 minutes (per Codex's device flow).
	const expiresAt = Date.now() + 15 * 60 * 1000;
	chatgptLoginError = null;
	chatgptLogin = {
		startedAt: Date.now(),
		verificationUrl: CHATGPT_DEVICE_VERIFY_URL,
		userCode,
		intervalMs,
		expiresAt,
		abort: false
	};
	// Fire-and-forget: the poll records terminal failures in
	// chatgptLoginError (never throws into an unhandled rejection — that
	// would crash the host process); the catch is belt-and-braces.
	void chatgptDevicePoll(deviceAuthId, userCode, intervalMs, proxyUrl).catch((e) => {
		chatgptLoginError = String((e as Error)?.message || e);
	});
	return { verificationUrl: CHATGPT_DEVICE_VERIFY_URL, userCode, intervalMs, expiresAt };
}

/**
 * Step 2: poll the device token endpoint until the user authorizes. On
 * success the response carries an authorization_code plus PKCE codes; we
 * then exchange the code for tokens and persist them to the DSH store.
 * Errors (pending/denied/expired) are swallowed here and surfaced to the
 * UI via chatgptLoginStatus().
 */
async function chatgptDevicePoll(deviceAuthId: string, userCode: string, initialIntervalMs: number, proxyUrl?: string): Promise<void> {
	const deadline = Date.now() + 15 * 60 * 1000;
	let intervalMs = initialIntervalMs;
	let lastError: string | undefined;
	while (Date.now() < deadline) {
		if (chatgptLogin?.abort || chatgptLogin?.userCode !== userCode) return;
		await new Promise((r) => setTimeout(r, intervalMs));
		if (chatgptLogin?.abort || chatgptLogin?.userCode !== userCode) return;
		try {
			const res = await getJson(CHATGPT_DEVICETOKEN_URL, {
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			}, proxyUrl, UPSTREAM_TIMEOUT_MS, 'POST', JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }));
			const json: any = await res.json().catch(() => null);
			if (!json) continue;
			if (json.authorization_code) {
				const verifier = typeof json.code_verifier === 'string' && json.code_verifier
					? json.code_verifier
					: chatgptPkce().verifier;
				const tokens = await chatgptExchangeCode(String(json.authorization_code), verifier, UPSTREAM_TIMEOUT_MS, proxyUrl);
				await writeChatGPTDshStore(tokens);
				chatgptTokenCache = { bundle: tokens };
				chatgptLogin = null;
				chatgptLoginError = null;
				return;
			}
			// authorization_pending / slow_down / access_denied / expired_token
			lastError = json.error_description || json.error || lastError;
			if (json.error === 'access_denied' || json.error === 'expired_token') break;
			if (json.error === 'slow_down' && intervalMs < 15000) {
				intervalMs = Math.min(15000, intervalMs + 5000);
			}
		} catch (e) {
			lastError = String((e as Error)?.message || e);
		}
	}
	chatgptLogin = null;
	// Record (do NOT throw): nothing awaits this promise, and an unhandled
	// rejection crashes the DSH host process (Node's default policy).
	chatgptLoginError = lastError ? `ChatGPT login failed: ${lastError}` : 'ChatGPT login timed out';
}

/** Step 3: exchange an authorization_code (with PKCE) for a token bundle. */
async function chatgptExchangeCode(code: string, codeVerifier: string, timeoutMs = UPSTREAM_TIMEOUT_MS, proxyUrl?: string): Promise<ChatGPTTokenBundle> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: CHATGPT_DEVICE_REDIRECT_URI,
		client_id: CHATGPT_CLIENT_ID,
		code_verifier: codeVerifier
	}).toString();
	const res = await getJson(CHATGPT_TOKEN_URL, {
		'Content-Type': 'application/x-www-form-urlencoded'
	}, proxyUrl, timeoutMs, 'POST', body);
	const json: any = await res.json().catch(() => null);
	if (!res.ok || json === null) {
		throw new Error(`ChatGPT token exchange failed: ${chatgptErrorText(json, `HTTP ${res.status}`)}`);
	}
	if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
		throw new Error('ChatGPT token exchange response missing access_token');
	}
	const expiresIn = Number(json.expires_in);
	let account_id: string | undefined;
	let plan_type: string | undefined;
	if (typeof json.id_token === 'string') {
		const claims = chatgptDecodeIdToken(json.id_token);
		account_id = claims.account_id;
		plan_type = claims.plan_type;
	}
	return {
		access_token: json.access_token,
		refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
		id_token: typeof json.id_token === 'string' ? json.id_token : undefined,
		account_id,
		plan_type,
		expires_at_ms: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined
	} as ChatGPTTokenBundle;
}

/** Decode (without verifying) the id_token JWT payload for account/plan hints. */
function chatgptDecodeIdToken(idToken: string): { account_id?: string; plan_type?: string } {
	try {
		const part = idToken.split('.')[1];
		if (!part) return {};
		const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
		const ns = json?.['https://api.openai.com/auth'];
		return {
			account_id: typeof json?.account_id === 'string' ? json.account_id : (typeof ns?.user_id === 'string' ? ns.user_id : undefined),
			plan_type: typeof json?.plan_type === 'string' ? json.plan_type : (typeof ns?.plan_type === 'string' ? ns.plan_type : undefined)
		};
	} catch {
		return {};
	}
}

/** Snapshot of the current in-flight login for the settings UI to render. */
function chatgptLoginStatus(): { active: boolean; verificationUrl?: string; userCode?: string; expiresAt?: number; error?: string | null } {
	if (!chatgptLogin || chatgptLogin.abort) return { active: false, error: chatgptLoginError };
	return {
		active: true,
		verificationUrl: chatgptLogin.verificationUrl,
		userCode: chatgptLogin.userCode,
		expiresAt: chatgptLogin.expiresAt
	};
}

/**
 * Resolve a usable access token. Order:
 *   1. in-memory cache while fresh
 *   2. DSH-managed store (device-code login) — refreshed and written back
 *   3. ~/.codex/auth.json (Codex CLI login) — refreshed in memory only
 */
async function resolveChatGPTToken(timeoutMs: number, proxyUrl?: string): Promise<{ accessToken: string; accountId?: string }> {
	const now = Date.now();
	const cached = chatgptTokenCache?.bundle;
	if (cached && cached.access_token && (!cached.expires_at_ms || cached.expires_at_ms - now > 30_000)) {
		return { accessToken: cached.access_token, accountId: cached.account_id };
	}
	// Source 1: DSH-managed device login (preferred).
	const dsh = await readChatGPTDshStore();
	if (dsh && dsh.access_token) {
		if (!dsh.expires_at_ms || dsh.expires_at_ms - now > 30_000) {
			chatgptTokenCache = { bundle: dsh };
			return { accessToken: dsh.access_token, accountId: dsh.account_id };
		}
		if (dsh.refresh_token) {
			const refreshed = await refreshChatGPTToken(dsh.refresh_token, timeoutMs, proxyUrl);
			if (!refreshed.account_id) refreshed.account_id = dsh.account_id;
			await writeChatGPTDshStore(refreshed).catch(() => {});
			chatgptTokenCache = { bundle: refreshed };
			return { accessToken: refreshed.access_token, accountId: refreshed.account_id };
		}
	}
	// Source 2: Codex CLI auth.json fallback.
	const fromDisk = await readChatGPTAuthFile();
	if (!fromDisk.expires_at_ms || fromDisk.expires_at_ms - now > 30_000) {
		chatgptTokenCache = { bundle: fromDisk };
		return { accessToken: fromDisk.access_token, accountId: fromDisk.account_id };
	}
	if (!fromDisk.refresh_token) {
		throw new Error('ChatGPT: access token expired and no refresh_token — log in again');
	}
	const refreshed = await refreshChatGPTToken(fromDisk.refresh_token, timeoutMs, proxyUrl);
	if (!refreshed.account_id) refreshed.account_id = fromDisk.account_id;
	chatgptTokenCache = { bundle: refreshed };
	return { accessToken: refreshed.access_token, accountId: refreshed.account_id };
}

/**
 * Call the experimental ChatGPT usage endpoint. On a 401 the caller may
 * retry once after forcing a token refresh.
 */
async function fetchChatGPTUsage(accessToken: string, accountId: string | undefined, timeoutMs: number, proxyUrl?: string): Promise<any> {
	const headers: Record<string, string> = {
		'Authorization': `Bearer ${accessToken}`,
		'Accept': 'application/json'
	};
	if (accountId) headers['ChatGPT-Account-Id'] = accountId;
	const res = await getJson(CHATGPT_USAGE_URL, headers, proxyUrl, timeoutMs);
	const body: any = await res.json().catch(() => null);
	if (res.status === 401) {
		const err: any = new Error('ChatGPT: access token rejected (401)');
		err.code = 'chatgpt-auth';
		throw err;
	}
	if (body === null) throw new Error(`ChatGPT: HTTP ${res.status} non-JSON response`);
	if (!res.ok) throw new Error(`ChatGPT: HTTP ${res.status}: ${body?.detail || body?.error || 'unknown error'}`);
	return body;
}

/**
 * Normalize a wham/usage response into the plugin's usage view.
 * primary_window is the weekly allowance; secondary_window (Pro plans)
 * is the shorter 5h window. We surface primary as `weekly` and, when
 * present, secondary as `rolling`, matching the coding-plan convention.
 */
function parseChatGPTUsage(body: any): { kind: 'usage'; windows: Record<string, any>; title: string } | null {
	const rl = body?.rate_limit;
	if (!rl || typeof rl !== 'object') return null;
	const toIso = (epochSec: unknown) => {
		const n = Number(epochSec);
		if (!Number.isFinite(n) || n <= 0) return undefined;
		return new Date(n > 1e12 ? n : n * 1000).toISOString();
	};
	const mapWindow = (w: any) => {
		if (!w || typeof w !== 'object') return null;
		const pct = Number(w.used_percent);
		if (!Number.isFinite(pct)) return null;
		return {
			percent: Math.min(100, Math.max(0, Math.round(pct))),
			resetsAt: toIso(w.reset_at)
		};
	};
	const windows: Record<string, any> = {};
	const primary = mapWindow(rl.primary_window);
	if (primary) windows.weekly = primary;
	const secondary = mapWindow(rl.secondary_window);
	if (secondary) windows.rolling = secondary;
	if (Object.keys(windows).length === 0) return null;
	const plan = typeof body?.plan_type === 'string' && body.plan_type ? body.plan_type : 'subscription';
	const titleParts = [
		`plan: ${plan}`,
		windows.rolling ? `5h: ${windows.rolling.percent}%` : null,
		windows.weekly ? `weekly: ${windows.weekly.percent}%` : null
	].filter(Boolean);
	return { kind: 'usage', windows, title: titleParts.join('\n') };
}

/**
 * Normalized row views an adapter may produce. The browser half renders
 * these generically; upstream response schema details never leave the host.
 * @typedef {object} RowView
 * @property {'balance'} kind - monetary balance row
 * @property {number} amount - remaining balance in the row's currency
 * @property {'usage'} [kind] - usage-percentage row
 * @property {object} [windows] - { rolling, weekly, monthly } each
 *           { percent: number, resetsAt?: string }
 * @property {'info'} [kind] - plain text row (providers without a balance API)
 * @property {string} [text] - info row content
 * @property {string} [title] - hover text, newlines allowed
 */

/** View kind and currency each adapter's rows render as. */
const FORMAT_META = {
	'deepseek-balance': { kind: 'balance', currency: '¥' },
	'openrouter-credits': { kind: 'balance', currency: '$' },
	'siliconflow-balance': { kind: 'balance', currency: '¥' },
	'moonshot-balance': { kind: 'balance', currency: '¥' },
	'minimax-remains': { kind: 'usage' },
	'stepfun-accounts': { kind: 'balance', currency: '¥' },
	'xai-credits': { kind: 'balance', currency: '$' },
	'openai-billing': { kind: 'balance', currency: '$' },
	'zhipu-quota': { kind: 'info' },
	'opencode-usage': { kind: 'usage' },
	'zai-coding-quota': { kind: 'usage' },
	'kimi-coding-usage': { kind: 'usage' },
	'volcengine-usage': { kind: 'usage' },
	'chatgpt-subscription': { kind: 'usage' }
};

/**
 * Built-in provider catalog probed by auto discovery. `refs` lists the
 * credential references tried in order; the first one that resolves wins.
 * Endpoints verified against provider docs (see README "内置供应商目录").
 */
const CATALOG = [
	{ id: 'deepseek', label: 'DeepSeek', refs: ['DEEPSEEK_API_KEY'], endpoint: 'https://api.deepseek.com/user/balance', format: 'deepseek-balance' },
	{ id: 'openrouter', label: 'OpenRouter', refs: ['OPENROUTER_API_KEY'], endpoint: 'https://openrouter.ai/api/v1/credits', format: 'openrouter-credits' },
	{ id: 'siliconflow', label: 'SiliconFlow', refs: ['SILICONFLOW_API_KEY'], endpoint: 'https://api.siliconflow.com/v1/user/info', format: 'siliconflow-balance', currency: '$' },
	{ id: 'siliconflow-cn', label: 'SiliconFlow CN', refs: ['SILICONFLOW_CN_API_KEY'], endpoint: 'https://api.siliconflow.cn/v1/user/info', format: 'siliconflow-balance' },
	{ id: 'moonshot', label: 'Moonshot', refs: ['MOONSHOT_API_KEY'], endpoint: 'https://api.moonshot.cn/v1/users/me/balance', format: 'moonshot-balance' },
	{ id: 'minimax', label: 'MiniMax Coding', refs: ['MINIMAX_API_KEY'], endpoint: 'https://www.minimax.io/v1/token_plan/remains', format: 'minimax-remains', windowLabels: { rolling: '5h' } },
	{ id: 'minimax-cn', label: 'MiniMax Coding CN', refs: ['MINIMAX_CN_API_KEY'], endpoint: 'https://api.minimaxi.com/v1/token_plan/remains', format: 'minimax-remains', windowLabels: { rolling: '5h' } },
	{ id: 'stepfun', label: 'StepFun', refs: ['STEP_API_KEY', 'STEPFUN_API_KEY'], endpoint: 'https://api.stepfun.com/v1/accounts', format: 'stepfun-accounts' },
	{ id: 'xai', label: 'xAI', refs: ['XAI_API_KEY'], endpoint: 'https://api.x.ai/v1/billing/credits', format: 'xai-credits' },
	{ id: 'zhipu', label: 'ZhiPu GLM', refs: ['ZHIPU_API_KEY', 'GLM_API_KEY'], endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', format: 'zhipu-quota' },
	{ id: 'zai-coding-cn', label: 'ZhiPu GLM Coding', refs: ['ZAI_CODING_CN_API_KEY'], endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', format: 'zai-coding-quota', windowLabels: { rolling: '5h', weekly: '周', monthly: '月' } },
	{ id: 'zai', label: 'Z.AI GLM Coding', refs: ['ZAI_API_KEY'], endpoint: 'https://api.z.ai/api/monitor/usage/quota/limit', format: 'zai-coding-quota', windowLabels: { rolling: '5h', weekly: '周', monthly: '月' } },
	{ id: 'kimi-coding', label: 'Kimi Coding', refs: ['KIMI_API_KEY'], endpoint: 'https://api.kimi.com/coding/v1/usages', format: 'kimi-coding-usage', windowLabels: { rolling: '5h', weekly: '周' } },
	{ id: 'opencode-go', label: 'OpenCode Go', refs: ['OPENCODE_GO_API_KEY'], endpoint: 'https://opencode.ai/zen/go/v1/usage', format: 'opencode-usage' },
	// Volcengine Ark (火山方舟): Agent Plan + Coding Plan usage via the
	// OpenAPI control plane. Unlike every other catalog row this one
	// authenticates with an AK/SK pair (signed, not Bearer) —
	// `secretRefs` is the second credential and fetchRow signs the request.
	{ id: 'volcengine', label: 'Volcengine Ark', refs: ['VOLC_ACCESS_KEY'], secretRefs: ['VOLC_SECRET_KEY'], endpoint: 'https://open.volcengineapi.com', format: 'volcengine-usage', windowLabels: { rolling: '5h', weekly: '周', monthly: '月' } },
	// ChatGPT subscription (Plus/Pro/Business via Codex OAuth). Unlike every
	// other row this does NOT use ctx.credentials: tokens are read from
	// ~/.codex/auth.json (written by `codex login`) and refreshed host-side.
	// `localAuth: 'codex'` makes resolveRows skip credential probing and always
	// surface the row (the row errors at fetch time if auth.json is missing).
	{ id: 'chatgpt', label: 'ChatGPT', localAuth: 'codex', endpoint: CHATGPT_USAGE_URL, format: 'chatgpt-subscription', windowLabels: { rolling: '5h', weekly: '周' } }
];

/** Keys a `catalog` override may set on an auto-discovered row. */
const CATALOG_OVERRIDE_KEYS = ['label', 'endpoint', 'format', 'proxy', 'refs', 'secretRefs', 'currency', 'balanceTiers', 'warnPercent', 'errorPercent', 'windowLabels', 'localAuth'];

/**
 * Format adapters: upstream JSON → RowView. Each returns a view or throws
 * with a message prefixed by the format id; callers capture per row.
 * @type {Record<string, (body: any) => RowView>}
 */
const FORMATS = {
	'deepseek-balance': (body) => {
		const info = body?.balance_infos?.[0];
		const amount = Number(info?.total_balance);
		if (!Number.isFinite(amount)) throw new Error('missing balance_infos[0].total_balance');
		return { kind: 'balance', amount, title: `currency: ${info.currency}\ngranted: ¥${info.granted_balance}\ntopped-up: ¥${info.topped_up_balance}` };
	},
	'openrouter-credits': (body) => {
		const credits = Number(body?.data?.total_credits);
		const usage = Number(body?.data?.total_usage);
		if (!Number.isFinite(credits) || !Number.isFinite(usage)) throw new Error('missing data.total_credits / data.total_usage');
		return { kind: 'balance', amount: credits - usage, title: `purchased: $${credits.toFixed(2)}\nused: $${usage.toFixed(2)}` };
	},
	'siliconflow-balance': (body) => {
		const amount = Number(body?.data?.balance);
		if (!Number.isFinite(amount)) throw new Error('missing data.balance');
		return { kind: 'balance', amount, title: `charge: ¥${body.data.chargeBalance ?? '?'}\ntotal usage: ¥${body.data.totalUsage ?? '?'}` };
	},
	'moonshot-balance': (body) => {
		const amount = Number(body?.data?.total_balance);
		if (!Number.isFinite(amount)) throw new Error('missing data.total_balance');
		return { kind: 'balance', amount };
	},
	'minimax-remains': (body) => {
		const status = Number(body?.base_resp?.status_code);
		if (Number.isFinite(status) && status !== 0) throw new Error(`upstream status ${status}: ${body?.base_resp?.status_msg ?? 'unknown'}`);
		const remains = Array.isArray(body?.model_remains) ? body.model_remains : [];
		if (remains.length === 0) throw new Error('model_remains is empty');
		const num = (v) => {
			const n = Number(v);
			return Number.isFinite(n) ? n : NaN;
		};
		// Prefer the coding model row (MiniMax-M*, glm-plan-usage2 filter);
		// other rows (abab*, embedding…) carry different quota semantics.
		const name = (m) => String(m?.model_name ?? m?.model ?? '');
		const coding = remains.find((m) => name(m).startsWith('MiniMax-M')) ?? remains[0];
		// The remains endpoint family reports REMAINING counts: usage_count is
		// remaining, used = total - usage_count (documented OpenTokenUsage quirk,
		// confirmed by glm-plan-usage2).
		const toIso = (v) => {
			const n = Number(v);
			if (Number.isFinite(n)) return new Date(n > 1e12 ? n : n * 1000).toISOString();
			return typeof v === 'string' && v ? v : undefined;
		};
		const pick = (m) => {
			const total = num(m.current_interval_total_count);
			const resetsAt = toIso(m.end_time ?? m.remains_time);
			const pctRemaining = num(m.current_interval_remaining_percent);
			if (Number.isFinite(pctRemaining)) return { percent: Math.min(100, Math.max(0, Math.round(100 - pctRemaining))), resetsAt };
			const remaining = num(m.current_interval_remaining_count ?? m.current_interval_remains_count ?? m.current_interval_usage_count);
			if (total > 0 && Number.isFinite(remaining)) return { percent: Math.min(100, Math.round(((total - remaining) / total) * 100)), resetsAt };
			return null;
		};
		const first = pick(coding) ?? remains.map(pick).find((w) => w !== null);
		if (!first) throw new Error('no usable current_interval fields in model_remains');
		const windows: Record<string, any> = { rolling: first };
		// Weekly lane (glm-plan-usage2): old plans report weekly_total_count=0 —
		// no weekly window then, never a fabricated one.
		const weeklyTotal = num(coding.current_weekly_total_count);
		const weeklyRemaining = num(coding.current_weekly_usage_count);
		if (weeklyTotal > 0 && Number.isFinite(weeklyRemaining)) {
			windows.weekly = {
				percent: Math.min(100, Math.round(((weeklyTotal - weeklyRemaining) / weeklyTotal) * 100)),
				resetsAt: toIso(coding.weekly_end_time)
			};
		}
		const plan = body?.current_subscribe_title ?? body?.plan_name ?? body?.plan;
		const title = [
			plan ? `plan: ${plan}` : null,
			`model: ${name(coding) || '?'}`,
			`5h prompts: ${first.percent}% used`,
			windows.weekly ? `weekly prompts: ${windows.weekly.percent}% used` : null
		].filter(Boolean).join('\n');
		return { kind: 'usage', windows, title };
	},
	'stepfun-accounts': (body) => {
		const amount = Number(body?.balance);
		if (!Number.isFinite(amount)) throw new Error('missing balance');
		return { kind: 'balance', amount, title: `现金: ¥${body.total_cash_balance ?? '?'}\n赠金: ¥${body.total_voucher_balance ?? '?'}` };
	},
	'xai-credits': (body) => {
		const cents = Number(body?.total?.val);
		if (!Number.isFinite(cents)) throw new Error('missing total.val');
		return { kind: 'balance', amount: Math.abs(cents) / 100 };
	},
	'zhipu-quota': (body) => {
		if (body?.code !== 200) throw new Error(`upstream code ${body?.code}: ${body?.msg ?? 'unknown'}`);
		const limits = Array.isArray(body?.data?.limits) ? body.data.limits : [];
		if (limits.length === 0) throw new Error('data.limits is empty');
		const text = limits.map((l) => {
			if (l.remaining != null) return `${l.remaining}/${l.number ?? '?'}`;
			if (l.percentage != null) return `${l.percentage}%`;
			return '?';
		}).join(' · ');
		return { kind: 'info', text, title: '配额剩余/总数（智谱无公开余额接口）' };
	},
	'opencode-usage': (body) => {
		const u = body?.usage;
		const pick = (key) => {
			const percent = Number(u?.[key]?.percent);
			if (!Number.isFinite(percent)) throw new Error(`missing usage.${key}.percent`);
			return { percent, resetsAt: u[key].resetsAt };
		};
		return { kind: 'usage', windows: { rolling: pick('rolling'), weekly: pick('weekly'), monthly: pick('monthly') } };
	},
	'zai-coding-quota': (body) => {
		if (body?.code !== 200) throw new Error(`upstream code ${body?.code}: ${body?.msg ?? 'unknown'}`);
		const limits = Array.isArray(body?.data?.limits) ? body.data.limits : [];
		if (limits.length === 0) throw new Error('data.limits is empty');
		// Semantic window mapping, cross-checked against the official console
		// (issue #2) and glm-plan-usage2: TOKENS_LIMIT unit=3 is the 5h window,
		// unit=6 the weekly window, TIME_LIMIT the MCP monthly lane. The former
		// size heuristic (sort by unit×number, smallest=5h) swaps 5h/weekly on
		// plans that return both TOKENS_LIMIT rows.
		const pct = (l) => {
			const n = Number(l?.percentage);
			return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
		};
		// Fallback percentage from raw counts; null when unparseable so the
		// client renders "-%" instead of a fabricated 0%.
		const countPct = (l) => {
			const used = Number(l?.currentValue);
			const total = Number(l?.usage);
			if (Number.isFinite(used) && Number.isFinite(total) && total > 0) return Math.round((used / total) * 100);
			return null;
		};
		const resets = (l) => (Number.isFinite(Number(l?.nextResetTime)) ? new Date(Number(l.nextResetTime)).toISOString() : undefined);
		const tokens = limits.filter((l) => l.type === 'TOKENS_LIMIT');
		const time = limits.find((l) => l.type === 'TIME_LIMIT');
		let rolling = tokens.find((l) => Number(l.unit) === 3);
		let weekly = tokens.find((l) => Number(l.unit) === 6);
		if (!rolling && !weekly && tokens.length > 0) {
			// Unknown unit codes: the 5h window always resets before the weekly
			// one, so order by nextResetTime instead of guessing by size.
			const sorted = [...tokens].sort((a, b) => Number(a.nextResetTime ?? Infinity) - Number(b.nextResetTime ?? Infinity));
			rolling = sorted[0];
			weekly = sorted.length > 1 ? sorted[sorted.length - 1] : undefined;
		}
		const mkWin = (l) => {
			if (!l) return undefined;
			const p = pct(l) ?? countPct(l);
			return { percent: p === null ? null : p, resetsAt: resets(l) };
		};
		const windows: Record<string, any> = {};
		if (rolling) windows.rolling = mkWin(rolling);
		if (weekly && weekly !== rolling) windows.weekly = mkWin(weekly);
		if (time) windows.monthly = mkWin(time);
		if (Object.keys(windows).length === 0) throw new Error('no TOKENS_LIMIT / TIME_LIMIT entries');
		const plan = body?.data?.planName ?? body?.data?.plan ?? body?.data?.plan_type ?? body?.data?.packageName ?? body?.data?.level;
		const title = [
			plan ? `plan: ${plan}` : null,
			windows.rolling ? `5h tokens: ${windows.rolling.percent}%` : null,
			windows.weekly ? `weekly tokens: ${windows.weekly.percent}%` : null,
			time ? `MCP monthly: ${Number.isFinite(Number(time.currentValue)) && Number.isFinite(Number(time.usage)) ? `${time.currentValue}/${time.usage} (${windows.monthly.percent}%)` : `${windows.monthly.percent}%`}` : null
		].filter(Boolean).join('\n');
		return { kind: 'usage', windows, title };
	},
	'kimi-coding-usage': (body) => {
		const num = (v) => {
			const n = Number(v);
			return Number.isFinite(n) ? n : NaN;
		};
		// Window semantics per glm-plan-usage2: limits[] carries both windows,
		// identified by window.duration (300 = 5h, 10080 = weekly) — never by
		// array position. Counts are remaining-side: used = limit - remaining
		// (a `used` field is honored when a build provides it directly).
		const limits = Array.isArray(body?.limits) ? body.limits : [];
		const byDuration = (d) => limits.find((l) => Number(l?.window?.duration) === d
			&& (l?.window?.timeUnit ?? 'TIME_UNIT_MINUTE') === 'TIME_UNIT_MINUTE');
		const winFromDetail = (detail) => {
			if (!detail) return null;
			const limit = num(detail.limit);
			let used = num(detail.used);
			if (!Number.isFinite(used)) {
				const remaining = num(detail.remaining);
				if (Number.isFinite(remaining) && Number.isFinite(limit)) used = limit - remaining;
			}
			if (!(limit > 0) || !Number.isFinite(used)) return null;
			return { percent: Math.min(100, Math.round((used / limit) * 100)), resetsAt: detail.resetTime };
		};
		const windows: Record<string, any> = {};
		const rolling = winFromDetail(byDuration(300)?.detail);
		if (rolling) windows.rolling = rolling;
		let weekly = winFromDetail(byDuration(10080)?.detail);
		if (!weekly && body?.usage) {
			// Older shapes only carry the top-level usage aggregate (weekly).
			const usage = body.usage;
			const limit = num(usage.limit);
			let used = num(usage.used);
			if (!Number.isFinite(used)) {
				const remaining = num(usage.remaining);
				if (Number.isFinite(remaining) && Number.isFinite(limit)) used = limit - remaining;
			}
			if (limit > 0 && Number.isFinite(used)) weekly = { percent: Math.min(100, Math.round((used / limit) * 100)), resetsAt: usage.resetTime };
		}
		if (weekly) windows.weekly = weekly;
		if (Object.keys(windows).length === 0) throw new Error('no usable windows: limits[].window.duration=300/10080 or usage.limit needed');
		const title = [
			windows.rolling ? `5h requests: ${windows.rolling.percent}% used` : null,
			windows.weekly ? `weekly requests: ${windows.weekly.percent}% used` : null
		].filter(Boolean).join('\n');
		return { kind: 'usage', windows, title };
	},
	// `volcengine-usage` is not dispatched through adaptRow: fetchRow handles
	// the two-step GetAFPUsage → GetCodingPlanUsage fallback inline because
	// the Volcengine auth path (signed AK/SK, not Bearer) and response
	// envelopes differ from every other provider. The adapter exists so the
	// format is registered in FORMATS/FORMAT_META for config validation.
	'volcengine-usage': () => {
		throw new Error('volcengine-usage is handled inline by fetchRow');
	},
	// chatgpt-subscription is dispatched inline in fetchRow because it uses
	// an OAuth token from ~/.codex/auth.json (with refresh), not ctx.credentials.
	'chatgpt-subscription': () => {
		throw new Error('chatgpt-subscription is handled inline by fetchRow');
	}
};

/**
 * Plugin config schema: structure and defaults live here so profile patches
 * can stay minimal; cross-field semantics (id uniqueness, tier ordering,
 * proxy references, catalog override keys) are checked in {@link apply}.
 */
export const Config = z.object({
	refreshMs: z.number().min(5000).default(60000),
	auto: z.boolean().default(true),
	hide: z.array(z.string()).default([]),
	proxies: z.dict(z.string()).default({}),
	catalog: z.dict(z.any()).default({}),
	providers: z.array(z.object({
		id: z.string().pattern(PROVIDER_ID_PATTERN).required(),
		label: z.string().required(),
		credential: z.string().role('credential-ref').required(),
		secretCredential: z.string().role('credential-ref'),
		region: z.string(),
		localAuth: z.union([z.const('codex')]),
		endpoint: z.string().pattern(HTTP_URL_PATTERN).required(),
		format: z.union([
			z.const('deepseek-balance'), z.const('openrouter-credits'), z.const('siliconflow-balance'),
			z.const('moonshot-balance'), z.const('minimax-remains'), z.const('stepfun-accounts'),
			z.const('xai-credits'), z.const('openai-billing'), z.const('zhipu-quota'),
			z.const('opencode-usage'), z.const('zai-coding-quota'), z.const('kimi-coding-usage'),
			z.const('volcengine-usage'), z.const('chatgpt-subscription')
		]).default('deepseek-balance'),
		proxy: z.string(),
		currency: z.string(),
		balanceTiers: z.object({
			critical: z.number().default(10),
			warn: z.number().default(20),
			healthy: z.number().default(50)
		}),
		lowBalance: z.number(),
		windowLabels: z.object({
			rolling: z.string(),
			weekly: z.string(),
			monthly: z.string()
		}),
		warnPercent: z.number().default(70),
		errorPercent: z.number().default(90)
	})).default([])
});

/** Numeric field with fallback; guards NaN. */
function numOf(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Default balance tiers after the legacy lowBalance alias. */
function resolveTiers(entry, at) {
	const explicit = entry.balanceTiers && typeof entry.balanceTiers === 'object';
	const tiers = explicit
		? {
			critical: numOf(entry.balanceTiers.critical, 10),
			warn: numOf(entry.balanceTiers.warn, 20),
			healthy: numOf(entry.balanceTiers.healthy, 50)
		}
		: typeof entry.lowBalance === 'number' && Number.isFinite(entry.lowBalance)
			? { critical: entry.lowBalance / 2, warn: entry.lowBalance, healthy: 50 }
			: { critical: 10, warn: 20, healthy: 50 };
	if (!(tiers.critical <= tiers.warn && tiers.warn <= tiers.healthy)) {
		throw new Error(`${at}.balanceTiers must satisfy critical <= warn <= healthy`);
	}
	return tiers;
}

/**
 * Cross-field validation the schema cannot express: unique ids, tier
 * ordering, proxy references, and catalog override keys. Also derives the
 * render kind/currency from each row's format.
 * @param {object} raw - schema-processed config.
 * @returns {object[]} the normalized explicit provider list.
 */
function validateProviders(raw) {
	const seen = new Set();
	return raw.providers.map((entry, index) => {
		const at = `quota-panel: config.providers[${index}]`;
		if (!entry || typeof entry !== 'object') throw new Error(`${at} must be an object`);
		if (seen.has(entry.id)) throw new Error(`${at}.id duplicates "${entry.id}"`);
		seen.add(entry.id);
		const format = entry.format ?? 'deepseek-balance';
		const meta = FORMAT_META[format];
		if (!meta) throw new Error(`${at}.format "${format}" is unknown`);
		if (entry.proxy !== undefined && !(entry.proxy in raw.proxies)) {
			throw new Error(`${at}.proxy "${entry.proxy}" is not defined in config.proxies`);
		}
		return {
			id: entry.id,
			label: entry.label,
			credential: entry.credential,
			secretCredential: entry.secretCredential,
			region: entry.region,
			endpoint: entry.endpoint,
			format: format,
			proxy: entry.proxy,
			currency: typeof entry.currency === 'string' && entry.currency ? entry.currency : undefined,
			balanceTiers: resolveTiers(entry, at),
			windowLabels: {
				rolling: '滚',
				weekly: '周',
				monthly: '月',
				...(entry.windowLabels && typeof entry.windowLabels === 'object' ? entry.windowLabels : {})
			},
			warnPercent: numOf(entry.warnPercent, 70),
			errorPercent: numOf(entry.errorPercent, 90)
		};
	});
}

/** Parse an HTTP(S) proxy URL; throws a plain message on anything else. */
function parseHttpProxyUrl(url) {
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('must be http:// or https:// (socks is unsupported)');
	}
	return parsed;
}

/** Validate the proxies map: HTTP(S) proxy URLs only. */
function validateProxies(proxies) {
	const out = {};
	for (const [name, url] of Object.entries(proxies || {})) {
		if (typeof url !== 'string') throw new Error(`quota-panel: config.proxies.${name} must be a URL string`);
		try {
			parseHttpProxyUrl(url);
		} catch (error) {
			throw new Error(`quota-panel: config.proxies.${name} "${url}" ${error instanceof Error ? error.message : 'is not a valid URL'}`);
		}
		out[name] = url;
	}
	return out;
}

/**
 * Validate catalog overrides: only known keys, ids must match the catalog,
 * and proxy references must name a configured proxy. Self-contained
 * misconfiguration fails loud here at load time.
 */
function validateCatalog(catalog: Record<string, any>, proxies: Record<string, string>) {
	const out: Record<string, any> = {};
	const known = new Set(CATALOG.map((entry) => entry.id));
	for (const [id, override] of Object.entries(catalog || {}) as [string, any][]) {
		if (!known.has(id)) throw new Error(`quota-panel: config.catalog.${id} matches no catalog entry (known: ${[...known].join(', ')})`);
		if (!override || typeof override !== 'object') throw new Error(`quota-panel: config.catalog.${id} must be an object`);
		for (const key of Object.keys(override)) {
			if (!CATALOG_OVERRIDE_KEYS.includes(key)) {
				throw new Error(`quota-panel: config.catalog.${id}.${key} is not a known override key (${CATALOG_OVERRIDE_KEYS.join(', ')})`);
			}
		}
		if (override.refs !== undefined && (!Array.isArray(override.refs) || !override.refs.every((ref: any) => CREDENTIAL_REF_PATTERN.test(ref)))) {
			throw new Error(`quota-panel: config.catalog.${id}.refs must be an array of UPPER_SNAKE credential references`);
		}
		if (override.secretRefs !== undefined && (!Array.isArray(override.secretRefs) || !override.secretRefs.every((ref: any) => CREDENTIAL_REF_PATTERN.test(ref)))) {
			throw new Error(`quota-panel: config.catalog.${id}.secretRefs must be an array of UPPER_SNAKE credential references`);
		}
		if (override.format !== undefined && !FORMAT_META[override.format]) {
			throw new Error(`quota-panel: config.catalog.${id}.format "${override.format}" is unknown`);
		}
		if (override.proxy !== undefined && !(override.proxy in proxies)) {
			throw new Error(`quota-panel: config.catalog.${id}.proxy "${override.proxy}" is not defined in config.proxies`);
		}
		out[id] = override;
	}
	return out;
}

/** JSON-safe row spec sent to the client half (render hints only, no secrets). */
function rowSpec(provider) {
	const meta = FORMAT_META[provider.format];
	const spec: Record<string, any> = { id: provider.id, label: provider.label, kind: meta.kind, proxy: provider.proxy ?? null };
	if (meta.kind === 'balance') {
		spec.currency = typeof provider.currency === 'string' && provider.currency ? provider.currency : meta.currency;
		spec.balanceTiers = provider.balanceTiers;
	} else if (meta.kind === 'usage') {
		spec.windowLabels = provider.windowLabels;
		spec.warnPercent = provider.warnPercent;
		spec.errorPercent = provider.errorPercent;
	}
	return spec;
}

/**
 * Request one URL as JSON through an HTTP(S) proxy without external
 * dependencies. https targets go through a CONNECT tunnel (TLS over the
 * tunnel socket); http targets are requested with their absolute URI.
 * Redirects are not followed; quota endpoints answer directly.
 * @param {string} targetUrl - absolute http(s) URL to request.
 * @param {string} proxyUrl - http(s) proxy URL, may carry user:pass.
 * @param {object} headers - request headers (authorization, ...).
 * @param {number} timeoutMs - whole-operation timeout.
 * @param {string} [method] - HTTP method (default GET).
 * @param {string} [body] - request body (JSON or form string).
 * @returns {Promise<{ok: boolean, status: number, json(): Promise<any>}>}
 */
function proxiedGetJson(targetUrl: string, proxyUrl: string, headers: Record<string, string>, timeoutMs: number, method: string = 'GET', body?: string): Promise<any> {
	const reqHeaders = body !== undefined
		? { ...headers, 'content-length': String(Buffer.byteLength(body, 'utf8')) }
		: { ...headers };
	return new Promise((resolve, reject) => {
		const target = new URL(targetUrl);
		const proxy = new URL(proxyUrl);
		const proxyTls = proxy.protocol === 'https:';
		const proxyPort = Number(proxy.port) || (proxyTls ? 443 : 80);
		const proxyHeaders = { ...headers };
		if (proxy.username || proxy.password) {
			const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
			proxyHeaders['proxy-authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
		}
		let settled = false;
		const timer = setTimeout(() => {
			settled = true;
			sock.destroy();
			reject(new Error(`proxy fetch timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const finish = (fn) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const fail = (error) => finish(() => reject(error));
		const sock = proxyTls
			? tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
			: net.connect({ host: proxy.hostname, port: proxyPort });
		sock.once('error', fail);
		const readResponse = (req) => {
			req.once('response', (res) => {
				const chunks = [];
				let size = 0;
				res.on('data', (chunk) => {
					size += chunk.length;
					if (size > MAX_BODY_BYTES) {
						res.destroy();
						fail(new Error(`upstream body exceeds ${MAX_BODY_BYTES} bytes`));
						return;
					}
					chunks.push(chunk);
				});
				res.once('end', () => finish(() => resolve({
					ok: res.statusCode >= 200 && res.statusCode < 300,
					status: res.statusCode,
					json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8'))
				})));
				res.once('error', fail);
			});
			req.once('error', fail);
			req.end(body);
		};
		if (target.protocol === 'https:') {
			const connect = http.request({
				createConnection: () => sock,
				method: 'CONNECT',
				host: proxy.hostname,
				port: proxyPort,
				path: `${target.hostname}:${target.port || 443}`,
				headers: { ...proxyHeaders, host: `${target.hostname}:${target.port || 443}` },
				setHost: false
			});
			connect.once('connect', (res, tunnel) => {
				if (res.statusCode !== 200) {
					tunnel.destroy();
					fail(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
					return;
				}
				const secure = tls.connect({ socket: tunnel, servername: target.hostname });
				secure.once('error', fail);
				readResponse(https.request({
					createConnection: () => secure,
					method,
					host: target.hostname,
					port: target.port || 443,
					path: `${target.pathname}${target.search}`,
					headers: reqHeaders
				}));
			});
			connect.end();
		} else {
			readResponse(http.request({
				createConnection: () => sock,
				method,
				host: target.hostname,
				port: proxyPort,
				path: targetUrl,
				headers: reqHeaders
			}));
		}
	});
}

/**
 * Request one provider URL as JSON, direct or through the row's proxy.
 * @param {string} [method] - HTTP method (default GET).
 * @param {string} [body] - request body (JSON or form string).
 * @returns {Promise<{ok: boolean, status: number, json(): Promise<any>}>}
 */
async function getJson(url, headers, proxyUrl, timeoutMs, method: string = 'GET', body?: string) {
	if (proxyUrl === undefined) {
		const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
		return { ok: res.ok, status: res.status, json: () => res.json() };
	}
	return proxiedGetJson(url, proxyUrl, headers, timeoutMs, method, body);
}

/**
 * First catalog credential reference that resolves, or null. Probing runs
 * per fetch cycle so environment changes apply without a restart.
 */
async function firstResolvedRef(ctx, refs) {
	for (const ref of refs) {
		const hit = await ctx.credentials.resolve(ref);
		if (hit && typeof hit.value === 'string' && hit.value.length > 0) return { ref, value: hit.value };
	}
	return null;
}

/**
 * Resolve the active provider rows: auto-discovered catalog entries (unless
 * hidden or replaced by an explicit same-id entry) plus explicit entries.
 * @returns {Promise<object[]>} rows with credential resolved for fetching.
 */
async function resolveRows(ctx, raw) {
	const rows = [];
	const explicitIds = new Set(raw.providers.map((entry) => entry.id));
	if (raw.auto) {
		for (const entry of CATALOG) {
			if (raw.hide.includes(entry.id) || explicitIds.has(entry.id)) continue;
			const override = raw.catalog[entry.id] || {};
			const merged = { ...entry, ...override };

			let credentialRef: string | undefined;
			let secretCredential: string | undefined;

			if (merged.localAuth) {
				// localAuth rows (ChatGPT via ~/.codex/auth.json) probe the
				// local auth source each cycle; they join the panel only when
				// that source exists. They surface their own fetch error if
				// the file later disappears or is malformed.
				if (merged.localAuth === 'codex' && !(await chatgptAuthExists())) continue;
				credentialRef = undefined;
			} else {
				// Bearer/key rows: the primary ref must resolve. Two-credential
				// rows (e.g. Volcengine AK/SK) require BOTH refs; the resolved
				// ref NAME is stored (not the value); fetchRow re-resolves per
				// cycle.
				const hit = await firstResolvedRef(ctx, merged.refs);
				if (!hit) continue;
				credentialRef = hit.ref;
				if (Array.isArray(merged.secretRefs) && merged.secretRefs.length > 0) {
					const secretHit = await firstResolvedRef(ctx, merged.secretRefs);
					if (!secretHit) continue;
					secretCredential = secretHit.ref;
				}
			}

			const at = `quota-panel: config.catalog.${entry.id}`;
			rows.push({
				id: merged.id,
				label: merged.label,
				credential: credentialRef,
				secretCredential,
				region: merged.region,
				localAuth: merged.localAuth,
				endpoint: merged.endpoint,
				format: merged.format,
				proxy: merged.proxy,
				currency: typeof merged.currency === 'string' && merged.currency ? merged.currency : undefined,
				balanceTiers: resolveTiers({ ...entry, ...override }, at),
				windowLabels: {
					rolling: '滚',
					weekly: '周',
					monthly: '月',
					...(merged.windowLabels && typeof merged.windowLabels === 'object' ? merged.windowLabels : {})
				},
				warnPercent: numOf(merged.warnPercent, 70),
				errorPercent: numOf(merged.errorPercent, 90)
			});
		}
	}
	for (const entry of raw.providers) {
		if (raw.hide.includes(entry.id)) continue;
		rows.push(entry);
	}
	return rows;
}

/** Convert a Volcengine epoch value (ms or seconds, or -1 sentinel) to an ISO string or undefined. */
function volcEpochToIso(v: unknown): string | undefined {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

/**
 * Parse a GetAFPUsage `Result` into rolling/weekly/monthly usage windows.
 * AFPDaily is intentionally skipped (hidden in the official console — its
 * quota is the legacy default, not an enforced limit). Quota<=0 marks an
 * unbound/unsubscribed window and is dropped, so an empty result means "no
 * active Agent Plan" and the caller falls through to Coding Plan.
 */
function parseVolcengineAFP(result: any): { kind: 'usage'; windows: Record<string, any>; title: string } | null {
	const parseWin = (key: string) => {
		const w = result?.[key];
		if (!w) return null;
		const quota = Number(w.Quota);
		if (!Number.isFinite(quota) || quota <= 0) return null;
		const used = Number(w.Used);
		const percent = Math.min(100, Math.max(0, Math.round((Number.isFinite(used) ? used : 0) / quota * 100)));
		return { percent, resetsAt: volcEpochToIso(w.ResetTime) };
	};
	const rolling = parseWin('AFPFiveHour');
	const weekly = parseWin('AFPWeekly');
	const monthly = parseWin('AFPMonthly');
	const windows: Record<string, any> = {};
	if (rolling) windows.rolling = rolling;
	if (weekly) windows.weekly = weekly;
	if (monthly) windows.monthly = monthly;
	if (Object.keys(windows).length === 0) return null;
	const title = [
		`5h: ${rolling?.percent ?? '—'}%`,
		`weekly: ${weekly?.percent ?? '—'}%`,
		`monthly: ${monthly?.percent ?? '—'}%`
	].join('\n');
	return { kind: 'usage', windows, title };
}

/**
 * Parse a GetCodingPlanUsage `Result` into rolling/weekly/monthly windows.
 * The API only reports percentages (no absolute counts); reset times are
 * in seconds. Field names verified against real responses (2026-06):
 * QuotaUsage[].Level in {session, weekly, monthly}, Percent in [0,100],
 * ResetTimestamp in seconds (or -1 when no reset is scheduled).
 */
function parseVolcengineCodingPlan(result: any): { kind: 'usage'; windows: Record<string, any>; title: string } | null {
	const arr = result?.QuotaUsage ?? result?.Usages ?? result?.Details;
	if (!Array.isArray(arr) || arr.length === 0) return null;
	const slotFor = (label: string): string | null => {
		switch (label.toLowerCase()) {
			case 'session': case '5h': case 'fivehour': case 'five_hour': case 'rolling_5h': return 'rolling';
			case 'weekly': case 'week': case '7d': return 'weekly';
			case 'monthly': case 'month': return 'monthly';
			default: return null;
		}
	};
	const windows: Record<string, any> = {};
	for (const item of arr) {
		const label = String(item?.Level ?? item?.Type ?? item?.Period ?? item?.Label ?? item?.Window ?? '');
		const slot = slotFor(label);
		if (!slot) continue;
		const percent = Number(item?.Percent ?? item?.UsedPercent ?? item?.UsagePercent);
		if (!Number.isFinite(percent)) continue;
		windows[slot] = {
			percent: Math.min(100, Math.max(0, Math.round(percent))),
			resetsAt: volcEpochToIso(item?.ResetTime ?? item?.ResetTimestamp)
		};
	}
	if (Object.keys(windows).length === 0) return null;
	const title = [
		`5h: ${windows.rolling?.percent ?? '—'}%`,
		`weekly: ${windows.weekly?.percent ?? '—'}%`,
		`monthly: ${windows.monthly?.percent ?? '—'}%`
	].join('\n');
	return { kind: 'usage', windows, title };
}

/** Normalize one upstream body through its format adapter. */
function adaptRow(format, body) {
	const adapter = FORMATS[format] ?? FORMATS['deepseek-balance'];
	try {
		return { view: adapter(body) };
	} catch (error) {
		return { error: `${format}: ${String((error && error.message) || error)}` };
	}
}

/**
 * Fetch one provider row: resolve its credential, call the upstream
 * endpoint(s), normalize through the format adapter. openai-billing issues
 * two dashboard requests against the configured base URL. A client-supplied
 * proxy URL (settings panel) wins over the row's profile-configured proxy.
 */
async function fetchRow(ctx, provider, proxies, clientProxyUrl) {
	try {
		// ── ChatGPT subscription (Codex OAuth) ──────────────────
		// Reads tokens from ~/.codex/auth.json, refreshes host-side,
		// and queries the experimental wham/usage endpoint. On a 401
		// we force a single token refresh retry.
		if (provider.format === 'chatgpt-subscription') {
			try {
				// Per-row proxy (client override or config) covers the usage
				// query AND token refresh — same region constraints apply.
				const cgProxy = clientProxyUrl !== undefined
					? clientProxyUrl
					: (provider.proxy !== undefined ? proxies[provider.proxy] : undefined);
				let { accessToken, accountId } = await resolveChatGPTToken(UPSTREAM_TIMEOUT_MS, cgProxy);
				let body: any;
				try {
					body = await fetchChatGPTUsage(accessToken, accountId, UPSTREAM_TIMEOUT_MS, cgProxy);
				} catch (e) {
					if ((e as any)?.code === 'chatgpt-auth') {
						// Drop the cached token and refresh once.
						chatgptTokenCache = null;
						const refreshed = await resolveChatGPTToken(UPSTREAM_TIMEOUT_MS, cgProxy);
						accessToken = refreshed.accessToken;
						accountId = refreshed.accountId;
						body = await fetchChatGPTUsage(accessToken, accountId, UPSTREAM_TIMEOUT_MS, cgProxy);
					} else {
						throw e;
					}
				}
				const view = parseChatGPTUsage(body);
				if (!view) {
					return { id: provider.id, error: 'ChatGPT: no rate_limit data in usage response' };
				}
				return { id: provider.id, view };
			} catch (e) {
				return { id: provider.id, error: String((e && (e as Error).message) || e) };
			}
		}
		const hit = await ctx.credentials.resolve(provider.credential);
		if (!hit || typeof hit.value !== 'string' || hit.value.length === 0) {
			return { id: provider.id, error: `${provider.credential} is not configured` };
		}
		// ── Volcengine Ark: AK/SK signed OpenAPI, not Bearer ──────
		//
		// Calls GetAFPUsage first (Agent Plan); if no quota windows
		// come back (signature OK but no subscription), falls through
		// to GetCodingPlanUsage. Per-row errors are surfaced inline;
		// auth failures carry the upstream code in the message.
		if (provider.format === 'volcengine-usage') {
			if (!provider.secretCredential) {
				return { id: provider.id, error: 'volcengine-usage requires both VOLC_ACCESS_KEY and VOLC_SECRET_KEY (only the AK was resolved)' };
			}
			const skHit = await ctx.credentials.resolve(provider.secretCredential);
			if (!skHit || typeof skHit.value !== 'string' || skHit.value.length === 0) {
				return { id: provider.id, error: `${provider.secretCredential} is not configured` };
			}
			const ak = hit.value;
			const sk = skHit.value;
			// Region from the explicit provider.region override, else
			// derived from a volces.com data-plane host in `endpoint`,
			// else the Volcengine Beijing default.
			let region = 'cn-beijing';
			if (typeof provider.region === 'string' && provider.region) {
				region = provider.region;
			} else {
				const m = /ark\.([a-z0-9-]+)\.volces\.com/.exec(provider.endpoint || '');
				if (m) region = m[1];
			}
			try {
				const afpBody = await volcengineCall('GetAFPUsage', region, ak, sk, UPSTREAM_TIMEOUT_MS);
				const afpResult = afpBody?.Result ?? afpBody;
				const afpView = parseVolcengineAFP(afpResult);
				if (afpView) {
					const plan = afpResult?.PlanType ? `Agent Plan ${afpResult.PlanType}` : 'Agent Plan';
					afpView.title = `plan: ${plan}\n` + afpView.title;
					return { id: provider.id, view: afpView };
				}
				const cpBody = await volcengineCall('GetCodingPlanUsage', region, ak, sk, UPSTREAM_TIMEOUT_MS);
				const cpResult = cpBody?.Result ?? cpBody;
				const cpView = parseVolcengineCodingPlan(cpResult);
				if (cpView) {
					cpView.title = 'plan: Coding Plan\n' + cpView.title;
					return { id: provider.id, view: cpView };
				}
				return { id: provider.id, error: 'No active Agent Plan or Coding Plan subscription' };
			} catch (ve) {
				return { id: provider.id, error: String((ve && (ve as Error).message) || ve) };
			}
		}
		const headers = { authorization: `Bearer ${hit.value}` };
		const proxyUrl = clientProxyUrl !== undefined
			? clientProxyUrl
			: (provider.proxy !== undefined ? proxies[provider.proxy] : undefined);
		if (provider.format === 'openai-billing') {
			const base = provider.endpoint.replace(/\/+$/, '');
			const sub = await getJson(`${base}/v1/dashboard/billing/subscription`, headers, proxyUrl, UPSTREAM_TIMEOUT_MS);
			const usage = await getJson(`${base}/v1/dashboard/billing/usage`, headers, proxyUrl, UPSTREAM_TIMEOUT_MS);
			const limit = Number((await sub.json())?.hard_limit_usd);
			const used = Number((await usage.json())?.total_usage);
			if (!Number.isFinite(limit) || !Number.isFinite(used)) {
				return { id: provider.id, error: 'openai-billing: missing hard_limit_usd / total_usage' };
			}
			return { id: provider.id, view: { kind: 'balance', amount: limit - used, title: `额度上限: $${limit.toFixed(2)}\n已用: $${used.toFixed(2)}` } };
		}
		const upstream = await getJson(provider.endpoint, headers, proxyUrl, UPSTREAM_TIMEOUT_MS);
		const body = await upstream.json().catch(() => null);
		if (body === null) return { id: provider.id, error: `HTTP ${upstream.status}: non-JSON response` };
		const outcome = adaptRow(provider.format, body);
		if (!upstream.ok && outcome.error === undefined) {
			return { id: provider.id, error: `HTTP ${upstream.status}`, view: outcome.view };
		}
		return { id: provider.id, ...outcome };
	} catch (error) {
		return { id: provider.id, error: String((error && error.message) || error) };
	}
}

/**
 * Apply the plugin: normalize config and own the loopback RPC channel.
 * Channel registrations belong to the caller fiber (disposed with it), so no
 * explicit effect wrapper is needed.
 * @param ctx - plugin context with connection and credentials services.
 * @param config - raw plugin config (schema-processed by the loader).
 */
export function apply(ctx, config: Record<string, any> = {}) {
	const raw: Record<string, any> = config && typeof config === 'object' ? config : {};
	const refreshMs = numOf(raw.refreshMs, 60000);
	if (!(refreshMs >= 5000)) throw new Error('quota-panel: config.refreshMs must be >= 5000');
	const proxies = validateProxies(raw.proxies);
	const catalog = validateCatalog(raw.catalog, proxies);
	const providers = validateProviders({ providers: Array.isArray(raw.providers) ? raw.providers : [], proxies });

	ctx.connection.rpc.handle(RPC_CHANNEL, async (endpoint, payload, _signal) => {
		try {
			// ── ChatGPT subscription auth (device-code login) ──────
			// These endpoints drive the in-plugin device-authorization
			// flow so users without Codex CLI can still log in. No
			// secrets leave the host.
			if (endpoint === 'chatgpt-auth-status') {
				const dsh = await readChatGPTDshStore();
				return {
					ok: true,
					value: {
						loggedIn: !!(dsh?.access_token) || await chatgptAuthExists(),
						source: dsh ? 'dsh' : (await codexAuthFileExists() ? 'codex' : null),
						account_id: dsh?.account_id,
						plan_type: dsh?.plan_type,
						login: chatgptLoginStatus()
					}
				};
			}
			if (endpoint === 'chatgpt-login-start') {
				// Optional per-login proxy (settings panel): the whole device
				// flow (usercode → poll → exchange) goes through it — the
				// user may need it to reach auth.openai.com at all.
				let loginProxy: string | undefined;
				const rawProxy = payload && typeof payload === 'object' && typeof payload.proxy === 'string' ? payload.proxy.trim() : '';
				if (rawProxy) {
					try {
						parseHttpProxyUrl(rawProxy);
						loginProxy = rawProxy;
					} catch (error) {
						return { ok: false, error: { code: 'invalid-proxy', message: `proxy "${rawProxy}": ${error instanceof Error ? error.message : 'is not a valid URL'}`, details: {} } };
					}
				}
				// Cancel any in-flight login, then start a fresh one.
				if (chatgptLogin) chatgptLogin.abort = true;
				const info = await chatgptDeviceStart(UPSTREAM_TIMEOUT_MS, loginProxy);
				return { ok: true, value: info };
			}
			if (endpoint === 'chatgpt-login-cancel') {
				if (chatgptLogin) chatgptLogin.abort = true;
				chatgptLogin = null;
				chatgptLoginError = null; // user-initiated cancel is not an error
				return { ok: true, value: { cancelled: true } };
			}
			if (endpoint === 'chatgpt-logout') {
				await deleteChatGPTDshStore();
				return { ok: true, value: { loggedOut: true } };
			}
			const rows = await resolveRows(ctx, {
				auto: raw.auto !== false,
				hide: Array.isArray(raw.hide) ? raw.hide : [],
				providers,
				proxies,
				catalog
			});
			if (endpoint === 'specs') {
				return { ok: true, value: { rows: rows.map(rowSpec), refreshMs } };
			}
			if (endpoint === 'fetch-all') {
				const overrides = {};
				const overrideErrors = {};
				const rawOverrides = payload && typeof payload === 'object' && payload.proxy && typeof payload.proxy === 'object' ? payload.proxy : {};
				for (const [id, url] of Object.entries(rawOverrides)) {
					if (url === null || url === undefined || url === '') continue;
					try {
						parseHttpProxyUrl(url);
						overrides[id] = url;
					} catch (error) {
						overrideErrors[id] = `client proxy "${url}": ${error instanceof Error ? error.message : 'is not a valid URL'}`;
					}
				}
				const fetched = await Promise.all(rows.map(async (provider) => {
					if (overrideErrors[provider.id] !== undefined) {
						return { id: provider.id, error: overrideErrors[provider.id] };
					}
					return fetchRow(ctx, provider, proxies, overrides[provider.id]);
				}));
				return { ok: true, value: { rows: fetched, fetchedAt: Date.now() } };
			}
			return { ok: false, error: { code: 'internal', message: `unknown endpoint: ${String(endpoint)}`, details: {} } };
		} catch (error) {
			return { ok: false, error: { code: 'internal', message: String((error && error.message) || error), details: {} } };
		}
	}, { authority: 'loopback' });
}
