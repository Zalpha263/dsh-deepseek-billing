// dsh-deepseek-billing — Host half (persistent).
//
// Registers the `deepseekBilling` Remote service for the web Client half.
// The Client calls it through the Typert Gateway (`/api` RPC), mirroring
// dsh-file-explorer's pattern: TypertRemoteService registers the service via
// ctx.reflect.props, the wire binding comes from the superclass constructor,
// and `@Remote` markers are applied without decorator syntax (Node 24 rejects
// stage-3 decorators) through the manual decorator-context trick below.
//
// IMPORTANT: the Gateway derives parameter wires from the method SOURCE
// (parameter names must be simple identifiers — no destructuring, defaults,
// or rest); the client-side contribution matches them positionally.

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/* ===== 官方规则（多来源交叉验证） ===== */
const HOUR = 3600000
const BJ = 8 * HOUR // 北京时间 = UTC+8（固定偏移，无 DST）
const PEAK_FROM = Date.UTC(2026, 7, 16, 16, 0, 0) // 峰谷定价 2026-08-17 00:00(北京) 生效
const WEEKEND_FROM = Date.UTC(2026, 7, 22, 16, 0, 0) // 周末全天谷 2026-08-23 00:00(北京) 起
const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]] // 北京 09:00–12:00、14:00–18:00

/* ===== 官方价表：元 / 每 1M tokens（谷时价；峰值价 = 谷时价 × PEAK_MULTIPLIER） =====
   三档价：cacheHitIn（缓存命中输入）/ missIn（未命中输入）/ out（输出）。
   缓存命中价明显低于未命中价（官方 V4 Flash：0.05 vs 1.5），所以必须分开记，
   否则缓存命中的调用会被按未命中价高估 30 倍。

   v0.1.24：从「精确模型名」改为「模型族 + 前缀匹配」。
   v0.1.26：再修一次 —— 模型 id 是**自由字符串**，不是官方价页的模型名。

   实测（从真实会话日志里读出来的模型 id）：
       settings.yaml → agent-default-model.model = "deepseek-flash"
       同库另有两个 id："deepseek-v4-flash"、"deepseek-v4.1-flash-expires-on-0910"
   第一次改成族匹配时我用了 `deepseek-v4-flash` 作 pattern，于是
   `'deepseek-flash'.startsWith('deepseek-v4-flash')` 为假 → 555 次调用全部
   归入「未识别模型不计价」，本次窗口费用恒为 ¥0.0000。
   根因是**契约误读**：我假设 DSH 的 model id 等于官方价页的模型名，实际它是
   provider 配置里用户可自由填写的字符串（本机就有三种写法共存）。

   现在匹配按顺序尝试三档，并给出识别结论（见 priceFor）：
     ① 族前缀匹配（FAMILIES）
     ② 显式别名（ALIASES）—— 覆盖 'deepseek-flash' 这类官方价页没有的写法
     ③ provider 前缀兜底（PROVIDER_PREFIXES）—— 认得「这是 DeepSeek 的模型」
        但查不到具体价时，报 recognized 而不是伪装成「非 DeepSeek 模型」；
        这样它会在面板上被点名要你补价，而不是静默算 0。

   改价时只需更新 FAMILIES 的数值与 PRICE_AS_OF 日期。 */
const PRICE_AS_OF = '2026-09-03' // 官方定价页截图日期
const PEAK_MULTIPLIER = 2 // 官方高峰系数（v0.1.20：不再把峰值价硬编码进价表）
const FAMILIES = [
  /* 顺序即匹配优先级：先具体、后宽泛。`pattern` 是前缀，不是完整名。 */
  { pattern: 'deepseek-v4-flash', label: 'V4 Flash', cacheHitIn: 0.05, missIn: 1.5, out: 4.5 },
  { pattern: 'deepseek-v4-pro', label: 'V4 Pro', cacheHitIn: 0.15, missIn: 4.5, out: 13.5 },
  /* v0.1.21：0910 试验版无独立官方价页，按 V4 Flash 价表计（官方页 2026-09-03）。
     'deepseek-v4.1-flash…' 不以 'deepseek-v4-flash' 开头，所以需要独立一行。 */
  { pattern: 'deepseek-v4.1-flash', label: 'V4.1 Flash', cacheHitIn: 0.05, missIn: 1.5, out: 4.5 }
]
const FAMILY_BY_LABEL = {}
for (const f of FAMILIES) FAMILY_BY_LABEL[f.pattern] = f
/* 显式别名：DSH 的 model id → 官方价表里的族。
   这些都是真实出现过的写法（见文件头注释），必须在此登记，否则就是不计价。 */
const ALIASES = {
  'deepseek-flash': 'deepseek-v4-flash',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-v4-flash-latest': 'deepseek-v4-flash',
  'deepseek-pro': 'deepseek-v4-pro',
  'deepseek-reasoner': 'deepseek-v4-pro'
}
/* provider 前缀兜底：认得「这是 DeepSeek 的模型」但没有具体价时的最后一档。
   返回的族**没有价**（数值为 null），所以 priceFor 会给出 recognized。
   只认带横线的 `deepseek-` —— 无横线的 `deepseek` 会匹配掉 `deepseekclone-x`
   这类第三方模型，把它们误报成「DeepSeek 未定价」而不是「非 DeepSeek」。 */
