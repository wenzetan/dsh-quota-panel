// Dual-face check for dsh-quota-panel v0.5+ (host RPC half + browser client half).
//
// Part A exercises lib/index.js: Config schema defaults, cross-field
// validation, the loopback RPC channel contract (specs / fetch-all /
// unknown endpoint), built-in catalog auto discovery by credential probing,
// hide / catalog overrides, host-side format normalization into view models,
// the openai-billing double request, and the zero-dependency HTTP proxy
// engine against real local servers (absolute-URI forward + CONNECT refusal).
// Part B exercises lib/client.js: the __ModuleLoader__ handoff shape, the
// shell.overlay slot registration, and the settings-panel surface.
import vm from 'node:vm';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = await import(`file://${join(root, 'lib/index.js')}`);
let ok = true;
const check = (name, pass) => {
	console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}`);
	if (!pass) ok = false;
};

// ---------- Part A: host half ----------
const registrations = [];
let credentialMap = {};
const hostCtx = {
	connection: {
		rpc: {
			handle: (channel, handler, options) => {
				registrations.push({ channel, handler, options });
				return async () => {};
			}
		}
	},
	credentials: {
		resolve: async (ref) => credentialMap[ref] ? { value: credentialMap[ref], source: 'file' } : undefined
	}
};
const mount = (config) => {
	registrations.length = 0;
	plugin.apply(hostCtx, structuredClone(config));
	return registrations[0].handler;
};

// ---------- A1: explicit rows (auto rows replaced by same-id entries) ----------
credentialMap = { DEEPSEEK_API_KEY: 'sk-ds', OPENCODE_GO_API_KEY: 'sk-oc' };
let handler = mount({
	refreshMs: 60000,
	providers: [
		{ id: 'deepseek', label: 'DeepSeek', credential: 'DEEPSEEK_API_KEY', endpoint: 'https://api.deepseek.com/user/balance', format: 'deepseek-balance', balanceTiers: { critical: 10, warn: 20, healthy: 50 } },
		{ id: 'opencode-go', label: 'OpenCode Go', credential: 'OPENCODE_GO_API_KEY', endpoint: 'https://opencode.ai/zen/go/v1/usage', format: 'opencode-usage', windowLabels: { rolling: '五', weekly: '周', monthly: '月' }, warnPercent: 70, errorPercent: 90 }
	]
});

check('A: one RPC registration', registrations.length === 1);
check('A: channel /dsh-quota-panel', registrations[0]?.channel === '/dsh-quota-panel');
check('A: authority loopback', registrations[0]?.options?.authority === 'loopback');

let specs = await handler('specs', null, undefined);
check('A: explicit rows replace catalog ids', specs.ok === true && specs.value.rows.length === 2);
check('A: specs row fields + kinds', (() => {
	const row = specs.value.rows[0];
	return row.id === 'deepseek' && row.label === 'DeepSeek' && row.kind === 'balance'
		&& row.currency === '¥' && row.balanceTiers.critical === 10
		&& specs.value.rows[1].kind === 'usage' && specs.value.rows[1].warnPercent === 70;
})());
check('A: specs carries refreshMs', specs.value.refreshMs === 60000);
check('A: specs leaks no credential/endpoint', (() => {
	const text = JSON.stringify(specs);
	return !text.includes('DEEPSEEK_API_KEY') && !text.includes('api.deepseek.com') && !text.includes('endpoint');
})());

// fetch-all normalizes upstream JSON into view models
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
	if (String(url).includes('deepseek')) {
		return { ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '58.36', granted_balance: '10.00', topped_up_balance: '48.36' }] }) };
	}
	if (String(url).includes('opencode.ai')) {
		return { ok: true, status: 200, json: async () => ({ usage: { rolling: { percent: 45, resetsAt: new Date(Date.now() + 3600e3).toISOString() }, weekly: { percent: 22 }, monthly: { percent: 10 } } }) };
	}
	throw new Error('network down');
};
let fetchAll;
try {
	fetchAll = await handler('fetch-all', null, undefined);
} finally {
	globalThis.fetch = realFetch;
}
check('A: fetch-all ok envelope', fetchAll.ok === true && Array.isArray(fetchAll.value.rows) && typeof fetchAll.value.fetchedAt === 'number');
check('A: deepseek row normalized to balance view', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'deepseek');
	return row && row.view?.kind === 'balance' && row.view.amount === 58.36 && typeof row.view.title === 'string';
})());
check('A: opencode row normalized to usage view', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'opencode-go');
	return row && row.view?.kind === 'usage' && row.view.windows?.rolling?.percent === 45 && row.view.windows?.monthly?.percent === 10;
})());

const unknown = await handler('bogus', null, undefined);
check('A: unknown endpoint -> ok:false', unknown.ok === false && unknown.error.code === 'internal');

// ---------- A2: catalog auto discovery ----------
credentialMap = { DEEPSEEK_API_KEY: 'sk-ds', OPENROUTER_API_KEY: 'sk-or', ZHIPU_API_KEY: 'sk-zp' };
handler = mount({});
specs = await handler('specs', null, undefined);
check('A: auto discovery includes configured providers only', (() => {
	const ids = specs.value.rows.map((r) => r.id);
	return ids.includes('deepseek') && ids.includes('openrouter') && ids.includes('zhipu')
		&& !ids.includes('moonshot') && !ids.includes('opencode-go');
})());
check('A: catalog kinds/currencies derived', (() => {
	const or = specs.value.rows.find((r) => r.id === 'openrouter');
	const zp = specs.value.rows.find((r) => r.id === 'zhipu');
	return or.kind === 'balance' && or.currency === '$' && zp.kind === 'info' && zp.balanceTiers === undefined;
})());

// auto discovery + normalization across adapters
globalThis.fetch = async (url) => {
	if (String(url).includes('openrouter')) {
		return { ok: true, status: 200, json: async () => ({ data: { total_credits: 10, total_usage: 2.5 } }) };
	}
	if (String(url).includes('bigmodel')) {
		return { ok: true, status: 200, json: async () => ({ code: 200, data: { limits: [{ remaining: 5, number: 100 }, { remaining: 2, number: 10 }] } }) };
	}
	if (String(url).includes('deepseek')) {
		return { ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '58.36', granted_balance: '1', topped_up_balance: '2' }] }) };
	}
	return { ok: false, status: 404, json: async () => ({}) };
};
try {
	fetchAll = await handler('fetch-all', null, undefined);
} finally {
	globalThis.fetch = realFetch;
}
check('A: openrouter credits -> balance 7.5', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'openrouter');
	return row && row.view?.kind === 'balance' && row.view.amount === 7.5;
})());
check('A: zhipu limits -> info view', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'zhipu');
	return row && row.view?.kind === 'info' && row.view.text === '5/100 · 2/10';
})());


// ---------- A2c: siliconflow dual-site rows (global $ / cn ¥) ----------
credentialMap = { SILICONFLOW_API_KEY: 'sk-sf', SILICONFLOW_CN_API_KEY: 'sk-sfcn' };
handler = mount({});
specs = await handler('specs', null, undefined);
check('A: siliconflow dual-site rows discovered', (() => {
	const ids = specs.value.rows.map((r) => r.id);
	return ids.includes('siliconflow') && ids.includes('siliconflow-cn');
})());
check('A: siliconflow currencies split ($ global / ¥ cn)', (() => {
	const sf = specs.value.rows.find((r) => r.id === 'siliconflow');
	const sfc = specs.value.rows.find((r) => r.id === 'siliconflow-cn');
	return sf.kind === 'balance' && sf.currency === '$' && sfc.kind === 'balance' && sfc.currency === '¥';
})());
const sfHits = [];
globalThis.fetch = async (url) => {
	if (String(url).includes('api.siliconflow.com')) {
		sfHits.push('com');
		return { ok: true, status: 200, json: async () => ({ data: { balance: '12.34', chargeBalance: '10.00', totalUsage: '5.00' } }) };
	}
	if (String(url).includes('api.siliconflow.cn')) {
		sfHits.push('cn');
		return { ok: true, status: 200, json: async () => ({ data: { balance: '56.78', chargeBalance: '50.00', totalUsage: '8.00' } }) };
	}
	return { ok: false, status: 404, json: async () => ({}) };
};
try {
	fetchAll = await handler('fetch-all', null, undefined);
} finally {
	globalThis.fetch = realFetch;
}
check('A: siliconflow rows hit their own endpoints', sfHits.includes('com') && sfHits.includes('cn'));
check('A: siliconflow balances normalized', (() => {
	const sf = fetchAll.value.rows.find((r) => r.id === 'siliconflow');
	const sfc = fetchAll.value.rows.find((r) => r.id === 'siliconflow-cn');
	return sf.view?.kind === 'balance' && sf.view.amount === 12.34 && sfc.view?.kind === 'balance' && sfc.view.amount === 56.78;
})());
check('A: catalog currency override key accepted', (() => {
	try {
		mount({ catalog: { siliconflow: { currency: 'US$' } } });
		return true;
	} catch {
		return false;
	}
})());
// ---------- A2b: coding plan catalog (zai / kimi / minimax) ----------
credentialMap = { ZAI_CODING_CN_API_KEY: 'sk-zai-cn', ZAI_API_KEY: 'sk-zai', KIMI_API_KEY: 'sk-kimi', MINIMAX_CN_API_KEY: 'sk-mmcn', ZHIPU_API_KEY: 'sk-zp' };
handler = mount({});
specs = await handler('specs', null, undefined);
check('A: coding plan rows discovered', (() => {
	const ids = specs.value.rows.map((r) => r.id);
	return ids.includes('zai-coding-cn') && ids.includes('zai') && ids.includes('kimi-coding') && ids.includes('minimax-cn') && !ids.includes('minimax');
})());
check('A: coding plan kinds and window labels', (() => {
	const zc = specs.value.rows.find((r) => r.id === 'zai-coding-cn');
	const km = specs.value.rows.find((r) => r.id === 'kimi-coding');
	return zc.kind === 'usage' && zc.windowLabels?.rolling === '5h' && zc.windowLabels?.monthly === '月'
		&& km.kind === 'usage' && km.windowLabels?.rolling === '5h' && km.windowLabels?.monthly === '月';
})());
globalThis.fetch = async (url) => {
	const s = String(url);
	if (s.includes('bigmodel') || s.includes('api.z.ai')) {
		return { ok: true, status: 200, json: async () => ({ code: 200, success: true, data: { level: 'pro', limits: [
			{ type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 31, remaining: 969, percentage: 3, nextResetTime: 1893456000000 },
			{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 64, nextResetTime: 1893456000000 }
		] } }) };
	}
	if (s.includes('api.kimi.com')) {
		return { ok: true, status: 200, json: async () => ({ usage: { limit: '2048', used: '214', remaining: '1834', resetTime: '2026-01-09T15:23:13.716839Z' }, limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '200', used: '139', remaining: '61', resetTime: '2026-01-06T13:33:02.717Z' } }] }) };
	}
	if (s.includes('minimaxi')) {
		return { ok: true, status: 200, json: async () => ({ base_resp: { status_code: 0, status_msg: '' }, current_subscribe_title: 'MiniMax Coding', model_remains: [{ model: 'MiniMax-M2.5', current_interval_total_count: 100, current_interval_usage_count: 25, current_interval_remaining_percent: 75, end_time: 1893456000000 }] }) };
	}
	return { ok: false, status: 404, json: async () => ({}) };
};
try {
	fetchAll = await handler('fetch-all', null, undefined);
} finally {
	globalThis.fetch = realFetch;
}
check('A: zai coding quota -> usage windows', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'zai-coding-cn');
	const z = fetchAll.value.rows.find((r) => r.id === 'zai');
	return row && row.view?.kind === 'usage' && row.view.windows?.rolling?.percent === 64 && row.view.windows?.monthly?.percent === 3
		&& row.view.windows?.weekly === undefined && z.view?.windows?.rolling?.percent === 64;
})());
check('A: kimi coding usage windows', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'kimi-coding');
	return row && row.view?.kind === 'usage' && row.view.windows?.rolling?.percent === 70 && row.view.windows?.weekly?.percent === 10 && row.view.windows?.monthly === undefined;
})());
check('A: minimax remains -> usage percent', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'minimax-cn');
	return row && row.view?.kind === 'usage' && row.view.windows?.rolling?.percent === 25 && typeof row.view.windows?.rolling?.resetsAt === 'string';
})());
check('A: zhipu quota percentage fallback', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'zhipu');
	return row && row.view?.kind === 'info' && row.view.text === '969/1 · 64%';
})());

// ---------- A2d: search lane unknown / absent weekly (no fabricated 0%) ----------
let t1, t2;
globalThis.fetch = async (url) => {
	if (String(url).includes('bigmodel') || String(url).includes('api.z.ai')) {
		// TIME_LIMIT present but no parseable count/percent -> null
		return { ok: true, status: 200, json: async () => ({ code: 200, data: { limits: [
			{ type: 'TIME_LIMIT', unit: 5, number: 1, nextResetTime: 1893456000000 },
			{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 96, nextResetTime: 1893456000000 }
		] } }) };
	}
	return { ok: false, status: 404, json: async () => ({}) };
};
try { t1 = await handler('fetch-all', null, undefined); } finally { globalThis.fetch = realFetch; }
check('A: search lane unknown -> monthly.percent null', (() => {
	const row = t1.value.rows.find((r) => r.id === 'zai-coding-cn');
	return row.view?.kind === 'usage' && row.view.windows?.monthly?.percent === null;
})());
globalThis.fetch = async (url) => {
	if (String(url).includes('bigmodel') || String(url).includes('api.z.ai')) {
		// no TIME_LIMIT at all -> no monthly window; only 5h tokens
		return { ok: true, status: 200, json: async () => ({ code: 200, data: { limits: [
			{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 96, nextResetTime: 1893456000000 }
		] } }) };
	}
	return { ok: false, status: 404, json: async () => ({}) };
};
try { t2 = await handler('fetch-all', null, undefined); } finally { globalThis.fetch = realFetch; }
check('A: no TIME_LIMIT -> no monthly window (client drops/renders -%)', (() => {
	const row = t2.value.rows.find((r) => r.id === 'zai-coding-cn');
	const w = row.view?.windows;
	return w?.rolling?.percent === 96 && w?.weekly === undefined && w?.monthly === undefined;
})());
let t3;
globalThis.fetch = async (url) => {
	if (String(url).includes('bigmodel') || String(url).includes('api.z.ai')) {
		// currentValue 0 / usage 100 -> 0% is a REAL value, not unknown
		return { ok: true, status: 200, json: async () => ({ code: 200, data: { limits: [
			{ type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 0, percentage: 0, nextResetTime: 1893456000000 },
			{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 96, nextResetTime: 1893456000000 }
		] } }) };
	}
	return { ok: false, status: 404, json: async () => ({}) };
};
try { t3 = await handler('fetch-all', null, undefined); } finally { globalThis.fetch = realFetch; }
check('A: search lane 0% is kept as a real value', (() => {
	const row = t3.value.rows.find((r) => r.id === 'zai-coding-cn');
	return row.view?.windows?.monthly?.percent === 0;
})());

// ---------- A2e: coding-plan window semantics (issue #2 + glm-plan-usage2) ----------
let q1, q2, q3, q4;
globalThis.fetch = async (url) => {
	const s = String(url);
	if (s.includes('bigmodel') || s.includes('api.z.ai')) {
		// issue #2 payload: both TOKENS_LIMIT rows + TIME_LIMIT. Official console
		// says 5h=1%, weekly=40%, MCP monthly=1% — the size heuristic inverts
		// 5h/weekly and currentValue/usage (16/4000) reads as 0%.
		return { ok: true, status: 200, json: async () => ({ code: 200, data: { limits: [
			{ type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 16, percentage: 1, nextResetTime: 1893456000000 },
			{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: 1893456060000 },
			{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 40, nextResetTime: 1894059060000 }
		] } }) };
	}
	return { ok: false, status: 404, json: async () => ({}) };
};
try { q1 = await handler('fetch-all', null, undefined); } finally { globalThis.fetch = realFetch; }
check('A: zai unit=3 -> rolling, unit=6 -> weekly (not size order)', (() => {
	const w = q1.value.rows.find((r) => r.id === 'zai-coding-cn')?.view?.windows;
	return w?.rolling?.percent === 1 && w?.weekly?.percent === 40;
})());
check('A: zai TIME_LIMIT monthly prefers the percentage field', (() => {
	const w = q1.value.rows.find((r) => r.id === 'zai-coding-cn')?.view?.windows;
	return w?.monthly?.percent === 1;
})());
globalThis.fetch = async (url) => {
	const s = String(url);
	if (s.includes('bigmodel') || s.includes('api.z.ai')) {
		// unknown unit codes -> fall back to reset-time ordering (5h always
		// resets before weekly). Products invert here: unit9x2 < unit7x3.
		return { ok: true, status: 200, json: async () => ({ code: 200, data: { limits: [
			{ type: 'TOKENS_LIMIT', unit: 7, number: 3, percentage: 30, nextResetTime: 1893456060000 },
			{ type: 'TOKENS_LIMIT', unit: 9, number: 2, percentage: 90, nextResetTime: 1894059060000 }
		] } }) };
	}
	return { ok: false, status: 404, json: async () => ({}) };
};
try { q2 = await handler('fetch-all', null, undefined); } finally { globalThis.fetch = realFetch; }
check('A: zai unknown units -> nearer reset becomes rolling', (() => {
	const w = q2.value.rows.find((r) => r.id === 'zai-coding-cn')?.view?.windows;
	return w?.rolling?.percent === 30 && w?.weekly?.percent === 90;
})());
globalThis.fetch = async (url) => {
	if (String(url).includes('api.kimi.com')) {
		// glm-plan-usage2 shape: weekly window FIRST, no `used`, no top-level usage
		return { ok: true, status: 200, json: async () => ({ limits: [
			{ window: { duration: 10080, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '1000', remaining: '400', resetTime: '2026-01-12T00:00:00Z' } },
			{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '200', remaining: '50', resetTime: '2026-01-06T13:00:00Z' } }
		] }) };
	}
	return { ok: false, status: 404, json: async () => ({}) };
};
try { q3 = await handler('fetch-all', null, undefined); } finally { globalThis.fetch = realFetch; }
check('A: kimi rolling = duration-300 window (limit - remaining)', (() => {
	const w = q3.value.rows.find((r) => r.id === 'kimi-coding')?.view?.windows;
	return w?.rolling?.percent === 75 && typeof w?.rolling?.resetsAt === 'string';
})());
check('A: kimi weekly = duration-10080 window', (() => {
	const w = q3.value.rows.find((r) => r.id === 'kimi-coding')?.view?.windows;
	return w?.weekly?.percent === 60 && typeof w?.weekly?.resetsAt === 'string';
})());
globalThis.fetch = async (url) => {
	if (String(url).includes('minimaxi')) {
		// coding model NOT first; weekly fields only on the coding model row;
		// no remaining_percent anywhere (older builds)
		return { ok: true, status: 200, json: async () => ({ base_resp: { status_code: 0, status_msg: '' }, model_remains: [
			{ model_name: 'abab6.5s-chat', current_interval_total_count: 50, current_interval_usage_count: 10, end_time: 1893456000000 },
			{ model_name: 'MiniMax-M2.5', current_interval_total_count: 100, current_interval_usage_count: 25, end_time: 1893456060000, current_weekly_total_count: 1000, current_weekly_usage_count: 700, weekly_end_time: 1894059060000 }
		] }) };
	}
	return { ok: false, status: 404, json: async () => ({}) };
};
try { q4 = await handler('fetch-all', null, undefined); } finally { globalThis.fetch = realFetch; }
check('A: minimax prefers the MiniMax-M coding model row', (() => {
	const w = q4.value.rows.find((r) => r.id === 'minimax-cn')?.view?.windows;
	return w?.rolling?.percent === 75 && typeof w?.rolling?.resetsAt === 'string';
})());
check('A: minimax weekly window (weekly usage_count = remaining)', (() => {
	const w = q4.value.rows.find((r) => r.id === 'minimax-cn')?.view?.windows;
	return w?.weekly?.percent === 30 && typeof w?.weekly?.resetsAt === 'string';
})());


// hide drops catalog rows
handler = mount({ hide: ['zhipu'] });
specs = await handler('specs', null, undefined);
check('A: hide removes catalog row', !specs.value.rows.some((r) => r.id === 'zhipu'));

// specs carry the configured proxy name (render hint only, no URL)
credentialMap = { OPENROUTER_API_KEY: 'sk-or' };
handler = mount({ proxies: { home: 'http://127.0.0.1:7890' }, catalog: { openrouter: { proxy: 'home' } } });
specs = await handler('specs', null, undefined);
check('A: specs carries configured proxy name', specs.value.rows.find((r) => r.id === 'openrouter')?.proxy === 'home');
check('A: specs default proxy is null', specs.value.rows.every((r) => r.proxy === null || typeof r.proxy === 'string'));

// catalog override: label + proxy reference; auto off disables probing
handler = mount({ auto: false, catalog: { openrouter: { label: 'OR' } }, providers: [] });
specs = await handler('specs', null, undefined);
check('A: auto:false -> only explicit rows', specs.value.rows.length === 0);
let threw = false;
try { mount({ catalog: { openrouter: { proxy: 'nope' } } }); } catch { threw = true; }
check('A: catalog proxy without definition throws', threw);
threw = false;
try { mount({ catalog: { 'unknown-id': { label: 'x' } } }); } catch { threw = true; }
check('A: catalog override with unknown id throws', threw);
threw = false;
try { mount({ catalog: { openrouter: { bogus: 1 } } }); } catch { threw = true; }
check('A: catalog override with unknown key throws', threw);
threw = false;
try { mount({ proxies: { s5: 'socks5://127.0.0.1:1080' }, providers: [{ id: 'x', label: 'X', credential: 'C', endpoint: 'https://x.example/q', proxy: 's5' }] }); } catch { threw = true; }
check('A: socks proxy rejected', threw);
threw = false;
try {
	mount({ providers: [
		{ id: 'x', label: 'X', credential: 'C', endpoint: 'https://x.example/q', format: 'deepseek-balance' },
		{ id: 'x', label: 'X2', credential: 'C', endpoint: 'https://x.example/q', format: 'deepseek-balance' }
	] });
} catch { threw = true; }
check('A: duplicate ids throw', threw);
threw = false;
try { mount({ providers: [{ id: 'x', label: 'X', credential: 'C', endpoint: 'https://x.example/q', proxy: 'ghost' }] }); } catch { threw = true; }
check('A: provider proxy without definition throws', threw);

// explicit row with unconfigured credential fails loud per row
credentialMap = {};
handler = mount({ providers: [{ id: 'deepseek', label: 'DeepSeek', credential: 'DEEPSEEK_API_KEY', endpoint: 'https://api.deepseek.com/user/balance' }] });
fetchAll = await handler('fetch-all', null, undefined);
check('A: missing credential row gets error', (() => {
	const row = fetchAll.value.rows[0];
	return row && typeof row.error === 'string' && row.error.includes('DEEPSEEK_API_KEY');
})());

// ---------- A3: openai-billing double request ----------
const billingHits = [];
credentialMap = { AGG_KEY: 'sk-agg' };
globalThis.fetch = async (url) => {
	billingHits.push(String(url));
	if (String(url).endsWith('/v1/dashboard/billing/subscription')) {
		return { ok: true, status: 200, json: async () => ({ hard_limit_usd: 100 }) };
	}
	if (String(url).endsWith('/v1/dashboard/billing/usage')) {
		return { ok: true, status: 200, json: async () => ({ total_usage: 37.5 }) };
	}
	throw new Error('unexpected url ' + url);
};
try {
	handler = mount({ providers: [{ id: 'agg', label: '聚合站', credential: 'AGG_KEY', endpoint: 'https://agg.example', format: 'openai-billing' }] });
	fetchAll = await handler('fetch-all', null, undefined);
} finally {
	globalThis.fetch = realFetch;
}
check('A: openai-billing hits subscription + usage', billingHits.length === 2 && billingHits.every((u) => u.startsWith('https://agg.example/v1/dashboard/billing/')));
check('A: openai-billing remaining = limit - usage', (() => {
	const row = fetchAll.value.rows[0];
	return row.view?.kind === 'balance' && row.view.amount === 62.5;
})());

// ---------- A4: proxy engine against real local servers ----------
const upstream = http.createServer((req, res) => {
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '1', topped_up_balance: '2' }] }));
});
const seenProxied = [];
let connectAttempts = 0;
const proxy = http.createServer((req, res) => {
	seenProxied.push(req.url);
	const target = http.request(req.url, (up) => {
		res.writeHead(up.statusCode, up.headers);
		up.pipe(res);
	});
	req.pipe(target);
});
proxy.on('connect', (req, clientSocket, head) => {
	connectAttempts += 1;
	clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
	clientSocket.end();
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;
const proxyPort = proxy.address().port;
credentialMap = { LOCAL_KEY: 'sk-local' };
handler = mount({
	proxies: { home: `http://127.0.0.1:${proxyPort}` },
	providers: [
		{ id: 'via-proxy', label: 'ViaProxy', credential: 'LOCAL_KEY', endpoint: `http://127.0.0.1:${upstreamPort}/user/balance`, format: 'deepseek-balance', proxy: 'home' },
		{ id: 'connect-refused', label: 'ConnectRefused', credential: 'LOCAL_KEY', endpoint: 'https://blocked.example/user/balance', format: 'deepseek-balance', proxy: 'home' }
	]
});
fetchAll = await handler('fetch-all', null, undefined);
check('A: proxied http GET uses absolute URI', seenProxied.length === 1 && seenProxied[0].includes(`http://127.0.0.1:${upstreamPort}/user/balance`));
check('A: proxied row normalized', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'via-proxy');
	return row && row.view?.amount === 12.34;
})());
check('A: refused CONNECT surfaces per-row error', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'connect-refused');
	return row && typeof row.error === 'string' && row.error.includes('proxy CONNECT failed: HTTP 403');
})());

