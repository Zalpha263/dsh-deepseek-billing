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

		/* v0.1.24：客户端**不再自带一份价表副本**。
		   旧的 DEFAULT_PRICES / MODEL_LABELS 与宿主 index.js 各写一份，改价时必须
		   两处同步，必然漂移（而且两边都写死了完整模型名，新模型上来就两边都不认）。
		   现在价表的单一真源在宿主，客户端从 summary 的 meta.priceModels 拿列表渲染
		   表单与显示默认价；模型名匹配也由宿主负责。

		   v0.1.26：三档 × 峰谷 = 六个输入框。缓存命中输入与未命中输入的官方价差
		   约 30 倍（V4 Flash：0.05 vs 1.5），共用一个「输入」价会把命中调用高估。 */
		const PRICE_FIELDS = [
			["peakMissIn", "高峰 · 未命中输入"],
			["peakCacheHitIn", "高峰 · 缓存命中输入"],
			["peakOut", "高峰 · 输出"],
			["valleyMissIn", "闲时 · 未命中输入"],
			["valleyCacheHitIn", "闲时 · 缓存命中输入"],
			["valleyOut", "闲时 · 输出"]
		];
		const PRICE_FIELD_KEYS = PRICE_FIELDS.map(function (f) { return f[0]; });

		/* 把任意来源的一条价格记录收敛成六值结构。
		   兼容三代历史结构：
		     v0.1.26 六值 peakCacheHitIn/peakMissIn/peakOut/valleyCacheHitIn/valleyMissIn/valleyOut
		     v0.1.24 四值 peakIn/peakOut/valleyIn/valleyOut（当时命中与未命中共用一个输入价，
		              回填到两档不引入新误差——当时的口径就是这样）
		     更早三值 hit/miss/out + *Peak（谷时价，峰值靠 ×2） */
		function toPriceValues(row, defaults) {
			const out = {};
			const num = function (v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined; };
			const legacy = row && typeof row === "object" ? row : {};
			const fallback = defaults && typeof defaults === "object" ? defaults : {};
			const pick = function (keys, from) {
				for (const k of keys) { const v = num(from[k]); if (v !== undefined) return v; }
				return undefined;
			};
			const IN_MISS = ["missIn", "miss", "valleyMissIn"];
			const IN_HIT = ["cacheHitIn", "hit", "valleyCacheHitIn"];
			const OUT = ["out", "valleyOut"];
			const IN_FOUR = ["valleyIn"];
			const IN_MISS_PEAK = ["missPeak", "peakMissIn"];
			const IN_HIT_PEAK = ["hitPeak", "peakCacheHitIn"];
			const OUT_PEAK = ["outPeak", "peakOut"];
			const IN_FOUR_PEAK = ["peakIn"];

			/* 谷时三档 */
			out.valleyMissIn = pick(IN_MISS, legacy);
			if (out.valleyMissIn === undefined) out.valleyMissIn = pick(IN_FOUR, legacy);
			if (out.valleyMissIn === undefined) out.valleyMissIn = num(fallback.valleyMissIn);
			out.valleyCacheHitIn = pick(IN_HIT, legacy);
			if (out.valleyCacheHitIn === undefined) out.valleyCacheHitIn = pick(IN_FOUR, legacy);
			if (out.valleyCacheHitIn === undefined) out.valleyCacheHitIn = num(fallback.valleyCacheHitIn);
			out.valleyOut = pick(OUT, legacy);
			if (out.valleyOut === undefined) out.valleyOut = num(fallback.valleyOut);

			/* 峰值三档：优先峰值专用字段，其次 = 谷时 × 2 */
			out.peakMissIn = pick(IN_MISS_PEAK, legacy);
			if (out.peakMissIn === undefined) out.peakMissIn = pick(IN_FOUR_PEAK, legacy);
			if (out.peakMissIn === undefined) out.peakMissIn = num(fallback.peakMissIn);
			if (out.peakMissIn === undefined && out.valleyMissIn !== undefined) out.peakMissIn = out.valleyMissIn * 2;
			out.peakCacheHitIn = pick(IN_HIT_PEAK, legacy);
			if (out.peakCacheHitIn === undefined) out.peakCacheHitIn = pick(IN_FOUR_PEAK, legacy);
			if (out.peakCacheHitIn === undefined) out.peakCacheHitIn = num(fallback.peakCacheHitIn);
			if (out.peakCacheHitIn === undefined && out.valleyCacheHitIn !== undefined) out.peakCacheHitIn = out.valleyCacheHitIn * 2;
			out.peakOut = pick(OUT_PEAK, legacy);
			if (out.peakOut === undefined) out.peakOut = num(fallback.peakOut);
			if (out.peakOut === undefined && out.valleyOut !== undefined) out.peakOut = out.valleyOut * 2;
			return out;
		}

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
.pvcst-root { container-type: inline-size; container-name: pvcst; min-width: 0; width: 100%; max-width: 100%; }
.pvcst-body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--dsw-alias-label-primary); padding: 12px 14px; font-size: 12px; box-sizing: border-box; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.pvcst-card { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; overflow: hidden; min-width: 0; max-width: 100%; box-sizing: border-box; }
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
/* v0.1.24：宿主换成官方右侧栏标签之后的紧凑化。
   面板现在渲染在右侧栏的 pane body 里，宽度由列几何决定（首开 = frame 的
   45%，下限 300px），与旧的 400px 独立面板/坞面板无关。明细行本来就是
   「标签左 / 数值右」两端布局（.pvcst-row），窄宽度下把字号和间距收一档，
   让「输入 · 缓存命中 63245k tok」这类行仍能一行放下并截断，而不是断成两行。
   下面这档覆盖 320–420px 区间 —— 那正是右侧栏最常见的可用宽度。 */
