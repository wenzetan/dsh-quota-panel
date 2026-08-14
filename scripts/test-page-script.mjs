// Dual-face check for dsh-quota-panel v0.4+ (host RPC half + browser client half).
//
// Part A exercises lib/index.js: Config schema defaults, cross-field
// validation, the loopback RPC channel contract (`specs` / `fetch-all` /
// unknown endpoint), and per-row error capture with a mocked global fetch.
// Part B exercises lib/client.js: the `__ModuleLoader__` handoff shape, the
// `shell.overlay` slot registration, and the settings-panel surface.
import vm from 'node:vm';
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

const BASE_CONFIG = {
	refreshMs: 60000,
	providers: [
		{ id: 'deepseek', label: 'DeepSeek', credential: 'DEEPSEEK_API_KEY', endpoint: 'https://api.deepseek.com/user/balance', format: 'deepseek-balance', balanceTiers: { critical: 10, warn: 20, healthy: 50 } },
		{ id: 'opencode-go', label: 'OpenCode Go', credential: 'OPENCODE_GO_API_KEY', endpoint: 'https://opencode.ai/zen/go/v1/usage', format: 'opencode-usage', windowLabels: { rolling: '五', weekly: '周', monthly: '月' }, warnPercent: 70, errorPercent: 90 }
	]
};

// ---------- Part A: host half ----------
const registrations = [];
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
		resolve: async (ref) => ref === 'DEEPSEEK_API_KEY' ? { value: 'sk-test', source: 'file' } : undefined
	}
};
plugin.apply(hostCtx, structuredClone(BASE_CONFIG));

check('A: one RPC registration', registrations.length === 1);
check('A: channel /dsh-quota-panel', registrations[0]?.channel === '/dsh-quota-panel');
check('A: authority loopback', registrations[0]?.options?.authority === 'loopback');
const handler = registrations[0].handler;

const specs = await handler('specs', null, undefined);
check('A: specs ok envelope', specs.ok === true && Array.isArray(specs.value.rows) && specs.value.rows.length === 2);
check('A: specs row fields', (() => {
	const row = specs.value.rows[0];
	return row.id === 'deepseek' && row.label === 'DeepSeek' && row.format === 'deepseek-balance'
		&& row.balanceTiers.critical === 10 && row.balanceTiers.warn === 20 && row.balanceTiers.healthy === 50;
})());
check('A: specs carries refreshMs', specs.value.refreshMs === 60000);
check('A: specs leaks no credential/endpoint', (() => {
	const text = JSON.stringify(specs);
	return !text.includes('DEEPSEEK_API_KEY') && !text.includes('api.deepseek.com');
})());

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
	if (String(url).includes('deepseek')) {
		return { ok: true, status: 200, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '58.36', granted_balance: '10.00', topped_up_balance: '48.36' }] }) };
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
check('A: deepseek row passes through data', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'deepseek');
	return row && row.data?.balance_infos?.[0]?.total_balance === '58.36';
})());
check('A: missing credential row gets error', (() => {
	const row = fetchAll.value.rows.find((r) => r.id === 'opencode-go');
	return row && typeof row.error === 'string' && row.error.includes('OPENCODE_GO_API_KEY');
})());

const unknown = await handler('bogus', null, undefined);
check('A: unknown endpoint -> ok:false', unknown.ok === false && unknown.error.code === 'internal');

let threw = false;
try {
	plugin.apply({ ...hostCtx, connection: { rpc: { handle: () => {} } } }, { providers: [
		{ id: 'x', label: 'X', credential: 'C', endpoint: 'https://x.example/q', format: 'deepseek-balance' },
		{ id: 'x', label: 'X2', credential: 'C', endpoint: 'https://x.example/q', format: 'deepseek-balance' }
	] });
} catch (e) { threw = true; }
check('A: duplicate ids throw', threw);

check('A: Config defaults', (() => {
	const filled = plugin.Config({});
	return filled.refreshMs === 60000 && Array.isArray(filled.providers) && filled.providers.length === 0;
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
	'no innerHTML': !clientSource.includes('innerHTML'),
	'no secrets in client': !clientSource.includes('credential') && !clientSource.includes('Bearer'),
	'tokens used': clientSource.includes('--dsw-alias-') && clientSource.includes('--dsw-static-'),
	'no literal </script>': !clientSource.includes('</script')
};
for (const [name, pass] of Object.entries(surface)) check(`B: ${name}`, pass);

if (!ok) process.exit(1);
console.log('\nAll dual-face checks passed.');