const PROVIDER_PREFIXES = [
  { pattern: 'deepseek-', label: 'DeepSeek（未定价）' }
]
function lookupFamily(model) {
  if (typeof model !== 'string' || model === '') return null
  const m = model.toLowerCase()
  /* ① 族前缀 */
  for (const f of FAMILIES) if (m.startsWith(f.pattern)) return f
  /* ② 显式别名 */
  const alias = ALIASES[m]
  if (alias !== undefined && FAMILY_BY_LABEL[alias] !== undefined) return FAMILY_BY_LABEL[alias]
  /* ③ provider 前缀兜底（带匹配标记，标签里保留原名以免误导） */
  for (const p of PROVIDER_PREFIXES) {
    if (m.startsWith(p.pattern)) {
      return { pattern: model, label: p.label, cacheHitIn: null, missIn: null, out: null, fallback: true }
    }
  }
  return null
}
/* 一个模型名的展示标签：命中的族标签 + 变体后缀（让人一眼看出是哪个具体模型）。
   provider 兜底命中时保留原始模型名 —— 否则不同模型会显示成同一个标签。 */
function labelFor(model) {
  const f = lookupFamily(model)
  if (f === null) return typeof model === 'string' ? model : String(model)
  if (f.fallback === true) return (typeof model === 'string' ? model : String(model)) + '（未定价）'
  const suffix = String(model).slice(f.pattern.length)
  if (suffix === '') return f.label
  return f.label + ' · ' + suffix.replace(/^-/, '')
}
function peakOf(valley) {
  return valley * PEAK_MULTIPLIER
}
const M = 1000000

/* ===== 模型目录交叉核对（v0.1.25） =====
   价表是「我们认得哪些族」的真源，而**当前供应商实际会广告哪些模型**只有
   DSH 自己知道：`ctx.llm.listProviders()` 给出已注册的供应商路由，
   `ctx.llm.listModels(provider)` 异步给出该路由广告的模型目录。

   两边的差集就是「值得提醒你补价」的清单。分两类，因为可信度不同：

   · advertisedUncovered —— 供应商**广告**了这个模型，但我们认不出它的族。
     最值得看：模型可用，一旦被调用就会漏算。
   · usedUnknown —— 会话里**真的出现过**但认不出族的模型名（nonDeep 记账）。
     最硬的证据：钱确实没算上。

   刻意**不**列出「广告了且已覆盖」的模型（纯噪声）。

   刷新是异步的（`listModels` 返回 Promise），而 `summary()` 是同步热路径，
   所以这里只读缓存；缓存在 apply 时、以及每 10 分钟刷新一次。
   `llm` 服务缺席（headless / 未装 LLM 插件）时整块静默降级。 */
const catalog = {
  ready: false,
  at: null,
  providers: [],
  advertised: 0,
  advertisedUncovered: [],
  error: null
}
const CATALOG_REFRESH_MS = 10 * 60 * 1000
let catalogTimer = null

function catalogForClient(usedUnknown) {
  const out = {
    ready: catalog.ready,
    at: catalog.at,
    providers: catalog.providers,
    advertised: catalog.advertised,
    advertisedUncovered: catalog.advertisedUncovered
  }
  if (catalog.error !== null) out.error = catalog.error
  /* 会话里真的出现过、但认不出族的模型名（来自 nonDeep 记账）。 */
  out.usedUnknown = Array.isArray(usedUnknown) ? usedUnknown : []
  return out
}

async function refreshCatalog(ctx) {
  try {
    const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      catalog.ready = false
      catalog.error = 'llm service unavailable'
      return
    }
    const providers = llm.listProviders()
    const providerIds = []
    const advertised = []
    for (const p of Array.isArray(providers) ? providers : []) {
      const id = p && typeof p.id === 'string' ? p.id : null
      if (id === null) continue
      providerIds.push(id)
      let list = []
      try {
        /* 目录成员资格是「建议性」的：某个供应商不回应也不该拖垮整轮核对。 */
        list = await llm.listModels(id)
      } catch (err) { list = [] }
      for (const m of Array.isArray(list) ? list : []) {
        const mid = m && typeof m.id === 'string' ? m.id : null
        if (mid === null) continue
        advertised.push({ provider: id, model: mid, name: m && typeof m.name === 'string' ? m.name : mid })
      }
    }
    const seen = new Set()
    const uncovered = []
    for (const a of advertised) {
      if (lookupFamily(a.model) !== null) continue
      if (seen.has(a.model)) continue
      seen.add(a.model)
      uncovered.push(a)
    }
    uncovered.sort((x, y) => String(x.model).localeCompare(String(y.model)))
    catalog.providers = providerIds
    catalog.advertised = advertised.length
    catalog.advertisedUncovered = uncovered
    catalog.ready = true
    catalog.at = Date.now()
    catalog.error = null
  } catch (err) {
    catalog.ready = false
    catalog.error = String(err && err.message ? err.message : err)
  }
}

