// dsh-deepseek-billing — 客户端半区冒烟测试（零依赖，node:test）
//
// 为什么需要它：客户端是手写的 `__ModuleLoader__` bundle，语法检查（node --check）
// 只能证明「能解析」，证明不了「能挂载」。2026-09-30 就发生过一次：一次脚本化改写
// 误删了 renderData 与 buildSkeleton 尾部，语法仍然通过，但面板一片空白。
// 本文件用一个最小 DOM/React 桩把真实 bundle 跑起来，覆盖三条最容易断的路径：
//   ① bundle 注册与导出（id / inject / apply）
//   ② apply(ctx)：remote 贡献的 5 个描述符
//   ③ React 正文组件 → mountPanel → renderData（带载荷）→ renderForm（展开表单）
//
// 运行：npm test（= node test/pricing.test.mjs && node test/client-smoke.test.mjs）

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

/* ---------- 最小 DOM / React / ModuleLoader 桩 ---------- */
function makeEl(tag) {
  return {
    tagName: tag, children: [], style: {}, className: '', textContent: '', title: '', value: '', dataset: {}, handlers: {},
    appendChild(c) { this.children.push(c); return c },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1) },
    setAttribute(k, v) { this[k] = v },
    getAttribute(k) { return this[k] },
    addEventListener(k, fn) { (this.handlers[k] = this.handlers[k] || []).push(fn) },
    removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    contains() { return false },
    closest() { return null },
    replaceChildren() { this.children = [] },
    get firstElementChild() { return this.children[0] || null },
    get offsetWidth() { return 400 }
  }
}
const walk = (el, out = []) => { out.push(el); for (const c of el.children || []) if (c && c.children) walk(c, out); return out }

/** 载入 bundle：先执行顶层（注册 entry），再调用 factory 取导出。 */
function loadBundle() {
  let entry = null
  const win = {
    __ModuleLoader__: { load: (e) => { entry = e } },
    addEventListener() {}, removeEventListener() {},
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    innerWidth: 1200, innerHeight: 800,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  }
  const document = { createElement: makeEl, head: makeEl('head'), body: makeEl('body'), querySelector: () => null, addEventListener() {} }
  const hooks = { effect: null, ref: null }
  const React = {
    createElement: () => ({}),
    useState: (v) => [v, () => {}],
    useRef: () => (hooks.ref = { current: null }),
    useEffect: (fn) => { hooks.effect = fn }
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'React', SOURCE)(win, document, React)
  assert.ok(entry !== null, 'bundle 未调用 __ModuleLoader__.load')
  const exported = entry.factory((name) => (name === 'react' ? React : {}))
  return { entry, exported, hooks }
}

