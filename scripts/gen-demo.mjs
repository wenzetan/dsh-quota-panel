// Generate a self-contained demo page (docs/demo.html) for dsh-quota-panel.
// It reproduces the real injected panel script (captured from the actual
// plugin module) over a mock chat chrome, with fetch stubbed to demo data.
import { readFile, writeFile } from 'node:fs/promises';

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
    { id: 'deepseek', label: 'DS 余额', credential: 'DEEPSEEK_API_KEY', endpoint: 'https://api.deepseek.com/user/balance', format: 'deepseek-balance' },
    { id: 'opencode-go', label: 'OC Go', credential: 'OPENCODE_GO_API_KEY', endpoint: 'https://opencode.ai/zen/go/v1/usage', format: 'opencode-usage', windowLabels: { rolling: '滚', weekly: '周', monthly: '月' } }
  ]
});
const injected = taps[0]('</body>');

const mockFetch = `<script>
window.fetch = function (url) {
  var data;
  if (String(url).indexOf('deepseek') >= 0) {
    data = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '15.63', granted_balance: '0.00', topped_up_balance: '15.63' }] };
  } else {
    data = { usage: {
      rolling: { status: 'ok', percent: 12, resetsAt: new Date(Date.now() + 4 * 3600e3).toISOString() },
      weekly:  { status: 'ok', percent: 43, resetsAt: new Date(Date.now() + 2 * 86400e3).toISOString() },
      monthly: { status: 'ok', percent: 21, resetsAt: new Date(Date.now() + 27 * 86400e3).toISOString() }
    } };
  }
  return Promise.resolve({ json: function () { return Promise.resolve(data); } });
};
<\/script>`;

const demo = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>dsh-quota-panel demo</title>
<style>
  html, body { margin: 0; height: 100%; background: #14161c; }
  body { font-family: system-ui, sans-serif; color: #c9d1d9; }
  .chrome { display: flex; height: 100vh; }
  .sidebar { width: 220px; background: #101218; border-right: 1px solid #23262e; padding: 12px; }
  .brand { font-size: 13px; font-weight: 700; color: #e6edf3; margin-bottom: 14px; }
  .nav { font-size: 12px; line-height: 2.2; color: #8b949e; }
  .main { flex: 1; display: flex; flex-direction: column; }
  .chat { flex: 1; padding: 24px; overflow: hidden; }
  .msg { max-width: 640px; margin: 0 auto 14px; font-size: 13px; line-height: 1.6; }
  .msg .who { font-weight: 700; color: #7ee787; margin-bottom: 4px; }
  .msg p { margin: 4px 0; color: #b8c0c8; }
  .composer { border-top: 1px solid #23262e; padding: 12px 24px; }
  .box { max-width: 640px; margin: 0 auto; background: #1a1d25; border: 1px solid #2b2f3a; border-radius: 10px; padding: 10px 14px; color: #7d8590; font-size: 13px; }
</style>
</head>
<body>
<div class="chrome">
  <div class="sidebar">
    <div class="brand">DeepSeek Harness</div>
    <div class="nav">新会话<br/>会话历史<br/>工作区<br/>设置</div>
  </div>
  <div class="main">
    <div class="chat">
      <div class="msg"><div class="who">助手</div><p>你好！我是运行在 DeepSeek Harness 里的编程智能体。</p></div>
      <div class="msg"><div class="who">用户</div><p>帮我看看账户余额和用量。</p></div>
      <div class="msg"><div class="who">助手</div><p>好的，右下角面板实时显示各提供方的配额情况。</p></div>
    </div>
    <div class="composer"><div class="box">输入消息…</div></div>
  </div>
</div>
${mockFetch}
${injected}
</body>
</html>
`;

await writeFile('D:/deepseek/dsh-quota-panel/docs/demo.html', demo, 'utf8');
console.log('demo.html written; injected script bytes:', injected.length);
