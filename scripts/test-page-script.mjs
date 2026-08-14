// Syntax + content check for the emitted page script (v0.3 capsule + card).
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
		{ id: 'deepseek', label: 'DeepSeek', credential: 'DEEPSEEK_API_KEY', endpoint: 'https://api.deepseek.com/user/balance', format: 'deepseek-balance', balanceTiers: { critical: 10, warn: 20, healthy: 50 } },
		{ id: 'opencode-go', label: 'OpenCode Go', credential: 'OPENCODE_GO_API_KEY', endpoint: 'https://opencode.ai/zen/go/v1/usage', format: 'opencode-usage', windowLabels: { rolling: '五', weekly: '周', monthly: '月' }, warnPercent: 70, errorPercent: 90 }
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
	'panel root id': inner.includes('dsh-quota-panel'),
	'capsule id': inner.includes('dsh-quota-capsule'),
	'card id': inner.includes('dsh-quota-card'),
	'capsule default collapsed (card hidden)': inner.includes('cardEl.hidden = true'),
	'setExpanded toggle': inner.includes('function setExpanded') && inner.includes('capsuleEl.hidden = open') && inner.includes('cardEl.hidden = !open'),
	'aria-expanded on capsule': inner.includes("setAttribute('aria-expanded'"),
	'expand on capsule click': inner.includes("setExpanded(true)"),
	'collapse button': inner.includes('收起模型额度') && inner.includes("setExpanded(false)"),
	'capsule has no text labels (额度/用量)': !inner.includes('dsh-capsule-label') && !inner.includes("'额度'") && !inner.includes("'用量 '"),
	'capsule chevron': inner.includes('dsh-capsule-chevron'),
	'per-provider dot map': inner.includes('CAPSULE_DOTS'),
	'per-provider value map': inner.includes('CAPSULE_VALUES'),
	'per-provider independent dot state': inner.includes("dot.className = 'dsh-capsule-dot state-' + status"),
	'usage battery-green when ok': inner.includes('.dsh-capsule-item.state-ok.dsh-usage'),
	'dot battery colors': inner.includes('.dsh-capsule-dot.state-ok') && inner.includes('.dsh-capsule-dot.state-warn') && inner.includes('.dsh-capsule-dot.state-error'),
	'value battery colors': inner.includes('.dsh-capsule-item.state-warn') && inner.includes('.dsh-capsule-item.state-error'),
	'hidden attribute enforced over display': inner.includes('#dsh-quota-panel [hidden]{display:none!important}'),
	'card state dots kept': inner.includes('#dsh-quota-card .state-warn .dsh-status-dot') && inner.includes('#dsh-quota-card .state-error .dsh-status-dot'),
	'STATE summary for deepseek': inner.includes("summary: '¥' + total.toFixed(2)"),
	'STATE summary for usage': inner.includes("summary: high + '%'"),
	'expand triggers refresh': inner.includes('if (open) refreshAll()'),
	'header title 模型额度': inner.includes('模型额度'),
	'refresh button + aria-label': inner.includes('dsh-quota-icon') && inner.includes('刷新模型额度'),
	'provider loop over ROWS': inner.includes('for (var i = 0; i < ROWS.length; i++)'),
	'progress bar': inner.includes('dsh-progress-fill'),
	'caption 当前最高占用': inner.includes('当前最高占用'),
	'4-tier balance text': inner.includes('建议充值') && inner.includes('余额紧张') && inner.includes('余额充足') && inner.includes('余额正常'),
	'error sub 暂时无法获取余额': inner.includes('暂时无法获取余额'),
	'loading text 正在更新': inner.includes('正在更新'),
	'refresh guard': inner.includes('if (refreshing) return'),
	'hidden-page skip': inner.includes('document.hidden'),
	'visibilitychange': inner.includes('visibilitychange'),
	'z-index 900': inner.includes('z-index:900'),
	'capsule height 32 / radius 18': inner.includes('height:32px') && inner.includes('border-radius:18px'),
	'card width 300 / radius 16': inner.includes('width:300px') && inner.includes('border-radius:16px'),
	'token border-l2': inner.includes('--dsw-alias-border-l2'),
	'token shadow lv2 + lv3': inner.includes('--dsw-shadow-lv2') && inner.includes('--dsw-shadow-lv3'),
	'token font-family': inner.includes('--dsw-font-family'),
	'token bg-layer-2': inner.includes('--dsw-alias-bg-layer-2'),
	'token deepseek-500 progress': inner.includes('--dsw-static-deepseek-500'),
	'token green/amber/red states': inner.includes('--dsw-static-green-500') && inner.includes('--dsw-static-amber-500') && inner.includes('--dsw-static-red-500'),
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
