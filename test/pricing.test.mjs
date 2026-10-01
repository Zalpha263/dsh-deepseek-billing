// dsh-deepseek-billing — 计价核心单测（零依赖，node:test）
//
// 覆盖 v0.4.0 引入的四件事：官方渠道闸门、模型族解析、价表纪元、峰谷与节假日判时。
// 运行：npm test（= node test/pricing.test.mjs）

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OFFICIAL_PROVIDERS,
  isOfficialProvider,
  providerGate,
  familyFor,
  resolveFamily,
  inferFamily,
  labelFor,
  PRICE_EPOCHS,
  epochAt,
  priceAt,
  baseRow,
  classifyAt,
  nextBoundary,
  weekendAllValley,
  PEAK_MULTIPLIER,
  PEAK_FROM,
  rowFor,
  priceRow,
  overrideRecordFor
} from '../lib/pricing.js'
import {
  isHoliday,
  bjYear,
  CALIBRATED_YEARS,
  deriveHolidaySeeds,
  validateHolidays
} from '../lib/holidays.js'

/** 北京时间字面量 → UTC ms。 */
const bj = (s) => Date.parse(s + '+08:00')

test('官方渠道闸门：只放行两条官方 provider 路由', () => {
  assert.deepEqual(OFFICIAL_PROVIDERS, ['deepseek-official', 'deepseek-account'])
  assert.equal(providerGate('deepseek-official'), 'official')
  assert.equal(providerGate('deepseek-account'), 'official')
  assert.equal(providerGate('my-openai-proxy'), 'non-official')
  assert.equal(providerGate(''), 'unknown')
  assert.equal(providerGate(null), 'unknown')
  assert.equal(isOfficialProvider('deepseek-official'), true)
  assert.equal(isOfficialProvider('deepseek-official-clone'), false)
})

test('模型族：前缀与别名命中，且前缀按最长优先', () => {
  assert.equal(resolveFamily('deepseek-flash').key, 'flash')
  assert.equal(resolveFamily('deepseek-v4-flash').key, 'flash')
  assert.equal(resolveFamily('deepseek-v4.1-flash').key, 'flash')
  assert.equal(resolveFamily('deepseek-v4-pro').key, 'pro')
  assert.equal(resolveFamily('deepseek-reasoner').key, 'pro')
  assert.equal(resolveFamily('deepseek-chat').key, 'flash')
  assert.equal(resolveFamily('gpt-5'), null)
  /* 变体名带出后缀，便于在面板区分具体模型。 */
  assert.equal(labelFor('deepseek-flash-preview'), 'Flash · preview')
})

test('关键字推断只在允许时生效（外部同名模型不得套用官方价）', () => {
  assert.equal(inferFamily('deepseek-next-flash-2027').key, 'flash')
  assert.equal(inferFamily('some-vendor-pro-max').key, 'pro')
  assert.equal(inferFamily('qwen-3'), null)
  /* allowInfer=false 时，连猜测都不做 */
  assert.equal(familyFor('qwen-3', false), null)
  assert.equal(familyFor('deepseek-next-flash-2027', true).how, 'inferred')
})

test('价表纪元：2026-09-10 12:00（北京时间）前后各用各的价', () => {
  const beforeNoon = bj('2026-09-10T11:59:00')
  const afterNoon = bj('2026-09-10T12:00:00')
  assert.deepEqual(priceAt('flash', beforeNoon), { cacheHitIn: 0.05, missIn: 1.5, out: 4.5 })
  assert.deepEqual(priceAt('flash', afterNoon), { cacheHitIn: 0.02, missIn: 1.0, out: 4.0 })
  /* Pro 两代未变，避免「改价连坐」。 */
  assert.deepEqual(priceAt('pro', beforeNoon), { cacheHitIn: 0.15, missIn: 4.5, out: 13.5 })
  assert.deepEqual(priceAt('pro', afterNoon), { cacheHitIn: 0.15, missIn: 4.5, out: 13.5 })
  assert.equal(PRICE_EPOCHS.length, 2)
  assert.equal(epochAt(beforeNoon).source.indexOf('snapshot') >= 0, true)
  assert.equal(epochAt(afterNoon).source.indexOf('news260910') >= 0, true)
  assert.equal(PRICE_EPOCHS.length, 2)
})

