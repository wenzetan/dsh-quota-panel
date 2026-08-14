/**
 * dsh-quota-panel — provider quota card for the dsh web surface.
 *
 * Dual-face plugin (option-C refactor of the v0.3 single-file page-script
 * injection; see README "Architecture"):
 *
 *  - Host half (this file, zero runtime dependencies — the schema library is
 *    vendored under lib/vendor/):
 *    registers one loopback-only Connection RPC channel `/dsh-quota-panel`
 *    with two endpoints. API keys are resolved through `ctx.credentials` and
 *    never reach the browser; upstream quota endpoints are called host-side
 *    with `Authorization: Bearer <key>`.
 *      - `specs`     → provider row specs + default refreshMs (render hints)
 *      - `fetch-all` → per-provider upstream JSON (or per-row error string)
 *
 *  - Client half (`lib/client.js`, served at `/plugins/dsh-quota-panel/client.js`
 *    through the `dsh.client` manifest): a `shell.overlay` slot entry that
 *    renders the collapsed capsule / expanded card / settings panel with
 *    React, talking to this half over `ctx.connection.rpc`.
 *
 * Providers are config-driven (validated by the exported `Config` schema,
 * so the profile patch may omit every defaulted field). Each entry:
 *
 *   id:          row key; ^[a-z0-9-]+$ (unique)
 *   label:       provider name, e.g. "DeepSeek"
 *   credential:  credential reference, e.g. "DEEPSEEK_API_KEY"
 *   endpoint:    quota/balance JSON endpoint (GET, Bearer auth), http(s) URL
 *   format:      row renderer: "deepseek-balance" | "opencode-usage"
 *   balanceTiers: (deepseek-balance) { critical, warn, healthy }, defaults
 *                { 10, 20, 50 }; must satisfy critical <= warn <= healthy
 *   lowBalance:  legacy alias for balanceTiers.warn
 *   windowLabels: (opencode-usage) { rolling, weekly, monthly } labels,
 *                defaults { 滚, 周, 月 }
 *   warnPercent / errorPercent: (opencode-usage) thresholds, defaults 70 / 90
 *
 * Example mount (profile patch):
 *
 *   - insert:
 *       - id: quota-panel
 *         name: 'dsh-quota-panel'
 *         config:
 *           refreshMs: 60000
 *           providers:
 *             - id: deepseek
 *               label: DeepSeek
 *               credential: DEEPSEEK_API_KEY
 *               endpoint: https://api.deepseek.com/user/balance
 *               format: deepseek-balance
 * Schema library is vendored under lib/vendor/ (schemastery 3.18.1 +
 * cosmokit, both MIT; zero further runtime dependencies) and imported by
 * relative path, so the package resolves with or without node_modules —
 * required because `dsh plugin add link:` installs resolve imports from the
 * repo's real path, which cannot walk up to dsh's bundled packages.
 */
import z from './vendor/schemastery.mjs';

export const name = 'quota-panel';

export const inject = ['connection', 'credentials'];

/** Loopback-only Connection RPC channel this plugin owns. */
export const RPC_CHANNEL = '/dsh-quota-panel';

/** Upstream fetch timeout per provider row. */
const UPSTREAM_TIMEOUT_MS = 15000;

const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Plugin config schema: structure and defaults live here so profile patches
 * can stay minimal; cross-field semantics (id uniqueness, tier ordering) are
 * checked in {@link validateProviders} below.
 */
export const Config = z.object({
	refreshMs: z.number().min(5000).default(60000),
	providers: z.array(z.object({
		id: z.string().pattern(PROVIDER_ID_PATTERN).required(),
		label: z.string().required(),
		credential: z.string().role('credential-ref').required(),
		endpoint: z.string().pattern(/^https?:\/\//).required(),
		format: z.union([z.const('deepseek-balance'), z.const('opencode-usage')]).default('deepseek-balance'),
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

/**
 * Cross-field validation the schema cannot express: unique ids and
 * critical <= warn <= healthy tier ordering.
 * @param {unknown[]} providers - schema-processed provider entries.
 * @returns {object[]} the normalized provider list.
 */
function validateProviders(providers) {
	const seen = new Set();
	return providers.map((entry, index) => {
		const at = `quota-panel: config.providers[${index}]`;
		if (!entry || typeof entry !== 'object') throw new Error(`${at} must be an object`);
		if (seen.has(entry.id)) throw new Error(`${at}.id duplicates "${entry.id}"`);
		seen.add(entry.id);
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
		return {
			id: entry.id,
			label: entry.label,
			credential: entry.credential,
			endpoint: entry.endpoint,
			format: entry.format,
			balanceTiers: tiers,
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

/** JSON-safe row spec sent to the client half (render hints only, no secrets). */
function rowSpec(provider) {
	return {
		id: provider.id,
		label: provider.label,
		format: provider.format,
		windowLabels: provider.windowLabels,
		warnPercent: provider.warnPercent,
		errorPercent: provider.errorPercent,
		balanceTiers: provider.balanceTiers
	};
}

/**
 * Fetch every configured provider upstream, capturing per-row errors so one
 * bad endpoint never breaks the whole card.
 * @param ctx - plugin context with the credentials service.
 * @param providers - normalized provider entries.
 * @returns the `fetch-all` rows payload.
 */
async function fetchAll(ctx, providers) {
	const rows = await Promise.all(providers.map(async (provider) => {
		try {
			const hit = await ctx.credentials.resolve(provider.credential);
			if (!hit || typeof hit.value !== 'string' || hit.value.length === 0) {
				return { id: provider.id, error: `${provider.credential} is not configured` };
			}
			const upstream = await fetch(provider.endpoint, {
				headers: { authorization: `Bearer ${hit.value}` },
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
			});
			const body = await upstream.json().catch(() => null);
			if (body === null) return { id: provider.id, error: `HTTP ${upstream.status}: non-JSON response` };
			if (!upstream.ok) return { id: provider.id, error: `HTTP ${upstream.status}` , data: body };
			return { id: provider.id, data: body };
		} catch (error) {
			return { id: provider.id, error: String((error && error.message) || error) };
		}
	}));
	return { rows, fetchedAt: Date.now() };
}

/**
 * Apply the plugin: normalize config and own the loopback RPC channel.
 * Channel registrations belong to the caller fiber (disposed with it), so no
 * explicit effect wrapper is needed.
 * @param ctx - plugin context with connection and credentials services.
 * @param config - raw plugin config (schema-processed by the loader).
 */
export function apply(ctx, config = {}) {
	const raw = config && typeof config === 'object' ? config : {};
	const refreshMs = numOf(raw.refreshMs, 60000);
	if (!(refreshMs >= 5000)) throw new Error('quota-panel: config.refreshMs must be >= 5000');
	const providers = validateProviders(Array.isArray(raw.providers) ? raw.providers : []);

	ctx.connection.rpc.handle(RPC_CHANNEL, async (endpoint, _payload, _signal) => {
		try {
			if (endpoint === 'specs') {
				return { ok: true, value: { rows: providers.map(rowSpec), refreshMs } };
			}
			if (endpoint === 'fetch-all') {
				return { ok: true, value: await fetchAll(ctx, providers) };
			}
			return { ok: false, error: { code: 'internal', message: `unknown endpoint: ${String(endpoint)}`, details: {} } };
		} catch (error) {
			return { ok: false, error: { code: 'internal', message: String((error && error.message) || error), details: {} } };
		}
	}, { authority: 'loopback' });
}
