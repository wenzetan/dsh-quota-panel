/**
 * dsh-quota-panel — client half (browser bundle, served at
 * /plugins/dsh-quota-panel/client.js through the `dsh.client` manifest).
 *
 * Registers one `shell.overlay` slot entry rendering the quota widget with
 * React: a collapsed glanceable capsule by default
 * (`● ¥58.36 · ● 45%`), expanding on click into the full card
 * (header "模型额度" + per-provider rows + progress bars). Next to the
 * refresh button, a gear button (⚙) opens the settings panel:
 * per-provider visibility, refresh interval, and per-provider warn
 * thresholds — persisted to localStorage, never sent anywhere.
 *
 * Data arrives over the loopback Connection RPC channel `/dsh-quota-panel`
 * (endpoints `specs` / `fetch-all`) owned by the host half in lib/index.js;
 * API keys never reach the browser. `fetch-all` rows carry host-normalized
 * views (kind balance / usage / info) — upstream JSON schemas stay
 * host-side; threshold judgement and coloring happen here from spec hints
 * so the local settings overrides apply without a refetch.
 *
 * Styled with the Harness design tokens (`--dsw-alias-*`, `--dsw-static-*`,
 * `--dsw-shadow-*`, `--dsw-font-*`) with sensible fallbacks, so the widget
 * follows the product theme (light/dark) instead of carrying its own palette.
 */
