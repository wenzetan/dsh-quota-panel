// Verify the demo pages rendered the v0.2 native card, dump DOM facts, and
// report the panel rect for cropping. Used to prove the screenshots show a
// correctly-rendered card (the capturing model cannot view images).
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

await send('Page.enable');
await send('Page.navigate', { url });
await sleep(4000);

const evalResult = await send('Runtime.evaluate', {
	expression: `JSON.stringify({
    panel: (() => { const p = document.getElementById('dsh-quota-panel'); if (!p) return null; const r = p.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), z: getComputedStyle(p).zIndex, radius: getComputedStyle(p).borderRadius, bg: getComputedStyle(p).backgroundColor }; })(),
    providers: Array.from(document.querySelectorAll('#dsh-quota-panel .dsh-provider')).map(function (p) {
      return {
        state: p.className,
        name: p.querySelector('.dsh-provider-name') && p.querySelector('.dsh-provider-name').textContent,
        value: p.querySelector('.dsh-provider-value') && p.querySelector('.dsh-provider-value').textContent,
        sub: p.querySelector('.dsh-provider-sub') && p.querySelector('.dsh-provider-sub').textContent,
        usage: p.querySelector('.dsh-usage-values') && p.querySelector('.dsh-usage-values').textContent,
        barWidth: p.querySelector('.dsh-progress-fill') && p.querySelector('.dsh-progress-fill').style.width,
        caption: p.querySelector('.dsh-usage-caption') && p.querySelector('.dsh-usage-caption').textContent
      };
    }),
    title: document.querySelector('#dsh-quota-panel .dsh-quota-title') && document.querySelector('#dsh-quota-panel .dsh-quota-title').textContent,
    refreshLabel: document.querySelector('#dsh-quota-panel .dsh-quota-refresh') && document.querySelector('#dsh-quota-panel .dsh-quota-refresh').getAttribute('aria-label')
  })`,
	returnByValue: true
});
console.log(evalResult.result.value);

ws.close();
chrome.kill();