// client-supplied proxy override (settings panel) wins over profile config
seenProxied.length = 0;
handler = mount({
	providers: [
		{ id: 'client-proxy', label: 'ClientProxy', credential: 'LOCAL_KEY', endpoint: `http://127.0.0.1:${upstreamPort}/user/balance`, format: 'deepseek-balance' }
	]
});
fetchAll = await handler('fetch-all', { proxy: { 'client-proxy': `http://127.0.0.1:${proxyPort}` } }, undefined);
check('A: client proxy override routes via proxy', seenProxied.length === 1 && seenProxied[0].includes('/user/balance'));
check('A: client proxy override row ok', (() => {
	const row = fetchAll.value.rows[0];
	return row && row.view?.amount === 12.34 && row.error === undefined;
})());
fetchAll = await handler('fetch-all', { proxy: { 'client-proxy': 'socks5://127.0.0.1:1080' } }, undefined);
check('A: invalid client proxy -> row error', (() => {
	const row = fetchAll.value.rows[0];
	return row && typeof row.error === 'string' && row.error.includes('client proxy');
})());
proxy.close();
upstream.close();

// ---------- A5: Config schema ----------
check('A: Config defaults', (() => {
	const filled = plugin.Config({});
	return filled.refreshMs === 60000 && filled.auto === true && Array.isArray(filled.hide) && filled.hide.length === 0
		&& typeof filled.proxies === 'object' && typeof filled.catalog === 'object' && Array.isArray(filled.providers);
})());
check('A: Config rejects bad format', (() => {
	try { plugin.Config({ providers: [{ id: 'x', label: 'X', credential: 'C', endpoint: 'https://x.example/q', format: 'nope' }] }); return false; }
	catch { return true; }
})());
check('A: Config rejects bad id pattern', (() => {
	try { plugin.Config({ providers: [{ id: 'Bad_Id', label: 'X', credential: 'C', endpoint: 'https://x.example/q' }] }); return false; }
	catch { return true; }
})());
check('A: inject is connection+credentials', JSON.stringify(plugin.inject) === JSON.stringify(['connection', 'credentials']));

