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

/* ===== 官方规则（多来源交叉验证，2026-09-03） ===== */
const HOUR = 3600000
const BJ = 8 * HOUR // 北京时间 = UTC+8（固定偏移，无 DST）
const PEAK_FROM = Date.UTC(2026, 7, 16, 16, 0, 0) // 峰谷定价 2026-08-17 00:00(北京) 生效
const WEEKEND_FROM = Date.UTC(2026, 7, 22, 16, 0, 0) // 周末全天谷 2026-08-23 00:00(北京) 起
const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]] // 北京 09:00–12:00、14:00–18:00

/* ===== 官方价表：元 / 每 1M tokens（2026-09-03 官方定价页截图） ===== */
const OFFICIAL = {
  'deepseek-v4-flash': { hit: [0.05, 0.10], miss: [1.5, 3.0], out: [4.5, 9.0] },
  'deepseek-v4-pro': { hit: [0.15, 0.30], miss: [4.5, 9.0], out: [13.5, 27.0] },
  'deepseek-v4-flash-vision-exp': { hit: [0.05, 0.10], miss: [1.5, 3.0], out: [4.5, 9.0] }
}
const LABELS = {
  'deepseek-v4-flash': 'V4 Flash',
  'deepseek-v4-pro': 'V4 Pro',
  'deepseek-v4-flash-vision-exp': 'V4 Flash Vision'
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
  const base = OFFICIAL[model]
  if (base === undefined) return null
  const ov = overrides[model]
  if (!ov) return base
  const mk = (bucket) => {
    if (ov[bucket] === undefined) return base[bucket]
    const v = Number(ov[bucket])
    if (!Number.isFinite(v) || v < 0) return base[bucket]
    const p = ov[bucket + 'Peak']
    const peak = Number.isFinite(Number(p)) && Number(p) >= 0 ? Number(p) : v * 2
    return [v, peak]
  }
  return { hit: mk('hit'), miss: mk('miss'), out: mk('out') }
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
    tokens: { inMiss: 0, inHit: 0, out: 0, reasoning: 0 },
    calls: { priced: 0, unpriced: 0, nonDeep: 0 },
    cost: { peak: 0, valley: 0 },
    byModel: new Map(),
    scanned: false,
    cursor: 0
  }
}
function buildSample(context, time, usage) {
  const t = usage || {}
  const inMiss = Number(t.inputTokens) || 0
  const inHit = Number(t.cacheReadTokens) || 0
  const out = Number(t.outputTokens) || 0
  const reasoning = Number(t.reasoningTokens) || 0
  const model = context ? context.model : null
  const phase = classifyAt(time)
  const priced = phase !== 'unpriced' && model !== null && OFFICIAL[model] !== undefined
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
  } else {
    acc.calls.unpriced += k
  }
}
function foldEvent(acc, ev) {
  if (ev.type === 'request/context') {
    const d = ev.data || {}
    acc.context = { provider: d.provider, model: d.model }
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
  const s = buildSample(acc.context, ev.time, usage)
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
function scanSession(session) {
  if (!session) return
  const acc = accountOf(session)
  if (acc.scanned) return
  const events = session.events || []
  for (let i = acc.cursor; i < events.length; i++) foldEvent(acc, events[i])
  acc.cursor = events.length
  acc.scanned = true
}

/* ===== 会话树与汇总 ===== */
function liveSessions(ctx) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return []
  return sessions.list ? sessions.list() : []
}
function defaultRootId(ctx) {
  const agents = ctx.get('agents')
  if (agents !== undefined && typeof agents.roots === 'function') {
    const roots = agents.roots()
    let best = null, bestT = -1
    for (const a of roots) {
      const s = a && a.session
      if (!s) continue
      const ev = s.events && s.events.length ? s.events[s.events.length - 1] : null
      const t = ev && ev.time !== undefined ? ev.time : (s.header ? s.header.createdAt : 0)
      if (t >= bestT) { best = s; bestT = t }
    }
    if (best) return String(best.id)
  }
  const all = liveSessions(ctx)
  let best = null, bestT = -1
  for (const s of all) {
    if (!s || !s.header) continue
    const ev = s.events && s.events.length ? s.events[s.events.length - 1] : null
    const t = ev && ev.time !== undefined ? ev.time : s.header.createdAt
    if (t >= bestT) { best = s; bestT = t }
  }
  return best ? String(best.id) : null
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

/** 折叠一个持久化会话（子代理或冷根）的日志；按（id, 事件数）缓存，变化时重折。 */
async function persistedAccount(ctx, id) {
  const sp = ctx.get('sessionPersistence')
  if (sp === undefined || typeof sp.readFrom !== 'function') return null
  let events = []
  let len = 0
  try {
    const res = await sp.readFrom(id, 0)
    events = (res && res.events) || []
    len = events.length
  } catch (err) {
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

async function aggregate(ctx, rootId) {
  const out = { tokens: { inMiss: 0, inHit: 0, out: 0, reasoning: 0 }, calls: { priced: 0, unpriced: 0, nonDeep: 0 }, cost: { peak: 0, valley: 0 }, byModel: new Map(), sessions: [] }
  /* 根：live store（增量快）；冷会话（已从内存卸载的历史会话）回退到持久化日志（同子代理路径） */
  let rootLive = null
  for (const s of liveSessions(ctx)) {
    if (s && s.header && String(s.id) === String(rootId)) { rootLive = s; break }
  }
  if (rootLive !== null) {
    const acc = accountOf(rootLive)
    scanSession(rootLive)
    mergeAccount(out, acc, String(rootLive.id))
  } else {
    const acc = await persistedAccount(ctx, rootId)
    if (acc !== null) mergeAccount(out, acc, String(rootId))
  }
  /* 子代理：持久化日志（含已结束会话） */
  const children = await persistedChildren(ctx, rootId)
  for (const cid of children) {
    const acc = await persistedAccount(ctx, cid)
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

  /** 汇总：状态 + 窗口 token/费用（sessionId 缺省取最近活动的根会话）。
   *  子代理经持久化日志聚合（v0.1.9），含已结束会话。 */
  async summary(input) {
    const a = input || {}
    const rootId = typeof a.sessionId === 'string' && a.sessionId !== '' ? a.sessionId : defaultRootId(this.ctx)
    const agg = rootId === null ? null : await aggregate(this.ctx, rootId)
    const now = Date.now()
    const st = statusAt(now)
    let period = null
    if (agg && st.endsAt !== null) {
      let total = 0
      const accOf = function (sid) {
        const live = accounts.get(sid)
        if (live !== undefined) return live
        const child = childAccounts.get(sid)
        return child !== undefined ? child.acc : null
      }
      for (const sid of agg.sessions) {
        const acc = accOf(sid)
        if (acc === null) continue
        for (const sm of acc.byStep.values()) {
          if (sm.time >= st.endsAt && sm.kind === 'priced') total += sm.cost.total
        }
      }
      period = total
    }
    const byModel = []
    if (agg) {
      for (const [model, m] of agg.byModel) {
        byModel.push({ model, label: LABELS[model] || model, inMiss: m.inMiss, inHit: m.inHit, out: m.out, peakCalls: m.peakCalls, valleyCalls: m.valleyCalls, peakCny: m.peakCny, valleyCny: m.valleyCny, cny: m.peakCny + m.valleyCny })
      }
      byModel.sort((x, y) => y.cny - x.cny)
    }
    return {
      status: st,
      sessionId: rootId,
      sessions: agg ? agg.sessions : [],
      childCount: agg ? agg.childCount : 0,
      tokens: agg ? agg.tokens : { inMiss: 0, inHit: 0, out: 0, reasoning: 0 },
      calls: agg ? agg.calls : { priced: 0, unpriced: 0, nonDeep: 0 },
      cost: { totalCny: agg ? agg.cost.peak + agg.cost.valley : 0, peakCny: agg ? agg.cost.peak : 0, valleyCny: agg ? agg.cost.valley : 0, periodCny: period },
      byModel,
      meta: { priceSource: 'official-2026-09-03', fxRate, fxSource, updatedAt: now }
    }
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

  // 实时增量：只折叠已建档的会话（其余懒扫描）
  ctx.on('session/event', (session, event) => {
    const acc = accounts.get(String(session.id))
    if (acc !== undefined) foldEvent(acc, event)
  })

  // 汇率刷新：启动即试一次，之后每 6 小时
  refreshFx().catch(() => {})
  const fxTimer = setInterval(() => { refreshFx().catch(() => {}) }, 6 * 3600 * 1000)
  ctx.effect(() => () => { clearInterval(fxTimer) })
}
