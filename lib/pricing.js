// dsh-deepseek-billing — 计价核心（纯函数；宿主半区专有，客户端不 import）
//
// 这里集中三件事，让 lib/index.js 只负责账户折叠与 Remote 服务：
//   1. 模型名 → 价族（前缀表 + 别名 + 官方渠道下的关键字推断）
//   2. 事件时刻 → 价表纪元（不同时段用不同价表，改价不追溯重算旧时段）
//   3. 时刻 → 峰 / 谷 / 未定价（周末、法定节假日、北京时间的峰窗）
//
// 抽成独立文件是为了可单测（test/pricing.test.mjs），并且只有一份价表真源。

import { isHoliday } from './holidays.js'

export const HOUR = 3600000
/** 北京时间固定偏移（UTC+8，无夏令时）。 */
export const BJ = 8 * HOUR
/** 峰谷定价生效时刻：2026-08-17 00:00 北京时间。更早的记录记为 unpriced。 */
export const PEAK_FROM = Date.UTC(2026, 7, 16, 16, 0, 0)
/** 2026-08-23 00:00（北京）起周末全天谷时。 */
export const WEEKEND_FROM = Date.UTC(2026, 7, 22, 16, 0, 0)
/** 高峰时段（北京时间，分钟）：09:00-12:00、14:00-18:00。 */
export const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]
/** 官方高峰系数：空闲价 = 高峰价的一半，故 峰值 = 谷时 × 2（可由手动覆盖改写）。 */
export const PEAK_MULTIPLIER = 2

/**
 * 认作「官方渠道」的 provider 路由。DSH 里官方有两条：
 *   deepseek-official —— API key 路线（dsh-llm-deepseek-api-key）
 *   deepseek-account  —— 平台账号登录路线（dsh-llm-deepseek-account）
 * 其它 provider（外部接入 / 自建 OpenAI 兼容端点）一律不参与计价。
 */
export const OFFICIAL_PROVIDERS = ['deepseek-official', 'deepseek-account']

export function isOfficialProvider(provider) {
  return typeof provider === 'string' && OFFICIAL_PROVIDERS.indexOf(provider) >= 0
}

/**
 * 计价前的渠道闸门：'official' 可计价；'non-official' 是外部接入（可见但不计价）；
 * 'unknown' 表示这条记录取不到 provider（旧日志/异常），同样不计价但要单独交代。
 */
export function providerGate(provider) {
  if (typeof provider !== 'string' || provider === '') return 'unknown'
  return isOfficialProvider(provider) ? 'official' : 'non-official'
}

/* ===== 价族：模型名 → 族键；价格只在纪元里出现一次 ===== */

export const FAMILIES = [
  {
    key: 'flash',
    label: 'Flash',
    /* 前缀匹配，顺序敏感：先长后短，避免短前缀吃掉长前缀。 */
    prefixes: ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-flash'],
    aliases: ['deepseek-chat', 'deepseek-v4-flash-latest', 'deepseek-flash-latest']
  },
  {
    key: 'pro',
    label: 'Pro',
    prefixes: ['deepseek-v4-pro'],
    aliases: ['deepseek-pro', 'deepseek-reasoner']
  }
]

export function familyByKey(key) {
  for (const f of FAMILIES) if (f.key === key) return f
  return null
}

export function labelForFamily(key) {
  const f = familyByKey(key)
  return f === null ? String(key) : f.label
}

/**
 * 前缀 / 别名匹配。返回 { key, label, how, pattern }，认不出返回 null。
 * how: 'prefix' 命中前缀；'alias' 命中显式别名。
 */
export function resolveFamily(model) {
  if (typeof model !== 'string' || model === '') return null
  const m = model.toLowerCase()
  for (const f of FAMILIES) {
    for (const p of f.prefixes) {
      if (m.startsWith(p)) return { key: f.key, label: f.label, how: 'prefix', pattern: p }
    }
  }
  for (const f of FAMILIES) {
    if (f.aliases.indexOf(m) >= 0) return { key: f.key, label: f.label, how: 'alias', pattern: null }
  }
  return null
}

/**
 * 关键字推断：官方目录里出现的新名字（如 deepseek-flash-2027）自动落到已知族。
 * 只在调用方确认「该模型由官方渠道广告」后才允许使用，避免给外部同名模型套价。
 */
