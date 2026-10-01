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

/* ===== v0.4.0：规则、价表与节假日全部移到纯函数模块 =====
   ./pricing.js  —— 族/前缀/别名、价表纪元、峰谷与节假日判时、下一次切换时刻
   ./holidays.js —— 法定节假日日期表（只登记放假日，调休不处理）+ ICU 农历自检

   本文件只保留：账户折叠、模型目录核对、手动覆盖状态、Remote 服务。
   这样做的好处是「计价规则」可以脱离 ctx 单测（test/pricing.test.mjs），
   并且价表只有一份真源（以前 FAMILIES/ALIASES/覆盖查找散在三个地方）。 */
import {
  PEAK_MULTIPLIER,
  isOfficialProvider,
  providerGate,
  FAMILIES,
  familyFor,
  labelForFamily,
  PRICE_EPOCHS,
  priceAt,
  baseRow,
  rowFor,
  priceRow,
  epochAt,
  classifyAt,
  nextBoundary,
  weekendAllValley,
  isHolidayDate,
  labelFor as labelForModel
} from './pricing.js'
import { bjYear, isCalibratedYear } from './holidays.js'

/* ===== 模型 id 的历史教训（v0.1.24 → v0.4.0） =====

      实测（从真实会话日志里读出来的模型 id）：
       settings.yaml → agent-default-model.model = "deepseek-flash"
       同库另有两个 id："deepseek-v4-flash"、"deepseek-v4.1-flash-expires-on-0910"
   第一次改成族匹配时我用了 `deepseek-v4-flash` 作 pattern，于是
   `'deepseek-flash'.startsWith('deepseek-v4-flash')` 为假 → 555 次调用全部
   归入「未识别模型不计价」，本次窗口费用恒为 ¥0.0000。
   根因是**契约误读**：我假设 DSH 的 model id 等于官方价页的模型名，实际它是
   provider 配置里用户可自由填写的字符串（本机就有三种写法共存）。

   v0.4.0 的匹配规则（见 pricing.js）：
     ① 前缀 / 别名精确命中已知族（flash、pro）；
     ② 仍在官方渠道目录里、但名字变了的新模型 → 关键字推断（含 flash/pro），
        标注为「推断价」；推断不出则进入「需补价」名单；
     ③ 非官方 provider 的请求一律不参与计价（provider 白名单见 pricing.js）。
   原先的 `PROVIDER_PREFIXES`（凡 `deepseek-` 开头都算）已删除：它会把外部接入
   的同名模型也按官方价计费。 */

/* 价表真源在 pricing.js 的 PRICE_EPOCHS：改价时新增一条纪元（带生效时刻与出处），
   不要改历史纪元 —— 计价按事件自身时刻查表，历史账目因此不会被追溯重算。 */
/* 展示标签：族名 + 变体后缀（真源在 pricing.js）。 */
function labelFor(model) {
  return labelForModel(model)
}
const M = 1000000

/* ===== 官方模型目录（v0.4.0：只认官方渠道） =====
   模型清单的唯一真源是 DSH 自己：`ctx.llm.listProviders()` 给出已注册的 provider
   路由，`ctx.llm.listModels(provider)` 给出该路由广告的模型目录（官方适配器自带
   目录数组，不发网络请求、不需要密钥）。

   本插件**只**消费官方渠道（pricing.js 的 OFFICIAL_PROVIDERS）：
     · official —— 官方目录里的模型，逐条解析族（前缀/别名命中，未命中则关键字
       推断并标 inferred），据此渲染面板的价表表单；`needsPrice` 是既非官方渠道
       无价、又推断不出的那几条，面板点名要你补价。
     · 外部 provider —— 只记录 id 数量，**不拉取、不展示、不计价**，避免把外部
       同名模型按官方价结算。

   刷新是异步的（listModels 返回 Promise），而 summary() 是同步热路径，所以只读
   缓存；缓存在 apply 时与每 10 分钟各刷一次；llm 服务缺席时整块静默降级。 */
