// Generate self-contained demo pages (docs/demo.html light + docs/demo-dark.html)
// for dsh-quota-panel. Each reproduces the real injected panel script captured
// from the actual plugin module, over a mock Harness-like chat surface.
// The light page defines the Harness design tokens (light values); the dark
// page adds data-ds-dark-theme with the dark token values, proving the card
// follows the product theme instead of carrying its own palette.
import { writeFile } from 'node:fs/promises';

const plugin = await import('file:///D:/deepseek/dsh-quota-panel/lib/index.js');

// Capture the injected script exactly as the plugin would produce it.
const taps = [];
const ctx = {
	credentials: { resolve: async () => ({ value: 'sk-mock', source: 'file' }) },
	webServer: {
		register: () => () => {},
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
const injected = taps[0]('</body>');

const mockFetch = `<script>
window.fetch = function (url) {
  var data;
  if (String(url).indexOf('deepseek') >= 0) {
    data = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '58.36', granted_balance: '0.00', topped_up_balance: '58.36' }] };
  } else {
    data = { usage: {
      rolling: { status: 'ok', percent: 10, resetsAt: new Date(Date.now() + 4 * 3600e3).toISOString() },
      weekly:  { status: 'ok', percent: 45, resetsAt: new Date(Date.now() + 2 * 86400e3).toISOString() },
      monthly: { status: 'ok', percent: 22, resetsAt: new Date(Date.now() + 27 * 86400e3).toISOString() }
    } };
  }
  return Promise.resolve({ json: function () { return Promise.resolve(data); } });
};
<\/script>`;

const TOKENS_LIGHT = `body {
  --dsw-alias-bg-layer-2: #ffffff;
  --dsw-alias-bg-overlay: #ebeef2;
  --dsw-alias-border-l1: rgba(0,0,0,.06);
  --dsw-alias-border-l2: rgba(0,0,0,.10);
  --dsw-alias-label-primary: #1b1b1c;
  --dsw-alias-label-secondary: #61666b;
  --dsw-alias-interactive-bg-hover: rgba(0,0,0,.05);
  --dsw-static-green-500: #22c55e;
  --dsw-static-amber-500: #f59e0b;
  --dsw-static-red-500: #ef4444;
  --dsw-static-deepseek-500: #4176e6;
  --dsw-static-neutral-bluish-400: #adb2b8;
  --dsw-shadow-lv3: 0 0 1px 0 rgba(0,0,0,.2), 0 0 4px 0 rgba(0,0,0,.02), 0 12px 32px 0 rgba(0,0,0,.08);
  --dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
}`;

const TOKENS_DARK = `body[data-ds-dark-theme] {
  --dsw-alias-bg-layer-2: #2c2c2e;
  --dsw-alias-bg-overlay: #434346;
  --dsw-alias-border-l1: rgba(255,255,255,.06);
  --dsw-alias-border-l2: rgba(255,255,255,.12);
  --dsw-alias-label-primary: #f2f2f2;
  --dsw-alias-label-secondary: #c6c8cc;
  --dsw-alias-interactive-bg-hover: rgba(255,255,255,.08);
  --dsw-static-green-500: #22c55e;
  --dsw-static-amber-500: #f59e0b;
  --dsw-static-red-500: #f87171;
  --dsw-static-deepseek-500: #4d82f0;
  --dsw-static-neutral-bluish-400: #9aa0a8;
  --dsw-shadow-lv3: 0 0 1px 0 rgba(0,0,0,.4), 0 0 4px 0 rgba(0,0,0,.1), 0 12px 32px 0 rgba(0,0,0,.35);
}`;

const PAGE = (title, darkAttr, tokens) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { background: #ffffff; font-family: var(--dsw-font-family, system-ui, sans-serif); color: var(--dsw-alias-label-primary, #1b1b1c); }
  ${tokens}
  .chrome { display: flex; height: 100vh; }
  .sidebar { width: 220px; background: #ffffff; border-right: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); padding: 12px; }
  .brand { font-size: 13px; font-weight: 700; margin-bottom: 14px; }
  .nav { font-size: 12px; line-height: 2.2; color: var(--dsw-alias-label-secondary, #61666b); }
  .main { flex: 1; display: flex; flex-direction: column; }
  .chat { flex: 1; padding: 24px; overflow: hidden; background: #ffffff; }
  .msg { max-width: 640px; margin: 0 auto 14px; font-size: 13px; line-height: 1.6; }
  .msg .who { font-weight: 700; color: var(--dsw-static-deepseek-500, #4176e6); margin-bottom: 4px; }
  .msg p { margin: 4px 0; color: var(--dsw-alias-label-secondary, #61666b); }
  .composer { border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); padding: 12px 24px; background: #ffffff; }
  .box { max-width: 640px; margin: 0 auto; background: #ffffff; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 10px; padding: 10px 14px; color: var(--dsw-alias-label-secondary, #61666b); font-size: 13px; }
</style>
</head>
<body${darkAttr}>
<div class="chrome">
  <div class="sidebar">
    <div class="brand">DeepSeek Harness</div>
    <div class="nav">新会话<br/>会话历史<br/>工作区<br/>设置</div>
  </div>
  <div class="main">
    <div class="chat">
      <div class="msg"><div class="who">助手</div><p>你好！我是运行在 DeepSeek Harness 里的编程智能体。</p></div>
      <div class="msg"><div class="who">用户</div><p>帮我看看账户余额和用量。</p></div>
      <div class="msg"><div class="who">助手</div><p>好的，右下角卡片实时显示各提供方的配额情况。</p></div>
    </div>
    <div class="composer"><div class="box">输入消息…</div></div>
  </div>
</div>
${mockFetch}
${injected}
</body>
</html>
`;

await writeFile('D:/deepseek/dsh-quota-panel/docs/demo.html', PAGE('dsh-quota-panel demo (light)', '', TOKENS_LIGHT + '\n' + TOKENS_DARK), 'utf8');
await writeFile('D:/deepseek/dsh-quota-panel/docs/demo-dark.html', PAGE('dsh-quota-panel demo (dark)', ' data-ds-dark-theme', TOKENS_LIGHT + '\n' + TOKENS_DARK), 'utf8');
console.log('demo pages written; injected script bytes:', injected.length);