export function inferFamily(model) {
  if (typeof model !== 'string' || model === '') return null
  const m = model.toLowerCase()
  if (m.indexOf('flash') >= 0) return { key: 'flash', label: 'Flash', how: 'inferred', pattern: null }
  if (m.indexOf('pro') >= 0) return { key: 'pro', label: 'Pro', how: 'inferred', pattern: null }
  return null
}

/** 统一入口：先精确匹配，allowInfer 为真时再按关键字推断。 */
export function familyFor(model, allowInfer) {
  const exact = resolveFamily(model)
  if (exact !== null) return exact
  return allowInfer === true ? inferFamily(model) : null
}

/** 展示标签：族名 + 前缀之后的变体后缀（别名/推断命中时只给族名）。 */
export function labelFor(model) {
  if (typeof model !== 'string' || model === '') return String(model)
  const hit = resolveFamily(model)
  if (hit === null) return model
  if (hit.pattern === null) return hit.label
  const suffix = model.slice(hit.pattern.length).replace(/^[-_.]/, '')
  return suffix === '' ? hit.label : hit.label + ' · ' + suffix
}

/* ===== 价表纪元 =====
   每个纪元 = 一段生效区间 + 该区间内各族的谷时价（元 / 每 1M tokens）。
   计费用**事件自身的时刻**查表，因此改价只影响改价之后的流量。

   出处：
     纪元一 —— 本插件 2026-09-03 的官方价格页快照（git fa721d6 起 PRICE_AS_OF）。
     纪元二 —— 官方新闻《DeepSeek V4.1 Flash》news260910：
               「新价格于 2026 年 9 月 10 日 12:00 开始生效」，Flash 下调为 0.02/1/4。 */

export const PRICE_EPOCHS = [
  {
    from: PEAK_FROM,
    source: 'snapshot 2026-09-03',
    prices: {
      flash: { cacheHitIn: 0.05, missIn: 1.5, out: 4.5 },
      pro: { cacheHitIn: 0.15, missIn: 4.5, out: 13.5 }
    }
  },
  {
    from: Date.UTC(2026, 8, 10, 4, 0, 0), // 2026-09-10 12:00 北京时间
    source: '官方 news260910（2026-09-10 12:00 +08:00 生效）',
    prices: {
      flash: { cacheHitIn: 0.02, missIn: 1.0, out: 4.0 },
      pro: { cacheHitIn: 0.15, missIn: 4.5, out: 13.5 }
    }
  }
]

/** 该时刻生效的纪元；早于第一个纪元返回 null。 */
export function epochAt(time) {
  let hit = null
  for (const e of PRICE_EPOCHS) if (e.from <= time) hit = e
  return hit
}

/** 该时刻该族的谷时价 { cacheHitIn, missIn, out }；纪元或族缺失返回 null。 */
export function priceAt(familyKey, time) {
  const e = epochAt(time)
  if (e === null) return null
  const p = e.prices[familyKey]
  return p === undefined ? null : p
}

/** 该时刻该族的三档价（含峰值 = 谷时 × PEAK_MULTIPLIER）。缺价返回 null。 */
export function baseRow(familyKey, time) {
  const p = priceAt(familyKey, time)
  if (p === null) return null
  const mk = (v) => ({ valley: v, peak: v * PEAK_MULTIPLIER, ok: Number.isFinite(v) })
  return { cacheHitIn: mk(p.cacheHitIn), missIn: mk(p.missIn), out: mk(p.out) }
}

/* ===== 手动覆盖 × 纪元：一行三档价的组装与判定 ===== */

const FIELD_NAME = {
  cacheHitIn: { valley: 'valleyCacheHitIn', peak: 'peakCacheHitIn' },
  missIn: { valley: 'valleyMissIn', peak: 'peakMissIn' },
  out: { valley: 'valleyOut', peak: 'peakOut' }
}

/** 覆盖记录查找：模型 id 优先，其次族键（表单按族写盘，真实调用可能是别名）。 */
export function overrideRecordFor(model, overrides) {
  if (overrides === undefined || overrides === null) return undefined
  const direct = overrides[model]
  if (direct !== undefined) return direct
  const hit = resolveFamily(model)
  return hit === null ? undefined : overrides[hit.key]
}

/**
 * 组装一行价：三档各带 { valley, peak, ok }，外加命中的族与纪元基础价。
 *   mode='official' —— 手动覆盖逐字段优先，未填字段回落该时刻的纪元价；
 *   mode='manual'   —— 只认手动覆盖，六值不全即 ok=false（面板点名，绝不按 0 静默计）。
 * 认不出族且没有覆盖记录时返回 null（调用方记 unknown）。
 */
