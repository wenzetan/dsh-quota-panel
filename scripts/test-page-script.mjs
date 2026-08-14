// Syntax + content check for the emitted page script (v0.2 native card).
import vm from 'node:vm';

const plugin = await import('file:///D:/deepseek/dsh-quota-panel/lib/index.js');

const taps = [];
const ctx = {
	credentials: { resolve: async () => ({ value: 'sk-test', source: 'file' }) },
	webServer: {
		register: (route) => { console.log('route:', route.path); return () => {}; },
		tapIndex: (fn) => { taps.push(fn); return () => {}; }
	},
	effect: (fn) => { fn(); return () => {}; }
};
plugin.apply(ctx, {
	refreshMs: 60000,
	providers: [
		{ id: 'deepseek', label: 'DeepSeek', credential: 'DEEPSEEK_API_KEY', endpoint: 'https://api.deepseek.com/user/balance', format: 'deepseek-balance' },
		{ id: 'opencode-go', label: 'OpenCode Go', credential: 'OPENCODE_GO_API_KEY', endpoint: 'https://opencode.ai/zen/go/v1/usage', format: 'opencode-usage', windowLabels: { rolling: '五', weekly: '周', monthly: '月' } }
	]
});

const html = taps[0]('</body>');
const start = html.indexOf('(function () {');
const end = html.lastIndexOf('})();');
const inner = html.slice(start, end + '})();'.length);
if (start < 0 || end < 0) throw new Error('script markers not found');

try {
	new vm.Script(inner);
	console.log('page script syntax OK');
} catch (e) {
	console.error('SYNTAX ERROR:', e.message);
	process.exit(1);
}

const checks = {
	'panel id': inner.includes('dsh-quota-panel'),
	'header title 模型额度': inner.includes('模型额度'),
	'refresh button + aria-label': inner.includes('dsh-quota-refresh') && inner.includes('刷新模型额度'),
	'provider loop over ROWS': inner.includes('for (var i = 0; i < ROWS.length; i++)'),
	'view-based render (no whole-panel rebuild)': inner.includes('VIEWS') && inner.includes('createProviderView'),
	'deepseek renderer': inner.includes('renderDeepSeek'),
	'usage renderer': inner.includes('renderUsage'),
	'progress bar': inner.includes('dsh-progress-fill'),
	'caption 当前最高占用': inner.includes('当前最高占用'),
	'4-tier balance text 建议充值': inner.includes('建议充值'),
	'4-tier balance text 余额紧张': inner.includes('余额紧张'),
	'4-tier balance text 余额充足': inner.includes('余额充足'),
	'error sub 暂时无法获取余额': inner.includes('暂时无法获取余额'),
	'loading text 正在更新': inner.includes('正在更新'),
	'refresh guard': inner.includes('if (refreshing) return'),
	'hidden-page skip': inner.includes('document.hidden'),
	'visibilitychange': inner.includes('visibilitychange'),
	'z-index 900': inner.includes('z-index:900'),
	'width 300px': inner.includes('width:300px'),
	'radius 16px': inner.includes('border-radius:16px'),
	'token border-l2': inner.includes('--dsw-alias-border-l2'),
	'token shadow-lv3': inner.includes('--dsw-shadow-lv3'),
	'token font-family': inner.includes('--dsw-font-family'),
	'token bg-layer-2': inner.includes('--dsw-alias-bg-layer-2'),
	'token deepseek-500 progress': inner.includes('--dsw-static-deepseek-500'),
	'token green-500 dot': inner.includes('--dsw-static-green-500'),
	'token amber/red state': inner.includes('--dsw-static-amber-500') && inner.includes('--dsw-static-red-500'),
	'no neon green #7ee787': !inner.includes('#7ee787'),
	'no dark HUD rgba(18,22,30': !inner.includes('rgba(18,22,30'),
	'no monospace font': !inner.includes('monospace'),
	'no backdrop-filter': !inner.includes('backdrop-filter'),
	'no innerHTML data injection': !inner.includes('innerHTML'),
	'tabular-nums': inner.includes('tabular-nums'),
	'config balanceTiers embedded': inner.includes('balanceTiers'),
	'window label 五 from config': inner.includes('五')
};
let ok = true;
for (const [name, pass] of Object.entries(checks)) {
	console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}`);
	if (!pass) ok = false;
}
if (!ok) process.exit(1);