@container pvcst (width<=420px) {
  .pvcst-body { padding: 10px 12px; }
  .pvcst-card { padding: 12px 13px; margin-bottom: 10px; }
  .pvcst-row { padding: 8px 0; gap: 6px; }
  .pvcst-rowlabel { font-size: 11.5px; }
  .pvcst-rowval { font-size: 12px; }
  .pvcst-rowval.pvcst-strong { font-size: 12.5px; }
  .pvcst-head { gap: 6px; }
  .pvcst-title { font-size: 12.5px; }
  .pvcst-key { font-size: 14px; }
  .pvcst-coin { font-size: 20px; }
  .pvcst-foot { font-size: 11px; line-height: 1.6; }
}
/* 极窄兜底：明细行改为上下两段，避免标签与数值在 200px 以下互相挤压。 */
@container pvcst (width<=240px) {
  .pvcst-row, .pvcst-row-plain { flex-wrap: wrap; gap: 2px; }
  .pvcst-row > :first-child { flex: 1 1 100%; }
  .pvcst-row > :last-child { flex: 0 0 auto; margin-left: auto; }
  .pvcst-costrow { flex-wrap: wrap; }
  .pvcst-countdown { display: none; }
}
/* v0.1.12：插件面板「···（全部插件）」按钮置顶（flex order，视觉最前） */
[data-vsc-pplist] > div > button[title="全部插件"] { order: -1; }
/* 官方右侧栏标签正文的宿主容器：面板自行撑满可用高度 */
.pvcst-tabhost { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
`;
			const style = document.createElement("style");
			style.id = "dsh-deepseek-billing-css";
			style.textContent = css;
			document.head.appendChild(style);
			return () => { if (style.parentNode) style.parentNode.removeChild(style); };
		}

		/* ================= Remote namespace contribution ================= */
		// `remote.deepseekBilling` 由本入口挂载（不能出现在 inject，否则自锁）。0.1.7 起 strict codec 必须带 create() 工厂（两端 Gateway 都调用 codec.create().parse(value)），旧 codec.schema 字段已无人读取。
		function passthroughSchema() {
			return { parse: (value) => value };
		}
		function strictCodec(typeSymbol) {
			return { mode: "strict", typeSymbol, create: () => passthroughSchema() };
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
		/* v0.1.26：把落盘的覆盖记录重新灌回宿主。
		   两步：
		   ① 旧键**迁移到族 pattern**。四值版本的表单是按「族 pattern」写盘的，
		      但用户可能在更早的版本里按**具体模型名**保存过（那时表单列的是
		      'deepseek-v4-flash' 这种完整名）。现在表单只写族 pattern，于是那些
		      旧键永远不会被表单回填，看起来像"覆盖丢了"。这里按别名的目标族把
		      它们并到族键上（族键已有值时不覆盖，以用户最新一次编辑为准）。
		   ② 六值字段逐个提交；`toPriceValues` 负责吃下三代历史结构。 */
		function hydrateFromStorage(r) {
			const prices = lsGet("prices", null);
			if (!prices || typeof prices !== "object") return Promise.resolve();
			const ALIAS_TO_PATTERN = {
				"deepseek-flash": "deepseek-v4-flash",
				"deepseek-chat": "deepseek-v4-flash",
				"deepseek-v4-flash-latest": "deepseek-v4-flash",
				"deepseek-pro": "deepseek-v4-pro",
				"deepseek-reasoner": "deepseek-v4-pro"
			};
			const merged = {};
			const absorb = function (key, row) {
				const target = ALIAS_TO_PATTERN[key] || key;
				const incoming = toPriceValues(row, null);
				const existing = merged[target] || {};
				const next = {};
				for (const field of PRICE_FIELD_KEYS) {
					const v = existing[field] !== undefined ? existing[field] : incoming[field];
					if (v !== undefined) next[field] = v;
				}
				merged[target] = next;
			};
			/* 先放旧键，再放「已是族键」的记录，让族键（较新）赢。 */
			const keys = Object.keys(prices);
			const isFamilyKey = function (k) { return ALIAS_TO_PATTERN[k] === undefined && k.indexOf("deepseek-v") === 0; };
			for (const k of keys) if (!isFamilyKey(k)) absorb(k, prices[k]);
			for (const k of keys) if (isFamilyKey(k)) absorb(k, prices[k]);

			const jobs = [];
			for (const model of Object.keys(merged)) {
				for (const field of PRICE_FIELD_KEYS) {
					const v = merged[model][field];
					if (v === undefined) continue;
					jobs.push(r.setPrices({ model, field, value: v }));
				}
			}
			/* 迁移过就把结果写回，避免每次启动都重算。 */
			if (jobs.length > 0) lsSet("prices", merged);
			return Promise.all(jobs);
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
			/* meta 必须在提示块之前取：下面的交叉核对读 meta.catalog，
			   写在后面会撞 const 的暂时性死区（ReferenceError）。 */
			const meta = d.meta || {};
			const notes = [];
			if (calls.unpriced > 0) notes.push(calls.unpriced + " 次调用无用量/调价前未计价");
			if (calls.nonDeep > 0) notes.push(calls.nonDeep + " 次未识别模型不计价");
			/* v0.1.24：认得模型族但价表没覆盖 → 点名，而不是让它混进"未识别"里静默漏算。
			   这正是"DSH 一发新模型名，计费就悄悄算不出来"的可见化。
			   v0.1.25：再加上宿主用 ctx.llm 目录做的交叉核对 —— 供应商**广告**了但我们
			   认不出族的模型（advertisedUncovered），以及本会话真的用过、却完全认不出
			   的模型名（usedUnknown，即 nonDeep 记账里有次数的那些）。三类提示共用
			   `notes`，页脚一次显示完。 */
			const recognized = Array.isArray(d.recognizedModels) ? d.recognizedModels : [];
			if (calls.recognized > 0) {
				const names = recognized.slice(0, 3).map(function (r) { return r.label || r.model; }).join("、");
				notes.push("⚠ " + calls.recognized + " 次调用认得模型但价表缺价（" + names + (recognized.length > 3 ? " 等" : "") + "）—— 请在「价格配置」里补齐");
			}
			const cat = meta.catalog && typeof meta.catalog === "object" ? meta.catalog : null;
			const adUncov = cat && Array.isArray(cat.advertisedUncovered) ? cat.advertisedUncovered : [];
			if (adUncov.length > 0) {
				const names = adUncov.slice(0, 3).map(function (m) { return m.model; }).join("、");
				notes.push("⚠ 当前供应商还广告了 " + adUncov.length + " 个我不认识的模型（" + names + (adUncov.length > 3 ? " 等" : "") + "）—— 未计价前不会算它的钱");
			}
			/* usedUnknown 只取「真的出现过」的；已经在上一条里点过名的就不重复。 */
			const usedUnknown = cat && Array.isArray(cat.usedUnknown) ? cat.usedUnknown : [];
			const shownAlready = {};
			for (const r of recognized) shownAlready[r.model] = true;
			const freshUnknown = usedUnknown.filter(function (u) { return !shownAlready[u.model]; });
			if (freshUnknown.length > 0) {
				const names = freshUnknown.slice(0, 3).map(function (u) { return u.model; }).join("、");
				notes.push("⚠ 本会话用过但完全认不出的模型：" + names + (freshUnknown.length > 3 ? " 等" : "") + "（已按不计价处理）");
			}
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
			/* v0.1.24：模型列表与默认价都来自宿主 meta.priceModels（单一真源），
			   客户端不再硬编码。列表按「族」给出，覆盖该族的全部具体模型名。 */
			const meta = st.data && st.data.meta ? st.data.meta : {};
			const models = Array.isArray(meta.priceModels) ? meta.priceModels : [];
			const box = h("div", { className: "pvcst-form", style: { marginTop: 10 } });
			box.appendChild(h("div", { className: "pvcst-formtitle", text: "手动价格覆盖（官方改价时使用）" }));
			if (models.length === 0) {
				box.appendChild(h("div", { className: "pvcst-foot", text: "暂时拿不到价表（宿主未返回 priceModels）。" }));
				z.formContainer.appendChild(box);
				return;
			}
			const stored = lsGet("prices", null) || {};
			const inputs = {};
			for (const fam of models) {
				const key = fam.pattern;
				const cell = h("div", { style: { margin: "10px 0" } });
				cell.appendChild(h("div", { className: "pvcst-formmodel", text: (fam.label || key) + "（" + key + "*）" }));
				const values = toPriceValues(stored[key], fam);
				for (const [field, label] of PRICE_FIELDS) {
					const input = h("input", { type: "number", step: "0.01", min: "0", className: "pvcst-input", value: values[field] === undefined ? "" : String(values[field]) });
					inputs[key + ":" + field] = input;
					cell.appendChild(h("div", { className: "pvcst-formrow" }, [
						h("span", { className: "pvcst-label", text: label }),
						input
					]));
				}
				box.appendChild(cell);
			}
			const msg = h("div", { className: "pvcst-foot pvcst-msg", style: { marginTop: 4 } });
			const saveBtn = h("button", { type: "button", className: "pvcst-btn", text: "保存" });
			/* v0.1.24：原来的「恢复官方」按钮被去掉——它做的事（清空手动覆盖回到
			   内置价表）与"保存空值"语义重叠，名字还容易被误读成"把官方价表拉回来"。
			   改成明确的「清空手动值」。 */
			const clearBtn = h("button", { type: "button", className: "pvcst-btn", text: "清空手动值" });
			saveBtn.addEventListener("click", function () {
				let p = Promise.resolve();
				const next = {};
				for (const fam of models) {
					const key = fam.pattern;
					const row = {};
					for (const field of PRICE_FIELD_KEYS) {
						const el = inputs[key + ":" + field];
						const raw = el.value.trim();
						if (raw === "") {
							/* v0.1.28：留空 = 用内置价 —— 必须显式清除宿主覆盖值，
							   否则表单显示内置价、宿主仍按旧手动价计费。 */
							p = p.then(function () { return remote().setPrices({ model: key, field: field, value: null }); });
							continue;
						}
						const v = Number(raw);
						if (!Number.isFinite(v) || v < 0) continue;
						row[field] = v;
						p = p.then(function () { return remote().setPrices({ model: key, field: field, value: v }); });
					}
					if (Object.keys(row).length > 0) next[key] = row;
				}
				lsSet("prices", next);
				p.then(function () { msg.textContent = "已保存（下次打开自动生效）"; }).catch(function (e) { msg.textContent = "保存失败：" + String(e && e.message || e); });
			});
			clearBtn.addEventListener("click", function () {
				lsClear();
				remote().setPrices({ reset: true }).then(function () {
					for (const fam of models) {
						const key = fam.pattern;
						const values = toPriceValues(null, fam);
						for (const field of PRICE_FIELD_KEYS) {
							inputs[key + ":" + field].value = values[field] === undefined ? "" : String(values[field]);
						}
					}
					msg.textContent = "已清空手动值，回到内置价表";
				}).catch(function (e) { msg.textContent = String(e && e.message || e); });
			});
			box.appendChild(h("div", { className: "pvcst-btnrow" }, [saveBtn, clearBtn]));
			box.appendChild(h("div", { className: "pvcst-foot", style: { marginTop: 8 }, text: "单位：元 / 每 1M tokens · 留空 = 用内置价 · 高峰默认 = 闲时 × " + (meta.peakMultiplier === undefined ? 2 : meta.peakMultiplier) + "（可单独覆盖）" }));
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

				/* ================= 官方右侧栏标签（唯一入口） =================
				   规范来自 @deepseek-ai/dsh-client-ui-sidebar-right 的 README「扩展席位」：
				   两阶段注册 —— ① 标签类型 ctx.sidebarRightTabs.register({ id, kind, title,
				   guide, priority })（静态声明，返回 disposer；**同一个 id 第二次注册会 throw**）；
				   ② 正文 ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)。
				   正文先行、类型后行：slots.register 在槽位尚未声明时会抛错，而类型注册失败无法
				   回滚，所以让可能失败的一步先发生在无副作用的一侧。

				   v0.2.1：注册改为**依赖驱动 + 有界重试**。原实现在 apply 时一次性
				   ctx.get("sidebarRightTabs")，拿不到就 return —— 而客户端各 entry 的 apply
				   顺序/并发并不保证，服务（以及 sidebar.right.pane.tab 槽位）可能晚一拍才出现，
				   注册就被静默丢弃：右侧栏「开始」页再也不出现本插件胶囊，只在 console 留一行。 */
				let lastOfficialTabError = null;
				function describeError(err) { return String((err && err.message) || err); }
				/** 尝试注册一次：成功返回 disposer，失败返回 null 并把原因写入 lastOfficialTabError。 */
				function registerOfficialTab() {
					const tabs = ctx.get("sidebarRightTabs");
					const slotsService = ctx.get("slots");
					if (tabs === undefined || tabs === null || typeof tabs.register !== "function") {
						lastOfficialTabError = "sidebarRightTabs 服务此刻不可用（entry 的 apply 顺序/并发不保证，稍后重试即可）";
						return null;
					}
					if (slotsService === undefined || slotsService === null || typeof slotsService.register !== "function") {
						lastOfficialTabError = "slots 服务此刻不可用";
						return null;
					}
					/* 正文仍用纯 DOM 构建（见文件头 v0.1.6 注释）：React 只负责把容器挂上去，
					   避免与宿主卸载时的 textContent='' 竞争。 */
					const body = function BillingPanelBody() {
						const boxRef = React.useRef(null);
						React.useEffect(function () {
							const box = boxRef.current;
							if (box === null) return undefined;
							const dispose = mountPanel(box);
							return function () { try { if (typeof dispose === "function") dispose(); else box.textContent = ""; } catch (err) {} };
						}, []);
						return React.createElement("div", { ref: boxRef, className: "pvcst-tabhost" });
					};
					/* 正文先行：slots.register 在槽位尚未声明时会抛错，此处必须自己兜住 ——
					   否则异常会冒泡出 ctx.effect 并中断整个 apply（后半段的会话探测就没了）。
					   此时没有任何注册落地，直接放弃，交给上层重试，不留半注册。 */
					let disposeBody = null;
					try {
						disposeBody = slotsService.register({ name: "sidebar.right.pane.tab", key: PANEL_ID }, body);
					} catch (err) {
						lastOfficialTabError = "槽位 sidebar.right.pane.tab 尚未声明：" + describeError(err);
						return null;
					}
					let disposeTitle = null;
					try {
						disposeTitle = slotsService.register({ name: "sidebar.right.pane.tab.title", key: PANEL_ID }, function BillingPanelTitle() { return PANEL_TITLE; });
					} catch (err) { disposeTitle = null; }
					let disposeType = null;
					try {
						disposeType = tabs.register({
							id: PANEL_ID,
							kind: PANEL_ID,
							priority: "extension",
							title: function () { return PANEL_TITLE; },
							/* 右侧栏「开始」引导页上的入口胶囊：没有它用户只能在标签条的 + 里找 */
							guide: [{
								order: 110,
								title: function () { return PANEL_TITLE; },
								description: function () { return "查看 DeepSeek 峰谷时段计费明细"; },
								icon: function BillingGuideIcon() { return React.createElement("span", null, PANEL_ICON); }
							}]
						});
					} catch (err) {
						lastOfficialTabError = "sidebarRightTabs.register 被拒绝：" + describeError(err);
						try { if (typeof disposeTitle === "function") disposeTitle(); } catch (e2) {}
						try { if (typeof disposeBody === "function") disposeBody(); } catch (e2) {}
						return null;
					}
					debugLog("官方右侧栏标签注册成功:", PANEL_ID);
					lastOfficialTabError = null;
					return function () {
						try { if (typeof disposeType === "function") disposeType(); } catch (err) {}
						try { if (typeof disposeTitle === "function") disposeTitle(); } catch (err) {}
						try { if (typeof disposeBody === "function") disposeBody(); } catch (err) {}
					};
				}
				/* 依赖驱动（服务出现即回调、消失即 dispose，宿主自己的插件也是这个写法）+
				   有界重试（槽位可能比服务更晚声明）；重试用尽后打印一次可诊断的原因。 */
				ctx.effect(function officialSidebarTab() {
					const RETRY_DELAYS = [0, 50, 120, 300, 700, 1200, 2000, 3000, 5000, 8000];
					let retryTimer = null;
					let retryIndex = 0;
					let disposed = false;
					let disposeTab = null;
					const tryAttach = () => {
						retryTimer = null;
						if (disposed || disposeTab !== null) return;
						const dispose = registerOfficialTab();
						if (dispose !== null) { disposeTab = dispose; retryIndex = 0; return; }
						if (retryIndex >= RETRY_DELAYS.length) {
							console.error("[dsh-deepseek-billing] 官方右侧栏入口注册失败，右侧栏「开始」页不会出现「" + PANEL_TITLE + "」：" +
								(lastOfficialTabError === null ? "原因未知" : lastOfficialTabError) +
								"（已重试 " + RETRY_DELAYS.length + " 次；其余功能不受影响）");
							return;
						}
						retryTimer = setTimeout(tryAttach, RETRY_DELAYS[retryIndex]);
						retryIndex += 1;
					};
					let disposeInject = null;
					if (typeof ctx.inject === "function") {
						disposeInject = ctx.inject(["sidebarRightTabs"], function () {
							retryIndex = 0;
							tryAttach();
							return function () { if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; } };
						});
					}
					tryAttach();
					return function () {
						disposed = true;
						if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
						try { if (typeof disposeInject === "function") disposeInject(); } catch (err) {}
						try { if (typeof disposeTab === "function") disposeTab(); } catch (err) {}
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