test('价表纪元：峰谷机制生效前无价，未知族无价，绝不跨纪元借价', () => {
  assert.equal(priceAt('flash', PEAK_FROM - 1000), null)
  assert.equal(epochAt(PEAK_FROM - 1000), null)
  assert.equal(priceAt('flash', PEAK_FROM), PRICE_EPOCHS[0].prices.flash)
  assert.equal(priceAt('unknown-family', bj('2026-09-20T10:00:00')), null)
  assert.equal(baseRow('unknown-family', bj('2026-09-20T10:00:00')), null)
})

test('峰值价 = 谷时价 × 2（官方口径：空闲价为高峰价的一半）', () => {
  const row = baseRow('flash', bj('2026-09-20T10:00:00'))
  assert.equal(PEAK_MULTIPLIER, 2)
  assert.equal(row.cacheHitIn.peak, row.cacheHitIn.valley * 2)
  assert.equal(row.missIn.peak, row.missIn.valley * 2)
  assert.equal(row.out.peak, row.out.valley * 2)
  assert.equal(row.cacheHitIn.ok, true)
})

test('时段判定：北京时间工作日的两个峰窗、午休与夜间为谷时', () => {
  /* 2026-09-11 是周五。 */
  assert.equal(classifyAt(bj('2026-09-11T09:00:00')), 'peak')
  assert.equal(classifyAt(bj('2026-09-11T11:59:00')), 'peak')
  assert.equal(classifyAt(bj('2026-09-11T12:00:00')), 'valley')
  assert.equal(classifyAt(bj('2026-09-11T14:00:00')), 'peak')
  assert.equal(classifyAt(bj('2026-09-11T18:00:00')), 'valley')
  assert.equal(classifyAt(bj('2026-09-11T03:00:00')), 'valley')
})

test('时段判定：周末全天谷时；峰谷机制生效前为 unpriced', () => {
  /* 2026-09-12 是周六。 */
  assert.equal(classifyAt(bj('2026-09-12T10:00:00')), 'valley')
  assert.equal(weekendAllValley(bj('2026-09-12T10:00:00')), true)
  assert.equal(weekendAllValley(bj('2026-09-11T10:00:00')), false)
  assert.equal(classifyAt(PEAK_FROM - 1000), 'unpriced')
})

test('法定节假日全天谷时（只认放假日，调休不处理）', () => {
  /* 2026 国庆 10-01~10-07；10-01 是周四。 */
  assert.equal(classifyAt(bj('2026-10-01T10:00:00')), 'valley')
  assert.equal(classifyAt(bj('2026-10-07T15:00:00')), 'valley')
  assert.equal(classifyAt(bj('2026-10-08T10:00:00')), 'peak')
  /* 春节 02-15~02-23 */
  assert.equal(isHoliday(bj('2026-02-16T10:00:00')), true)
  assert.equal(isHoliday(bj('2026-02-24T10:00:00')), false)
  assert.equal(bjYear(bj('2026-02-16T00:30:00')), 2026)
  assert.deepEqual(CALIBRATED_YEARS, [2026])
})

test('节假日表与 ICU 农历交叉自检一致', () => {
  const seeds = deriveHolidaySeeds(2026)
  assert.equal(seeds.springFestival, '2026-02-17')
  assert.equal(seeds.dragonBoat, '2026-06-19')
  assert.equal(seeds.midAutumn, '2026-09-25')
  assert.deepEqual(validateHolidays(2026), [])
  /* 未内置年份：不判节假日、也不报错（退回「只有周末是谷时」）。 */
  assert.deepEqual(validateHolidays(2030), [])
  assert.equal(isHoliday(bj('2030-10-01T10:00:00')), false)
})