window.__ModuleLoader__.load({
	id: "dsh-quota-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");

		var CHANNEL = "/dsh-quota-panel";
		var STORAGE_KEY = "dsh-quota-panel:settings";

		var REFRESH_CHOICES = [
			{ value: "", label: "跟随配置" },
			{ value: "15000", label: "15 秒" },
			{ value: "30000", label: "30 秒" },
			{ value: "60000", label: "1 分钟" },
			{ value: "120000", label: "2 分钟" },
			{ value: "300000", label: "5 分钟" }
		];

		var CSS = [
			'#dsh-quota-panel{position:fixed;right:18px;bottom:18px;z-index:900;display:flex;flex-direction:column;align-items:flex-end;pointer-events:auto;color:var(--dsw-alias-label-primary,#1b1b1c);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);font-size:13px;line-height:1.45}',
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
			'#dsh-quota-card .dsh-quota-icon.is-active{color:var(--dsw-static-deepseek-500,#4176e6);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
			'@keyframes dsh-quota-spin{to{transform:rotate(360deg)}}',
			'#dsh-quota-card .dsh-provider{width:100%}',
			'#dsh-quota-card .dsh-provider-main{display:flex;align-items:flex-start;gap:10px}',
			'#dsh-quota-card .dsh-status-dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--dsw-static-green-500,#22c55e)}',
			'#dsh-quota-card .state-loading .dsh-status-dot{background:var(--dsw-static-neutral-bluish-400,#adb2b8)}',
			'#dsh-quota-card .state-warn .dsh-status-dot{background:var(--dsw-static-amber-500,#f59e0b)}',
			'#dsh-quota-card .state-error .dsh-status-dot{background:var(--dsw-static-red-500,#ef4444)}',
		'#dsh-quota-card .state-info .dsh-status-dot{background:var(--dsw-static-deepseek-500,#4176e6)}',
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
			'#dsh-quota-card .dsh-usage-caption{margin-top:8px;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;line-height:18px}',
			'#dsh-quota-card .dsh-quota-error{color:var(--dsw-static-red-500,#ef4444);font-size:12px;line-height:18px;word-break:break-all}',
			'#dsh-quota-card .dsh-setting-section{margin-bottom:12px}',
			'#dsh-quota-card .dsh-setting-title{margin-bottom:6px;color:var(--dsw-alias-label-primary,#1b1b1c);font-size:12px;font-weight:600;line-height:18px}',
			'#dsh-quota-card .dsh-setting-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0;color:var(--dsw-alias-label-primary,#1b1b1c);font-size:13px;line-height:20px}',
			'#dsh-quota-card .dsh-setting-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'#dsh-quota-card .dsh-setting-input,#dsh-quota-card .dsh-setting-select{width:104px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1c);font:inherit;font-size:12px;line-height:18px;box-sizing:border-box}',
			'#dsh-quota-card .dsh-setting-input:focus,#dsh-quota-card .dsh-setting-select:focus{outline:none;border-color:var(--dsw-static-deepseek-500,#4176e6)}',
			'#dsh-quota-card .dsh-setting-check{flex:none;accent-color:var(--dsw-static-deepseek-500,#4176e6)}',
			'#dsh-quota-card .dsh-setting-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
			'#dsh-quota-card .dsh-setting-hint{color:var(--dsw-alias-label-tertiary,#818590);font-size:11px;line-height:16px}',
			'#dsh-quota-card .dsh-setting-reset{padding:3px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:color 120ms ease,background-color 120ms ease}',
			'#dsh-quota-card .dsh-setting-proxy{width:150px}',
			'#dsh-quota-card .dsh-setting-reset:hover{color:var(--dsw-alias-label-primary,#1b1b1c);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}'
		].join("\n");

		function readSettings() {
			var base = { hidden: {}, refreshMs: null, warn: {}, proxy: {} };
			try {
				var raw = globalThis.localStorage.getItem(STORAGE_KEY);
				if (raw === null) return base;
				var parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object") {
					if (parsed.hidden && typeof parsed.hidden === "object") base.hidden = parsed.hidden;
					if (typeof parsed.refreshMs === "number" && Number.isFinite(parsed.refreshMs) && parsed.refreshMs >= 5000) base.refreshMs = parsed.refreshMs;
					if (parsed.warn && typeof parsed.warn === "object") base.warn = parsed.warn;
					if (parsed.proxy && typeof parsed.proxy === "object") base.proxy = parsed.proxy;
				}
			} catch (err) {}
			return base;
		}

		function writeSettings(settings) {
			try {
				globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
			} catch (err) {}
		}

		function fmtReset(iso) {
			var ms = new Date(iso).getTime() - Date.now();
			if (!isFinite(ms) || ms <= 0) return "即将重置";
			var s = Math.floor(ms / 1000);
			var d = Math.floor(s / 86400); s -= d * 86400;
			var h = Math.floor(s / 3600); s -= h * 3600;
			var m = Math.round(s / 60);
			if (m === 60) { h += 1; m = 0; }
			if (h === 24) { d += 1; h = 0; }
			var parts = [];
			if (d) parts.push(d + "天");
			if (h) parts.push(h + "小时");
			if (m) parts.push(m + "分");
			return parts.length ? parts.join("") : "即将重置";
		}

		/** Effective balance tiers with the local warn override applied. */
		function effectiveTiers(spec, warnOverride) {
			var tiers = spec.balanceTiers || { critical: 10, warn: 20, healthy: 50 };
			if (typeof warnOverride === "number" && Number.isFinite(warnOverride) && warnOverride >= 0) {
				return { critical: warnOverride / 2, warn: warnOverride, healthy: tiers.healthy };
			}
			return tiers;
		}

		/** Effective usage thresholds with the local warn override applied. */
		function effectivePercents(spec, warnOverride) {
			var warn = typeof warnOverride === "number" && Number.isFinite(warnOverride) && warnOverride >= 0 ? warnOverride : (spec.warnPercent || 70);
			var error = Math.max(spec.errorPercent || 90, warn + 1);
			return { warn: warn, error: Math.min(error, 100) };
		}

		/**
		 * Row view model: status + texts for one provider spec + its
		 * host-normalized view (kind balance / usage / info). Threshold
		 * judgement stays client-side so local settings overrides apply
		 * without a refetch.
		 */
		function rowView(spec, entry, warnOverride) {
			var kind = spec.kind || "balance";
			var unavailable = kind === "usage" ? "暂时无法获取用量" : kind === "info" ? "暂时无法获取配额" : "暂时无法获取余额";
			if (!entry || entry.error) {
				return {
					kind: kind, status: "error", summary: "—", value: "—",
					sub: unavailable, usageText: null, barPercent: 0, caption: "",
					title: entry && entry.error ? String(entry.error) : "no data"
				};
			}
			var view = entry.view || {};
			if (view.kind === "usage") {
				var w = view.windows || {};
				var rp = Number(w.rolling && w.rolling.percent) || 0;
				var wp = Number(w.weekly && w.weekly.percent) || 0;
				var mp = Number(w.monthly && w.monthly.percent) || 0;
				var high = Math.max(rp, wp, mp);
				var labels = spec.windowLabels || { rolling: "滚", weekly: "周", monthly: "月" };
				var pcts = effectivePercents(spec, warnOverride);
				var status = high >= pcts.error ? "error" : high >= pcts.warn ? "warn" : "ok";
				return {
					kind: "usage", status: status, summary: high + "%", value: null,
					usageText: labels.rolling + " " + rp + "% · " + labels.weekly + " " + wp + "% · " + labels.monthly + " " + mp + "%",
					barPercent: Math.min(Math.max(high, 0), 100),
					caption: "当前最高占用 " + high + "%",
					title: "rolling: " + rp + "%（重置于 " + fmtReset(w.rolling && w.rolling.resetsAt) + "）\nweekly: " + wp + "%（重置于 " + fmtReset(w.weekly && w.weekly.resetsAt) + "）\nmonthly: " + mp + "%（重置于 " + fmtReset(w.monthly && w.monthly.resetsAt) + "）"
				};
			}
			if (view.kind === "info") {
				var text = String(view.text || "—");
				return {
					kind: "info", status: "info",
					summary: text.length > 12 ? text.slice(0, 12) + "…" : text, value: null,
					sub: text, usageText: null, barPercent: 0, caption: "",
					title: view.title || ""
				};
			}
			var amount = Number(view.amount);
			if (!Number.isFinite(amount)) {
				return {
					kind: "balance", status: "error", summary: "—", value: "—",
					sub: "余额数据异常", usageText: null, barPercent: 0, caption: "",
					title: "non-numeric amount"
				};
			}
			var tiers = effectiveTiers(spec, warnOverride);
			var status2, sub;
			if (amount <= tiers.critical) { status2 = "error"; sub = "建议充值"; }
			else if (amount <= tiers.warn) { status2 = "warn"; sub = "余额紧张"; }
			else if (amount <= tiers.healthy) { status2 = "ok"; sub = "余额正常"; }
			else { status2 = "ok"; sub = "余额充足"; }
			var shown = (spec.currency || "¥") + amount.toFixed(2);
			return {
				kind: "balance", status: status2, summary: shown,
				value: shown, sub: sub, usageText: null, barPercent: 0, caption: "",
				title: view.title || ""
			};
		}

		function ProviderRow(props) {
			var spec = props.spec;
			var view = props.view;
			var children = [
				React.createElement("span", { key: "dot", className: "dsh-status-dot" })
			];
			var headChildren = [React.createElement("span", { key: "name", className: "dsh-provider-name" }, spec.label)];
			if (view.value !== null && view.value !== undefined) {
				headChildren.push(React.createElement("span", { key: "value", className: "dsh-provider-value" }, view.value));
			}
			var body = [React.createElement("div", { key: "head", className: "dsh-provider-head" }, headChildren)];
			if (view.kind === "usage") {
				body.push(React.createElement("div", { key: "usage", className: "dsh-usage-values" }, view.usageText));
				body.push(React.createElement("div", { key: "track", className: "dsh-progress" },
					React.createElement("div", { className: "dsh-progress-fill", style: { width: view.barPercent + "%" } })));
				if (view.caption) body.push(React.createElement("div", { key: "cap", className: "dsh-usage-caption" }, view.caption));
			} else if (view.sub) {
				body.push(React.createElement("div", { key: "sub", className: "dsh-provider-sub" }, view.sub));
			}
			children.push(React.createElement("div", { key: "body", className: "dsh-provider-body" }, body));
			return React.createElement("div", { className: "dsh-provider state-" + view.status, title: view.title },
				React.createElement("div", { className: "dsh-provider-main" }, children));
		}

		function SettingsPanel(props) {
			var specs = props.specs;
			var settings = props.settings;
			var onChange = props.onChange;
			var onReset = props.onReset;

			var toggle = function (id) {
				var hidden = Object.assign({}, settings.hidden);
				if (hidden[id]) delete hidden[id];
				else hidden[id] = true;
				onChange(Object.assign({}, settings, { hidden: hidden }));
			};
			var setRefresh = function (value) {
				var ms = value === "" ? null : Number(value);
				if (ms !== null && !(Number.isFinite(ms) && ms >= 5000)) ms = null;
				onChange(Object.assign({}, settings, { refreshMs: ms }));
			};
			var setWarn = function (id, text) {
				var warn = Object.assign({}, settings.warn);
				var n = Number(text);
				if (text === "" || !Number.isFinite(n) || n < 0) delete warn[id];
				else warn[id] = n;
				onChange(Object.assign({}, settings, { warn: warn }));
			};
			var setProxy = function (id, text) {
				var proxy = Object.assign({}, settings.proxy);
				var trimmed = text.trim();
				if (trimmed === "") delete proxy[id];
				else proxy[id] = trimmed;
				onChange(Object.assign({}, settings, { proxy: proxy }));
			};

			var refreshValue = "";
			if (settings.refreshMs !== null && settings.refreshMs !== undefined) {
				var match = REFRESH_CHOICES.some(function (choice) { return Number(choice.value) === settings.refreshMs; });
				refreshValue = match ? String(settings.refreshMs) : "";
			}

			var visibilityRows = specs.rows.map(function (spec) {
				return React.createElement("div", { key: spec.id, className: "dsh-setting-row" },
					React.createElement("span", { className: "dsh-setting-name" }, spec.label),
					React.createElement("input", {
						className: "dsh-setting-check",
						type: "checkbox",
						checked: !settings.hidden[spec.id],
						onChange: function () { toggle(spec.id); }
					}));
			});

			var proxyRows = specs.rows.map(function (spec) {
				var raw = settings.proxy && settings.proxy[spec.id] !== undefined ? String(settings.proxy[spec.id]) : "";
				var placeholder = spec.proxy
					? "已配置代理：" + spec.proxy + "（留空沿用）"
					: "http://127.0.0.1:7890（留空直连）";
				return React.createElement("div", { key: spec.id, className: "dsh-setting-row" },
					React.createElement("span", { className: "dsh-setting-name" }, spec.label),
					React.createElement("input", {
						className: "dsh-setting-input dsh-setting-proxy",
						type: "text",
						placeholder: placeholder,
						value: raw,
						onChange: function (event) { setProxy(spec.id, event.target.value); }
					}));
			});

			var thresholdRows = specs.rows.map(function (spec) {
				if (spec.kind === "info") return null;
				var isUsage = spec.kind === "usage";
				var placeholder = isUsage
					? "预警 %（默认 " + (spec.warnPercent || 70) + "）"
					: "预警 " + (spec.currency || "¥") + "（默认 " + ((spec.balanceTiers && spec.balanceTiers.warn) || 20) + "）";
				var raw = settings.warn[spec.id];
				return React.createElement("div", { key: spec.id, className: "dsh-setting-row" },
					React.createElement("span", { className: "dsh-setting-name" }, spec.label + (isUsage ? "（%）" : "（" + (spec.currency || "¥") + "）")),
					React.createElement("input", {
						className: "dsh-setting-input",
						type: "number",
						min: "0",
						placeholder: placeholder,
						value: raw === undefined || raw === null ? "" : String(raw),
						onChange: function (event) { setWarn(spec.id, event.target.value); }
					}));
			});

			return React.createElement("div", { className: "dsh-quota-settings" },
				React.createElement("div", { className: "dsh-setting-section" },
					React.createElement("div", { className: "dsh-setting-title" }, "显示供应商"),
					visibilityRows.length ? visibilityRows : React.createElement("div", { className: "dsh-setting-hint" }, "（未配置供应商）")),
				React.createElement("div", { className: "dsh-setting-section" },
					React.createElement("div", { className: "dsh-setting-title" }, "刷新间隔"),
					React.createElement("div", { className: "dsh-setting-row" },
						React.createElement("span", { className: "dsh-setting-name" }, "自动刷新"),
						React.createElement("select", {
							className: "dsh-setting-select",
							value: refreshValue,
							onChange: function (event) { setRefresh(event.target.value); }
						}, REFRESH_CHOICES.map(function (choice) {
							return React.createElement("option", { key: choice.value || "follow", value: choice.value },
								choice.value === "" ? choice.label + "（" + Math.round(specs.refreshMs / 1000) + " 秒）" : choice.label);
						})))),
				React.createElement("div", { className: "dsh-setting-section" },
					React.createElement("div", { className: "dsh-setting-title" }, "代理"),
					React.createElement("div", { className: "dsh-setting-hint", style: { marginBottom: "4px" } }, "填写 http(s) 代理 URL，仅该供应商经此代理查询"),
					proxyRows.length ? proxyRows : null),
				React.createElement("div", { className: "dsh-setting-section" },
					React.createElement("div", { className: "dsh-setting-title" }, "预警阈值"),
					thresholdRows.filter(Boolean).length ? thresholdRows : null),
				React.createElement("div", { className: "dsh-setting-actions" },
					React.createElement("span", { className: "dsh-setting-hint" }, "设置仅保存在本浏览器"),
					React.createElement("button", { className: "dsh-setting-reset", type: "button", onClick: onReset }, "恢复默认")));
		}

		const inject = ["slots", "timer", "connection"];

		function apply(ctx) {
			// Standard cordis effect: setup runs now, the RETURNED function is the
			// disposer. (Do NOT invoke the callback here — passing the disposer to
			// ctx.effect would run tag.remove() immediately and strip the CSS,
			// leaving the widget unstyled in the overlay layer's top-left corner.)
			ctx.effect(function () {
				var tag = document.createElement("style");
				tag.dataset.plugin = "dsh-quota-panel";
				tag.textContent = CSS;
				document.head.append(tag);
				return function () { tag.remove(); };
			});

			function QuotaPanel() {
				var specsState = React.useState(null);
				var specs = specsState[0], setSpecs = specsState[1];
				var dataState = React.useState({});
				var dataById = dataState[0], setDataById = dataState[1];
				var errState = React.useState(null);
				var loadError = errState[0], setLoadError = errState[1];
				var atState = React.useState(null);
				var fetchedAt = atState[0], setFetchedAt = atState[1];
				var expState = React.useState(false);
				var expanded = expState[0], setExpanded = expState[1];
				var setOpen = React.useState(false);
				var settingsOpen = setOpen[0], setSettingsOpen = setOpen[1];
				var refreshState = React.useState(false);
				var refreshing = refreshState[0], setRefreshing = refreshState[1];
				var settingsState = React.useState(readSettings);
				var settings = settingsState[0];
				var updateSettings = function (next) {
					writeSettings(next);
					settingsState[1](next);
				};

				var loadSpecs = function () {
					return ctx.connection.rpc.call(CHANNEL, "specs", null).then(function (result) {
						if (result && result.ok === true && result.value && Array.isArray(result.value.rows)) {
							setSpecs(result.value);
						} else {
							setLoadError(result && result.error ? result.error.message : "无法读取配置");
						}
					}).catch(function (error) {
						setLoadError(String((error && error.message) || error));
					});
				};

				var load = function () {
					var proxyPayload = {};
					if (settings.proxy && typeof settings.proxy === "object") {
						for (var key in settings.proxy) {
							var v = settings.proxy[key];
							if (typeof v === "string" && v.trim() !== "") proxyPayload[key] = v.trim();
						}
					}
					return ctx.connection.rpc.call(CHANNEL, "fetch-all", { proxy: proxyPayload }).then(function (result) {
						if (result && result.ok === true && result.value && Array.isArray(result.value.rows)) {
							var map = {};
							for (var i = 0; i < result.value.rows.length; i++) {
								var row = result.value.rows[i];
								map[row.id] = row;
							}
							setDataById(map);
							setFetchedAt(result.value.fetchedAt || Date.now());
							setLoadError(null);
						} else {
							setLoadError(result && result.error ? result.error.message : "查询失败");
						}
					}).catch(function (error) {
						setLoadError(String((error && error.message) || error));
					});
				};

				var refreshAll = function () {
					if (refreshing) return Promise.resolve();
					setRefreshing(true);
					return (specs ? Promise.resolve() : loadSpecs()).then(load).then(function () {
						setRefreshing(false);
					});
				};

				React.useEffect(function () {
					loadSpecs().then(load);
				}, []);

				var effectiveMs = settings.refreshMs !== null && settings.refreshMs !== undefined
					? settings.refreshMs
					: (specs ? specs.refreshMs : 60000);
				var proxyKey = JSON.stringify(settings.proxy || {});

				React.useEffect(function () {
					return ctx.interval(function () {
						if (!document.hidden) load();
					}, effectiveMs);
				}, [effectiveMs, proxyKey]);

				React.useEffect(function () {
					var onVisible = function () {
						if (!document.hidden) load();
					};
					document.addEventListener("visibilitychange", onVisible);
					return function () { document.removeEventListener("visibilitychange", onVisible); };
				}, [proxyKey]);

				var rows = [];
				var views = {};
				if (specs) {
					rows = specs.rows.filter(function (spec) { return !settings.hidden[spec.id]; });
					for (var i = 0; i < specs.rows.length; i++) {
						var spec = specs.rows[i];
						views[spec.id] = rowView(spec, dataById[spec.id], settings.warn[spec.id]);
					}
				}

				if (!expanded) {
					var pairs = [];
					if (specs === null && loadError !== null) {
						pairs.push(React.createElement("span", { key: "err", className: "dsh-capsule-item state-error" }, "—"));
					} else if (rows.length === 0) {
						pairs.push(React.createElement("span", { key: "none", className: "dsh-capsule-item state-loading" }, "已全部隐藏"));
					} else {
						for (var j = 0; j < rows.length; j++) {
							var rspec = rows[j];
							var view = views[rspec.id];
							pairs.push(React.createElement("span", { key: rspec.id + "-dot", className: "dsh-capsule-dot state-" + view.status }));
							pairs.push(React.createElement("span", {
								key: rspec.id + "-value",
								className: "dsh-capsule-item state-" + view.status + (view.kind === "usage" ? " dsh-usage" : "")
							}, view.summary));
						}
					}
						pairs.push(React.createElement("span", { key: "chevron", className: "dsh-capsule-chevron" }, "▾"));
					return React.createElement("div", { id: "dsh-quota-panel" },
						React.createElement("button", {
							id: "dsh-quota-capsule",
							type: "button",
							"aria-label": "展开模型额度",
							"aria-expanded": "false",
							onClick: function () { setExpanded(true); }
						}, pairs));
				}

				var bodyChildren = [];
				if (settingsOpen) {
					bodyChildren.push(React.createElement(SettingsPanel, {
						key: "settings",
						specs: specs,
						settings: settings,
						onChange: updateSettings,
						onReset: function () { updateSettings({ hidden: {}, refreshMs: null, warn: {}, proxy: {} }); }
					}));
				} else if (loadError !== null) {
					bodyChildren.push(React.createElement("div", { key: "err", className: "dsh-quota-error" }, String(loadError)));
				} else if (rows.length === 0) {
					bodyChildren.push(React.createElement("div", { key: "empty", className: "dsh-provider-sub" }, "所有供应商均已隐藏，可在设置中开启"));
				} else {
					for (var k = 0; k < rows.length; k++) {
						if (k > 0) bodyChildren.push(React.createElement("div", { key: rows[k].id + "-div", className: "dsh-quota-divider" }));
						bodyChildren.push(React.createElement(ProviderRow, { key: rows[k].id, spec: rows[k], view: views[rows[k].id] }));
					}
					if (fetchedAt !== null) {
						bodyChildren.push(React.createElement("div", { key: "at", className: "dsh-quota-divider" }));
						bodyChildren.push(React.createElement("div", { key: "at-text", className: "dsh-usage-caption" },
							"更新于 " + new Date(fetchedAt).toLocaleTimeString()));
					}
				}

				return React.createElement("div", { id: "dsh-quota-panel" },
					React.createElement("div", { id: "dsh-quota-card" },
						React.createElement("div", { className: "dsh-quota-header" },
							React.createElement("div", { className: "dsh-quota-title" }, "模型额度"),
							React.createElement("div", { className: "dsh-quota-actions" },
								React.createElement("button", {
									className: "dsh-quota-icon" + (refreshing ? " is-loading" : ""),
									type: "button",
									"aria-label": "刷新模型额度",
									disabled: refreshing,
									onClick: function () { refreshAll(); }
								}, "↻"),
								React.createElement("button", {
									className: "dsh-quota-icon" + (settingsOpen ? " is-active" : ""),
									type: "button",
									"aria-label": settingsOpen ? "关闭设置" : "打开设置",
									"aria-expanded": settingsOpen ? "true" : "false",
									onClick: function () { setSettingsOpen(!settingsOpen); }
								}, "⚙"),
								React.createElement("button", {
									className: "dsh-quota-icon",
									type: "button",
									"aria-label": "收起模型额度",
									onClick: function () { setExpanded(false); }
								}, "▴"))),
						bodyChildren));
			}

			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{ name: "shell.overlay", id: "dsh-quota-panel", order: 100, label: "模型额度" },
				() => React.createElement(QuotaPanel, null)
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