const catalog = {
  ready: false,
  at: null,
  providers: [],
  officialProviders: [],
  official: [],
  needsPrice: [],
  advertised: 0,
  error: null
}
const CATALOG_REFRESH_MS = 10 * 60 * 1000
let catalogTimer = null

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
    const officialProviders = []
    const official = []
    let advertised = 0
    const now = Date.now()
    for (const p of Array.isArray(providers) ? providers : []) {
      const id = p && typeof p.id === 'string' ? p.id : null
      if (id === null) continue
      providerIds.push(id)
      if (!isOfficialProvider(id)) continue // 外部渠道：不拉目录、不计价
      officialProviders.push(id)
      let list = []
      try {
        /* 目录成员资格是「建议性」的：某个供应商不回应也不该拖垮整轮核对。 */
        list = await llm.listModels(id)
      } catch (err) { list = [] }
      for (const m of Array.isArray(list) ? list : []) {
        const mid = m && typeof m.id === 'string' ? m.id : null
        if (mid === null) continue
        advertised += 1
        const fam = familyFor(mid, true)
        official.push({
          provider: id,
          model: mid,
          name: m && typeof m.name === 'string' ? m.name : mid,
          family: fam === null ? null : fam.key,
          label: fam === null ? mid : fam.label,
          how: fam === null ? null : fam.how,
          inferred: fam !== null && fam.how === 'inferred',
          needsPrice: fam === null || priceAt(fam.key, now) === null
        })
      }
    }
    official.sort((x, y) => String(x.model).localeCompare(String(y.model)))
    catalog.providers = providerIds
    catalog.officialProviders = officialProviders
    catalog.official = official
    catalog.needsPrice = official.filter((m) => m.needsPrice)
    catalog.advertised = advertised
    catalog.ready = true
    catalog.at = now
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

   v0.3.0 起只认这一种结构：宿主与客户端同包发布，客户端在灌入前已经把
   localStorage 里的旧结构（v0.1.24 四值 / 更早的 hit/miss/out）归一化，
   宿主侧的旧结构读取分支已删除。 */
const overrides = Object.create(null)

/* 计价模式（v0.4.0）：
     official —— 手动覆盖逐字段优先，未填字段回落「该时刻生效的纪元价」（默认）
     manual   —— **只认**手动覆盖；六值不全即不计价并在面板点名，绝不回落内置 */
let pricingMode = 'official'

/* 规则逻辑（bjParts / inPeak / classifyAt / nextBoundary）已移入 pricing.js。 */

/* ===== 价格（手动覆盖 + 价表纪元） =====
   组装与判定都在 pricing.js 的纯函数里（rowFor / priceRow），本文件只提供状态：
   overrides（手动覆盖记录）与 pricingMode（是否允许回落内置纪元价）。 */