test('下一次换档时刻：11:59 的下一次是 12:00（北京）', () => {
  const t = nextBoundary(bj('2026-09-11T11:59:00'))
  assert.equal(new Date(t + 8 * 3600000).toISOString().slice(11, 16), '12:00')
  assert.equal(nextBoundary(bj('2026-09-11T17:59:00')) !== null, true)
})

test('手动覆盖：official 模式逐字段叠加在纪元价之上', () => {
  const t = bj('2026-09-20T10:00:00') // 峰谷生效后、降价之后
  const overrides = { flash: { valleyMissIn: 9 } }
  const row = rowFor('deepseek-flash', t, overrides, 'official')
  assert.equal(row.missIn.valley, 9)                 // 手动值生效
  assert.equal(row.missIn.peak, 18)                  // 峰值缺省 = 谷时 × 2
  assert.equal(row.cacheHitIn.valley, 0.02)          // 未覆盖字段回落纪元价
  assert.equal(row.out.valley, 4)
  assert.equal(priceRow(row, 'valley', 'official').kind, 'priced')
})

test('手动覆盖：峰值可单独覆盖，不再被 ×2 推断覆盖掉', () => {
  const t = bj('2026-09-20T10:00:00')
  const row = rowFor('deepseek-flash', t, { flash: { valleyMissIn: 9, peakMissIn: 12 } }, 'official')
  assert.equal(row.missIn.valley, 9)
  assert.equal(row.missIn.peak, 12)
})

test('手动覆盖按族键查找：别名写法也能读到同一份覆盖', () => {
  const t = bj('2026-09-20T10:00:00')
  const overrides = { flash: { valleyOut: 7 } }
  assert.equal(overrideRecordFor('deepseek-flash', overrides).valleyOut, 7)
  assert.equal(rowFor('deepseek-chat', t, overrides, 'official').out.valley, 7)
  /* 模型 id 级覆盖优先于族键 */
  const both = { flash: { valleyOut: 7 }, 'deepseek-flash': { valleyOut: 3 } }
  assert.equal(rowFor('deepseek-flash', t, both, 'official').out.valley, 3)
})

test('只用手动价模式：六值不全即不计价（manual-incomplete），齐全才算得出来', () => {
  const t = bj('2026-09-20T10:00:00')
  const partial = rowFor('deepseek-flash', t, { flash: { valleyMissIn: 1 } }, 'manual')
  assert.equal(partial.cacheHitIn.ok, false)
  const verdict = priceRow(partial, 'valley', 'manual')
  assert.equal(verdict.kind, 'recognized')
  assert.equal(verdict.reason, 'manual-incomplete')

  const full = {
    flash: {
      valleyCacheHitIn: 0.02, valleyMissIn: 1, valleyOut: 4,
      peakCacheHitIn: 0.04, peakMissIn: 2, peakOut: 8
    }
  }
  const complete = rowFor('deepseek-flash', t, full, 'manual')
  const ok = priceRow(complete, 'peak', 'manual')
  assert.equal(ok.kind, 'priced')
  assert.equal(ok.hit, 0.04)
  assert.equal(ok.miss, 2)
  assert.equal(ok.out, 8)
})

test('只用手动价模式不会给没有覆盖记录的族凭空造出价', () => {
  const t = bj('2026-09-20T10:00:00')
  const row = rowFor('deepseek-flash', t, {}, 'manual')
  assert.equal(priceRow(row, 'valley', 'manual').kind, 'recognized')
  assert.equal(priceRow(row, 'valley', 'manual').reason, 'manual-incomplete')
})

test('未知模型名：无族无覆盖 → unknown-family', () => {
  assert.equal(rowFor('gpt-5', bj('2026-09-20T10:00:00'), {}, 'official'), null)
  assert.equal(priceRow(null, 'valley', 'official').kind, 'unknown')
})