/* ---------- 与宿主契约一致的假 summary 载荷 ---------- */
const SUMMARY = {
  status: { phase: 'peak', endsAt: Date.now() + 3600000, weekendAllValley: false, holiday: false },
  sessionId: 'session-00000000-0000-0000-0000-000000000abc', childCount: 1,
  tokens: {
    inMiss: 1000, inHit: 5000, out: 300, reasoning: 100,
    main: { inMiss: 400, inHit: 2000, out: 100, reasoning: 40 },
    children: { inMiss: 600, inHit: 3000, out: 200, reasoning: 60 }
  },
  calls: { priced: 3, unpriced: 1, nonDeep: 2, recognized: 1, nonOfficial: 4, providerUnknown: 1 },
  recognizedModels: [{ model: 'deepseek-v9-flash', label: 'Flash · v9', count: 1, reason: 'no-price-in-epoch' }],
  nonOfficialModels: [{ model: 'gpt-5', count: 4 }],
  providerUnknownModels: [{ model: 'deepseek-flash', count: 1 }],
  cost: { totalCny: 0.42, peakCny: 0.3, valleyCny: 0.12 },
  meta: {
    pricingMode: 'official', priceSource: 'official', peakMultiplier: 2,
    epoch: { from: 2, source: 'epoch-2' },
    priceModels: [
      {
        key: 'flash', family: 'flash', label: 'Flash', models: ['deepseek-flash', 'deepseek-v4-flash'],
        how: 'prefix', inferred: false, needsPrice: false, manual: false,
        base: { valleyCacheHitIn: 0.02, valleyMissIn: 1, valleyOut: 4, peakCacheHitIn: 0.04, peakMissIn: 2, peakOut: 8 }, override: null
      },
      {
        key: 'pro', family: 'pro', label: 'Pro', models: ['deepseek-v4-pro'],
        how: 'prefix', inferred: false, needsPrice: false, manual: true,
        base: { valleyCacheHitIn: 0.15, valleyMissIn: 4.5, valleyOut: 13.5, peakCacheHitIn: 0.3, peakMissIn: 9, peakOut: 27 },
        override: { valleyCacheHitIn: 0.2, valleyMissIn: 5, valleyOut: 14, peakCacheHitIn: 0.4, peakMissIn: 10, peakOut: 28 }
      },
      { key: 'deepseek-v9-flash', family: null, label: 'deepseek-v9-flash（未定价）', models: ['deepseek-v9-flash'], how: null, inferred: false, needsPrice: true, manual: false, base: null, override: null }
    ],
    holiday: { year: 2026, calibrated: true },
    fxRate: 7.16, updatedAt: Date.now()
  }
}

/** 用桩上下文跑一次完整挂载，返回面板容器与调用记录。 */
async function mountPanelWith(payload) {
  const { exported, hooks } = loadBundle()
  let bodyComp = null
  const mounted = []
  const calls = []
  const slots = {
    inject: (n, cb) => { if (cb) cb(); return () => {} },
    register: (def, comp) => { if (def.name === 'sidebar.right.pane.tab') bodyComp = comp; return () => {} }
  }
  const ok = (value) => Promise.resolve({ ok: true, value })
  const namespace = {
    summary: (input) => { calls.push(['summary', input]); return ok(payload) },
    status: () => ok(payload.status),
    setPrices: (input) => { calls.push(['setPrices', input]); return ok({ ok: true }) },
    setPricingMode: (input) => { calls.push(['setPricingMode', input]); return ok({ ok: true }) },
    setRate: () => ok({ ok: true })
  }
  const ctx = {
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    get: (k) => (k === 'slots' ? slots : (k === 'sidebarRightTabs' ? { register: () => () => {} } : (k === 'remote.deepseekBilling' ? namespace : undefined))),
    inject: (deps, cb) => { if (cb) cb(); return () => {} },
    remote: { $mount: async (c) => { mounted.push(c); return () => {} } }
  }
  await exported.apply(ctx)
  assert.ok(bodyComp !== null, '正文组件未注册到 sidebar.right.pane.tab')
  bodyComp()
  const box = makeEl('div')
  hooks.ref.current = box
  const dispose = hooks.effect()
  await new Promise((r) => setTimeout(r, 20))
  return { exported, mounted, box, dispose, calls, namespace }
}

test('bundle 注册：id / exports / inject', () => {
  const { entry, exported } = loadBundle()
  assert.equal(entry.id, 'dsh-deepseek-billing')
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['slots', 'remote'])
})

test('apply：remote 贡献挂载五个方法（含 v0.4.0 新增的 setPricingMode）', async () => {
  const { mounted } = await mountPanelWith(SUMMARY)
  assert.equal(mounted.length, 1)
  const methods = mounted[0].descriptors.map((d) => d.method)
  assert.deepEqual(methods, ['summary', 'status', 'setPrices', 'setPricingMode', 'setRate'])
  for (const d of mounted[0].descriptors) {
    assert.equal(d.result.mode, 'strict', d.method + ' 必须是 strict codec')
    assert.equal(typeof d.result.create, 'function', d.method + ' 的 strict codec 必须带 create()')
  }
})

