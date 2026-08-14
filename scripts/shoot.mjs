// Capture PNG screenshots of the demo pages via Chrome DevTools Protocol.
// Usage: node scripts/shoot.mjs [light|dark|both]
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const USER_DATA = 'D:/deepseek/dsh-quota-panel/.chrome-cdp';
const SHOTS = {
	light: {
		url: 'file:///D:/deepseek/dsh-quota-panel/docs/demo.html',
		out: 'D:/deepseek/dsh-quota-panel/docs/screenshot-light.png'
	},
	dark: {
		url: 'file:///D:/deepseek/dsh-quota-panel/docs/demo-dark.html',
		out: 'D:/deepseek/dsh-quota-panel/docs/screenshot-dark.png'
	}
};
const mode = process.argv[2] || 'both';

await rm(USER_DATA, { recursive: true, force: true });
await mkdir(USER_DATA, { recursive: true });

const chrome = spawn(CHROME, [
	'--headless=new',
	'--disable-gpu',
	'--no-first-run',
	'--no-default-browser-check',
	`--user-data-dir=${USER_DATA}`,
	`--remote-debugging-port=${PORT}`,
	'--window-size=1280,800',
	'about:blank'
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
if (!targets?.length) {
	console.error('FAIL: no CDP target');
	chrome.kill();
	process.exit(1);
}

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
for (const [key, shot] of Object.entries(SHOTS)) {
	if (mode !== 'both' && mode !== key) continue;
	await send('Page.navigate', { url: shot.url });
	await sleep(4000);
	const result = await send('Page.captureScreenshot', { format: 'png' });
	await writeFile(shot.out, Buffer.from(result.data, 'base64'));
	console.log('saved:', shot.out);
}

ws.close();
chrome.kill();
