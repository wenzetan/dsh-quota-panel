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

// hide drops catalog rows
handler = mount({ hide: ['zhipu'] });
specs = await handler('specs', null, undefined);
check('A: hide removes catalog row', !specs.value.rows.some((r) => r.id === 'zhipu'));

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
proxy.close();
upstream.close();
check('A: proxied http GET uses absolute URI', seenProxied.length === 1 && seenProxied[0].includes(`http://127.0.0.1:${upstreamPort}/user/balance`));
check('A: proxied row normalized', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'via-proxy');
	return row && row.view?.amount === 12.34;
})());
check('A: refused CONNECT surfaces per-row error', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'connect-refused');
	return row && typeof row.error === 'string' && row.error.includes('proxy CONNECT failed: HTTP 403');
})());

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
	createElement: (type, props, ...children) => ({ type, props, children })
};
const clientExports = handoffs[0].factory((spec) => {
	if (spec === 'react') return reactStub;
	throw new Error(`unexpected require: ${spec}`);
});
check('B: exports apply + inject', typeof clientExports.apply === 'function' && Array.isArray(clientExports.inject));
check('B: inject services', JSON.stringify(clientExports.inject) === JSON.stringify(['slots', 'timer', 'connection']));

let injectedSlot = null;
let registered = null;
const clientCtx = {
	effect: (fn) => { fn(); return () => {}; },
	interval: () => () => {},
	timeout: () => () => {},
	slots: {
		inject: (name, fn) => { injectedSlot = name; fn(); },
		register: (spec, renderer) => { registered = { spec, renderer }; }
	},
	connection: { rpc: { call: async () => ({ ok: false, error: { code: 'internal', message: 'stub' } }) } }
};
clientExports.apply(clientCtx);
check('B: injects into shell.overlay', injectedSlot === 'shell.overlay');
check('B: registers entry id dsh-quota-panel', registered?.spec?.id === 'dsh-quota-panel' && registered?.spec?.name === 'shell.overlay');
const element = registered.renderer();
check('B: renderer returns element', element && typeof element.type === 'function');

// Surface checks on the bundle source (gear entry, aria, persistence, overlay opt-in).
const surface = {
	'gear button ⚙': clientSource.includes('"⚙"'),
	'gear aria 打开设置/关闭设置': clientSource.includes('打开设置') && clientSource.includes('关闭设置'),
	'gear active class': clientSource.includes('is-active'),
	'refresh button + aria': clientSource.includes('刷新模型额度'),
	'collapse aria': clientSource.includes('收起模型额度'),
	'capsule expand aria': clientSource.includes('展开模型额度'),
	'settings: provider visibility': clientSource.includes('显示供应商'),
	'settings: refresh interval': clientSource.includes('刷新间隔') && clientSource.includes('跟随配置'),
	'settings: warn thresholds': clientSource.includes('预警阈值'),
	'settings: reset button': clientSource.includes('恢复默认'),
	'settings persist localStorage': clientSource.includes('localStorage') && clientSource.includes('dsh-quota-panel:settings'),
	'pointer-events opt-in (overlay)': clientSource.includes('pointer-events:auto'),
	'rpc channel matches host': clientSource.includes('"/dsh-quota-panel"') && clientSource.includes('"specs"') && clientSource.includes('"fetch-all"'),
	'rpc error surfaced': clientSource.includes('查询失败') && clientSource.includes('无法读取配置'),
	'hidden-page skip': clientSource.includes('document.hidden'),
	'visibilitychange': clientSource.includes('visibilitychange'),
	'hidden-all fallback text': clientSource.includes('已全部隐藏'),
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