// ---------- Part B: client half ----------
const clientSource = readFileSync(join(root, 'lib/client.js'), 'utf8');
const handoffs = [];
const sandbox = {
	window: { __ModuleLoader__: { load: (handoff) => handoffs.push(handoff) } },
	globalThis: { localStorage: { getItem: () => null, setItem: () => {} } },
	document: {
		createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
		head: { append: () => {} },
		addEventListener: () => {},
		removeEventListener: () => {}
	}
};
vm.createContext(sandbox);
vm.runInContext(clientSource, sandbox);

check('B: one handoff registered', handoffs.length === 1);
check('B: handoff id matches package name', handoffs[0]?.id === 'dsh-quota-panel');

// A minimal React stub: enough for module-level + apply-time usage.
const reactStub = {
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useEffect: () => {},
	useRef: (init) => ({ current: init }),
	createElement: (type, props, ...children) => ({ type, props, children })
};
const clientExports = handoffs[0].factory((spec) => {
	if (spec === 'react') return reactStub;
	throw new Error(`unexpected require: ${spec}`);
});
check('B: exports apply + inject', typeof clientExports.apply === 'function' && Array.isArray(clientExports.inject));
check('B: inject services', JSON.stringify(clientExports.inject) === JSON.stringify(['slots', 'timer', 'connection', 'locale']));