function priceFor(model, phase, time) {
  return priceRow(rowFor(model, time, overrides, pricingMode), phase, pricingMode)
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
   冲抵再重算。持久化子代理（childAccounts）只以事件数为缓存键，价格变化后
   事件数不变时会命中旧价账户，所以必须与活会话账户一起清空（v0.1.28）。 */
/* 价格一变就丢掉活会话账户与持久化子代理账户（理由见上）。函数名保留，
   但不再维护计数器：序号没有任何读取方，真正的失效动作是下面两次 clear。 */
function bumpPriceRevision() {
  accounts.clear()
  /* v0.1.28: persisted (child) accounts are cached by (id, 事件数) only, so a
     price change would keep serving accounts folded under the OLD price table
     whenever a child's log length is unchanged. Drop them with the live ones. */
  childAccounts.clear()
}
function newAccount() {
  return {
    byStep: new Map(),
    context: null,
    /* request/header.config 的最近模型（request/context 每会话仅 1 条，
       多模型会话以最近一条请求头为准）。 */
    headerModel: null,
    /* request/header.config 的最近 provider（v0.4.0：计价前的官方渠道闸门）。 */
    headerProvider: null,
    tokens: { inMiss: 0, inHit: 0, out: 0, reasoning: 0 },
    calls: { priced: 0, unpriced: 0, nonDeep: 0, recognized: 0, nonOfficial: 0, providerUnknown: 0 },
    /* 只有「需要点名」的两类保留模型明细：缺价的（价格配置里要补）
       与走非官方渠道的（钱没算进来）。其余计数即可，不再逐模型记账。 */
    recognizedModels: new Map(), // model -> { count, reason }
    nonOfficialModels: new Map(),
    cost: { peak: 0, valley: 0 },
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
/* 该次调用的 provider：请求头优先，会话上下文兜底。用于官方渠道闸门。 */
function providerOf(acc) {
  return acc.headerProvider || (acc.context ? acc.context.provider : null)
}
function buildSample(model, time, usage, provider) {
  const t = usage || {}
  const inMiss = Number(t.inputTokens) || 0
  const inHit = Number(t.cacheReadTokens) || 0
  const out = Number(t.outputTokens) || 0
  const reasoning = Number(t.reasoningTokens) || 0
  const phase = classifyAt(time)
  /* 官方渠道闸门（v0.4.0）：provider 未知或非官方一律不计价，
     分别计入 providerUnknown / nonOfficial，面板单独交代——绝不静默按 0 也不误算。 */
  const gate = providerGate(provider)
  const official = gate === 'official'
  let price = null
  if (gate === 'unknown') price = { kind: 'gated', reason: 'provider-unknown' }
  else if (!official) price = { kind: 'gated', reason: 'non-official' }
  else if (model === null) price = { kind: 'unknown', reason: 'no-model' }
  else price = priceFor(model, phase, time)
  const priced = official && phase !== 'unpriced' && price.kind === 'priced'
  const hitC = priced ? inHit / M * price.hit : 0
  const missC = priced ? inMiss / M * price.miss : 0
  const outC = priced ? out / M * price.out : 0
  let kind
  if (gate === 'unknown') kind = 'providerUnknown'
  else if (!official) kind = 'nonOfficial'
  else if (phase === 'unpriced') kind = 'pre'
  else if (priced) kind = 'priced'
  else if (price.kind === 'unknown') kind = 'nonDeep'
  else kind = 'recognized'
  return {
    time, model, provider, phase, priced,
    reason: price.reason || null,
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
  const keyOf = (model) => (model === null || model === undefined ? '(no model)' : String(model))
  if (s.kind === 'priced') {
    acc.calls.priced += k
    acc.cost[s.phase] += k * s.cost.total
  } else if (s.kind === 'recognized') {
    /* 官方模型但算不出价：单独记账并把理由带出去，面板据此点名。 */
    acc.calls.recognized += k
    const key = keyOf(s.model)
    const prev = acc.recognizedModels.get(key)
    acc.recognizedModels.set(key, { count: (prev ? prev.count : 0) + k, reason: s.reason || prev && prev.reason || 'no-base-price' })
  } else if (s.kind === 'nonOfficial') {
    /* 外部接入的 provider：不计价，但要让你看见「这个会话有多少钱没算进来」。 */
    acc.calls.nonOfficial += k
    const key = keyOf(s.model)
    acc.nonOfficialModels.set(key, (acc.nonOfficialModels.get(key) || 0) + k)
  } else if (s.kind === 'providerUnknown') {
    acc.calls.providerUnknown += k
  } else if (s.kind === 'nonDeep') {
    acc.calls.nonDeep += k
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
    /* 每条请求一条 request/header；header.config 是 LlmCallConfig，含 provider 与
       model（0.2.0-rc.2 实测类型：provider 为必填字段）。request/context 每会话仅 1
       条，多模型/多 provider 会话以最近一条请求头为准。 */
    const cfg = ev.data && ev.data.header && ev.data.header.config
    if (cfg && typeof cfg.model === 'string') acc.headerModel = cfg.model
    if (cfg && typeof cfg.provider === 'string') acc.headerProvider = cfg.provider
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
  const s = buildSample(modelOf(acc), ev.time, usage, providerOf(acc))
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
/** dsh Session 的只读事件快照访问器（0.2.0-rc.2：snapshotEvents()）。
 *  注意：Session 上没有 .events / .log 属性——旧代码用它们作兜底，
 *  恒为 undefined，导致 resumed（种子重放）会话的历史永远折不进账户。 */
function sessionEventsOf(session) {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return []
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
    for (const entry of headers) {
      /* list() yields SessionPersistenceSnapshot{header, revision}. */
      const h = entry && entry.header !== undefined ? entry.header : entry
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

/** 读取一个非 live 会话的完整事件日志。
 *  优先用 live-preferred 的 ctx.sessionQuery.readSession(id)（返回 {session, events}），
 *  否则用句柄 open(id,'read') + read(0) 兜底（0.2.0-rc.2 的 seam 只有 open/read）。
 *  返回 null 表示没有任何可用的读取途径（调用方据此降级）。 */
async function readPersistedEvents(ctx, id) {
  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.readSession === 'function') {
    const snapshot = await query.readSession(id)
    return (snapshot && snapshot.events) || []
  }
  const sp = ctx.get('sessionPersistence')
  if (sp === undefined) return null
  if (typeof sp.open === 'function') {
    const handle = await sp.open(id, 'read')
    try {
      const res = await handle.read(0)
      return (res && res.events) || []
    } finally {
      try { await handle.close() } catch (err) { /* close is best-effort */ }
    }
  }
  return null
}

/** 折叠一个持久化会话（子代理或冷根）的日志；按（id, 事件数）缓存，变化时重折。
 *  diag（可选）收集失败痕迹，供 summary(debug) 定位。 */
async function persistedAccount(ctx, id, diag) {
  let events = []
  let len = 0
  try {
    const read = await readPersistedEvents(ctx, id)
    if (read === null) {
      if (diag) diag.errorTrail.push('会话日志读取不可用（sessionQuery.readSession 与 sessionPersistence.open 均不可用）')
      return null
    }
    events = read
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

/**
 * 把一份账户并入汇总。isChild 决定 token 计入「主会话」还是「子代理总消耗」——
 * 面板明细卡要分别显示这两个数字，费用仍只给一个总数（用户要求）。
 */
function mergeAccount(out, acc, id, isChild) {
  out.sessions.push(id)
  const tokenTarget = isChild ? out.childTokens : out.mainTokens
  for (const k of ['inMiss', 'inHit', 'out', 'reasoning']) {
    out.tokens[k] += acc.tokens[k]
    tokenTarget[k] += acc.tokens[k]
  }
  out.calls.priced += acc.calls.priced
  out.calls.unpriced += acc.calls.unpriced
  out.calls.nonDeep += acc.calls.nonDeep
  out.calls.recognized += acc.calls.recognized
  out.calls.nonOfficial += acc.calls.nonOfficial
  out.calls.providerUnknown += acc.calls.providerUnknown
  for (const [model, rec] of acc.recognizedModels) {
    const prev = out.recognizedModels.get(model)
    out.recognizedModels.set(model, {
      count: (prev ? prev.count : 0) + rec.count,
      reason: prev !== undefined && prev.reason !== undefined ? prev.reason : rec.reason
    })
  }
  for (const [model, n] of acc.nonOfficialModels) {
    out.nonOfficialModels.set(model, (out.nonOfficialModels.get(model) || 0) + n)
  }
  out.cost.peak += acc.cost.peak
  out.cost.valley += acc.cost.valley
}

async function aggregate(ctx, rootId, diag) {
  const out = {
    tokens: zeroTokens(),
    mainTokens: zeroTokens(),
    childTokens: zeroTokens(),
    calls: { priced: 0, unpriced: 0, nonDeep: 0, recognized: 0, nonOfficial: 0, providerUnknown: 0 },
    recognizedModels: new Map(),
    nonOfficialModels: new Map(),
    cost: { peak: 0, valley: 0 },
    sessions: []
  }
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
    mergeAccount(out, acc, String(rootLive.id), false)
    if (diag) diag.attributedModel = modelOf(acc)
  } else {
    if (diag) diag.rootOrigin = 'persisted'
    const acc = await persistedAccount(ctx, rootId, diag)
    if (acc !== null) {
      mergeAccount(out, acc, String(rootId), false)
      if (diag) diag.attributedModel = modelOf(acc)
    }
  }
  /* 子代理：持久化日志（含已结束会话） */
  const children = await persistedChildren(ctx, rootId)
  for (const cid of children) {
    const acc = await persistedAccount(ctx, cid, diag)
    if (acc !== null) mergeAccount(out, acc, cid, true)
  }
  out.childCount = out.sessions.length > 0 ? out.sessions.length - 1 : 0
  return out
}
function statusAt(now) {
  const phase = classifyAt(now)
  return {
    phase: phase,
    endsAt: nextBoundary(now),
    weekendAllValley: weekendAllValley(now),
    holiday: isHolidayDate(now)
  }
}

/* ===== 汇率（USD ↔ CNY；CNY 为官方计价货币） ===== */
let fxRate = 7.16
async function refreshFx() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return
    const json = await res.json()
    const v = Number(json && json.rates && json.rates.CNY)
    if (Number.isFinite(v) && v > 0) fxRate = v
  } catch (err) {
    /* 静默：保持默认/手动 */
  }
}

/* 响应里的三个零值构造器：空会话与聚合失败共用，避免同一组字面量写三遍。 */
function zeroTokens() { return { inMiss: 0, inHit: 0, out: 0, reasoning: 0 } }
/** 空会话的 tokens 与真实响应同形：总数 + 主会话 / 子代理两份拆分。 */
function emptyTokens() {
  return { inMiss: 0, inHit: 0, out: 0, reasoning: 0, main: zeroTokens(), children: zeroTokens() }
}
function emptyCalls() { return { priced: 0, unpriced: 0, nonDeep: 0, recognized: 0, nonOfficial: 0, providerUnknown: 0 } }
function emptyCost() { return { totalCny: 0, peakCny: 0, valleyCny: 0 } }

/* ===== 面板价表（按族分组，族下挂官方目录里的模型名） =====
   行的真源是**官方目录**：官方新增/改名模型后，这里自动跟着变；
   同一族下的多个名字共用一份价格与一份手动覆盖（用户覆盖的是「这个族的价格」）。
   目录不可用（llm 服务缺席）时退回静态族表，面板仍可用。 */
function priceModelsForClient(time) {
  const buckets = new Map()
  const push = (bucketKey, family, label, how, inferred, provider, model) => {
    let b = buckets.get(bucketKey)
    if (b === undefined) {
      b = { key: bucketKey, family: family, label: label, how: how, inferred: false, provider: provider, models: [] }
      buckets.set(bucketKey, b)
    }
    if (model !== null && b.models.indexOf(model) < 0) b.models.push(model)
    if (inferred === true) b.inferred = true
    return b
  }
  if (catalog.official.length > 0) {
    for (const m of catalog.official) {
      if (m.family === null) push(m.model, null, m.model + '（未定价）', null, false, m.provider, m.model)
      else push(m.family, m.family, labelForFamily(m.family), m.how, m.inferred === true, m.provider, m.model)
    }
  } else {
    for (const f of FAMILIES) push(f.key, f.key, f.label, 'family', false, null, f.key)
  }
  const rows = []
  for (const b of buckets.values()) {
    const base = b.family === null ? null : baseRow(b.family, time)
    /* 覆盖键：有族就用族键（用户覆盖的是「这个族的价格」），无族就用模型 id。
       这个 key 同时是客户端写盘/回填的键，必须与宿主 overrideRecordFor 的查找一致。 */
    const ovKey = b.family === null ? b.models[0] : b.family
    const ov = overrides[ovKey] !== undefined ? overrides[ovKey] : (b.models[0] !== undefined ? overrides[b.models[0]] : undefined)
    rows.push({
      key: ovKey,
      family: b.family,
      label: b.label,
      models: b.models,
      provider: b.provider,
      how: b.how,
      inferred: b.inferred === true,
      needsPrice: base === null,
      manual: ov !== undefined,
      base: base === null ? null : {
        valleyCacheHitIn: base.cacheHitIn.valley, valleyMissIn: base.missIn.valley, valleyOut: base.out.valley,
        peakCacheHitIn: base.cacheHitIn.peak, peakMissIn: base.missIn.peak, peakOut: base.out.peak
      },
      override: ov === undefined ? null : {
        valleyCacheHitIn: ov.valleyCacheHitIn, valleyMissIn: ov.valleyMissIn, valleyOut: ov.valleyOut,
        peakCacheHitIn: ov.peakCacheHitIn, peakMissIn: ov.peakMissIn, peakOut: ov.peakOut
      }
    })
  }
  rows.sort((x, y) => String(x.label).localeCompare(String(y.label)))
  return rows
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
    /* v0.4.0：meta 只放客户端真正要渲染的东西 —— 计价模式、当前价表纪元、
       峰谷系数、面板价表行与汇率。目录/节假日等宿主内部事实不再外泄。 */
    const epoch = epochAt(now)
    const year = bjYear(now)
    const meta = {
      pricingMode: pricingMode,
      peakMultiplier: PEAK_MULTIPLIER,
      /* 当前生效的价表纪元（面板页脚用它交代「这笔钱按哪版价算」）。 */
      epoch: epoch === null ? null : { from: epoch.from, source: epoch.source },
      /* 放假安排缺年份时规则会退化为「只有周末是闲时」，此时如实提示一次。 */
      holiday: { year: year, calibrated: isCalibratedYear(year) },
      priceModels: priceModelsForClient(now),
      fxRate: fxRate,
      updatedAt: now
    }

    if (rootId === null) {
      return {
        sessionId: null, empty: true, status: st, childCount: 0,
        tokens: emptyTokens(), calls: emptyCalls(), cost: emptyCost(),
        recognizedModels: [], nonOfficialModels: [], meta
      }
    }
    const diag = { rootOrigin: null, contextEvents: 0, attributedModel: null, errorTrail: [] }
    const agg = await aggregate(this.ctx, rootId, diag)
    const pairs = (map) => (agg ? [...map.entries()].map(([model, count]) => ({ model, count })).sort((x, y) => y.count - x.count) : [])
    /* 官方模型但算不出价（纪元缺价 / 只用手动价模式下未配置）：点名并给理由。 */
    const recognizedModels = agg
      ? [...agg.recognizedModels.entries()].map(([model, rec]) => ({ model, label: labelFor(model), count: rec.count, reason: rec.reason })).sort((x, y) => y.count - x.count)
      : []
    /* 非官方渠道：不计价但必须可见，否则「少算的钱」无从发现。 */
    const nonOfficialModels = pairs(agg ? agg.nonOfficialModels : new Map())
    const tok = agg ? agg.tokens : emptyTokens()
    const main = agg ? agg.mainTokens : emptyTokens()
    const child = agg ? agg.childTokens : emptyTokens()
    const resp = {
      status: st,
      sessionId: rootId,
      childCount: agg ? agg.childCount : 0,
      /* tokens 是总数；main / children 是明细卡要分行显示的拆分。 */
      tokens: {
        inMiss: tok.inMiss, inHit: tok.inHit, out: tok.out, reasoning: tok.reasoning,
        main: { inMiss: main.inMiss, inHit: main.inHit, out: main.out },
        children: { inMiss: child.inMiss, inHit: child.inHit, out: child.out }
      },
      calls: agg ? agg.calls : emptyCalls(),
      recognizedModels,
      nonOfficialModels,
      cost: agg
        ? { totalCny: agg.cost.peak + agg.cost.valley, peakCny: agg.cost.peak, valleyCny: agg.cost.valley }
        : emptyCost(),
      meta
    }
    if (a.debug === true) resp.diag = diag
    return resp
  }

  /** 轻量峰谷状态。 */
  async status() {
    return statusAt(Date.now())
  }

  /** 手动价格覆盖（六值接口）—— `field` ∈
   *  peakCacheHitIn|peakMissIn|peakOut|valleyCacheHitIn|valleyMissIn|valleyOut，
   *  单位元/每 1M tokens；一次只写一个字段，客户端逐个提交。
   *  `reset` 清空全部手动覆盖（＝「清空手动值」，回到内置价表）。
   *  v0.3.0：只接受六值字段。旧的 `field: peakIn` 四值与
   *  `bucket: hit|miss|out + valley/peak` 载荷来自同包的旧客户端 bundle，
   *  已随旧结构一起删除（客户端在灌入前自行归一化 localStorage）。
   *  v0.1.27：写入后让价格派生缓存失效，否则已折过的历史事件保留旧价，
   *  面板的窗口费用不会跟着变。
   *  v0.1.28：传 value = null/'' 表示清除该字段的手动覆盖（回到内置价）。 */
  async setPrices(input) {
    const a = input || {}
    if (a.reset === true) {
      for (const k of Object.keys(overrides)) delete overrides[k]
      bumpPriceRevision()
      return { ok: true }
    }
    if (typeof a.model !== 'string' || a.model === '') return { ok: false }
    /* v0.4.0：单模型「恢复内置」= clear。表单按族写盘，故 model 既可能是族键
       （flash/pro），也可能是某个具体模型 id。 */
    if (a.clear === true) {
      if (overrides[a.model] === undefined) return { ok: true }
      delete overrides[a.model]
      bumpPriceRevision()
      return { ok: true }
    }
    const FIELDS = ['peakCacheHitIn', 'peakMissIn', 'peakOut', 'valleyCacheHitIn', 'valleyMissIn', 'valleyOut']
    const field = typeof a.field === 'string' && FIELDS.indexOf(a.field) >= 0 ? a.field : null
    const value = Number(a.value)
    if (field === null) return { ok: false }
    /* v0.1.28：value = null/'' 表示「清除该字段的手动覆盖，回到内置价」。
       此前客户端对空输入直接跳过，宿主覆盖值永远留着——表单显示内置价、
       实际仍按旧手动价计费。 */
    if (a.value === null || a.value === undefined || a.value === '') {
      const current = overrides[a.model]
      if (current === undefined || current[field] === undefined) return { ok: true }
      delete current[field]
      if (Object.keys(current).length === 0) delete overrides[a.model]
      bumpPriceRevision()
      return { ok: true }
    }
    if (!Number.isFinite(value) || value < 0) return { ok: false }
    let o = overrides[a.model]
    if (o === undefined) { o = {}; overrides[a.model] = o }
    const before = o[field]
    o[field] = value
    /* 值真的变了才失效缓存 —— 客户端会逐字段提交（六个字段 = 六次调用），
       其中一个值与当前相同是常态，没必要为它重折一遍。 */
    if (before !== value) bumpPriceRevision()
    return { ok: true }
  }

  /** 计价模式（v0.4.0）：official = 手动优先 + 缺档回落纪元价；manual = 只用手动价。 */
  async setPricingMode(input) {
    const mode = input && typeof input.mode === 'string' ? input.mode : ''
    if (mode !== 'official' && mode !== 'manual') return { ok: false }
    if (pricingMode !== mode) {
      pricingMode = mode
      bumpPriceRevision()
    }
    return { ok: true, mode: pricingMode }
  }

  /** 手动设置汇率（CNY/USD）。 */
  async setRate(input) {
    const v = input && input.rate !== undefined ? Number(input.rate) : NaN
    if (!Number.isFinite(v) || v <= 0) return { ok: false }
    fxRate = v
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
markRemote('setPricingMode')
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
