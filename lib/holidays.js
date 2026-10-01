// dsh-deepseek-billing — 法定节假日日历（宿主半区专有，客户端不 import）
//
// 用途：官方峰谷规则里「北京时间周一至周五 9:00-12:00、14:00-18:00 为高峰，
// 其余时段（含法定节假日全天）为谷时」。所以只要判断「这一天是不是放假日」，
// 是则全天谷时。
//
// 数据来源（唯一权威）：国务院办公厅关于 2026 年部分节假日安排的通知
// （国办发明电〔2025〕7 号，2025-11-04）。只登记**放假的日期**；调休上班的
// 周末按本插件的既定取舍不做特殊处理（仍按周末=谷时计），这一偏差在面板上
// 与 README 里都如实标注。
//
// ICU 的角色：Intl 的农历（zh-CN-u-ca-chinese）可以算出春节/端午/中秋的基准
// 日，用来 (a) 校验表里写歪的年份、(b) 下一年据以快速拟草表。放假**区间**
// 是行政决定，任何时候都必须来自通知原文，不能从农历推导。

export const HOUR = 3600000
export const DAY = 24 * HOUR
export const BJ = 8 * HOUR

/** 北京时间的「第几天」序号（固定 +8，无 DST），用于与日期区间做整数比较。 */
function dayIndex(ms) {
  return Math.floor((ms + BJ) / DAY)
}
function isoDay(iso) {
  return dayIndex(Date.parse(iso + 'T00:00:00+08:00'))
}
function range(fromIso, toIso) {
  return [isoDay(fromIso), isoDay(toIso)]
}

/* 按年登记的放假区间（含首尾）。加了新年份时同时补 `HOLIDAY_SOURCES`。 */
const HOLIDAY_RANGES = {
  2026: [
    range('2026-01-01', '2026-01-03'), // 元旦
    range('2026-02-15', '2026-02-23'), // 春节（腊月二十八至正月初七）
    range('2026-04-04', '2026-04-06'), // 清明
    range('2026-05-01', '2026-05-05'), // 劳动节
    range('2026-06-19', '2026-06-21'), // 端午
    range('2026-09-25', '2026-09-27'), // 中秋
    range('2026-10-01', '2026-10-07')  // 国庆
  ]
}

export const HOLIDAY_SOURCES = {
  2026: '国办发明电〔2025〕7号（2025-11-04）'
}

/** 已内置放假安排的年份，升序。 */
export const CALIBRATED_YEARS = Object.keys(HOLIDAY_RANGES).map(Number).sort((a, b) => a - b)

/** 该时刻所处年份是否已内置放假安排。 */
export function isCalibratedYear(year) {
  return Object.prototype.hasOwnProperty.call(HOLIDAY_RANGES, year)
}

/** 北京时间下的年份（用于选表）。 */
export function bjYear(ms) {
  return new Date(ms + BJ).getUTCFullYear()
}

/**
 * 该时刻（UTC ms）是否落在已登记的放假区间内。
 * 未登记放假安排的年份一律返回 false（退回「只有周末是谷时」的旧行为）。
 */
export function isHoliday(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return false
  const year = bjYear(ms)
  const ranges = HOLIDAY_RANGES[year]
  if (ranges === undefined) return false
  const d = dayIndex(ms)
  for (let i = 0; i < ranges.length; i += 1) {
    if (d >= ranges[i][0] && d <= ranges[i][1]) return true
  }
  return false
}

/* ===== ICU 农历（自检与下一年拟草表用，不参与计价判定） ===== */

let lunarFormat = null
function lunarFormatter() {
  if (lunarFormat === null) {
    lunarFormat = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      timeZone: 'Asia/Shanghai',
      month: 'numeric',
      day: 'numeric'
    })
  }
  return lunarFormat
}

/** 返回该时刻的农历 { month, day }；ICU 不可用时返回 null。 */
export function lunarParts(ms) {
  try {
    const parts = lunarFormatter().formatToParts(new Date(ms))
    let month = null
    let day = null
    for (const p of parts) {
      if (p.type === 'month') month = Number(p.value)
      else if (p.type === 'day') day = Number(p.value)
    }
    if (!Number.isInteger(month) || !Number.isInteger(day)) return null
    return { month, day }
  } catch (err) {
    return null
  }
}

/**
 * 用农历推导某年的三个农历节日（春节初一 / 端午初五 / 中秋十五）的日期。
 * 返回 { springFestival, dragonBoat, midAutumn }（'YYYY-MM-DD'，取不到为 null）。
 * 仅用于校验登记表与拟下一年草表；放假区间仍以通知原文为准。
 */
export function deriveHolidaySeeds(year) {
  const out = { springFestival: null, dragonBoat: null, midAutumn: null }
  const start = Date.UTC(year, 0, 1) - BJ
  const end = Date.UTC(year + 1, 0, 1) - BJ
  for (let ms = start; ms < end; ms += DAY) {
    const lp = lunarParts(ms)
    if (lp === null) return out
    const iso = new Date(ms + BJ).toISOString().slice(0, 10)
    if (lp.month === 1 && lp.day === 1 && out.springFestival === null) out.springFestival = iso
    else if (lp.month === 5 && lp.day === 5 && out.dragonBoat === null) out.dragonBoat = iso
    else if (lp.month === 8 && lp.day === 15 && out.midAutumn === null) out.midAutumn = iso
  }
  return out
}

/**
 * 自检：把 ICU 推导出的农历节日与登记表对照，返回人可读的诊断数组。
 * 空数组 = 一致（或该年未登记 / ICU 不可用）。
 */
export function validateHolidays(year) {
  const problems = []
  const ranges = HOLIDAY_RANGES[year]
  if (ranges === undefined) return problems
  const seeds = deriveHolidaySeeds(year)
  const checks = [
    ['春节初一', seeds.springFestival],
    ['端午', seeds.dragonBoat],
    ['中秋', seeds.midAutumn]
  ]
  for (const [name, iso] of checks) {
    if (iso === null) continue
    const d = isoDay(iso)
    let hit = false
    for (const r of ranges) if (d >= r[0] && d <= r[1]) { hit = true; break }
    if (!hit) problems.push('农历' + name + '（' + iso + '）不在已登记的放假区间内')
  }
  return problems
}
