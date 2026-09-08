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
   改价时只需更新 OFFICIAL 数值与 PRICE_AS_OF 日期；峰值系数与界面宣示
   「高峰价 = 闲时价 × 2」共用 PEAK_MULTIPLIER 单一真源，防两处漂移。 */
const PRICE_AS_OF = '2026-09-03' // 官方定价页截图日期
const PEAK_MULTIPLIER = 2 // 官方高峰系数（v0.1.20：不再把峰值价硬编码进价表）
const OFFICIAL = {
  'deepseek-v4-flash': { hit: 0.05, miss: 1.5, out: 4.5 },
  'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
  'deepseek-v4-flash-vision-exp': { hit: 0.05, miss: 1.5, out: 4.5 },
  /* v0.1.21：0910 试验版模型（当前 agent 默认模型）无独立官方价页，
     按 V4 Flash 价表计（官方页 2026-09-03）。 */
  'deepseek-v4.1-flash-expires-on-0910': { hit: 0.05, miss: 1.5, out: 4.5 }
}
function peakOf(valley) {
  return valley * PEAK_MULTIPLIER
}
const LABELS = {
  'deepseek-v4-flash': 'V4 Flash',
  'deepseek-v4-pro': 'V4 Pro',
  'deepseek-v4-flash-vision-exp': 'V4 Flash Vision',
  'deepseek-v4.1-flash-expires-on-0910': 'V4.1 Flash · 0910'
}
const M = 1000000

/* ===== 手动覆盖（本进程内存；客户端 localStorage 会在启动时重新灌入） ===== */
const overrides = Object.create(null)

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

/* ===== 价格（含手动覆盖） ===== */
function offRow(model) {
  const base = OFFICIAL[model] !== undefined ? OFFICIAL[model] : null
  const ov = overrides[model]
  if (base === null && ov === undefined) return null
  const mk = (bucket) => {
    /* 谷时价：手动覆盖优先（非法值回退官方）；无官方行时未设置按 0 计（避免 NaN）。
       峰值价：默认 = 谷时价 × PEAK_MULTIPLIER（与界面宣示口径同源），可被
       bucket+'Peak' 显式覆盖。 */
    let valley
    if (ov !== undefined && ov[bucket] !== undefined) {
      const v = Number(ov[bucket])
      if (Number.isFinite(v) && v >= 0) valley = v
    }
    if (valley === undefined) valley = base !== null ? base[bucket] : 0
    const p = ov !== undefined ? ov[bucket + 'Peak'] : undefined
    const peak = Number.isFinite(Number(p)) && Number(p) >= 0 ? Number(p) : peakOf(valley)
    return [valley, peak]
  }
  const row = { hit: mk('hit'), miss: mk('miss'), out: mk('out') }
  /* 纯手动覆盖且全部未设置 = 无价行（保持旧语义：按「非 DeepSeek」归类）。 */
  if (base === null && row.hit[0] === 0 && row.miss[0] === 0 && row.out[0] === 0) return null
  return row
}
function priceFor(model, phase) {
  const row = offRow(model)
  if (row === null) return null
  const i = phase === 'peak' ? 1 : 0
  return { hit: row.hit[i], miss: row.miss[i], out: row.out[i] }
}

/* ===== 会话账号与增量折叠 ===== */
const accounts = new Map()
function newAccount() {
  return {
    byStep: new Map(),
    context: null,
    /* request/header.config 的最近模型（request/context 每会话仅 1 条，
       多模型会话以最近一条请求头为准）。 */
    headerModel: null,
    tokens: { inMiss: 0, inHit: 0, out: 0, reasoning: 0 },
    calls: { priced: 0, unpriced: 0, nonDeep: 0 },
    nonDeepModels: new Map(),
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
  const row = model === null ? null : offRow(model)
  const priced = phase !== 'unpriced' && row !== null
  const price = priced ? priceFor(model, phase) : null
  const hitC = price ? inHit / M * price.hit : 0
  const missC = price ? inMiss / M * price.miss : 0
  const outC = price ? out / M * price.out : 0
  return {
    time, model, phase, priced,
    tokens: { inMiss, inHit, out, reasoning },
    cost: { hit: hitC, miss: missC, out: outC, total: hitC + missC + outC },
    kind: priced ? 'priced' : (phase === 'unpriced' ? 'pre' : 'nonDeep')
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
  for (const [model, n] of acc.nonDeepModels) {
    out.nonDeepModels.set(model, (out.nonDeepModels.get(model) || 0) + n)
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
  const out = { tokens: { inMiss: 0, inHit: 0, out: 0, reasoning: 0 }, calls: { priced: 0, unpriced: 0, nonDeep: 0 }, nonDeepModels: new Map(), cost: { peak: 0, valley: 0 }, byModel: new Map(), sessions: [] }
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
      fxRate, fxSource, updatedAt: now
    }
    if (rootId === null) {
      return {
        sessionId: null, empty: true, status: st,
        sessions: [], childCount: 0,
        tokens: { inMiss: 0, inHit: 0, out: 0, reasoning: 0 },
        calls: { priced: 0, unpriced: 0, nonDeep: 0 },
        nonDeepModels: [],
        cost: { totalCny: 0, peakCny: 0, valleyCny: 0 },
        byModel: [], meta
      }
    }
    const diag = { rootOrigin: null, contextEvents: 0, attributedModel: null, errorTrail: [] }
    const agg = await aggregate(this.ctx, rootId, diag)
    const byModel = []
    if (agg) {
      for (const [model, m] of agg.byModel) {
        byModel.push({ model, label: LABELS[model] || model, inMiss: m.inMiss, inHit: m.inHit, out: m.out, peakCalls: m.peakCalls, valleyCalls: m.valleyCalls, peakCny: m.peakCny, valleyCny: m.valleyCny, cny: m.peakCny + m.valleyCny })
      }
      byModel.sort((x, y) => y.cny - x.cny)
    }
    const nonDeepModels = agg ? [...agg.nonDeepModels.entries()].map(([model, count]) => ({ model, count })).sort((x, y) => y.count - x.count) : []
    const resp = {
      status: st,
      sessionId: rootId,
      sessions: agg ? agg.sessions : [],
      childCount: agg ? agg.childCount : 0,
      tokens: agg ? agg.tokens : { inMiss: 0, inHit: 0, out: 0, reasoning: 0 },
      calls: agg ? agg.calls : { priced: 0, unpriced: 0, nonDeep: 0 },
      nonDeepModels,
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

  /** 手动价格覆盖（reset 恢复官方内置；bucket: hit|miss|out）。 */
  async setPrices(input) {
    const a = input || {}
    if (a.reset === true) { for (const k of Object.keys(overrides)) delete overrides[k]; return { ok: true } }
    if (a.model === undefined || a.bucket === undefined) return { ok: false }
    if (typeof a.model !== 'string' || (a.bucket !== 'hit' && a.bucket !== 'miss' && a.bucket !== 'out')) return { ok: false }
    const v = Number(a.valley)
    if (!Number.isFinite(v) || v < 0) return { ok: false }
    let o = overrides[a.model]
    if (o === undefined) { o = {}; overrides[a.model] = o }
    o[a.bucket] = v
    if (a.peak !== undefined && Number.isFinite(Number(a.peak)) && Number(a.peak) >= 0) o[a.bucket + 'Peak'] = Number(a.peak)
    else delete o[a.bucket + 'Peak']
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
