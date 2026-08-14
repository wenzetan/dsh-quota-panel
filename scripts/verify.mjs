// Verify the demo pages: collapsed capsule by default, click expands the
// card, collapse button shrinks back; report computed backgrounds + rects.
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const USER_DATA = 'D:/deepseek/dsh-quota-panel/.chrome-verify';
const url = process.argv[2] === 'dark'
	? 'file:///D:/deepseek/dsh-quota-panel/docs/demo-dark.html'
	: 'file:///D:/deepseek/dsh-quota-panel/docs/demo.html';

await rm(USER_DATA, { recursive: true, force: true });
await mkdir(USER_DATA, { recursive: true });

const chrome = spawn(CHROME, [
	'--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
	`--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`,
	'--window-size=1280,800', 'about:blank'
], { stdio: 'ignore' });

let targets;
for (let i = 0; i < 40; i++) {
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
		targets = await res.json();
		if (targets.length) break;
	} catch {}
	await sleep(250);
}
if (!targets?.length) { console.error('FAIL: no CDP target'); chrome.kill(); process.exit(1); }

const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
	}
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++seq;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((resolve) => { ws.onopen = resolve; });

const evaluate = async (expression) => {
	const res = await send('Runtime.evaluate', { expression, returnByValue: true });
	return res.result.value;
};

await send('Page.enable');
await send('Page.navigate', { url });
await sleep(4000);

const collapsed = await evaluate(`JSON.stringify({
  bodyBg: getComputedStyle(document.body).backgroundColor,
  sidebarBg: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
  composerBg: getComputedStyle(document.querySelector('.composer')).backgroundColor,
  capsule: (() => { const c = document.getElementById('dsh-quota-capsule'); if (!c) return null; const r = c.getBoundingClientRect(); return {
    visible: !c.hidden, hidden: c.hidden, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    text: c.textContent, ariaExpanded: c.getAttribute('aria-expanded'),
    pairs: Array.from(c.querySelectorAll('.dsh-capsule-dot')).map(function (dot, i) {
      const value = c.querySelectorAll('.dsh-capsule-item')[i];
      return {
        dotColor: getComputedStyle(dot).backgroundColor,
        dotClass: dot.className,
        value: value ? value.textContent : null,
        valueClass: value ? value.className : null
      };
    })
  }; })(),
  cardHidden: (() => { const c = document.getElementById('dsh-quota-card'); return c ? c.hidden : null; })()
})`);
console.log('COLLAPSED:', collapsed);

await evaluate(`document.getElementById('dsh-quota-capsule').click()`);
await sleep(2000);

const expanded = await evaluate(`JSON.stringify({
  capsuleHidden: document.getElementById('dsh-quota-capsule').hidden,
  capsuleAriaExpanded: document.getElementById('dsh-quota-capsule').getAttribute('aria-expanded'),
  card: (() => { const c = document.getElementById('dsh-quota-card'); const r = c.getBoundingClientRect(); return {
    visible: !c.hidden, hidden: c.hidden, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    bg: getComputedStyle(c).backgroundColor
  }; })(),
  providers: Array.from(document.querySelectorAll('#dsh-quota-card .dsh-provider')).map(function (p) {
    return {
      state: p.className,
      name: p.querySelector('.dsh-provider-name') && p.querySelector('.dsh-provider-name').textContent,
      value: p.querySelector('.dsh-provider-value') && p.querySelector('.dsh-provider-value').textContent,
      sub: p.querySelector('.dsh-provider-sub') && p.querySelector('.dsh-provider-sub').textContent,
      usage: p.querySelector('.dsh-usage-values') && p.querySelector('.dsh-usage-values').textContent,
      barWidth: p.querySelector('.dsh-progress-fill') && p.querySelector('.dsh-progress-fill').style.width,
      caption: p.querySelector('.dsh-usage-caption') && p.querySelector('.dsh-usage-caption').textContent
    };
  })
})`);
console.log('EXPANDED:', expanded);

await evaluate(`document.querySelectorAll('#dsh-quota-card .dsh-quota-icon')[1].click()`);
await sleep(500);
const recollapsed = await evaluate(`JSON.stringify({
  capsuleVisible: !document.getElementById('dsh-quota-capsule').hidden,
  cardHidden: document.getElementById('dsh-quota-card').hidden,
  ariaExpanded: document.getElementById('dsh-quota-capsule').getAttribute('aria-expanded')
})`);
console.log('RECOLLAPSED:', recollapsed);

ws.close();
chrome.kill();