/* ===== 手动覆盖（本进程内存；客户端 localStorage 会在启动时重新灌入） =====
   v0.1.26 结构（六值独立，三档 × 峰谷）：
     { peakCacheHitIn, peakMissIn, peakOut, valleyCacheHitIn, valleyMissIn, valleyOut }
   单位元 / 每 1M tokens。

   历史结构仍在读取时兼容（见 overrideAt）：
     v0.1.24 四值 { peakIn, peakOut, valleyIn, valleyOut } —— 当时缓存命中与未命中
       共用「输入」价，所以旧的 *In 同时喂给命中与未命中两档（当时的口径就是这样，
       回填成两档不会引入新误差）。
     更早三档 { hit, miss, out, *Peak }。 */
const overrides = Object.create(null)

/* 把一条覆盖记录读成某一档某一峰谷的值（新旧结构都吃）。缺的档返回 undefined。 */
function overrideAt(ov, tier, phase) {
  if (ov === undefined || ov === null) return undefined
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined }
  const isOut = tier === 'out'
  const camel = (t) => (t === 'cacheHitIn' ? 'CacheHitIn' : t === 'missIn' ? 'MissIn' : 'Out')
  const key = (phase === 'peak' ? 'peak' : 'valley') + camel(tier)
  const direct = num(ov[key])
  if (direct !== undefined) return direct
  /* v0.1.24 四值：只有「输入」一个值，命中与未命中都取它。 */
  if (!isOut) {
    const four = num(phase === 'peak' ? ov.peakIn : ov.valleyIn)
    if (four !== undefined) return four
  }
  /* 更早的三档结构：hit/miss/out 是谷时价，*Peak 是峰值价。 */
  if (phase === 'valley') {
    const legacy = num(ov[tier === 'cacheHitIn' ? 'hit' : tier === 'missIn' ? 'miss' : 'out'])
    if (legacy !== undefined) return legacy
    return undefined
  }
  const legacyPeak = num(ov[(tier === 'cacheHitIn' ? 'hit' : tier === 'missIn' ? 'miss' : 'out') + 'Peak'])
  if (legacyPeak !== undefined) return legacyPeak
  const legacyValley = num(ov[tier === 'cacheHitIn' ? 'hit' : tier === 'missIn' ? 'miss' : 'out'])
  if (legacyValley !== undefined) return peakOf(legacyValley)
  return undefined
}

/* ===== 规则逻辑 ===== */
function bjParts(ms) {
  const s = new Date(ms + BJ)
  return { weekday: s.getUTCDay(), minutes: s.getUTCHours() * 60 + s.getUTCMinutes() }
}
function inPeak(minutes) {
  for (const [a, b] of PEAK_WINDOWS) if (minutes >= a && minutes < b) return true
  return false
}
function classifyAt(ms) {
  if (ms < PEAK_FROM) return 'unpriced'
  const { weekday, minutes } = bjParts(ms)
  if ((weekday === 0 || weekday === 6) && ms >= WEEKEND_FROM) return 'valley'
  return inPeak(minutes) ? 'peak' : 'valley'
}
function floorBjDay(ms) {
  const shifted = ms + BJ
  return (shifted - (shifted % (24 * HOUR))) - BJ
}
function nextBoundary(ms) {
  const start = floorBjDay(ms)
  for (let off = -1; off <= 8; off++) {
    for (const h of [0, 9, 12, 14, 18, 24]) {
      const t = start + off * 24 * HOUR + h * HOUR
      if (t <= ms) continue
      if (classifyAt(t) !== classifyAt(t - 1000)) return t
    }
  }
  return null
}

/* ===== 价格（含手动覆盖） =====
   offRow 返回**行结构**，三档各带 {valley, peak, ok}，外加命中标记（hitKind）。
   v0.1.24：不再用 0 冒充「没配价」—— 算不出来就是 ok=false，由上层归入
   recognized（认得族但没价），而不是悄悄按 0 计费。
   v0.1.26：三档拆开 —— cacheHitIn（缓存命中输入）/ missIn（未命中输入）/ out。
   缓存命中价远低于未命中价，共用一个「输入」价会把命中调用高估约 30 倍。
   v0.1.27：覆盖要按**族**查，不能只按原始模型名查。表单写盘用的是族 pattern
   （用户覆盖的是"这个族的价格"），而真实调用的模型 id 可能是别名
   （`deepseek-flash`）。只按 id 查会让用户在表单里存的值读不回来 ——
   表现就是「配置了价格但费用不变」。 */
