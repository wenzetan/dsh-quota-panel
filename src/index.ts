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
	'kimi-coding-usage': { kind: 'usage' }
};

/**
 * Built-in provider catalog probed by auto discovery. `refs` lists the
 * credential references tried in order; the first one that resolves wins.
 * Endpoints verified against provider docs (see README "内置供应商目录").
 */
const CATALOG = [
	{ id: 'deepseek', label: 'DeepSeek', refs: ['DEEPSEEK_API_KEY'], endpoint: 'https://api.deepseek.com/user/balance', format: 'deepseek-balance' },
	{ id: 'openrouter', label: 'OpenRouter', refs: ['OPENROUTER_API_KEY'], endpoint: 'https://openrouter.ai/api/v1/credits', format: 'openrouter-credits' },
	{ id: 'siliconflow', label: 'SiliconFlow', refs: ['SILICONFLOW_API_KEY'], endpoint: 'https://api.siliconflow.cn/v1/user/info', format: 'siliconflow-balance' },
	{ id: 'moonshot', label: 'Moonshot', refs: ['MOONSHOT_API_KEY'], endpoint: 'https://api.moonshot.cn/v1/users/me/balance', format: 'moonshot-balance' },
	{ id: 'minimax', label: 'MiniMax Coding', refs: ['MINIMAX_API_KEY'], endpoint: 'https://www.minimax.io/v1/token_plan/remains', format: 'minimax-remains', windowLabels: { rolling: '5h' } },
	{ id: 'minimax-cn', label: 'MiniMax Coding 国内', refs: ['MINIMAX_CN_API_KEY'], endpoint: 'https://api.minimaxi.com/v1/token_plan/remains', format: 'minimax-remains', windowLabels: { rolling: '5h' } },
	{ id: 'stepfun', label: 'StepFun', refs: ['STEP_API_KEY', 'STEPFUN_API_KEY'], endpoint: 'https://api.stepfun.com/v1/accounts', format: 'stepfun-accounts' },
	{ id: 'xai', label: 'xAI', refs: ['XAI_API_KEY'], endpoint: 'https://api.x.ai/v1/billing/credits', format: 'xai-credits' },
	{ id: 'zhipu', label: '智谱 GLM', refs: ['ZHIPU_API_KEY', 'GLM_API_KEY'], endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', format: 'zhipu-quota' },
	{ id: 'zai-coding-cn', label: '智谱 GLM Coding', refs: ['ZAI_CODING_CN_API_KEY'], endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', format: 'zai-coding-quota', windowLabels: { rolling: '5h', weekly: '周', monthly: '搜索' } },
	{ id: 'zai', label: 'Z.AI GLM Coding', refs: ['ZAI_API_KEY'], endpoint: 'https://api.z.ai/api/monitor/usage/quota/limit', format: 'zai-coding-quota', windowLabels: { rolling: '5h', weekly: '周', monthly: '搜索' } },
	{ id: 'kimi-coding', label: 'Kimi Coding', refs: ['KIMI_API_KEY'], endpoint: 'https://api.kimi.com/coding/v1/usages', format: 'kimi-coding-usage', windowLabels: { rolling: '5h', weekly: '周' } },
	{ id: 'opencode-go', label: 'OpenCode Go', refs: ['OPENCODE_GO_API_KEY'], endpoint: 'https://opencode.ai/zen/go/v1/usage', format: 'opencode-usage' }
];

/** Keys a `catalog` override may set on an auto-discovered row. */
const CATALOG_OVERRIDE_KEYS = ['label', 'endpoint', 'format', 'proxy', 'refs', 'balanceTiers', 'warnPercent', 'errorPercent', 'windowLabels'];

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
		// MiniMax reports *remaining* counts; some builds return the remaining
		// value through current_interval_usage_count (documented OpenTokenUsage quirk).
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
		const first = remains.map(pick).find((w) => w !== null);
		if (!first) throw new Error('no usable current_interval fields in model_remains');
		const plan = body?.current_subscribe_title ?? body?.plan_name ?? body?.plan;
		const title = [plan ? `plan: ${plan}` : null, `5h prompts: ${first.percent}% used`].filter(Boolean).join('\n');
		return { kind: 'usage', windows: { rolling: first }, title };
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
		// CodexBar mapping: shortest TOKENS_LIMIT = 5h session window, longest
		// = weekly; TIME_LIMIT folds into the third slot as the search/MCP lane.
		const tokens = limits.filter((l) => l.type === 'TOKENS_LIMIT')
			.sort((a, b) => (Number(a.unit) || 0) * (Number(a.number) || 1) - (Number(b.unit) || 0) * (Number(b.number) || 1));
		const time = limits.find((l) => l.type === 'TIME_LIMIT');
		const pct = (l) => {
			const n = Number(l?.percentage);
			return Number.isFinite(n) ? Math.round(n) : 0;
		};
		const countPct = (l) => {
			const used = Number(l?.currentValue);
			const total = Number(l?.usage);
			if (Number.isFinite(used) && Number.isFinite(total) && total > 0) return Math.round((used / total) * 100);
			return pct(l);
		};
		const resets = (l) => (Number.isFinite(Number(l?.nextResetTime)) ? new Date(Number(l.nextResetTime)).toISOString() : undefined);
		const windows: Record<string, any> = {};
		if (tokens.length > 0) windows.rolling = { percent: pct(tokens[0]), resetsAt: resets(tokens[0]) };
		if (tokens.length > 1) windows.weekly = { percent: pct(tokens[tokens.length - 1]), resetsAt: resets(tokens[tokens.length - 1]) };
		if (time) windows.monthly = { percent: countPct(time), resetsAt: resets(time) };
		if (Object.keys(windows).length === 0) throw new Error('no TOKENS_LIMIT / TIME_LIMIT entries');
		const plan = body?.data?.planName ?? body?.data?.plan ?? body?.data?.plan_type ?? body?.data?.packageName ?? body?.data?.level;
		const title = [
			plan ? `plan: ${plan}` : null,
			tokens.length > 0 ? `5h tokens: ${pct(tokens[0])}%` : null,
			tokens.length > 1 ? `weekly tokens: ${pct(tokens[tokens.length - 1])}%` : null,
			time ? `searches: ${Number(time.currentValue)}/${Number(time.usage)}` : null
		].filter(Boolean).join('\n');
		return { kind: 'usage', windows, title };
	},
	'kimi-coding-usage': (body) => {
		const num = (v) => {
			const n = Number(v);
			return Number.isFinite(n) ? n : NaN;
		};
		const usage = body?.usage;
		const limit = num(usage?.limit);
		const used = num(usage?.used);
		if (!(limit > 0) || !Number.isFinite(used)) throw new Error('missing usage.limit / usage.used');
		const windows: Record<string, any> = { weekly: { percent: Math.min(100, Math.round((used / limit) * 100)), resetsAt: usage?.resetTime } };
		const detail = Array.isArray(body?.limits) && body.limits[0]?.detail ? body.limits[0].detail : null;
		const sLimit = num(detail?.limit);
		const sUsed = num(detail?.used);
		if (sLimit > 0 && Number.isFinite(sUsed)) windows.rolling = { percent: Math.min(100, Math.round((sUsed / sLimit) * 100)), resetsAt: detail?.resetTime };
		return { kind: 'usage', windows, title: `weekly requests: ${used}/${limit}` + (windows.rolling ? `\n5h requests: ${sUsed}/${sLimit}` : '') };
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
		endpoint: z.string().pattern(HTTP_URL_PATTERN).required(),
		format: z.union([z.const('deepseek-balance'), z.const('openrouter-credits'), z.const('siliconflow-balance'), z.const('moonshot-balance'), z.const('minimax-remains'), z.const('stepfun-accounts'), z.const('xai-credits'), z.const('openai-billing'), z.const('zhipu-quota'), z.const('opencode-usage')]).default('deepseek-balance'),
		proxy: z.string(),
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
			endpoint: entry.endpoint,
			format: format,
			proxy: entry.proxy,
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
		if (override.refs !== undefined && (!Array.isArray(override.refs) || !override.refs.every((ref) => CREDENTIAL_REF_PATTERN.test(ref)))) {
			throw new Error(`quota-panel: config.catalog.${id}.refs must be an array of UPPER_SNAKE credential references`);
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
		spec.currency = meta.currency;
		spec.balanceTiers = provider.balanceTiers;
	} else if (meta.kind === 'usage') {
		spec.windowLabels = provider.windowLabels;
		spec.warnPercent = provider.warnPercent;
		spec.errorPercent = provider.errorPercent;
	}
	return spec;
}

/**
 * GET one URL as JSON through an HTTP(S) proxy without external
 * dependencies. https targets go through a CONNECT tunnel (TLS over the
 * tunnel socket); http targets are requested with their absolute URI.
 * Redirects are not followed; quota endpoints answer directly.
 * @param {string} targetUrl - absolute http(s) URL to fetch.
 * @param {string} proxyUrl - http(s) proxy URL, may carry user:pass.
 * @param {object} headers - request headers (authorization, ...).
 * @param {number} timeoutMs - whole-operation timeout.
 * @returns {Promise<{ok: boolean, status: number, json(): Promise<any>}>}
 */
function proxiedGetJson(targetUrl: string, proxyUrl: string, headers: Record<string, string>, timeoutMs: number): Promise<any> {
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
			req.end();
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
					method: 'GET',
					host: target.hostname,
					port: target.port || 443,
					path: `${target.pathname}${target.search}`,
					headers
				}));
			});
			connect.end();
		} else {
			readResponse(http.request({
				createConnection: () => sock,
				method: 'GET',
				host: target.hostname,
				port: proxyPort,
				path: targetUrl,
				headers
			}));
		}
	});
}

/**
 * GET one provider URL as JSON, direct or through the row's proxy.
 * @returns {Promise<{ok: boolean, status: number, json(): Promise<any>}>}
 */
async function getJson(url, headers, proxyUrl, timeoutMs) {
	if (proxyUrl === undefined) {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
		return { ok: res.ok, status: res.status, json: () => res.json() };
	}
	return proxiedGetJson(url, proxyUrl, headers, timeoutMs);
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
			const hit = await firstResolvedRef(ctx, merged.refs);
			if (!hit) continue;
			const at = `quota-panel: config.catalog.${entry.id}`;
			rows.push({
				id: merged.id,
				label: merged.label,
				credential: hit.ref,
				endpoint: merged.endpoint,
				format: merged.format,
				proxy: merged.proxy,
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
		const hit = await ctx.credentials.resolve(provider.credential);
		if (!hit || typeof hit.value !== 'string' || hit.value.length === 0) {
			return { id: provider.id, error: `${provider.credential} is not configured` };
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