let injectedSlot = null;
let registered = null;
let localeDicts = null;
const clientCtx = {
	effect: (fn) => { fn(); return () => {}; },
	interval: () => () => {},
	timeout: () => () => {},
	slots: {
		inject: (name, fn) => { injectedSlot = name; fn(); },
		register: (spec, renderer) => { registered = { spec, renderer }; }
	},
	locale: {
		register: (ns, dicts) => { localeDicts = { ns, dicts }; return () => {}; },
		bind: () => (key, params) => key
	},
	connection: { rpc: { call: async () => ({ ok: false, error: { code: 'internal', message: 'stub' } }) } }
};
clientExports.apply(clientCtx);
check('B: injects into shell.overlay', injectedSlot === 'shell.overlay');
check('B: registers entry id dsh-quota-panel', registered?.spec?.id === 'dsh-quota-panel' && registered?.spec?.name === 'shell.overlay' && registered?.spec?.locale === 'quota-panel');
check('B: locale dictionaries registered (zh + en)', !!localeDicts && localeDicts.ns === 'quota-panel' && !!localeDicts.dicts.zh && !!localeDicts.dicts.en && localeDicts.dicts.zh.title === '模型额度' && localeDicts.dicts.en.title === 'Model quota');
const element = registered.renderer({ t: (key) => key });
check('B: renderer returns element', element && typeof element.type === 'function');