function offRow(model) {
  const base = lookupFamily(model)
  /* 覆盖查找：原始 id 优先，其次命中的族 pattern，最后别名指向的族。 */
  let ov = overrides[model]
  if (ov === undefined && base !== null && typeof base.pattern === 'string') ov = overrides[base.pattern]
  if (ov === undefined && typeof model === 'string') {
    const aliasTarget = ALIASES[model.toLowerCase()]
    if (aliasTarget !== undefined) ov = overrides[aliasTarget]
  }
  if (base === null && ov === undefined) return null
  const mk = (tier) => {
    /* 谷时：手动覆盖优先；否则用命中族的官方谷时价。
       峰值：手动覆盖优先；否则 = 谷时 × PEAK_MULTIPLIER（与界面宣示口径同源）。 */
    let valley = overrideAt(ov, tier, 'valley')
    if (valley === undefined && base !== null && base.fallback !== true) valley = base[tier]
    let peak = overrideAt(ov, tier, 'peak')
    if (peak === undefined && valley !== undefined) peak = peakOf(valley)
    const ok = Number.isFinite(valley) && Number.isFinite(peak)
    return { valley: ok ? valley : 0, peak: ok ? peak : 0, ok }
  }
  /* hitKind：'family' = 命中带价的族；'fallback' = 只认出是某 provider 的模型。 */
  const hitKind = base === null ? 'override-only' : (base.fallback === true ? 'fallback' : 'family')
  return { cacheHitIn: mk('cacheHitIn'), missIn: mk('missIn'), out: mk('out'), base, hitKind }
}
/* 计价入口。kind 三分类：
     · priced     —— 三档都有可用价，正常计费
     · recognized —— 认得（族缺价 / provider 兜底 / 覆盖不全），但算不出完整价
     · unknown    —— 完全认不出
   上层只在 priced 时计费；recognized 单独记账并在面板上点名，绝不静默按 0 计。 */
function priceFor(model, phase) {
  const row = offRow(model)
  if (row === null) return { kind: 'unknown' }
  const i = phase === 'peak' ? 'peak' : 'valley'
  const hit = row.cacheHitIn[i]
  const miss = row.missIn[i]
  const out = row.out[i]
  const ok = row.cacheHitIn.ok && row.missIn.ok && row.out.ok
  if (!ok) return { kind: 'recognized', hit: hit, miss: miss, out: out }
  return { kind: 'priced', hit: hit, miss: miss, out: out }
}

/* ===== 会话账号与增量折叠 ===== */
const accounts = new Map()
/* v0.1.27：价格修订号。cost 是在**折叠时**按当时的价表算好并累加进账户的
   （applySample → acc.cost / m.peakCny），而 scanSession 用 acc.cursor 只折
   cursor 之后的新事件 —— 于是改价后，**已折过的历史事件永远保留旧价**，
   面板的「本次窗口费用」不会变（客户端保存成功的提示也正是
   "已保存（下次打开自动生效）"，因为只有面板重开才会看到新价）。

   修法：价格一变就丢掉所有活会话的账户，下一次 summary 从零重折。
   必须**整体替换**账户、不能只把 cursor 归零：账户里已经累加过旧价的总数，
   若保留 accumulator 而清空 byStep，重折时 foldEvent 找不到 prev 而无法冲抵，
   会把同一批事件再加一遍（翻倍）。全新账户则从零累加，天然正确。

   重折本身安全且幂等：foldEvent 对同一个 (turn,step) 先 applySample(prev, -1)
   冲抵再重算。持久化子代理（childAccounts）每次都由 newAccount 从零构建、
   只以事件数为缓存键，因此价格变化对它自动正确，无需额外处理。 */
