/**
 * dsh-quota-panel — provider quota card for the dsh web surface.
 *
 * Host plugin (zero runtime dependencies):
 *  1. For every configured provider it registers one server-side proxy route
 *     `/api/quota/<id>`. The API key is resolved through `ctx.credentials` and
 *     never reaches the browser; the endpoint is called host-side with
 *     `Authorization: Bearer <key>` and the JSON body is passed through.
 *  2. It taps the served index.html and injects one self-contained page script
 *     that renders a Harness-native status widget (bottom-right) with two
 *     sizes: a collapsed glanceable capsule by default
 *     (`● 额度 ¥58.36 · 45%`), which expands on click into the full card
 *     (header "模型额度" + per-provider structured rows + progress bar).
 *     A collapse button shrinks it back; either size auto-refreshes.
 *
 * The widget is styled with the Harness design tokens (`--dsw-alias-*`,
 * `--dsw-static-*`, `--dsw-shadow-*`, `--dsw-font-*`) and falls back to
 * sensible values when tokens are absent, so it follows the product theme
 * (light/dark) instead of carrying its own palette.
 *
 * Providers are config-driven. Each entry:
 *
 *   id:          route id, also the row key (`/api/quota/<id>`); ^[a-z0-9-]+$
 *   label:       provider name, e.g. "DeepSeek"
 *   credential:  credential reference, e.g. "DEEPSEEK_API_KEY"
 *   endpoint:    quota/balance JSON endpoint to proxy (GET, Bearer auth)
 *   format:      row renderer: "deepseek-balance" | "opencode-usage"
 *   balanceTiers: (deepseek-balance) balance levels { critical, warn, healthy },
 *                defaults { 10, 20, 50 }: <=critical "建议充值" (red),
 *                <=warn "余额紧张" (amber), <=healthy "余额正常", else "余额充足"
 *   lowBalance:  legacy alias for balanceTiers.warn
 *   windowLabels: (opencode-usage) labels for the three windows, defaults
 *                { rolling: "滚", weekly: "周", monthly: "月" }
 *   warnPercent / errorPercent: (opencode-usage) thresholds, defaults 70 / 90
 *
 * Example mount (profile patch):
 *
 *   - insert:
 *       - id: quota-panel
 *         name: 'dsh-quota-panel'
 *         inject: [webServer, credentials]
 *         config:
 *           refreshMs: 60000
 *           providers:
 *             - id: deepseek
 *               label: DeepSeek
 *               credential: DEEPSEEK_API_KEY
 *               endpoint: https://api.deepseek.com/user/balance
 *               format: deepseek-balance
 *             - id: opencode-go
 *               label: OpenCode Go
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

/** Numeric config field with a default; NaN falls back to the default. */
function numOf(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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
		const warnPercent = numOf(entry.warnPercent, 70);
		const errorPercent = numOf(entry.errorPercent, 90);
		// Balance tiers: explicit object wins, legacy lowBalance maps to warn.
		const tiers = entry.balanceTiers && typeof entry.balanceTiers === 'object'
			? {
				critical: numOf(entry.balanceTiers.critical, 10),
				warn: numOf(entry.balanceTiers.warn, 20),
				healthy: numOf(entry.balanceTiers.healthy, 50)
			}
			: typeof entry.lowBalance === 'number' && Number.isFinite(entry.lowBalance)
				? { critical: entry.lowBalance / 2, warn: entry.lowBalance, healthy: 50 }
				: { critical: 10, warn: 20, healthy: 50 };
		if (!(tiers.critical <= tiers.warn && tiers.warn <= tiers.healthy)) {
			throw new Error(`${at}.balanceTiers must satisfy critical <= warn <= healthy`);
		}
		return { id, label, credential, endpoint, format, windowLabels, warnPercent, errorPercent, balanceTiers: tiers };
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
		balanceTiers: provider.balanceTiers
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
  var capsuleId = 'dsh-quota-capsule';
  var cardId = 'dsh-quota-card';
  var VIEWS = {};      // spec.id -> view object
  var STATE = {};      // spec.id -> { status, summary }
  var CAPSULE_DOTS = {};   // spec.id -> capsule dot element
  var CAPSULE_VALUES = {}; // spec.id -> capsule value element
  var capsuleEl = null;
  var cardEl = null;
  var refreshBtn = null;
  var refreshing = false;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtReset(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (!isFinite(ms) || ms <= 0) return '即将重置';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.round(s / 60);
    if (m === 60) { h += 1; m = 0; }
    if (h === 24) { d += 1; h = 0; }
    var parts = [];
    if (d) parts.push(d + '天');
    if (h) parts.push(h + '小时');
    if (m) parts.push(m + '分');
    return parts.length ? parts.join('') : '即将重置';
  }

  function setState(view, state) {
    view.root.classList.remove('state-loading', 'state-ok', 'state-warn', 'state-error');
    view.root.classList.add('state-' + state);
  }

  // Collapsed capsule: each provider renders its own dot + value pair with
  // independent status. Usage values are battery-colored (green/amber/red
  // by usage level); balance values stay neutral unless warn/error.
  function renderCapsule() {
    for (var i = 0; i < ROWS.length; i++) {
      var spec = ROWS[i];
      var s = STATE[spec.id];
      var dot = CAPSULE_DOTS[spec.id];
      var valueEl = CAPSULE_VALUES[spec.id];
      if (!dot || !valueEl) continue;
      var status = s ? s.status : 'loading';
      var isUsage = spec.format === 'opencode-usage';
      dot.className = 'dsh-capsule-dot state-' + status;
      valueEl.className = 'dsh-capsule-item' + (isUsage ? ' dsh-usage' : '') + ' state-' + status;
      valueEl.textContent = s ? s.summary : '…';
    }
  }

  function setExpanded(open) {
    capsuleEl.hidden = open;
    cardEl.hidden = !open;
    capsuleEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) refreshAll();
  }

  function createProviderView(spec) {
    var root = el('div', 'dsh-provider state-loading');
    var main = el('div', 'dsh-provider-main');
    var dot = el('span', 'dsh-status-dot');
    var body = el('div', 'dsh-provider-body');
    var head = el('div', 'dsh-provider-head');
    var nameEl = el('span', 'dsh-provider-name', spec.label);
    var value = null, sub = null, usage = null, track = null, progress = null, caption = null;

    head.appendChild(nameEl);
    if (spec.format === 'deepseek-balance') {
      value = el('span', 'dsh-provider-value', '—');
      head.appendChild(value);
      sub = el('div', 'dsh-provider-sub', '正在更新…');
    } else {
      usage = el('div', 'dsh-usage-values', '正在更新…');
      track = el('div', 'dsh-progress');
      progress = el('div', 'dsh-progress-fill');
      track.appendChild(progress);
      caption = el('div', 'dsh-usage-caption', '');
    }
    body.appendChild(head);
    if (sub) body.appendChild(sub);
    if (usage) body.appendChild(usage);
    if (progress) body.appendChild(track);
    if (caption) body.appendChild(caption);

    main.appendChild(dot);
    main.appendChild(body);
    root.appendChild(main);
    return { root, dot, name: nameEl, value, sub, usage, progress, caption };
  }

  function renderDeepSeek(view, spec, data) {
    var info = data && data.balance_infos && data.balance_infos[0];
    if (!data || data.error || !info) {
      setState(view, 'error');
      view.value.textContent = '—';
      view.sub.textContent = '暂时无法获取余额';
      view.root.title = data && data.error ? String(data.error) : 'no balance info';
      STATE[spec.id] = { status: 'error', summary: '—' };
      renderCapsule();
      return;
    }
    var total = Number(info.total_balance);
    if (!Number.isFinite(total)) {
      setState(view, 'error');
      view.value.textContent = '—';
      view.sub.textContent = '余额数据异常';
      view.root.title = 'non-numeric total_balance';
      STATE[spec.id] = { status: 'error', summary: '—' };
      renderCapsule();
      return;
    }
    view.value.textContent = '¥' + total.toFixed(2);
    var tiers = spec.balanceTiers || { critical: 10, warn: 20, healthy: 50 };
    var status;
    if (total <= tiers.critical) {
      status = 'error';
      view.sub.textContent = '建议充值';
    } else if (total <= tiers.warn) {
      status = 'warn';
      view.sub.textContent = '余额紧张';
    } else if (total <= tiers.healthy) {
      status = 'ok';
      view.sub.textContent = '余额正常';
    } else {
      status = 'ok';
      view.sub.textContent = '余额充足';
    }
    setState(view, status);
    view.root.title = 'currency: ' + info.currency + '\\ngranted: ¥' + info.granted_balance + '\\ntopped-up: ¥' + info.topped_up_balance;
    STATE[spec.id] = { status: status, summary: '¥' + total.toFixed(2) };
    renderCapsule();
  }

  function renderUsage(view, spec, data) {
    var u = data && data.usage;
    if (!data || data.error || !u || !u.rolling || !u.weekly || !u.monthly) {
      setState(view, 'error');
      view.usage.textContent = '暂时无法获取用量';
      view.progress.style.width = '0%';
      view.caption.textContent = '';
      view.root.title = data && data.error ? String(data.error) : 'usage unavailable';
      STATE[spec.id] = { status: 'error', summary: '—' };
      renderCapsule();
      return;
    }
    var r = u.rolling, w = u.weekly, m = u.monthly;
    var rp = Number(r.percent) || 0;
    var wp = Number(w.percent) || 0;
    var mp = Number(m.percent) || 0;
    var high = Math.max(rp, wp, mp);
    var labels = spec.windowLabels || { rolling: '滚', weekly: '周', monthly: '月' };

    view.usage.textContent = labels.rolling + ' ' + rp + '%' + ' · ' + labels.weekly + ' ' + wp + '%' + ' · ' + labels.monthly + ' ' + mp + '%';
    view.progress.style.width = Math.min(Math.max(high, 0), 100) + '%';
    view.caption.textContent = '当前最高占用 ' + high + '%';

    var status;
    if (high >= spec.errorPercent) status = 'error';
    else if (high >= spec.warnPercent) status = 'warn';
    else status = 'ok';
    setState(view, status);

    view.root.title = 'rolling: ' + rp + '%（重置于 ' + fmtReset(r.resetsAt) + '）' + '\\nweekly: ' + wp + '%（重置于 ' + fmtReset(w.resetsAt) + '）' + '\\nmonthly: ' + mp + '%（重置于 ' + fmtReset(m.resetsAt) + '）';
    STATE[spec.id] = { status: status, summary: high + '%' };
    renderCapsule();
  }

  function renderProviderError(view, spec, error) {
    setState(view, 'error');
    if (spec.format === 'deepseek-balance') {
      view.value.textContent = '—';
      view.sub.textContent = '暂时无法获取余额';
    } else {
      view.usage.textContent = '暂时无法获取用量';
      view.progress.style.width = '0%';
      view.caption.textContent = '';
    }
    view.root.title = String(error && error.message ? error.message : error);
    STATE[spec.id] = { status: 'error', summary: '—' };
    renderCapsule();
  }

  function injectStyles() {
    var css = [
      '#dsh-quota-panel{position:fixed;right:18px;bottom:18px;z-index:900;display:flex;flex-direction:column;align-items:flex-end;color:var(--dsw-alias-label-primary,#1b1b1c);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);font-size:13px;line-height:1.45}',
      '#dsh-quota-panel [hidden]{display:none!important}',
      '#dsh-quota-capsule{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px 0 14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:18px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(15,17,21,.02),0 2px 8px rgba(15,17,21,.04));cursor:pointer;font:inherit;transition:background-color 120ms ease}',
      '#dsh-quota-capsule:hover{background:var(--dsw-alias-bg-overlay,#ebeef2)}',
      '#dsh-quota-capsule .dsh-capsule-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-static-neutral-bluish-400,#adb2b8)}',
      '#dsh-quota-capsule .dsh-capsule-dot.state-ok{background:var(--dsw-static-green-500,#22c55e)}',
      '#dsh-quota-capsule .dsh-capsule-dot.state-warn{background:var(--dsw-static-amber-500,#f59e0b)}',
      '#dsh-quota-capsule .dsh-capsule-dot.state-error{background:var(--dsw-static-red-500,#ef4444)}',
      '#dsh-quota-capsule .dsh-capsule-item{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-primary,#1b1b1c)}',
      '#dsh-quota-capsule .dsh-capsule-item.state-loading{color:var(--dsw-alias-label-secondary,#61666b)}',
      '#dsh-quota-capsule .dsh-capsule-item.state-warn{color:var(--dsw-static-amber-500,#f59e0b)}',
      '#dsh-quota-capsule .dsh-capsule-item.state-error{color:var(--dsw-static-red-500,#ef4444)}',
      '#dsh-quota-capsule .dsh-capsule-item.state-ok.dsh-usage{color:var(--dsw-static-green-500,#22c55e)}',
      '#dsh-quota-capsule .dsh-capsule-chevron{color:var(--dsw-alias-label-tertiary,#818590);font-size:11px;line-height:1}',
      '#dsh-quota-card{width:300px;max-width:calc(100vw - 36px);margin-top:8px;padding:14px 16px 15px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:16px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-shadow-lv3,0 8px 26px rgba(15,17,21,.1),0 2px 6px rgba(15,17,21,.06));box-sizing:border-box}',
      '#dsh-quota-card .dsh-quota-header{display:flex;align-items:center;justify-content:space-between;min-height:24px;margin-bottom:13px}',
      '#dsh-quota-card .dsh-quota-title{color:var(--dsw-alias-label-primary,#1b1b1c);font-size:14px;font-weight:600;line-height:20px}',
      '#dsh-quota-card .dsh-quota-actions{display:flex;gap:4px;margin:-3px -4px -3px 0}',
      '#dsh-quota-card .dsh-quota-icon{display:inline-grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:8px;color:var(--dsw-alias-label-secondary,#61666b);background:transparent;font-size:16px;line-height:1;cursor:pointer;transition:background-color 120ms ease,color 120ms ease}',
      '#dsh-quota-card .dsh-quota-icon:hover{color:var(--dsw-alias-label-primary,#1b1b1c);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '#dsh-quota-card .dsh-quota-icon:disabled{cursor:default;opacity:.55}',
      '#dsh-quota-card .dsh-quota-icon.is-loading{animation:dsh-quota-spin .7s linear infinite}',
      '@keyframes dsh-quota-spin{to{transform:rotate(360deg)}}',
      '#dsh-quota-card .dsh-provider{width:100%}',
      '#dsh-quota-card .dsh-provider-main{display:flex;align-items:flex-start;gap:10px}',
      '#dsh-quota-card .dsh-status-dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--dsw-static-green-500,#22c55e)}',
      '#dsh-quota-card .state-loading .dsh-status-dot{background:var(--dsw-static-neutral-bluish-400,#adb2b8)}',
      '#dsh-quota-card .state-warn .dsh-status-dot{background:var(--dsw-static-amber-500,#f59e0b)}',
      '#dsh-quota-card .state-error .dsh-status-dot{background:var(--dsw-static-red-500,#ef4444)}',
      '#dsh-quota-card .dsh-provider-body{flex:1;min-width:0}',
      '#dsh-quota-card .dsh-provider-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '#dsh-quota-card .dsh-provider-name{overflow:hidden;color:var(--dsw-alias-label-primary,#1b1b1c);font-size:13px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}',
      '#dsh-quota-card .dsh-provider-value{flex:none;color:var(--dsw-alias-label-primary,#1b1b1c);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}',
      '#dsh-quota-card .state-warn .dsh-provider-value{color:var(--dsw-static-amber-500,#f59e0b)}',
      '#dsh-quota-card .state-error .dsh-provider-value{color:var(--dsw-static-red-500,#ef4444)}',
      '#dsh-quota-card .dsh-provider-sub{margin-top:3px;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;line-height:18px}',
      '#dsh-quota-card .dsh-quota-divider{height:1px;margin:14px 0;background:var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '#dsh-quota-card .dsh-usage-values{margin-top:3px;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}',
      '#dsh-quota-card .dsh-progress{position:relative;width:100%;height:5px;margin-top:10px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-overlay,#ebeef2)}',
      '#dsh-quota-card .dsh-progress-fill{height:100%;width:0;border-radius:inherit;background:var(--dsw-static-deepseek-500,#4176e6);transition:width 300ms ease,background-color 160ms ease}',
      '#dsh-quota-card .state-warn .dsh-progress-fill{background:var(--dsw-static-amber-500,#f59e0b)}',
      '#dsh-quota-card .state-error .dsh-progress-fill{background:var(--dsw-static-red-500,#ef4444)}',
      '#dsh-quota-card .dsh-usage-caption{margin-top:8px;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;line-height:18px}'
    ].join('\\n');
    var style = el('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function createPanel() {
    var panel = el('div');
    panel.id = panelId;

    // Collapsed capsule: one dot + value pair per provider, no text labels.
    capsuleEl = el('button', 'dsh-quota-capsule');
    capsuleEl.id = capsuleId;
    capsuleEl.type = 'button';
    capsuleEl.setAttribute('aria-label', '展开模型额度');
    capsuleEl.setAttribute('aria-expanded', 'false');
    for (var i = 0; i < ROWS.length; i++) {
      var spec = ROWS[i];
      var dot = el('span', 'dsh-capsule-dot state-loading');
      var valueEl = el('span', 'dsh-capsule-item state-loading', '…');
      CAPSULE_DOTS[spec.id] = dot;
      CAPSULE_VALUES[spec.id] = valueEl;
      capsuleEl.appendChild(dot);
      capsuleEl.appendChild(valueEl);
    }
    capsuleEl.appendChild(el('span', 'dsh-capsule-chevron', '▾'));
    capsuleEl.addEventListener('click', function () { setExpanded(true); });
    panel.appendChild(capsuleEl);

    // Expanded card.
    cardEl = el('div');
    cardEl.id = cardId;
    cardEl.hidden = true;
    var header = el('div', 'dsh-quota-header');
    header.appendChild(el('div', 'dsh-quota-title', '模型额度'));
    var actions = el('div', 'dsh-quota-actions');
    refreshBtn = el('button', 'dsh-quota-icon', '↻');
    refreshBtn.type = 'button';
    refreshBtn.setAttribute('aria-label', '刷新模型额度');
    refreshBtn.addEventListener('click', function () { refreshAll(); });
    var collapseBtn = el('button', 'dsh-quota-icon', '▴');
    collapseBtn.type = 'button';
    collapseBtn.setAttribute('aria-label', '收起模型额度');
    collapseBtn.addEventListener('click', function () { setExpanded(false); });
    actions.appendChild(refreshBtn);
    actions.appendChild(collapseBtn);
    header.appendChild(actions);
    cardEl.appendChild(header);
    for (var i = 0; i < ROWS.length; i++) {
      if (i > 0) cardEl.appendChild(el('div', 'dsh-quota-divider'));
      var view = createProviderView(ROWS[i]);
      VIEWS[ROWS[i].id] = view;
      cardEl.appendChild(view.root);
    }
    panel.appendChild(cardEl);
    return panel;
  }

  async function refreshProvider(spec) {
    var view = VIEWS[spec.id];
    if (!view) return;
    try {
      var response = await fetch('/api/quota/' + encodeURIComponent(spec.id), { cache: 'no-store' });
      var data = await response.json();
      if (spec.format === 'deepseek-balance') renderDeepSeek(view, spec, data);
      else renderUsage(view, spec, data);
    } catch (error) {
      renderProviderError(view, spec, error);
    }
  }

  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.classList.add('is-loading');
    try {
      await Promise.all(ROWS.map(function (spec) { return refreshProvider(spec); }));
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('is-loading');
    }
  }

  function mount() {
    if (document.getElementById(panelId)) return;
    injectStyles();
    var panel = createPanel();
    document.body.appendChild(panel);
    refreshAll();
    setInterval(function () {
      if (!document.hidden) refreshAll();
    }, AUTO_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshAll();
    });
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