export function rowFor(model, time, overrides, mode) {
  const hit = familyFor(model, true)
  const ov = overrideRecordFor(model, overrides)
  if (hit === null && ov === undefined) return null
  const base = hit === null ? null : baseRow(hit.key, time)
  const manualOnly = mode === 'manual'
  const at = (tier, phase) => {
    if (ov === undefined || ov === null) return undefined
    const raw = ov[FIELD_NAME[tier][phase]]
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }
  const mk = (tier) => {
    const mv = at(tier, 'valley')
    const mp = at(tier, 'peak')
    if (manualOnly) {
      const ok = mv !== undefined && mp !== undefined
      return { valley: ok ? mv : 0, peak: ok ? mp : 0, ok: ok }
    }
    let valley = mv
    let peak = mp
    if (valley === undefined && base !== null) valley = base[tier].valley
    if (peak === undefined && valley !== undefined) peak = valley * PEAK_MULTIPLIER
    const ok = Number.isFinite(valley) && Number.isFinite(peak)
    return { valley: ok ? valley : 0, peak: ok ? peak : 0, ok: ok }
  }
  return { cacheHitIn: mk('cacheHitIn'), missIn: mk('missIn'), out: mk('out'), family: hit, base: base }
}

/** 把一行价判定成 priced / recognized / unknown（reason 供面板点名）。 */
export function priceRow(row, phase, mode) {
  if (row === null) return { kind: 'unknown', reason: 'unknown-family' }
  const i = phase === 'peak' ? 'peak' : 'valley'
  const hit = row.cacheHitIn[i]
  const miss = row.missIn[i]
  const out = row.out[i]
  if (row.cacheHitIn.ok && row.missIn.ok && row.out.ok) return { kind: 'priced', hit: hit, miss: miss, out: out }
  let reason = 'no-base-price'
  if (mode === 'manual') reason = 'manual-incomplete'
  else if (row.base === null) reason = 'no-price-in-epoch'
  return { kind: 'recognized', hit: hit, miss: miss, out: out, reason: reason }
}

/* ===== 时段判定 ===== */

/** 北京时间的星期与当天分钟数。 */
export function bjParts(ms) {
  const s = new Date(ms + BJ)
  return { weekday: s.getUTCDay(), minutes: s.getUTCHours() * 60 + s.getUTCMinutes() }
}

export function inPeakWindow(minutes) {
  for (const [a, b] of PEAK_WINDOWS) if (minutes >= a && minutes < b) return true
  return false
}

/**
 * 返回 'peak' | 'valley' | 'unpriced'。
 * 顺序：峰谷机制生效前 → unpriced；放假日 → 全天 valley（调休不处理）；
 * 周末（自 WEEKEND_FROM 起）→ valley；否则按北京时间的峰窗判 peak。
 */
export function classifyAt(ms) {
  if (ms < PEAK_FROM) return 'unpriced'
  if (isHoliday(ms)) return 'valley'
  const { weekday, minutes } = bjParts(ms)
  if ((weekday === 0 || weekday === 6) && ms >= WEEKEND_FROM) return 'valley'
  return inPeakWindow(minutes) ? 'peak' : 'valley'
}

function floorBjDay(ms) {
  const shifted = ms + BJ
  return (shifted - (shifted % (24 * HOUR))) - BJ
}

/** 下一次时段切换的时刻（面板倒计时用）；找不到返回 null。 */
export function nextBoundary(ms) {
  const start = floorBjDay(ms)
  for (let off = -1; off <= 8; off += 1) {
    for (const h of [0, 9, 12, 14, 18, 24]) {
      const t = start + off * 24 * HOUR + h * HOUR
      if (t <= ms) continue
      if (classifyAt(t) !== classifyAt(t - 1000)) return t
    }
  }
  return null
}

/** 该时刻是否处于「周末全天谷时」区间（面板用来解释当前时段）。 */
export function weekendAllValley(ms) {
  if (ms < WEEKEND_FROM) return false
  const { weekday } = bjParts(ms)
  return weekday === 0 || weekday === 6
}

/** 该时刻的北京日期是否在已登记的放假日里。 */
export function isHolidayDate(ms) {
  return isHoliday(ms)
}