let priceRevision = 0
function bumpPriceRevision() {
  priceRevision += 1
  accounts.clear()
}
function newAccount() {
  return {
    byStep: new Map(),
    context: null,
    /* request/header.config 的最近模型（request/context 每会话仅 1 条，
       多模型会话以最近一条请求头为准）。 */
    headerModel: null,
    tokens: { inMiss: 0, inHit: 0, out: 0, reasoning: 0 },
    calls: { priced: 0, unpriced: 0, nonDeep: 0, recognized: 0 },
    nonDeepModels: new Map(),
    recognizedModels: new Map(),
    cost: { peak: 0, valley: 0 },
    byModel: new Map(),
    /* 增量折叠游标：每次 scanSession 只折 cursor 之后的新事件。
       foldEvent 对 (turn,step) 采用「旧样本冲抵 + 新样本替换」（byStep），
       request/context 重折只重设上下文——同一事件重折幂等，故重叠折叠安全。 */
    cursor: 0
  }
}
function modelOf(acc) {
  /* 请求头模型优先（每条请求一条），request/context 兜底（每会话一条）。 */
  return acc.headerModel || (acc.context ? acc.context.model : null)
}
function buildSample(model, time, usage) {
  const t = usage || {}
  const inMiss = Number(t.inputTokens) || 0
  const inHit = Number(t.cacheReadTokens) || 0
  const out = Number(t.outputTokens) || 0
  const reasoning = Number(t.reasoningTokens) || 0
  const phase = classifyAt(time)
  const price = model === null ? { kind: 'unknown' } : priceFor(model, phase)
  /* v0.1.24 三分类：只有 kind==='priced' 才计费。
     · priced     —— 命中价表
     · recognized —— 认得这个模型族，但这一档没有可用价（不再按 0 悄悄计费）
     · unknown    —— 完全认不出
     phase==='unpriced'（定价机制生效前的历史）单独走 'pre'，保持旧语义。 */
  const priced = phase !== 'unpriced' && price.kind === 'priced'
  const hitC = priced ? inHit / M * price.hit : 0
  const missC = priced ? inMiss / M * price.miss : 0
  const outC = priced ? out / M * price.out : 0
  let kind
  if (phase === 'unpriced') kind = 'pre'
  else if (priced) kind = 'priced'
  else if (price.kind === 'unknown') kind = 'nonDeep'
  else kind = 'recognized'
  return {
    time, model, phase, priced,
    tokens: { inMiss, inHit, out, reasoning },
    cost: { hit: hitC, miss: missC, out: outC, total: hitC + missC + outC },
    kind
  }
}
function applySample(acc, s, sign) {
  const k = sign
  acc.tokens.inMiss += k * s.tokens.inMiss
  acc.tokens.inHit += k * s.tokens.inHit
  acc.tokens.out += k * s.tokens.out
  acc.tokens.reasoning += k * s.tokens.reasoning
  if (s.kind === 'priced') {
    acc.calls.priced += k
    acc.cost[s.phase] += k * s.cost.total
    let m = acc.byModel.get(s.model)
    if (m === undefined) { m = { inMiss: 0, inHit: 0, out: 0, peakCalls: 0, valleyCalls: 0, peakCny: 0, valleyCny: 0 }; acc.byModel.set(s.model, m) }
    m.inMiss += k * s.tokens.inMiss
    m.inHit += k * s.tokens.inHit
    m.out += k * s.tokens.out
    if (s.phase === 'peak') { m.peakCalls += k; m.peakCny += k * s.cost.total }
    else { m.valleyCalls += k; m.valleyCny += k * s.cost.total }
  } else if (s.kind === 'recognized') {
    /* 认得族但没价：单独记账，面板会点名要你配价。 */
    acc.calls.recognized += k
    const key = s.model === null ? '(no model)' : String(s.model)
    acc.recognizedModels.set(key, (acc.recognizedModels.get(key) || 0) + k)
  } else if (s.kind === 'nonDeep') {
    acc.calls.nonDeep += k
    const key = s.model === null ? '(no model)' : String(s.model)
    acc.nonDeepModels.set(key, (acc.nonDeepModels.get(key) || 0) + k)
  } else {
    acc.calls.unpriced += k
  }
}
function foldEvent(acc, ev) {
  if (!ev || typeof ev.type !== 'string') return
  if (ev.type === 'request/context') {
    const d = ev.data || {}
    acc.context = { provider: d.provider, model: d.model }
    return
  }
  if (ev.type === 'request/header') {
    /* 每条请求一条 request/header；模型在 header.config（0.1.2-rc.1 实测）。
       request/context 每会话仅 1 条，多模型会话以最近请求头为准。 */
    const cfg = ev.data && ev.data.header && ev.data.header.config
    if (cfg && typeof cfg.model === 'string') acc.headerModel = cfg.model
    return
  }
  let usage = null, turn = undefined, step = undefined
  if (ev.type === 'assistant/chunk') {
    const d = ev.data || {}
    const c = d.chunk || {}
    if (c.type === 'usage' && c.usage) { usage = c.usage; turn = d.turn; step = d.step }
  } else if (ev.type === 'assistant/message') {
    const d = ev.data || {}
    if (d.usage) { usage = d.usage; turn = d.turn; step = d.step }
  }
  if (!usage || turn === undefined || step === undefined) return
  const key = String(turn) + ':' + String(step)
  const prev = acc.byStep.get(key)
  const s = buildSample(modelOf(acc), ev.time, usage)
  if (prev) applySample(acc, prev, -1)
  acc.byStep.set(key, s)
  applySample(acc, s, 1)
}
function accountOf(session) {
  const id = String(session.id)
  let acc = accounts.get(id)
  if (acc === undefined) { acc = newAccount(); accounts.set(id, acc) }
  return acc
}
/** dsh Session 的只读事件快照访问器：0.1.2+ 为 snapshotEvents()（log 兜底）。
 *  注意：Session 上没有 .events 属性——旧的 session.events 恒为 undefined，
 *  导致 resumed（种子重放）会话的历史永远折不进账户，账目为 0 并误判 nonDeep。 */
function sessionEventsOf(session) {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return Array.isArray(session.log) ? session.log : []
}
/* 增量折叠：每次调用只折 cursor 之后的新事件，幂等（见 newAccount 注释）。
   scanSession 不再有"只扫一次"的永久栅栏——任何一次 poll/刷新都会核对到
   会话日志尾部，漏折/失败可自愈。 */
function scanSession(session) {
  if (!session) return
  const acc = accountOf(session)
  const events = sessionEventsOf(session)
  for (let i = acc.cursor; i < events.length; i++) foldEvent(acc, events[i])
  acc.cursor = events.length
}

/* ===== 会话树与汇总 ===== */
function liveSessions(ctx) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return []
  return sessions.list ? sessions.list() : []
}
/* ===== 持久化子代理树（v0.1.9：已结束的子代理不在 live store，改用持久化日志聚合） ===== */
const childAccounts = new Map() // childId -> { len, acc }（以已读事件数作缓存键）

/** 从持久化头部构建 rootId 的全部后代（含非 live 会话）；即时错误降级为空。 */
async function persistedChildren(ctx, rootId) {
  const sp = ctx.get('sessionPersistence')
  if (sp === undefined || typeof sp.list !== 'function') return []
  let headers = []
  try { headers = await sp.list() } catch (err) { return [] }
  const out = []
  const queue = [String(rootId)]
  const seen = new Set()
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const h of headers) {
      const id = h && h.id !== undefined ? String(h.id) : null
      const pid = h && h.parentSession !== undefined ? String(h.parentSession) : null
      if (id === null || pid !== cur || seen.has(id)) continue
      seen.add(id)
      out.push(id)
      queue.push(id)
    }
  }
  return out
}

