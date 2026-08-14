// Capture PNG screenshots of the demo pages via Chrome DevTools Protocol.
// For each theme it captures three states:
//   1. collapsed: the minimal capsule (default state)
//   2. expanded: the full card (after clicking the capsule)
//   3. settings: the card with the settings panel open (after clicking ⚙)
// Usage: node scripts/shoot.mjs [light|dark|both]
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const docs = join(root, 'docs');
const CHROME = process.env.CHROME_BIN
  || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/google/chrome/chrome');
// headless chrome needs a writable HOME for its crashpad handler
process.env.HOME = process.env.CHROME_HOME || '/tmp/agent-chrome-home';
const PORT = 9333;
const USER_DATA = join(root, '.chrome-cdp');
const SHOTS = {
	light: {
		url: 'file://' + join(docs, 'demo.html'),
		collapsed: join(docs, 'screenshot-light.png'),
		expanded: join(docs, 'screenshot-light-expanded.png'),
		settings: join(docs, 'screenshot-light-settings.png')
	},
	dark: {
		url: 'file://' + join(docs, 'demo-dark.html'),
		collapsed: join(docs, 'screenshot-dark.png'),
		expanded: join(docs, 'screenshot-dark-expanded.png'),
		settings: join(docs, 'screenshot-dark-settings.png')
	}
};
const mode = process.argv[2] || 'both';

await rm(USER_DATA, { recursive: true, force: true });
await mkdir(USER_DATA, { recursive: true });

const chrome = spawn(CHROME, [
	'--headless=new',
	'--disable-gpu',
	'--no-sandbox',
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-extensions',
	'--hide-scrollbars',
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

	// 1. collapsed capsule
	const collapsed = await send('Page.captureScreenshot', { format: 'png' });
	await writeFile(shot.collapsed, Buffer.from(collapsed.data, 'base64'));
	console.log('saved (collapsed):', shot.collapsed);

	// 2. click capsule to expand
	await send('Runtime.evaluate', {
		expression: "document.getElementById('dsh-quota-capsule').click()"
	});
	await sleep(2000);
	const expanded = await send('Page.captureScreenshot', { format: 'png' });
	await writeFile(shot.expanded, Buffer.from(expanded.data, 'base64'));
	console.log('saved (expanded):', shot.expanded);

	// 3. click the gear button to open settings
	await send('Runtime.evaluate', {
		expression: "var b = document.querySelector('#dsh-quota-card .dsh-quota-actions button[aria-label=\"打开设置\"]'); b && b.click();"
	});
	await sleep(800);
	const settings = await send('Page.captureScreenshot', { format: 'png' });
	await writeFile(shot.settings, Buffer.from(settings.data, 'base64'));
	console.log('saved (settings):', shot.settings);
}

ws.close();
chrome.kill();
