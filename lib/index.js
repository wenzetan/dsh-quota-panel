/**
 * dsh-quota-panel — quota/balance corner panel for the dsh web surface.
 *
 * A zero-dependency host plugin: for every configured provider it registers
 * one server-side proxy route `/api/quota/<id>` (the API key is resolved from
 * the credentials seam and never reaches the browser), then taps the served
 * index.html to inject a small panel script that fetches the routes and
 * renders one row per provider in the bottom-right corner.
 *
 * Rendering is config-driven through `config.providers`. Each entry:
 *
 *   id:         route id, also the row key (`/api/quota/<id>`); ^[a-z0-9-]+$
 *   label:      text shown before the value, e.g. "DS 余额"
 *   credential: credential reference, e.g. "DEEPSEEK_API_KEY"
 *   endpoint:   the quota/balance JSON endpoint to proxy (GET, Bearer auth)
 *   format:     row renderer: "deepseek-balance" | "opencode-usage"
 *   windowLabels: (opencode-usage) labels for the three windows, defaults
 *                 { rolling: "滚", weekly: "周", monthly: "月" }
 *   warnPercent / errorPercent: (opencode-usage) color thresholds,
 *                 defaults 70 / 90
 *   lowBalance: (deepseek-balance) warn below this total, default 5
 *
 * Mounted from a profile patch, e.g.:
 *
 *   - insert:
 *       - id: quota-panel
 *         name: 'dsh-quota-panel'
 *         inject: [webServer, credentials]
 *         config:
 *           refreshMs: 60000
 *           providers:
 *             - id: deepseek
 *               label: DS 余额
 *               credential: DEEPSEEK_API_KEY
 *               endpoint: https://api.deepseek.com/user/balance
 *               format: deepseek-balance
 *             - id: opencode-go
 *               label: OC Go
 *               credential: OPENCODE_GO_API_KEY
 *               endpoint: https://opencode.ai/zen/go/v1/usage
 *               format: opencode-usage
 */
export const name = 'quota-panel';

export const inject = ['webServer', 'credentials'];

const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;

function sendJson(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body));
}

/** Normalize and validate the plugin config; throws with a readable message. */
function normalizeConfig(raw) {
	const config = { refreshMs: 60000, providers: [], ...(raw && typeof raw === 'object' ? raw : {}) };
	if (typeof config.refreshMs !== 'number' || !(config.refreshMs >= 5000)) {
		throw new Error('quota-panel: config.refreshMs must be a number >= 5000');
	}
	if (!Array.isArray(config.providers)) throw new Error('quota-panel: config.providers must be an array');
	const seen = new Set();
	const providers = config.providers.map((entry, index) => {
		const at = `quota-panel: config.providers[${index}]`;
		if (!entry || typeof entry !== 'object') throw new Error(`${at} must be an object`);
		const { id, label, credential, endpoint, format = 'deepseek-balance' } = entry;
		if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) throw new Error(`${at}.id must match /^[a-z0-9-]+$/`);
		if (seen.has(id)) throw new Error(`${at}.id duplicates "${id}"`);
		seen.add(id);
		if (typeof label !== 'string' || !label) throw new Error(`${at}.label must be a non-empty string`);
		if (typeof credential !== 'string' || !credential) throw new Error(`${at}.credential must be a non-empty string`);
		if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) throw new Error(`${at}.endpoint must be an http(s) URL`);
		if (format !== 'deepseek-balance' && format !== 'opencode-usage') throw new Error(`${at}.format must be "deepseek-balance" or "opencode-usage"`);
		const windowLabels = {
			rolling: '滚',
			weekly: '周',
			monthly: '月',
			...(entry.windowLabels && typeof entry.windowLabels === 'object' ? entry.windowLabels : {})
		};
		const warnPercent = typeof entry.warnPercent === 'number' ? entry.warnPercent : 70;
		const errorPercent = typeof entry.errorPercent === 'number' ? entry.errorPercent : 90;
		const lowBalance = typeof entry.lowBalance === 'number' ? entry.lowBalance : 5;
		return { id, label, credential, endpoint, format, windowLabels, warnPercent, errorPercent, lowBalance };
	});
	return { refreshMs: config.refreshMs, providers };
}

/** JSON-safe row spec embedded into the injected page script. */
function rowSpec(provider) {
	return {
		id: provider.id,
		label: provider.label,
		format: provider.format,
		windowLabels: provider.windowLabels,
		warnPercent: provider.warnPercent,
		errorPercent: provider.errorPercent,
		lowBalance: provider.lowBalance
	};
}

/**
 * Build the injected page script. ROWS is a JSON literal, so every value is
 * JSON-escaped; the surrounding script contains no literal `</script>`.
 * @param rows - the provider row specs.
 * @param refreshMs - auto-refresh interval.
 */