/** 折叠一个持久化会话（子代理或冷根）的日志；按（id, 事件数）缓存，变化时重折。
 *  diag（可选）收集失败痕迹，供 summary(debug) 定位。 */
async function persistedAccount(ctx, id, diag) {
  const sp = ctx.get('sessionPersistence')
  if (sp === undefined || typeof sp.readFrom !== 'function') {
    if (diag) diag.errorTrail.push('sessionPersistence 服务不可用或缺少 readFrom')
    return null
  }
  let events = []
  let len = 0
  try {
    const res = await sp.readFrom(id, 0)
    events = (res && res.events) || []
    len = events.length
    if (diag) diag.contextEvents = events.filter((ev) => ev.type === 'request/context').length
  } catch (err) {
    if (diag) diag.errorTrail.push(String((err && err.message) || err))
    const cached = childAccounts.get(String(id))
    return cached ? cached.acc : null
  }
  const cached = childAccounts.get(String(id))
  if (cached !== undefined && cached.len === len) return cached.acc
  const acc = newAccount()
  for (const ev of events) foldEvent(acc, ev)
  childAccounts.set(String(id), { len, acc })
  return acc
}

function mergeAccount(out, acc, id) {
  out.sessions.push(id)
  out.tokens.inMiss += acc.tokens.inMiss
  out.tokens.inHit += acc.tokens.inHit
  out.tokens.out += acc.tokens.out
  out.tokens.reasoning += acc.tokens.reasoning
  out.calls.priced += acc.calls.priced
  out.calls.unpriced += acc.calls.unpriced
  out.calls.nonDeep += acc.calls.nonDeep
  out.calls.recognized += acc.calls.recognized
  for (const [model, n] of acc.nonDeepModels) {
    out.nonDeepModels.set(model, (out.nonDeepModels.get(model) || 0) + n)
  }
  for (const [model, n] of acc.recognizedModels) {
    out.recognizedModels.set(model, (out.recognizedModels.get(model) || 0) + n)
  }
  out.cost.peak += acc.cost.peak
  out.cost.valley += acc.cost.valley
  for (const [model, m] of acc.byModel) {
    let t = out.byModel.get(model)
    if (t === undefined) { t = { inMiss: 0, inHit: 0, out: 0, peakCalls: 0, valleyCalls: 0, peakCny: 0, valleyCny: 0 }; out.byModel.set(model, t) }
    t.inMiss += m.inMiss; t.inHit += m.inHit; t.out += m.out
    t.peakCalls += m.peakCalls; t.valleyCalls += m.valleyCalls
    t.peakCny += m.peakCny; t.valleyCny += m.valleyCny
  }
}

async function aggregate(ctx, rootId, diag) {
  const out = { tokens: { inMiss: 0, inHit: 0, out: 0, reasoning: 0 }, calls: { priced: 0, unpriced: 0, nonDeep: 0, recognized: 0 }, nonDeepModels: new Map(), recognizedModels: new Map(), cost: { peak: 0, valley: 0 }, byModel: new Map(), sessions: [] }
  /* 根：live store（增量快）；冷会话（已从内存卸载的历史会话）回退到持久化日志（同子代理路径） */
  let rootLive = null
  for (const s of liveSessions(ctx)) {
    if (s && s.header && String(s.id) === String(rootId)) { rootLive = s; break }
  }
  if (rootLive !== null) {
    if (diag) {
      diag.rootOrigin = 'live'
      diag.contextEvents = sessionEventsOf(rootLive).filter((ev) => ev.type === 'request/context').length
    }
    const acc = accountOf(rootLive)
    scanSession(rootLive)
    mergeAccount(out, acc, String(rootLive.id))
    if (diag) diag.attributedModel = modelOf(acc)
  } else {
    if (diag) diag.rootOrigin = 'persisted'
    const acc = await persistedAccount(ctx, rootId, diag)
    if (acc !== null) {
      mergeAccount(out, acc, String(rootId))
      if (diag) diag.attributedModel = modelOf(acc)
    }
  }
  /* 子代理：持久化日志（含已结束会话） */
  const children = await persistedChildren(ctx, rootId)
  for (const cid of children) {
    const acc = await persistedAccount(ctx, cid, diag)
    if (acc !== null) mergeAccount(out, acc, cid)
  }
  out.childCount = out.sessions.length > 0 ? out.sessions.length - 1 : 0
  return out
}
function statusAt(now) {
  const phase = classifyAt(now)
  const endsAt = nextBoundary(now)
  const weekend = phase === 'valley' && (function () {
    const { weekday } = bjParts(now)
    return (weekday === 0 || weekday === 6) && now >= WEEKEND_FROM
  })()
  return { phase, endsAt, weekendAllValley: weekend, now }
}

/* ===== 汇率（USD ↔ CNY；CNY 为官方计价货币） ===== */
let fxRate = 7.16
let fxSource = 'default'
async function refreshFx() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return
    const json = await res.json()
    const v = Number(json && json.rates && json.rates.CNY)
    if (Number.isFinite(v) && v > 0) { fxRate = v; fxSource = 'online' }
  } catch (err) {
    /* 静默：保持默认/手动 */
  }
}

