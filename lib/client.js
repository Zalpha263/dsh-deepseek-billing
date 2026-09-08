window.__ModuleLoader__.load({
	id: "dsh-deepseek-billing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/* v0.1.13：React 仅用于会话探测槽位（不可见组件）；
		   dock 容器内仍是纯 DOM（不在此处做 React root 渲染）。
		   v0.1.21：① 窄宽度自适应（容器查询逐级遮挡 + 全量溢出收敛）；
		   ② 删除别名通道（UI/持久化/remote 描述符）；③ 缩小价格覆盖与
		   Token 明细字号。 */
		const React = require("react");

		/* ================= 会话跟随状态（v0.1.13） ================= */
		let currentSessionId = null;
		const sessionListeners = new Set();
		function setCurrentSession(id) {
			if (currentSessionId === id) return;
			currentSessionId = id;
			for (const fn of [...sessionListeners]) { try { fn(id) } catch (err) {} }
		}
		function SessionProbe(props) {
			React.useEffect(function () { setCurrentSession(props.sessionId || null) }, [props.sessionId]);
			return null;
		}

		/* v0.1.6：面板内容改为【纯 DOM 构建】（与 file-explorer 同模式）。
		   原因：React root 写入宿主管理的容器（ui-beautify PanelMount 的 div）时，
		   宿主在卸载后同步执行 el.textContent=''，与 React 异步提交竞争，导致
		   react-dom 内部 removeChild NotFoundError（未捕获异常打断应用渲染，
		   表现即多标签切换卡死）。纯 DOM 同步构建/清空完全可控，无此类竞争。 */

		/* ================= 常量与工具 ================= */
		const PANEL_ID = "deepseek-billing";
		const PANEL_TITLE = "峰谷计费";
		const PANEL_ICON = "💰";
		const LS_PREFIX = "dsh-deepseek-billing.";
		const CACHE_INTERVAL_MS = 5000;
		const TICK_MS = 1000;
		/* v0.1.19：诊断开关（true 时 summary 请求携带 debug，主机返回 diag 并打印到控制台）。 */
		const DEBUG_DIAG = false;

		const DEFAULT_PRICES = {
			"deepseek-v4-flash": { hit: 0.05, miss: 1.5, out: 4.5 },
			"deepseek-v4-pro": { hit: 0.15, miss: 4.5, out: 13.5 },
			"deepseek-v4-flash-vision-exp": { hit: 0.05, miss: 1.5, out: 4.5 },
			"deepseek-v4.1-flash-expires-on-0910": { hit: 0.05, miss: 1.5, out: 4.5 }
		};
		const MODEL_LABELS = {
			"deepseek-v4-flash": "V4 Flash",
			"deepseek-v4-pro": "V4 Pro",
			"deepseek-v4-flash-vision-exp": "V4 Flash Vision",
			"deepseek-v4.1-flash-expires-on-0910": "V4.1 Flash · 0910"
		};

		function lsGet(key, fallback) {
			try {
				const raw = window.localStorage.getItem(LS_PREFIX + key);
				return raw === null ? fallback : JSON.parse(raw);
			} catch (err) { return fallback; }
		}
		function lsSet(key, value) {
			try { window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch (err) {}
		}
		function lsClear() {
			try {
				window.localStorage.removeItem(LS_PREFIX + "prices");
				window.localStorage.removeItem(LS_PREFIX + "rate");
				/* v0.1.21：别名通道已删除，顺带清掉旧版本遗留的持久化键。 */
				window.localStorage.removeItem(LS_PREFIX + "aliases");
			} catch (err) {}
		}

		function fmtTokens(n) {
			const v = Number(n) || 0;
			return v >= 10000 ? Math.round(v / 1000) + "k" : String(v);
		}
		function fmtCny(v) {
			return "¥" + (Math.round(v * 10000) / 10000).toLocaleString("zh-CN", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
		}
		function fmtUsd(v, rate) {
			const usd = rate > 0 ? v / rate : 0;
			return "$" + (Math.round(usd * 1000000) / 1000000).toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 });
		}
		function fmtHms(msLeft) {
			if (msLeft <= 0) return "00:00:00";
			const s = Math.floor(msLeft / 1000);
			const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
			return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
		}
		function debugLog() {
			try { console.log.apply(console, ["[pvcst]", ...arguments]); } catch (err) {}
		}

		function cssBlock() {
			/* v0.1.8：按 Apple HIG 打磨 + 与 file-explorer 同款毛玻璃表层
			   （color-mix(bg-layer-2 86%, transparent) + blur(20px) saturate(180%)
			   + border-l2 + radius 12；内嵌控件用 solid bg-layer-1）。
			   v0.1.21：窄宽度自适应。此前卡片无 overflow 约束、行内文本
			   无 min-width:0/省略号，右侧面板被挤压时内容会画到卡片外面；
			   现按宿主自带面板同款策略处理（dsh-client-ui-chat 的
			   `@container (width<=900px){…display:none}`、deliverables 的
			   逐级隐藏），即：① 卡片/行全部 overflow:hidden + 文本省略；
			   ② 容器查询在宽度不足时逐级「遮挡」次要内容，而不是溢出。 */
			const css = `
.pvcst-root { container-type: inline-size; container-name: pvcst; }
.pvcst-body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--dsw-alias-label-primary); padding: 12px 14px; font-size: 12px; }
.pvcst-card { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; overflow: hidden; min-width: 0; }
.pvcst-title { font-size: 13px; font-weight: 600; letter-spacing: 0.2px; color: var(--dsw-alias-label-secondary); margin-bottom: 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pvcst-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-width: 0; }
.pvcst-head > .pvcst-title { flex: 1 1 auto; margin-bottom: 0; }
.pvcst-statusrow { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pvcst-costrow { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; min-width: 0; }
.pvcst-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 9px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); min-width: 0; }
.pvcst-row > :first-child { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pvcst-row > :last-child { flex: 0 0 auto; white-space: nowrap; }
.pvcst-rowlabel { font-size: 12px; }
.pvcst-rowval { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pvcst-rowlabel.pvcst-strong { font-weight: 600; }
.pvcst-rowval.pvcst-strong { font-size: 13px; font-weight: 700; }
.pvcst-row-plain { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 9px 0; min-width: 0; }
.pvcst-label { color: var(--dsw-alias-label-secondary); }
.pvcst-key { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pvcst-countdown { flex: 0 0 auto; margin-left: auto; }
.pvcst-badge { display: inline-flex; align-items: center; flex: 0 1 auto; min-width: 0; max-width: 100%; padding: 6px 12px; border-radius: 999px; color: #fff; font-size: 13px; font-weight: 700; letter-spacing: 0.3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pvcst-badge.peak { background: var(--dsw-alias-state-error-primary); }
.pvcst-badge.valley { background: var(--dsw-alias-state-success-primary); }
.pvcst-coin { font-size: 22px; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pvcst-btn { font-size: 11.5px; font-weight: 500; line-height: 16px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 5px 10px; cursor: pointer; flex: 0 0 auto; white-space: nowrap; }
.pvcst-input { width: 56px; height: 26px; box-sizing: border-box; font-size: 11.5px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 0 6px; flex: 0 0 auto; }
.pvcst-foot { font-size: 11.5px; color: var(--dsw-alias-label-secondary); line-height: 1.7; min-width: 0; overflow-wrap: anywhere; }
.pvcst-err { font-size: 12px; color: var(--dsw-alias-state-error-primary); padding: 8px 4px; }
.pvcst-form { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 12px; overflow: hidden; min-width: 0; }
.pvcst-formtitle { font-size: 12.5px; font-weight: 600; margin-bottom: 8px; color: var(--dsw-alias-label-primary); }
.pvcst-formmodel { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; color: var(--dsw-alias-label-primary); }
.pvcst-formrow { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; min-width: 0; }
.pvcst-formrow > .pvcst-label { flex: 1 1 auto; min-width: 0; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pvcst-btnrow { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
/* 窄宽度逐级遮挡：次要内容直接隐藏，而不是被挤到卡片外（宿主面板同款策略） */
@container pvcst (width<=320px) {
  .pvcst-body { padding: 10px 10px; }
  .pvcst-card { padding: 12px 12px; }
  .pvcst-form { padding: 10px 10px; }
  /* 换档时间提示（「距下一换档 … · 北京时间」）任何宽度都保留，只收紧字号 */
  .pvcst-sub { font-size: 11px; }
  .pvcst-badge { padding: 5px 10px; }
}
@container pvcst (width<=250px) {
  .pvcst-note { display: none; }
  .pvcst-key { font-size: 13px; }
  .pvcst-coin { font-size: 18px; }
  .pvcst-rowlabel { font-size: 11.5px; }
  .pvcst-rowval { font-size: 12px; }
  .pvcst-rowval.pvcst-strong { font-size: 12.5px; }
}
@container pvcst (width<=190px) {
  .pvcst-countdown { display: none; }
  .pvcst-costrow { flex-wrap: wrap; }
  .pvcst-formrow { flex-wrap: wrap; }
  .pvcst-formrow > .pvcst-input { width: 100%; }
}
/* v0.1.12：插件面板「···（全部插件）」按钮置顶（flex order，视觉最前） */
[data-vsc-pplist] > div > button[title="全部插件"] { order: -1; }
/* v0.1.23：未安装 ui-beautify 时的独立入口与浮动面板（与宿主按钮同款胶囊语言） */
.pvcst-entry { display: inline-flex; align-items: center; gap: 4px; height: 32px; padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 18px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; cursor: pointer; transition: background .15s ease, border-color .15s ease; }
.pvcst-entry:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pvcst-entry.pvcst-entry-on { background: var(--dsw-alias-interactive-bg-hover); }
.pvcst-float { position: fixed; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden; resize: both; background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 96%, transparent); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3); z-index: 900; }
.pvcst-floatbar { display: flex; align-items: center; gap: 6px; flex: none; padding: 8px 10px; cursor: grab; user-select: none; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.pvcst-floatx { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 6px; cursor: pointer; font-size: 13px; line-height: 1; }
.pvcst-floatx:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pvcst-floatbody { flex: 1 1 auto; min-height: 0; overflow: auto; }
`;
			const style = document.createElement("style");
			style.id = "dsh-deepseek-billing-css";
			style.textContent = css;
			document.head.appendChild(style);
			return () => { if (style.parentNode) style.parentNode.removeChild(style); };
		}

		/* ================= Remote namespace contribution ================= */
		// `remote.deepseekBilling` 由本入口挂载（不能出现在 inject，否则自锁）。
		function passthroughSchema() {
			return { parse: (value) => value };
		}
		function strictCodec(typeSymbol) {
			return { mode: "strict", typeSymbol, schema: passthroughSchema() };
		}
		const CONTRIBUTION = {
			package: "dsh-deepseek-billing",
			descriptors: [
				{
					id: "dsh-deepseek-billing#deepseekBilling/summary",
					service: "deepseekBilling",
					namespace: "deepseekBilling",
					method: "summary",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "input", wire: "input", source: "json", codec: strictCodec("dsh-deepseek-billing#deepseekBilling/summary:input") }
					],
					result: strictCodec("dsh-deepseek-billing#deepseekBilling/summary:result"),
					sourceLocation: { file: "dsh-deepseek-billing/lib/client.js", line: 1, column: 1 }
				},
				{
					id: "dsh-deepseek-billing#deepseekBilling/status",
					service: "deepseekBilling",
					namespace: "deepseekBilling",
					method: "status",
					invocation: { kind: "direct" },
					parameters: [],
					result: strictCodec("dsh-deepseek-billing#deepseekBilling/status:result"),
					sourceLocation: { file: "dsh-deepseek-billing/lib/client.js", line: 1, column: 1 }
				},
				{
					id: "dsh-deepseek-billing#deepseekBilling/setPrices",
					service: "deepseekBilling",
					namespace: "deepseekBilling",
					method: "setPrices",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "input", wire: "input", source: "json", codec: strictCodec("dsh-deepseek-billing#deepseekBilling/setPrices:input") }
					],
					result: strictCodec("dsh-deepseek-billing#deepseekBilling/setPrices:result"),
					sourceLocation: { file: "dsh-deepseek-billing/lib/client.js", line: 1, column: 1 }
				},
				{
					id: "dsh-deepseek-billing#deepseekBilling/setRate",
					service: "deepseekBilling",
					namespace: "deepseekBilling",
					method: "setRate",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "input", wire: "input", source: "json", codec: strictCodec("dsh-deepseek-billing#deepseekBilling/setRate:input") }
					],
					result: strictCodec("dsh-deepseek-billing#deepseekBilling/setRate:result"),
					sourceLocation: { file: "dsh-deepseek-billing/lib/client.js", line: 1, column: 1 }
				}
			]
		};

		// Remote 调用封装：命名空间方法返回 { ok, value } 信封。
		function unwrap(result) {
			if (result && result.ok === true) return result.value;
			const error = result && result.error;
			throw new Error((error && error.message) || "deepseekBilling remote call failed");
		}
		let applyCtx = null;
		function ctxGetRemote() {
			if (applyCtx === null) return undefined;
			return applyCtx.get("remote.deepseekBilling");
		}
		function remote() {
			const call = function (method) {
				const args = Array.prototype.slice.call(arguments, 1);
				return Promise.resolve().then(() => {
					const ns = ctxGetRemote();
					if (ns === undefined) throw new Error("deepseekBilling namespace unavailable");
					return ns[method].apply(ns, args);
				}).then(unwrap);
			};
			return {
				summary: (input) => call("summary", input),
				status: () => call("status"),
				setPrices: (input) => call("setPrices", input),
				setRate: (input) => call("setRate", input)
			};
		}

		/* ================= 持久化再水合 ================= */
		function hydrateFromStorage(r) {
			const prices = lsGet("prices", null);
			if (prices && typeof prices === "object") {
				const jobs = [];
				for (const model of Object.keys(prices)) {
					const row = prices[model];
					if (!row) continue;
					for (const bucket of ["hit", "miss", "out"]) {
						const v = Number(row[bucket]);
						if (Number.isFinite(v) && v >= 0) jobs.push(r.setPrices({ model, bucket, valley: v }));
					}
				}
				return Promise.all(jobs);
			}
			return Promise.resolve();
		}
		function hydrateRate(r) {
			const rate = lsGet("rate", null);
			if (rate !== null && Number.isFinite(Number(rate)) && Number(rate) > 0) return r.setRate({ rate: Number(rate) });
			return Promise.resolve();
		}

		/* ================= 纯 DOM 面板（v0.1.6） ================= */
		/* v0.1.21：CSSOM 会丢弃无单位的数值——`el.style.fontSize = 11` 会被转成
		   字符串 "11"（非法长度）而静默忽略。此前所有数值型内联样式都没生效：
		   Token 明细行拿不到 11px，只能继承宿主容器的 16px（比 13px 的标题还大），
		   marginTop/width 等同理。这里对非无单位属性补 px。 */
		const UNITLESS_STYLE_PROPS = {
			flex: 1, flexGrow: 1, flexShrink: 1, flexBasis: 0, fontWeight: 1, lineHeight: 1,
			opacity: 1, order: 1, zIndex: 1, zoom: 1, tabSize: 1, columnCount: 1, columns: 1,
			aspectRatio: 1, fillOpacity: 1, strokeOpacity: 1, strokeWidth: 1,
			gridRow: 1, gridColumn: 1, animationIterationCount: 1, WebkitLineClamp: 1
		};
		function cssLength(prop, value) {
			if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return value;
			return UNITLESS_STYLE_PROPS[prop] === 1 ? value : value + "px";
		}
		function h(tag, props, children) {
			const el = document.createElement(tag);
			if (props) {
				for (const k of Object.keys(props)) {
					const v = props[k];
					if (v === undefined || v === null) continue;
					if (k === "className") el.className = v;
					else if (k === "style" && typeof v === "object") {
						for (const p of Object.keys(v)) {
							const pv = v[p];
							if (pv === undefined || pv === null) continue;
							el.style[p] = cssLength(p, pv);
						}
					}
					else if (k === "text") el.textContent = v;
					else if (k === "html") el.innerHTML = v;
					else if (typeof v === "function") el.addEventListener(k.slice(0, 2) === "on" ? k.slice(2).toLowerCase() : k, v);
					else el.setAttribute(k, String(v));
				}
			}
			if (children !== undefined && children !== null) {
				if (Array.isArray(children)) for (const c of children) if (c) el.appendChild(c);
				else if (typeof children === "string") el.textContent = children;
				else el.appendChild(children);
			}
			return el;
		}

		/** 面板实例状态（每个面板容器独立） */
		function createPanelState() {
			return {
				data: null,
				err: null,
				now: Date.now(),
				currency: lsGet("currency", "cny") === "usd" ? "usd" : "cny",
				showForm: false,
				alive: true,
				timers: [],
				flashTimer: null,
				zones: null,
				poll: null,
				unsubSession: null
			};
		}

		function buildSkeleton(st) {
			const body = h("div", { className: "pvcst-body" });
			/* 状态卡 */
			const statusCard = h("div", { className: "pvcst-card" }, [
				h("div", { className: "pvcst-statusrow" }, [
					h("span", { className: "pvcst-badge valley", text: "…" }),
					h("span", { className: "pvcst-key pvcst-countdown", text: "--:--:--" })
				]),
				h("div", { className: "pvcst-foot pvcst-sub", style: { marginTop: 10 }, text: "…" })
			]);
			/* 费用卡：只保留标题 + 总额 + 币种切换（含零金额原因说明位） */
			const costCard = h("div", { className: "pvcst-card" }, [
				h("div", { className: "pvcst-title", text: "本次窗口费用" }),
				h("div", { className: "pvcst-costrow" }, [
					h("span", { className: "pvcst-key pvcst-coin", text: "…" }),
					h("button", { type: "button", className: "pvcst-btn", text: "切 USD" })
				]),
				h("div", { className: "pvcst-foot pvcst-note", style: { marginTop: 4 }, text: "" })
			]);
			/* 明细卡：标题行 = 「Token 明细」+ 右侧刷新按钮（v0.1.14 从状态卡移入） */
			const refreshBtn = h("button", { type: "button", className: "pvcst-btn", style: { padding: "2px 8px", lineHeight: "14px", fontSize: 11 }, text: "↻ 刷新", title: "手动刷新" });
			const detailTitle = h("div", { className: "pvcst-head" }, [
				h("div", { className: "pvcst-title", text: "Token 明细" }),
				refreshBtn
			]);
			const detailCard = h("div", { className: "pvcst-card" }, [
				detailTitle,
				h("div", { className: "pvcst-rows" })
			]);
			/* 页脚 */
			const foot = h("div", { className: "pvcst-foot pvcst-note", text: "…" });
			body.appendChild(statusCard);
			body.appendChild(costCard);
			body.appendChild(detailCard);
			body.appendChild(foot);
			/* 价格配置区（延迟创建） */
			const formToggle = h("div", { style: { marginTop: 6 } }, [
				h("button", { type: "button", className: "pvcst-btn", text: "价格配置" })
			]);
			const formContainer = h("div");
			body.appendChild(formToggle);
			body.appendChild(formContainer);
			st.zones = { body, statusCard, costCard, detailCard, foot, formToggle, formContainer, coin: costCard.children[1].children[0], cnyBtn: costCard.children[1].children[1], costNote: costCard.children[2], countdown: statusCard.children[0].children[1], badge: statusCard.children[0].children[0], sub: statusCard.children[1], refreshBtn };

			/* 事件挂载 */
			refreshBtn.addEventListener("click", function () {
				if (st.poll) st.poll();
				/* 反馈：短暂显示 ✓ 后恢复 */
				refreshBtn.textContent = "✓";
				if (st.flashTimer !== null) window.clearTimeout(st.flashTimer);
				st.flashTimer = window.setTimeout(function () { refreshBtn.textContent = "↻ 刷新"; st.flashTimer = null; }, 800);
			});
			st.zones.cnyBtn.addEventListener("click", function () {
				st.currency = st.currency === "cny" ? "usd" : "cny";
				lsSet("currency", st.currency);
				renderData(st);
			});
			formToggle.children[0].addEventListener("click", function () {
				st.showForm = !st.showForm;
				renderForm(st);
			});
			return body;
		}

		function renderData(st) {
			const z = st.zones;
			if (!z || !st.alive) return;
			const d = st.data;
			if (!d) {
				z.coin.textContent = st.err ? "加载失败" : "…";
				return;
			}
			if (d.diag) {
				try { console.log("[pvcst] diag", d.diag); } catch (err) {}
			}
			if (d.empty === true) {
				/* v0.1.19：未打开会话——显示占位而非聚合"最近活动会话"。 */
				z.badge.textContent = "峰谷计费";
				z.sub.textContent = "打开一个会话后开始计价";
				z.coin.textContent = "—";
				z.costNote.textContent = "等待会话…";
				const rows = z.detailCard.children[1];
				rows.textContent = "";
				z.foot.textContent = "会话 " + "—";
				return;
			}
			const peak = d.status && d.status.phase === "peak";
			z.badge.textContent = (peak ? "梁文峰 · 高峰" : "梁文谷 · 闲时") + (d.status && d.status.weekendAllValley ? "（周末）" : "");
			z.badge.className = "pvcst-badge " + (peak ? "peak" : "valley");
			z.sub.textContent = "距下一换档 " + (d.status && d.status.endsAt ? new Date(d.status.endsAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—") + " · 北京时间";
			const rate = (d.meta && d.meta.fxRate) || 7.16;
			const total = (d.cost && d.cost.totalCny) || 0;
			z.coin.textContent = st.currency === "cny" ? fmtCny(total) : fmtUsd(total, rate);
			z.cnyBtn.textContent = st.currency === "cny" ? "切 USD" : "切 CNY";
			/* 预估提示（v0.1.17）：本地按价表估算，实际以 API 平台账单为准 */
			const note = [];
			note.push("本地预估价 · 实际以 API 平台账单为准");
			const callsInfo = d.calls || {};
			const ndm = d.nonDeepModels || [];
			const ndmText = ndm.map(function (x) { return x.model + "×" + x.count; }).join("、");
			if (callsInfo.nonDeep > 0) {
				note.push((ndmText ? ndmText + "（" + callsInfo.nonDeep + " 次）" : callsInfo.nonDeep + " 次") + "调用未识别为 DeepSeek 模型，不计价");
			} else if (callsInfo.unpriced > 0) {
				note.push(callsInfo.unpriced + " 次调用发生在 2026-08-17 峰谷定价前，无价可计（Token 已计入明细）");
			}
			z.costNote.textContent = note.join(" · ");
			/* 预估值说明（悬浮显示全量口径） */
			z.costNote.title = "按官方价表与本地会话流估算（不含 Web 搜索/标题生成等平台侧调用），实际金额以 API 平台账单为准";
			/* Token 明细 */
			const rows = z.detailCard.children[1];
			rows.textContent = "";
			const tok = d.tokens || {};
			const detail = [
				["输入 · 缓存命中", tok.inHit],
				["输入 · 未命中", tok.inMiss],
				["输出（含推理）", tok.out],
				["推理 tokens", tok.reasoning]
			];
			for (const item of detail) {
				rows.appendChild(h("div", { className: "pvcst-row" }, [
					h("span", { className: "pvcst-label pvcst-rowlabel", text: item[0] }),
					h("span", { className: "pvcst-rowval", text: fmtTokens(item[1]) + " tok" })
				]));
			}
			/* 总消耗 = 缓存命中 + 未命中 + 输出（含推理；计费口径） */
			const totalTok = (tok.inHit || 0) + (tok.inMiss || 0) + (tok.out || 0);
			rows.appendChild(h("div", { className: "pvcst-row", style: { borderBottom: "none" } }, [
				h("span", { className: "pvcst-label pvcst-rowlabel pvcst-strong", text: "总消耗" }),
				h("span", { className: "pvcst-rowval pvcst-strong", text: fmtTokens(totalTok) + " tok" })
			]));
			/* 页脚 */
			const calls = d.calls || {};
			const notes = [];
			if (calls.unpriced > 0) notes.push(calls.unpriced + " 次调用无用量/调价前未计价");
			if (calls.nonDeep > 0) notes.push(calls.nonDeep + " 次未识别模型不计价");
			const meta = d.meta || {};
			/* v0.1.20：价表日期由宿主 meta.priceAsOf 提供（客户端不再硬编码），
			   manual 覆盖态由宿主按「是否存在手动覆盖」真实计算。 */
			z.foot.textContent = "价格源：内置官方 " + (typeof meta.priceAsOf === "string" && meta.priceAsOf !== "" ? meta.priceAsOf : "2026-09-03") + (meta.priceSource === "manual" ? "（已手动覆盖）" : "") +
				" · 汇率 " + ((meta.fxRate || 7.16).toFixed(4)) + "（" + (meta.fxSource || "default") + "）" +
				(notes.length ? " · " + notes.join(" · ") : "") +
				" · 会话 " + String(d.sessionId || "").slice(-8) +
				((d.childCount || 0) > 0 ? " · 含 " + d.childCount + " 个子代理会话" : "");
		}

		function renderTicker(st) {
			if (!st.zones || !st.alive) return;
			const d = st.data;
			const remain = d && d.status && d.status.endsAt ? d.status.endsAt - st.now : 0;
			st.zones.countdown.textContent = fmtHms(remain);
		}

		function renderForm(st) {
			const z = st.zones;
			z.formContainer.textContent = "";
			z.formToggle.children[0].textContent = st.showForm ? "收起价格配置" : "价格配置";
			if (!st.showForm) return;
			const models = Object.keys(DEFAULT_PRICES);
			const buckets = [["hit", "缓存命中"], ["miss", "未命中"], ["out", "输出"]];
			const box = h("div", { className: "pvcst-form", style: { marginTop: 10 } });
			box.appendChild(h("div", { className: "pvcst-formtitle", text: "手动价格覆盖（官方改价时使用）" }));
			const inputs = {};
			for (const m of models) {
				const cell = h("div", { style: { margin: "10px 0" } });
				cell.appendChild(h("div", { className: "pvcst-formmodel", text: MODEL_LABELS[m] || m }));
				for (const [b, bl] of buckets) {
					const input = h("input", { type: "number", step: "0.01", min: "0", className: "pvcst-input", value: String(DEFAULT_PRICES[m][b]) });
					inputs[m + ":" + b] = input;
					cell.appendChild(h("div", { className: "pvcst-formrow" }, [
						h("span", { className: "pvcst-label", text: bl }),
						input
					]));
				}
				box.appendChild(cell);
			}
			const msg = h("div", { className: "pvcst-foot pvcst-msg", style: { marginTop: 4 } });
			const saveBtn = h("button", { type: "button", className: "pvcst-btn", text: "保存" });
			const resetBtn = h("button", { type: "button", className: "pvcst-btn", text: "恢复官方" });
			saveBtn.addEventListener("click", function () {
				let p = Promise.resolve();
				const stored = {};
				for (const m of models) {
					stored[m] = {};
					for (const [b] of buckets) {
						const v = Number(inputs[m + ":" + b].value);
						if (!Number.isFinite(v) || v < 0) continue;
						stored[m][b] = v;
						p = p.then(function () { return remote().setPrices({ model: m, bucket: b, valley: v }); });
					}
				}
				lsSet("prices", stored);
				p.then(function () { msg.textContent = "已保存（下次打开自动生效）"; }).catch(function (e) { msg.textContent = "保存失败：" + String(e && e.message || e); });
			});
			resetBtn.addEventListener("click", function () {
				lsClear();
				remote().setPrices({ reset: true }).then(function () {
					for (const m of models) for (const [b] of buckets) inputs[m + ":" + b].value = String(DEFAULT_PRICES[m][b]);
					msg.textContent = "已恢复官方内置价格";
				}).catch(function (e) { msg.textContent = String(e && e.message || e); });
			});
			box.appendChild(h("div", { className: "pvcst-btnrow" }, [saveBtn, resetBtn]));
			box.appendChild(h("div", { className: "pvcst-foot", style: { marginTop: 8 }, text: "单位：元 / 每 1M tokens · 高峰价 = 闲时价 × 2" }));
			box.appendChild(msg);

			z.formContainer.appendChild(box);
		}

		/* ================= dock 面板 ================= */
		function mountPanel(el) {
			const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
			el.textContent = "";
			const st = createPanelState();
			const body = buildSkeleton(st);
			/* v0.1.21：外层容器承载 container-type（容器查询基准），卡片在其内自适应。 */
			const root = h("div", { className: "pvcst-root" }, [body]);
			el.appendChild(root);
			renderTicker(st);
			renderForm(st);

			/* 轮询 + 秒针（v0.1.13：跟随当前会话；会话切换时立即重拉。
			   v0.1.19：sessionId 恒显式传递（未打开会话时为 null）——主机不再
			   静默聚合"最近活动会话"，避免打开历史会话时面板显示到别的会话。） */
			const poll = function () {
				remote().summary({ sessionId: currentSessionId, debug: DEBUG_DIAG }).then(function (r) {
					if (!st.alive) return;
					st.data = r;
					st.err = null;
					renderData(st);
					renderTicker(st);
				}).catch(function (e) {
					if (!st.alive) return;
					st.err = String(e && e.message || e);
					st.data = null;
					renderData(st);
				});
			};
			st.poll = poll;
			poll();
			const t1 = window.setInterval(poll, CACHE_INTERVAL_MS);
			const t2 = window.setInterval(function () {
				if (!st.alive) return;
				st.now = Date.now();
				renderTicker(st);
			}, TICK_MS);
			st.timers.push(t1, t2);
			/* 会话切换 → 立即重拉 */
			st.unsubSession = function () {
				sessionListeners.add(poll);
				return function () { sessionListeners.delete(poll); };
			}();
			debugLog("mount(纯 DOM)", stamp);
			return function () {
				st.alive = false;
				if (st.unsubSession) { try { st.unsubSession(); } catch (err) {} }
				if (st.flashTimer !== null) window.clearTimeout(st.flashTimer);
				for (const t of st.timers) { try { window.clearInterval(t); } catch (err) {} }
				st.timers = [];
				/* 同步清空容器，宿主随后也会做一次（幂等） */
				try { el.textContent = ""; } catch (err) {}
				debugLog("unmount(纯 DOM)", stamp);
			};
		}

		/* ================= 独立面板（未安装 ui-beautify 时的降级界面） =================
		   v0.1.23：此前在原生 Web UI 里本插件完全不可见——面板只注册到 ui-beautify 的
		   dock 服务上，没装 ui-beautify 就没有任何入口。现在补一条降级链路：会话标题栏
		   出现「💰 计费」按钮，点开是一张可拖动、可缩放的浮动卡片，内容与插件面板里的
		   完全一致（复用同一个 mountPanel）。装上 ui-beautify 时按钮自动隐藏、面板交回
		   插件面板；ui-beautify 被卸载或热重载时按钮重新出现，之前开着的卡片也会自动回来。 */
		const STANDALONE_KEY = "standalone";
		const FLOAT_DEFAULT_W = 340;
		const FLOAT_DEFAULT_H = 480;
		let dockActive = false;
		const uiListeners = new Set();
		function bumpUi() {
			for (const fn of [...uiListeners]) { try { fn(); } catch (err) {} }
		}
		const standalone = { el: null, body: null, dispose: null, wantOpen: false, pos: null, saveTimer: null, ro: null };

		function loadStandalone() {
			const saved = lsGet(STANDALONE_KEY, null);
			if (!saved || typeof saved !== "object") return;
			const num = function (v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
			standalone.wantOpen = saved.open === true;
			standalone.pos = clampFloatRect({ x: num(saved.x, 0), y: num(saved.y, 0), w: num(saved.w, FLOAT_DEFAULT_W), h: num(saved.h, FLOAT_DEFAULT_H) });
		}
		function saveStandalone() {
			const p = standalone.pos || defaultFloatRect();
			lsSet(STANDALONE_KEY, { open: standalone.wantOpen === true, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h) });
		}
		function defaultFloatRect() {
			const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
			return { x: Math.max(12, vw - FLOAT_DEFAULT_W - 24), y: Math.max(12, Math.round((vh - FLOAT_DEFAULT_H) / 2)), w: FLOAT_DEFAULT_W, h: FLOAT_DEFAULT_H };
		}
		function clampFloatRect(r) {
			const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
			const w = Math.min(Math.max(260, r.w), Math.max(260, vw - 24));
			const h = Math.min(Math.max(320, r.h), Math.max(320, vh - 24));
			return { x: Math.min(Math.max(0, r.x), Math.max(0, vw - w - 8)), y: Math.min(Math.max(0, r.y), Math.max(0, vh - h - 8)), w: w, h: h };
		}
		function applyFloatRect() {
			if (standalone.el === null || standalone.pos === null) return;
			const p = standalone.pos;
			standalone.el.style.left = p.x + "px";
			standalone.el.style.top = p.y + "px";
			standalone.el.style.width = p.w + "px";
			standalone.el.style.height = p.h + "px";
		}
		function standaloneVisible() { return standalone.wantOpen === true && dockActive === false; }

		function startFloatDrag(e) {
			if (standalone.el === null) return;
			const t = e.target;
			if (t && typeof t.closest === "function" && t.closest("button") !== null) return;
			const base = standalone.pos || defaultFloatRect();
			const sx = e.clientX, sy = e.clientY;
			if (e.preventDefault) e.preventDefault();
			const move = function (ev) {
				standalone.pos = clampFloatRect({ x: base.x + (ev.clientX - sx), y: base.y + (ev.clientY - sy), w: base.w, h: base.h });
				applyFloatRect();
			};
			const up = function () {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				window.removeEventListener("pointercancel", up);
				saveStandalone();
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", up);
		}

		function ensureStandalone() {
			if (standalone.el !== null) return;
			standalone.pos = clampFloatRect(standalone.pos || defaultFloatRect());
			const bar = h("div", { className: "pvcst-floatbar", onPointerDown: startFloatDrag }, [
				h("span", {
					text: "💰 峰谷计费",
					style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }
				}),
				h("button", { type: "button", className: "pvcst-floatx", title: "关闭", text: "×", onClick: function () { closeStandalone(); } })
			]);
			const body = h("div", { className: "pvcst-floatbody" });
			const card = h("div", { className: "pvcst-float" }, [bar, body]);
			document.body.appendChild(card);
			standalone.el = card;
			standalone.body = body;
			applyFloatRect();
			standalone.dispose = mountPanel(body);
			if (typeof window.ResizeObserver === "function") {
				standalone.ro = new window.ResizeObserver(function () {
					if (standalone.el === null) return;
					const r = standalone.el.getBoundingClientRect();
					if (r.width < 1 || r.height < 1) return;
					standalone.pos = clampFloatRect({ x: standalone.pos.x, y: standalone.pos.y, w: Math.round(r.width), h: Math.round(r.height) });
					if (standalone.saveTimer !== null) window.clearTimeout(standalone.saveTimer);
					standalone.saveTimer = window.setTimeout(function () { standalone.saveTimer = null; saveStandalone(); }, 300);
				});
				standalone.ro.observe(card);
			}
		}
		function unmountStandalone() {
			if (standalone.ro !== null) { try { standalone.ro.disconnect(); } catch (err) {} standalone.ro = null; }
			if (standalone.saveTimer !== null) { window.clearTimeout(standalone.saveTimer); standalone.saveTimer = null; }
			if (typeof standalone.dispose === "function") { try { standalone.dispose(); } catch (err) {} }
			standalone.dispose = null;
			if (standalone.el !== null) { try { standalone.el.remove(); } catch (err) {} }
			standalone.el = null;
			standalone.body = null;
		}
		function openStandalone() {
			standalone.wantOpen = true;
			if (!dockActive) ensureStandalone();
			saveStandalone();
			bumpUi();
		}
		function closeStandalone() {
			standalone.wantOpen = false;
			unmountStandalone();
			saveStandalone();
			bumpUi();
		}
		function hideStandalone() { unmountStandalone(); bumpUi(); }
		function toggleStandalone() { if (standalone.el !== null) closeStandalone(); else openStandalone(); }
		function onStandaloneResize() {
			if (standalone.el === null) return;
			standalone.pos = clampFloatRect(standalone.pos);
			applyFloatRect();
			saveStandalone();
		}
		/* dock 服务出现/消失时在「插件面板」与「独立浮动卡」之间切换 */
		function setDockActive(v) {
			if (dockActive === v) return;
			dockActive = v;
			if (v) hideStandalone();
			else if (standalone.wantOpen === true) ensureStandalone();
			bumpUi();
		}

		/* 会话标题栏入口（仅在没有 ui-beautify 时出现） */
		function BillingEntry() {
			const [, setV] = React.useState(0);
			React.useEffect(function () {
				const fn = function () { setV(function (v) { return v + 1; }); };
				uiListeners.add(fn);
				return function () { uiListeners.delete(fn); };
			}, []);
			if (dockActive) return null;
			return React.createElement("button", {
				type: "button",
				className: "pvcst-entry" + (standaloneVisible() ? " pvcst-entry-on" : ""),
				title: standaloneVisible() ? "关闭峰谷计费面板" : "打开峰谷计费面板",
				onClick: function () { toggleStandalone(); }
			}, "💰 计费");
		}

		/* ================= apply ================= */
		async function apply(ctx) {
			debugLog("apply 启动");
			try {
				applyCtx = ctx;
				const cssDispose = cssBlock();
				ctx.effect(function () { return cssDispose; });
				debugLog("css 已注入 · 挂载 remote…");

				// 挂载 remote 命名空间（本入口自装，不能出现在 inject —— 会自锁）。
				// 失败不致命：面板仍注册，仅摘要调用会显示加载失败。
				try {
					const disposeMount = await ctx.remote.$mount(CONTRIBUTION);
					ctx.effect(function () { return () => { try { disposeMount(); } catch (err) {} }; });
					debugLog("remote 挂载成功 · 等待 dock…");
					// 本机持久化恢复：价格覆盖 + 汇率（失败静默）
					hydrateFromStorage(remote()).catch(function () {});
					hydrateRate(remote()).catch(function () {});
					/* v0.1.21：别名通道已删除，清掉旧版本遗留的 localStorage 镜像。 */
					try { window.localStorage.removeItem(LS_PREFIX + "aliases"); } catch (err) {}
				} catch (err) {
					console.error("[dsh-deepseek-billing] remote namespace mount failed:", err);
				}

				/* dock 面板（ui-beautify 可能晚于本插件提供 dock）。
				   规范见 dsh-ui-beautify/docs/plugin-panel-integration.md（dock API v2）。
				   ① 首选 cordis 可选依赖 `ctx.inject(['dock'], cb)`：dock 出现时执行回调
				      （注册面板），dock 消失（ui-beautify 热重载/重装）时执行回调返回的
				      清理函数，dock 再次出现时自动重新执行 —— 不需要轮询，也不会因为
				      重复的 internal/service 事件把用户正在看的面板反复注销重注册
				      （那会导致热重载后面板回来但是关着的）；
				   ② 守护 ctx（运行时动态包）没有 `inject`，退化为 internal/service 事件
				      + 1s 兜底轮询的**幂等**绑定器：已绑定且 `dock.has(id)` 为真时跳过，
				      只在 dock 注销或 host 被换掉时才重绑。 */
				const panelDef = { id: PANEL_ID, title: PANEL_TITLE, icon: PANEL_ICON, mount: mountPanel };
				const registerInto = function (d) {
					try {
						const dispose = d.registerPanel(panelDef);
						debugLog("dock 注册成功:", PANEL_ID);
						/* v0.1.23：面板已交给插件面板 —— 独立浮动卡与标题栏入口自动让位 */
						setDockActive(true);
						return function () {
							try { dispose(); } catch (err) {}
							setDockActive(false);
						};
					} catch (err) {
						console.error("[dsh-deepseek-billing] dock panel registration failed:", err);
						return null;
					}
				};
				const bindDockFallback = function () {
					let dispose = null;
					let bound = false;
					let boundTo = null;
					let stopped = false;
					const unbind = function () {
						if (dispose !== null) { try { dispose(); } catch (err) {} }
						dispose = null;
						bound = false;
						boundTo = null;
					};
					const sync = function () {
						if (stopped) return;
						const d = ctx.get("dock");
						if (d === undefined || d === null || typeof d.registerPanel !== "function") { unbind(); return; }
						if (bound) {
							const alive = typeof d.has === "function" ? d.has(PANEL_ID) : d === boundTo;
							if (alive) return;
							unbind();
						}
						dispose = registerInto(d);
						bound = dispose !== null;
						boundTo = bound ? d : null;
					};
					sync();
					let off = null;
					try {
						off = ctx.on("internal/service", function (name) { if (name === "dock") sync(); });
					} catch (err) {
						debugLog("internal/service 监听不可用，降级为轮询", err);
					}
					const timer = window.setInterval(sync, 1000);
					return function () {
						stopped = true;
						if (off !== null) { try { off(); } catch (err) {} off = null; }
						window.clearInterval(timer);
						unbind();
					};
				};
				let stopDock = null;
				if ("inject" in ctx) {
					try {
						/* 注意：回调**必须是箭头函数**（不可被 `new` 调用）。cordis 的
						   `_execute` 用 `isConstructor(cb)` 判断插件形态：普通 `function`
						   会被当成「类插件」用 `new` 调用，于是**返回的清理函数被丢弃**
						   —— dock 消失/本插件卸载时注册就泄漏在宿主里。 */
						ctx.inject(["dock"], (dockCtx) => {
							const d = dockCtx.get("dock");
							if (d === undefined || d === null || typeof d.registerPanel !== "function") return;
							const dispose = registerInto(d);
							if (dispose === null) return;
							return () => { try { dispose(); } catch (err) {} };
						});
					} catch (err) {
						console.error("[dsh-deepseek-billing] ctx.inject unavailable, using fallback binder:", err);
						stopDock = bindDockFallback();
					}
				} else {
					stopDock = bindDockFallback();
				}
				/* 仅退化绑定器需要显式清理；`ctx.inject` 的子纤维随本插件纤维一起销毁
				   （清理函数由 cordis 自动执行），无需再包一层 effect。 */
				if (stopDock !== null) {
					ctx.effect(function () {
						return function () { stopDock(); };
					});
				}

				/* v0.1.23：独立浮动卡的生命周期（未安装 ui-beautify 时的唯一入口） */
				loadStandalone();
				window.addEventListener("resize", onStandaloneResize);
				ctx.effect(function standaloneLifecycle() {
					if (standalone.wantOpen === true && !dockActive) ensureStandalone();
					return function () {
						window.removeEventListener("resize", onStandaloneResize);
						unmountStandalone();
					};
				});

				/* 会话探测：注册到会话头部工具槽位（不可见组件，仅上报 sessionId） */
				const slots = ctx.get("slots");
				if (slots !== undefined && typeof slots.inject === "function" && typeof slots.register === "function") {
					ctx.effect(function () {
						return slots.inject("conversation.session.header.utilities", function () {
							return slots.register(
								{ name: "conversation.session.header.utilities", id: "pvcst-session-probe", order: 1 },
								function (props) { return React.createElement(SessionProbe, { sessionId: props && props.sessionId }); }
							);
						});
					});
					/* v0.1.23：没有 ui-beautify 时，标题栏出现「💰 计费」按钮 */
					ctx.effect(function () {
						return slots.inject("conversation.session.header.utilities", function () {
							return slots.register(
								{ name: "conversation.session.header.utilities", id: "pvcst-entry", order: 11, label: "峰谷计费" },
								function () { return React.createElement(BillingEntry); }
							);
						});
					});
				}
			} catch (err) {
				console.error("[dsh-deepseek-billing] apply failed:", err);
			}
		}

		exports.apply = apply;
		exports.inject = ["slots", "remote"];
		return module.exports;
	}
});