function buildPageScript(rows, refreshMs) {
	const rowsJson = JSON.stringify(rows).replace(/</g, '\\u003C');
	const script = `(function () {
  var AUTO_MS = ${refreshMs};
  var ROWS = ${rowsJson};
  var panelId = 'dsh-quota-panel';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtReset(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (!isFinite(ms) || ms <= 0) return '\\u5373\\u5C06\\u91CD\\u7F6E';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.round(s / 60);
    if (m === 60) { h += 1; m = 0; }
    if (h === 24) { d += 1; h = 0; }
    var parts = [];
    if (d) parts.push(d + '\\u5929');
    if (h) parts.push(h + '\\u5C0F\\u65F6');
    if (m) parts.push(m + '\\u5206');
    return parts.length ? parts.join('') : '\\u5373\\u5C06\\u91CD\\u7F6E';
  }

  function renderDeepSeek(row, spec, data) {
    var info = data && data.balance_infos && data.balance_infos[0];
    if (!data || data.error || !info) {
      row.textContent = spec.label + ': \\uFF1F';
      row.title = data && data.error ? String(data.error) : 'no balance info';
      row.classList.add('err');
      return;
    }
    var total = Number(info.total_balance);
    row.textContent = spec.label + ': \\u00A5' + total.toFixed(2);
    row.title = 'currency: ' + info.currency + ' | granted: \\u00A5' + info.granted_balance + ' | topped-up: \\u00A5' + info.topped_up_balance;
    row.classList.toggle('warn', total < spec.lowBalance);
  }

  function renderUsage(row, spec, data) {
    var u = data && data.usage;
    if (!data || data.error || !u || !u.rolling || !u.weekly || !u.monthly) {
      row.textContent = spec.label + ': \\uFF1F';
      row.title = data && data.error ? String(data.error) : 'usage unavailable';
      row.classList.add('err');
      return;
    }
    var l = spec.windowLabels;
    var r = u.rolling, w = u.weekly, m = u.monthly;
    row.textContent = spec.label + ': ' + l.rolling + ' ' + r.percent + '% \\u00B7 ' + l.weekly + ' ' + w.percent + '% \\u00B7 ' + l.monthly + ' ' + m.percent + '%';
    row.title = 'rolling: ' + r.percent + '% (\\u91CD\\u7F6E\\u4E8E ' + fmtReset(r.resetsAt) + ')\\nweekly: ' + w.percent + '% (\\u91CD\\u7F6E\\u4E8E ' + fmtReset(w.resetsAt) + ')\\nmonthly: ' + m.percent + '% (\\u91CD\\u7F6E\\u4E8E ' + fmtReset(m.resetsAt) + ')';
    var high = Math.max(r.percent || 0, w.percent || 0, m.percent || 0);
    row.classList.toggle('warn', high >= spec.warnPercent && high < spec.errorPercent);
    row.classList.toggle('err', high >= spec.errorPercent);
  }

  function renderRow(spec, row) {
    fetch('/api/quota/' + spec.id, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (spec.format === 'deepseek-balance') renderDeepSeek(row, spec, data);
        else renderUsage(row, spec, data);
      })
      .catch(function (err) {
        row.textContent = spec.label + ': \\u2717';
        row.title = String(err);
        row.classList.add('err');
      });
  }

  function refresh() {
    for (var i = 0; i < ROWS.length; i++) {
      var row = document.getElementById('dsh-row-' + i);
      if (row) renderRow(ROWS[i], row);
    }
  }

  function mount() {
    if (document.getElementById(panelId)) return;
    var style = document.createElement('style');
    style.textContent = '#dsh-quota-panel{position:fixed;right:14px;bottom:14px;z-index:2147483000;display:flex;flex-direction:column;gap:4px;padding:8px 12px;border-radius:12px;background:rgba(18,22,30,.85);color:#7ee787;font:600 12px/1.5 ui-monospace,Consolas,monospace;letter-spacing:.2px;box-shadow:0 2px 12px rgba(0,0,0,.45);border:1px solid rgba(126,231,135,.35);backdrop-filter:blur(4px);cursor:pointer;user-select:none;transition:opacity .2s}';
    style.textContent += '#dsh-quota-panel:hover{opacity:.75}';
    style.textContent += '#dsh-quota-panel .warn{color:#ffd28a}';
    style.textContent += '#dsh-quota-panel .err{color:#ff9f9f}';
    document.head.appendChild(style);
    var panel = el('div');
    panel.id = panelId;
    for (var i = 0; i < ROWS.length; i++) {
      var row = el('div', 'row', ROWS[i].label + ': \\u2026');
      row.id = 'dsh-row-' + i;
      panel.appendChild(row);
    }
    panel.addEventListener('click', refresh);
    document.body.appendChild(panel);
    refresh();
    setInterval(refresh, AUTO_MS);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();`;
	return `<script>${script}<\/script>`;
}

/**
 * Apply the plugin: one proxy route per provider plus the index tap.
 * @param ctx - plugin context with webServer and credentials services.
 * @param config - raw plugin config (normalized here, no schema dependency).
 */
export function apply(ctx, config) {
	const { refreshMs, providers } = normalizeConfig(config);
	ctx.effect(() => {
		const disposers = providers.map((provider) => {
			return ctx.webServer.register({
				kind: 'exact',
				path: `/api/quota/${provider.id}`,
				handler: async (req, res) => {
					if (req.method !== 'GET') {
						sendJson(res, 405, { error: 'method not allowed' });
						return;
					}
					try {
						const hit = await ctx.credentials.resolve(provider.credential);
						if (!hit) {
							sendJson(res, 200, { error: `${provider.credential} is not configured` });
							return;
						}
						const upstream = await fetch(provider.endpoint, {
							headers: { authorization: `Bearer ${hit.value}` },
							signal: AbortSignal.timeout(15000)
						});
						const text = await upstream.text();
						res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
						res.end(text);
					} catch (error) {
						sendJson(res, 502, { error: String(error) });
					}
				}
			});
		});
		const disposeTap = ctx.webServer.tapIndex((html) => html.replace('</body>', buildPageScript(providers.map(rowSpec), refreshMs) + '</body>'));
		return () => {
			for (const dispose of disposers) dispose();
			disposeTap();
		};
	}, 'quota-panel: quota routes + index tap');
}