/* ===== Remote service ===== */
class DeepseekBillingService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'deepseekBilling')
  }

  /** 汇总：状态 + 窗口 token/费用。sessionId 由客户端显式传入（当前打开的会话）；
   *  未打开任何会话（null/空）时返回 empty 占位——不再静默聚合"最近活动会话"，
   *  避免打开历史会话时面板显示到别的会话（旧行为正是如此）。 */
  async summary(input) {
    const a = input || {}
    const rootId = typeof a.sessionId === 'string' && a.sessionId !== '' ? a.sessionId : null
    const now = Date.now()
    const st = statusAt(now)
    /* v0.1.20: priceSource 只在真正存在手动覆盖时才为 manual——旧实现恒为常量，
       客户端「（已覆盖）」分支永不触发；priceAsOf 由宿主单一真源提供，
       客户端不再硬编码日期。 */
    const meta = {
      priceSource: Object.keys(overrides).length > 0 ? 'manual' : 'official',
      priceAsOf: PRICE_AS_OF,
      peakMultiplier: PEAK_MULTIPLIER,
      /* v0.1.24：价表**单一真源**在这里。客户端不再自带一份硬编码副本
         （旧的 DEFAULT_PRICES / MODEL_LABELS 与宿主各写一份，改价时必然漂移），
         它拿这个列表渲染「价格配置」表单，并据此显示各族的当前默认价。
         v0.1.26：三档 × 峰谷 = 六个值（缓存命中输入 / 未命中输入 / 输出）。 */
      priceModels: FAMILIES.map((f) => ({
        pattern: f.pattern,
        label: f.label,
        valleyCacheHitIn: f.cacheHitIn,
        valleyMissIn: f.missIn,
        valleyOut: f.out,
        peakCacheHitIn: peakOf(f.cacheHitIn),
        peakMissIn: peakOf(f.missIn),
        peakOut: peakOf(f.out)
      })),
      /* 别名表也交给客户端，这样「价格配置」里能看出某个写法为什么算得出价。 */
      priceAliases: Object.keys(ALIASES).map((alias) => ({ alias, pattern: ALIASES[alias] })),
      fxRate, fxSource, updatedAt: now
    }
    /* v0.1.25：模型目录核对结果挂在 meta 上，两个分支都要有。空会话（rootId === null）
       拿不到会话记账，所以 usedUnknown 先给空数组，聚合后再补。 */
    meta.catalog = catalogForClient([])
    if (rootId === null) {
      return {
        sessionId: null, empty: true, status: st,
        sessions: [], childCount: 0,
        tokens: { inMiss: 0, inHit: 0, out: 0, reasoning: 0 },
        calls: { priced: 0, unpriced: 0, nonDeep: 0, recognized: 0 },
        nonDeepModels: [],
        recognizedModels: [],
        cost: { totalCny: 0, peakCny: 0, valleyCny: 0 },
        byModel: [], meta
      }
    }
    const diag = { rootOrigin: null, contextEvents: 0, attributedModel: null, errorTrail: [] }
    const agg = await aggregate(this.ctx, rootId, diag)
    const byModel = []
    if (agg) {
      for (const [model, m] of agg.byModel) {
        byModel.push({ model, label: labelFor(model), family: (lookupFamily(model) || {}).pattern || null, inMiss: m.inMiss, inHit: m.inHit, out: m.out, peakCalls: m.peakCalls, valleyCalls: m.valleyCalls, peakCny: m.peakCny, valleyCny: m.valleyCny, cny: m.peakCny + m.valleyCny })
      }
      byModel.sort((x, y) => y.cny - x.cny)
    }
    const nonDeepModels = agg ? [...agg.nonDeepModels.entries()].map(([model, count]) => ({ model, count })).sort((x, y) => y.count - x.count) : []
    /* v0.1.24：认得族但缺价的模型单独列出，面板据此点名要你配价。 */
    const recognizedModels = agg ? [...agg.recognizedModels.entries()].map(([model, count]) => ({ model, label: labelFor(model), count })).sort((x, y) => y.count - x.count) : []
    /* v0.1.25：usedUnknown 复用 nonDeepModels —— 它就是「会话里真实出现过、
       但完全认不出族」的那份记账，不必再算一遍。 */
    meta.catalog = catalogForClient(nonDeepModels)
    const resp = {
      status: st,
      sessionId: rootId,
      sessions: agg ? agg.sessions : [],
      childCount: agg ? agg.childCount : 0,
      tokens: agg ? agg.tokens : { inMiss: 0, inHit: 0, out: 0, reasoning: 0 },
      calls: agg ? agg.calls : { priced: 0, unpriced: 0, nonDeep: 0, recognized: 0 },
      nonDeepModels,
      recognizedModels,
      cost: { totalCny: agg ? agg.cost.peak + agg.cost.valley : 0, peakCny: agg ? agg.cost.peak : 0, valleyCny: agg ? agg.cost.valley : 0 },
      byModel,
      meta
    }
    if (a.debug === true) resp.diag = diag
    return resp
  }

  /** 轻量峰谷状态。 */
  async status() {
    return statusAt(Date.now())
  }

  /** 手动价格覆盖。v0.1.26：六值接口 —— `field` ∈
   *  peakCacheHitIn|peakMissIn|peakOut|valleyCacheHitIn|valleyMissIn|valleyOut，
   *  单位元/每 1M tokens；一次只写一个字段，客户端逐个提交。
   *  `reset` 清空全部手动覆盖（＝「清空手动值」，回到内置价表）。
   *  旧字段（field: peakIn 等四值 / bucket: hit|miss|out + valley/peak）
   *  仍被接受以便旧客户端继续工作。
   *  v0.1.27：写入后让价格派生缓存失效，否则已折过的历史事件保留旧价，
   *  面板的窗口费用不会跟着变。 */
  async setPrices(input) {
    const a = input || {}
    if (a.reset === true) {
      for (const k of Object.keys(overrides)) delete overrides[k]
      bumpPriceRevision()
      return { ok: true }
    }
    if (typeof a.model !== 'string' || a.model === '') return { ok: false }
    const FIELDS = ['peakCacheHitIn', 'peakMissIn', 'peakOut', 'valleyCacheHitIn', 'valleyMissIn', 'valleyOut']
    let field = typeof a.field === 'string' && FIELDS.indexOf(a.field) >= 0 ? a.field : null
    let value = Number(a.value)
    /* 旧客户端兼容：bucket + valley/peak 映射到四值字段。
       官方价页只给一个输入价，所以 hit 与 miss 共用「输入」。 */
    if (field === null && (a.bucket === 'hit' || a.bucket === 'miss' || a.bucket === 'out')) {
      const isPeak = a.peak !== undefined && Number.isFinite(Number(a.peak)) && Number(a.peak) >= 0
      /* v0.1.26：旧 bucket 的 hit / miss 现在各有独立档位，不再都落到 *In。 */
      const tierPart = a.bucket === 'hit' ? 'CacheHitIn' : a.bucket === 'miss' ? 'MissIn' : 'Out'
      field = (isPeak ? 'peak' : 'valley') + tierPart
      value = isPeak ? Number(a.peak) : Number(a.valley)
    }
    if (field === null || !Number.isFinite(value) || value < 0) return { ok: false }
    let o = overrides[a.model]
    if (o === undefined) { o = {}; overrides[a.model] = o }
    const before = o[field]
    o[field] = value
    /* 值真的变了才失效缓存 —— 客户端会逐字段提交（六个字段 = 六次调用），
       其中一个值与当前相同是常态，没必要为它重折一遍。 */
    if (before !== value) bumpPriceRevision()
    return { ok: true }
  }

  /** 手动设置汇率（CNY/USD）。 */
  async setRate(input) {
    const v = input && input.rate !== undefined ? Number(input.rate) : NaN
    if (!Number.isFinite(v) || v <= 0) return { ok: false }
    fxRate = v; fxSource = 'manual'
    return { ok: true }
  }
}