test('mountPanel 不抛错，且 renderData 反映三类点名与纪元出处', async () => {
  const { box } = await mountPanelWith(SUMMARY)
  const nodes = walk(box)
  const foot = nodes.find((n) => typeof n.textContent === 'string' && n.textContent.indexOf('价表：') === 0)
  assert.ok(foot, '页脚未渲染')
  assert.match(foot.textContent, /epoch-2/, '页脚应显示当前纪元出处')
  assert.match(foot.textContent, /会话 00000abc/, '页脚应显示会话 id 后 8 位')
  assert.match(foot.textContent, /含 1 个子代理会话/, '页脚应显示子代理数量')
  assert.match(foot.textContent, /非官方渠道/, '页脚应点名非官方渠道（钱没算进来）')
  assert.match(foot.textContent, /算不出价/, '页脚应点名官方模型缺价')
})

test('renderForm：按官方目录出行、带来源徽标、每行六个输入框', async () => {
  const { box } = await mountPanelWith(SUMMARY)
  const before = walk(box)
  const toggle = before.find((n) => n.children && n.children[0] && n.children[0].textContent === '价格配置')
  assert.ok(toggle, '找不到「价格配置」按钮')
  toggle.children[0].handlers.click[0]() // 展开表单
  const after = walk(box)
  const rows = after.filter((n) => typeof n.className === 'string' && n.className.indexOf('pvcst-formmodel') === 0)
  assert.equal(rows.length, 3, '三行：Flash / Pro / 未定价模型')
  assert.match(rows[0].textContent, /内置/)
  assert.match(rows[1].textContent, /手动/)
  assert.match(rows[2].textContent, /缺价/)
  assert.equal(after.filter((n) => n.tagName === 'input').length, 18, '3 行 × 6 个输入框')
  const labels = after.filter((n) => n.tagName === 'button').map((b) => b.textContent)
  assert.ok(labels.includes('内置价表优先') && labels.includes('只用手动价'), '应有计价模式按钮')
  assert.ok(labels.includes('恢复内置价'), '手动行应有恢复按钮')
})

test('明细卡：总消耗之外再分主会话与子代理两行', async () => {
  const { box } = await mountPanelWith(SUMMARY)
  const labels = walk(box).filter((n) => typeof n.className === 'string' && n.className.indexOf('pvcst-rowlabel') >= 0).map((n) => n.textContent)
  assert.ok(labels.includes('总消耗'), '应有总消耗行')
  assert.ok(labels.includes('主会话消耗'), '应有主会话消耗行')
  assert.ok(labels.includes('子代理总消耗'), '应有子代理总消耗行')
  const values = walk(box).filter((n) => typeof n.className === 'string' && n.className.indexOf('pvcst-rowval') >= 0).map((n) => n.textContent)
  /* 计费口径 = 命中 + 未命中 + 输出：总 6300、主会话 2500、子代理 3800 */
  assert.ok(values.some((v) => v === '6300 tok'), '总消耗应为 6300 tok（收到 ' + values.join(',') + '）')
  assert.ok(values.some((v) => v === '2500 tok'), '主会话应为 2500 tok')
  assert.ok(values.some((v) => v === '3800 tok'), '子代理应为 3800 tok')
})

test('切换计价模式会下发 setPricingMode', async () => {
  const { box, calls } = await mountPanelWith(SUMMARY)
  const toggle = walk(box).find((n) => n.children && n.children[0] && n.children[0].textContent === '价格配置')
  toggle.children[0].handlers.click[0]()
  const manualBtn = walk(box).find((n) => n.tagName === 'button' && n.textContent === '只用手动价')
  assert.ok(manualBtn, '找不到「只用手动价」按钮')
  manualBtn.handlers.click[0]()
  await new Promise((r) => setTimeout(r, 10))
  const call = calls.find((c) => c[0] === 'setPricingMode')
  assert.ok(call, '未调用 setPricingMode')
  assert.equal(call[1].mode, 'manual')
})