// ---------- B2: capsule display mode (issue #2 follow-up) ----------
// The collapsed capsule follows capsuleMode: auto/max = highest window
// (current behavior kept as default), rolling = the 5h window, weekly =
// the weekly window. Status dot / progress bar / caption align with the
// SHOWN value, so a 5h capsule does not glow warn because the weekly pool
// sits at 40%.
{
	const patched = clientSource.replace(
		'exports.apply = apply;',
		'exports.__rowView = rowView;\nexports.__clampPos = clampPos;\nexports.apply = apply;'
	);
	const handoffs2 = [];
	const sandbox2 = {
		window: { __ModuleLoader__: { load: (h) => handoffs2.push(h) } },
		globalThis: { localStorage: { getItem: () => null, setItem: () => {} } },
		document: {
			createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
			head: { append: () => {} },
			addEventListener: () => {},
			removeEventListener: () => {}
		}
	};
	vm.createContext(sandbox2);
	vm.runInContext(patched, sandbox2);
	const factoryExports = handoffs2[0].factory((spec) => {
		if (spec === 'react') return reactStub;
		throw new Error(`unexpected require: ${spec}`);
	});
	const rowView = factoryExports.__rowView;
	const t2 = (key) => key;
	const baseSpec = { kind: 'usage', windowLabels: {}, warnPercent: 70, errorPercent: 90 };
	const entry2 = { view: { kind: 'usage', windows: {
		rolling: { percent: 1, resetsAt: '2026-08-19T14:20:00.000Z' },
		weekly: { percent: 40, resetsAt: '2026-08-21T12:01:00.000Z' },
		monthly: { percent: 1, resetsAt: '2026-08-19T12:01:00.000Z' }
	} } };
	const modeView = {};
	for (const mode of ['auto', 'rolling', 'weekly', 'max']) {
		modeView[mode] = rowView(t2, { ...baseSpec, capsuleMode: mode }, entry2);
	}
	modeView.unset = rowView(t2, { ...baseSpec }, entry2);
	check('B: capsule auto = highest window (default behavior kept)', modeView.auto.summary === '40%' && modeView.unset.summary === '40%' && modeView.max.summary === '40%');
	check('B: capsule rolling shows the 5h window', modeView.rolling.summary === '1%' && modeView.rolling.barPercent === 1);
	check('B: capsule weekly shows the weekly window (not the max)', rowView(t2, { ...baseSpec, capsuleMode: 'weekly' }, { view: { kind: 'usage', windows: { rolling: { percent: 90, resetsAt: '2026-08-19T14:20:00.000Z' }, weekly: { percent: 40, resetsAt: '2026-08-21T12:01:00.000Z' } } } }).summary === '40%');
	check('B: capsule status aligns with the shown window (5h 1% stays ok despite weekly 40%)', modeView.rolling.status === 'ok' && modeView.auto.status === 'ok');
	const splitEntry = { view: { kind: 'usage', windows: {
		rolling: { percent: 10, resetsAt: '2026-08-19T14:20:00.000Z' },
		weekly: { percent: 75, resetsAt: '2026-08-21T12:01:00.000Z' }
	} } };
	check('B: capsule rolling ignores weekly pressure (ok when 5h 10% / weekly 75%)', rowView(t2, { ...baseSpec, capsuleMode: 'rolling' }, splitEntry).status === 'ok');
	check('B: capsule auto still warns on weekly pressure (warn when weekly 75%)', rowView(t2, { ...baseSpec, capsuleMode: 'auto' }, splitEntry).status === 'warn');
	const warnEntry = { view: { kind: 'usage', windows: {
		rolling: { percent: 75, resetsAt: '2026-08-19T14:20:00.000Z' },
		weekly: { percent: 90, resetsAt: '2026-08-21T12:01:00.000Z' }
	} } };
	check('B: capsule rolling warns (not errors) on 5h 75% while weekly 90% errors in auto', rowView(t2, { ...baseSpec, capsuleMode: 'rolling' }, warnEntry).status === 'warn' && rowView(t2, { ...baseSpec, capsuleMode: 'auto' }, warnEntry).status === 'error');
	// Plans WITHOUT the chosen window fall back to the highest (single-window
	// plans like zai-without-weekly must not show a broken capsule).
	const noWeekly = { view: { kind: 'usage', windows: {
		rolling: { percent: 30, resetsAt: '2026-08-19T14:20:00.000Z' },
		monthly: { percent: 5, resetsAt: '2026-08-19T12:01:00.000Z' }
	} } };
	check('B: capsule weekly on a plan without weekly falls back to highest', rowView(t2, { ...baseSpec, capsuleMode: 'weekly' }, noWeekly).summary === '30%');
	const noRolling = { view: { kind: 'usage', windows: { weekly: { percent: 80, resetsAt: '2026-08-21T12:01:00.000Z' } } } };
	check('B: capsule rolling on a plan without rolling falls back to highest', rowView(t2, { ...baseSpec, capsuleMode: 'rolling' }, noRolling).summary === '80%');
	check('B: capsule mode setting + dictionary keys shipped', clientSource.includes('capsuleMode') && clientSource.includes('settingsCapsule') && clientSource.includes('capsuleAuto') && clientSource.includes('capsuleRolling') && clientSource.includes('capsuleWeekly') && clientSource.includes('capsuleMax'));
	// Layout fixes from issue #1: the capsule must clear the bottom status
	// row, and the shell overlay layer must not sit UNDER body-mounted
	// third-party fixed panels (z-index 1000+).
	// Layout from issue #1, reworked per maintainer feedback: the default
	// position stays 18px (60px looked bad) and the panel is DRAGGABLE
	// instead; the overlay lift stays.
	check('B: capsule default bottom stays 18px (drag replaces the offset)', /#dsh-quota-panel\{[^}]*bottom:18px/.test(clientSource));
	check('B: overlay layer lift rule injected (z-index 1150 over body panels)', clientSource.includes('[class*="overlayLayer"]{z-index:1150 !important;}'));
	// Drag: pointer capture + move threshold (click-to-expand intact),
	// position clamped into the viewport and persisted with the other
	// settings; reset clears it.
	check('B: drag uses pointer capture with move+up handlers', clientSource.includes('setPointerCapture') && clientSource.includes('onPointerDown') && clientSource.includes('onPointerMove') && clientSource.includes('onPointerUp'));
	check('B: drag threshold suppresses the expand click', clientSource.includes('DRAG_THRESHOLD') && clientSource.includes('suppressClick'));
	check('B: drag position persisted + reset clears it', clientSource.includes('position: null') && (clientSource.split('position: null').length - 1) >= 2);
	check('B: drag touch-action none (capsule + header handles)', clientSource.includes('touch-action:none') && clientSource.includes('cursor:grab'));
	check('B: clampPos keeps the corner reachable on every edge', (() => {
		const f = factoryExports.__clampPos;
		if (typeof f !== 'function') return false;
		const a = f(-50, -50, 1000, 800);
		const b = f(5000, 5000, 1000, 800);
		const c = f(100, 100, 1000, 800);
		return a.x === 8 && a.y === 8 && b.x === 992 && b.y === 792 && c.x === 100 && c.y === 100;
	})());
	// Anchor semantics: the stored point is the capsule's BOTTOM-RIGHT corner.
	// All three sizes (capsule / card / card+settings) grow toward the top-
	// left from that shared corner, so expanding never shifts the anchor.
	check('B: dragged panel anchors its bottom-right corner (right/bottom px, no left/top)', (() => {
		const m = clientSource.match(/panelStyle = ([^;]+);/);
		return !!m && /right:/.test(m[1]) && /bottom:/.test(m[1]) && !/left:/.test(m[1]) && !/top:/.test(m[1]);
	})());
	check('B: clampPos clamps the bottom-right corner (max = vw-8 / vh-8)', (() => {
		const f = factoryExports.__clampPos;
		const b = f(5000, 5000, 1000, 800);
		const c = f(1000 - 8, 800 - 8, 1000, 800);
		return b.x === 992 && b.y === 792 && c.x === 992 && c.y === 792;
	})());
	check('B: drag stores the pointer-grab offset from the bottom-right corner', clientSource.includes('baseRight') && clientSource.includes('baseBottom') && clientSource.includes('anchorRight') && clientSource.includes('anchorBottom'));
}

// Surface checks on the bundle source (gear entry, aria, persistence, overlay opt-in).
const surface = {
	'gear button ⚙': clientSource.includes('"⚙"'),
	'gear aria keys': clientSource.includes('openSettings') && clientSource.includes('closeSettings'),
	'gear active class': clientSource.includes('is-active'),
	'aria keys present': clientSource.includes('t("expand")') && clientSource.includes('t("collapse")') && clientSource.includes('t("refresh")'),

	'settings: provider visibility key': clientSource.includes('settingsProviders'),
	'settings: refresh interval key': clientSource.includes('settingsInterval') && clientSource.includes('followConfig'),
	'settings: warn thresholds key': clientSource.includes('settingsThresholds'),
	'settings: proxy section key': clientSource.includes('settingsProxy') && clientSource.includes('setProxy'),
	'fetch-all payload carries proxy': clientSource.includes('"fetch-all", { proxy: proxyPayload }'),
	'reset clears proxy': clientSource.includes('proxy: {}'),
	'settings: reset button key': clientSource.includes('resetDefaults'),
	'settings persist localStorage': clientSource.includes('localStorage') && clientSource.includes('dsh-quota-panel:settings'),
	'pointer-events opt-in (overlay)': clientSource.includes('pointer-events:auto'),
	'rpc channel matches host': clientSource.includes('"/dsh-quota-panel"') && clientSource.includes('"specs"') && clientSource.includes('"fetch-all"'),
	'rpc error keys': clientSource.includes('loadFailed') && clientSource.includes('fetchFailed'),
	'hidden-page skip': clientSource.includes('document.hidden'),
	'visibilitychange': clientSource.includes('visibilitychange'),
	'hidden-all fallback key': clientSource.includes('allHidden'),
	'zh and en dictionaries shipped': clientSource.includes('title: "模型额度"') && clientSource.includes('title: "Model quota"') && clientSource.includes('zh: {') && clientSource.includes('en: {'),
	'view kinds rendered': clientSource.includes('view.kind === "usage"') && clientSource.includes('view.kind === "info"') && clientSource.includes('"balance"'),
	'info status styled': clientSource.includes('state-info'),
	'settings thresholds follow spec.kind': clientSource.includes('spec.kind === "info"'),
	'no innerHTML': !clientSource.includes('innerHTML'),
	'no secrets in client': !clientSource.includes('credential') && !clientSource.includes('Bearer'),
	'tokens used': clientSource.includes('--dsw-alias-') && clientSource.includes('--dsw-static-'),
	'no literal </script>': !clientSource.includes('</script')
};
for (const [name, pass] of Object.entries(surface)) check(`B: ${name}`, pass);

if (!ok) process.exit(1);
console.log('\nAll dual-face checks passed.');