// --- Manual Remote markers (decorator-syntax-free) ---
const proto = DeepseekBillingService.prototype
function markRemote(method) {
  const context = {
    private: false,
    static: false,
    name: method,
    addInitializer(cb) { this.cb = cb }
  }
  Remote(method)(undefined, context)
  context.cb.call(Object.create(proto))
}
markRemote('summary')
markRemote('status')
markRemote('setPrices')
markRemote('setRate')

export function apply(ctx) {
  new DeepseekBillingService(ctx)

  /* v0.1.25：模型目录核对。DSH 的 LLM 服务是本插件之外注册的，加载顺序不保证，
     所以：启动时先建目录，若此刻拿不到（ready=false）则 30 秒后重试一次，
     之后每 CATALOG_REFRESH_MS 刷新一轮（供应商/模型会随配置变化）。 */
  const kickCatalog = () => { refreshCatalog(ctx).catch(() => {}) }
  kickCatalog()
  const catalogRetry = setTimeout(() => { if (!catalog.ready) kickCatalog() }, 30 * 1000)
  catalogTimer = setInterval(kickCatalog, CATALOG_REFRESH_MS)
  ctx.effect(() => () => {
    clearTimeout(catalogRetry)
    if (catalogTimer !== null) { clearInterval(catalogTimer); catalogTimer = null }
  })

  // 实时增量：只折叠已建档的会话（其余懒扫描）。
  // 账户由 accountOf→scanSession 创建（首轮即全量快照折叠）。事件监听只求
  // 即时性——scanSession 按游标增量，且 foldEvent 对 (turn,step) 采用
  // 「冲抵+替换」幂等语义，因此监听器与 poll 折叠重叠安全；一旦监听遗漏
  // （监听器隔离/时序），下一次 poll/√刷新会从游标补折到日志尾部，可自愈。
  ctx.on('session/event', (session, event) => {
    const acc = accounts.get(String(session.id))
    if (acc === undefined) return
    foldEvent(acc, event)
  })

  // 汇率刷新：启动即试一次，之后每 6 小时
  refreshFx().catch(() => {})
  const fxTimer = setInterval(() => { refreshFx().catch(() => {}) }, 6 * 3600 * 1000)
  ctx.effect(() => () => { clearInterval(fxTimer) })
}
