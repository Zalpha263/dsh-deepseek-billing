# dsh-deepseek-billing

DeepSeek 峰谷计费插件（梁文峰 / 梁文谷）：实时判断当前是高峰还是闲时，按官方价表算出当前会话（含子代理）的 token 消耗与费用，挂在 **DSH 官方右侧栏**的一个标签页里。

## 能做什么

- **峰谷判定**：面板顶部显示当前时段（红色「梁文峰 · 高峰」或绿色「梁文谷 · 闲时」），并给出距离换档的秒级倒计时；周末与**已内置年份的法定放假日**全天按闲时算。右侧 ↻ 可手动刷新。
- **费用统计**：逐事件按**事件自身时刻生效的价表纪元**计价，覆盖未命中输入、缓存命中输入、输出（含推理）三类 token；默认人民币，可切美元（汇率在线刷新，也能手填）。统计范围是当前会话加它派生的子代理树——**已结束的子代理也会通过持久化日志计入**，明细卡会把 token 总量拆成「主会话」与「子代理」两行。
- **只认官方渠道**：每次请求都按 `provider` 过滤，只有 `deepseek-official`（API key 路线）与 `deepseek-account`（平台账号路线）参与计价；外部接入的 provider 不计价，并在页脚点名。
- **模型跟随官方目录**：价表表单的行来自 `ctx.llm.listModels()` 广告的**官方模型目录**，官方新增或改名后无需改代码；新名字若含 `flash` / `pro` 会按关键字推断到对应族并标注「推断」。
- **价格维护**：官方调价不用改代码，在「价格配置」里直接改。每个价族六个独立输入框（高峰 / 闲时 × 未命中输入 / 缓存命中输入 / 输出），**保存即整行快照成手动价**（不再出现一半内置一半手动的中间态），单行可「恢复内置价」。也可整体切到**只用手动价**模式：未手动配置的模型一律不计价并点名，绝不回落到内置表。
- **窄宽度自适应**：面板被挤窄时依次收紧内边距、隐藏脚注、缩写金额、让表单换行——宽度不足 320px 换档提示也始终保留。
- **入口固定**：本插件直接注册进 **DSH 官方右侧栏**（`sidebarRightTabs` + `sidebar.right.pane.tab` 槽位），**与 ui-beautify 是否安装无关**——ui-beautify 不再是必需项，也不再有任何标题栏按钮或自带浮动卡。

## 面板说明

| 组件 | 控件 | 作用 |
| --- | --- | --- |
| 状态卡 | 徽章 | 当前时段，高峰红、闲时绿 |
| 状态卡 | 倒计时 | 距离下一次换档的 HH:MM:SS |
| 费用卡 | 总额 | 当前窗口费用，可在人民币与美元之间切换 |
| 明细卡 | Token 表 | 缓存命中 / 未命中 / 输出（含推理）/ 推理 / 总消耗 / **主会话消耗 / 子代理总消耗** |
| 页脚 | 一行摘要 | 当前价表纪元 + 会话 id + 子代理会话数；只有出现「钱没算进来」时（非官方渠道、官方模型缺价）才追加 ⚠ 点名 |
| 价格配置 | 模式按钮 | 「内置价表优先」/「只用手动价」二选一，当前模式高亮 |
| 价格配置 | 表单 | 每个价族六个独立价（元 / 每 1M tokens）+ 来源徽标（内置 / 手动 / 缺价 / 推断）与「恢复内置价」 |

## 计费规则

- 高峰时段为北京时间 `09:00–12:00` 与 `14:00–18:00`，其余按闲时计价；闲时价是高峰价的一半（峰值 = 闲时 × 2）。
- 峰谷定价自 2026-08-17 00:00（北京）起生效，周末全天闲时价自 2026-08-23 00:00（北京）起生效；**法定放假日全天按闲时**（只认放假日，调休上班的周末不做特殊处理）。
- 计价用的是**事件自身发生的时刻**，所以一次会话跨过换档点时，两侧的请求会分别按各自时段的价计费。
- **价表按「纪元」分段**，改价不会追溯重算历史时段：

| 生效时刻（北京） | 出处 | Flash（闲时，元/1M） | Pro（闲时，元/1M） |
| --- | --- | --- | --- |
| 2026-08-17 00:00 | 峰谷定价生效 + 本插件 2026-09-03 的官方价页快照 | 0.05 / 1.5 / 4.5 | 0.15 / 4.5 / 13.5 |
| 2026-09-10 12:00 | 官方《DeepSeek V4.1 Flash》公告：新价于该时刻生效 | **0.02 / 1 / 4** | 0.15 / 4.5 / 13.5 |

（三档顺序为：缓存命中输入 / 未命中输入 / 输出；高峰价为闲时价的两倍。推理 token 按输出价计。）

**模型 id 是自由字符串，不是官方模型名。** 匹配顺序是：族前缀（`deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4.1-flash` / `deepseek-v4-pro`）→ 显式别名（`deepseek-chat` / `deepseek-reasoner` / `deepseek-pro` / `deepseek-v4-flash-latest` 等，见 `lib/pricing.js`）→ 官方目录内的关键字推断（含 `flash` / `pro`，标注「推断」）。2026-08-17 之前的事件没有峰谷价可比，计 0 并计入「未计价」提示；非官方 provider 与完全认不出的模型名都不计价并在页脚点名。

> 面板显示的是本地预估价，实际费用以 DeepSeek API 平台的账单为准（不含 Web 搜索、标题生成等平台侧调用）。

## 已知限制

- **节假日只认放假日、不认调休**：被调成工作日的周末仍按闲时计，因此那些日子的 9:00-12:00 / 14:00-18:00 会偏低约一半。放假日期表按年内置（`lib/holidays.js`），未内置的年份退回「只有周末是闲时」，面板会提示。
- **非官方渠道不计价**：`provider` 不在这两条官方路由内的调用不参与计价（页脚按「非官方渠道」单列），这是刻意的取舍——避免把外部接入的同名模型按官方价结算。
- **改价按纪元生效，不追溯**：新增纪元只影响生效时刻之后的请求；历史时段的账目保持原价。若某时段没有对应价表，会记为「该时段无价」而不是借当前价。
- **计价范围是会话日志**：不含 Web 搜索、标题生成等平台侧调用，实际费用以 DeepSeek API 平台账单为准；DSH 目前也没有「按 key / 按会话查询消费」的官方接口，只能在本地按 token 推导。

## 安装

要求：DSH `>=0.2.0-rc.1 <0.3.0`（已在 `0.2.0-rc.1`（web 宿主 / npm 全局 CLI）与 `0.2.0-rc.2`（桌面应用内建运行时）上校验：兼容性闸门通过、组成解析通过、Host 激活、客户端产物注册成功）与 [pnpm](https://pnpm.io/zh/)。

```bash
# 发布态：钉死提交，最稳定
dsh plugin --profile web add github:Zalpha263/dsh-deepseek-billing#<40位commit>

# 开发态：裸目录路径 = link:（源码即部署，改完不用重装）
dsh plugin --profile web add D:/path/to/dsh-deepseek-billing

# 卸载
dsh plugin --profile web remove dsh-deepseek-billing
```

装完**重启 DSH**（Host 半区需要加载），然后在官方右侧栏里选择「💰 峰谷计费」标签，或从右侧栏「开始」页的入口胶囊点开（order 110）。**不再有会话标题栏按钮。** Host 改动重启 DSH，Client 改动刷新页面即可。

**桌面版（DeepSeek Harness 桌面应用）**：`desktop` profile 由桌面应用独占，`dsh plugin --profile desktop ...` 会被 CLI 直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。请在桌面应用侧边栏的**插件**页里用**绝对路径**添加本插件目录（或 GitHub 仓库地址），装完重启应用生效。桌面应用自带 Node / pnpm 运行时并走应用内更新（不依赖 npm 全局安装），它的 DSH 版本可能与全局 CLI 不同（实测桌面 `0.2.0-rc.2` 内建运行时、npm 全局 CLI `0.2.0-rc.1`），本插件对两者都通过兼容检查。

## 常见问题

| 问题 | 原因与解决 |
| --- | --- |
| 费用一直是 ¥0.0000 | 看页脚点名：非官方渠道、provider 未知、模型名认不出、或（只用手动价模式下）该族还没配置价。早期（2026-08-17 前）的事件本身不计价 |
| 改了价格但数字没变 | 保存后下一次轮询就会刷新；若仍是旧值，确认保存成功（该行徽标应显示「手动」） |
| 子代理的费用没算进来 | 已结束的子代理通过持久化日志计入；若仍为 0，检查该会话是否走了非官方 provider |
| 想整体恢复内置价 | 逐行点「恢复内置价」，或点「清空全部手动值」 |
| 想完全自己定价 | 切到「只用手动价」——未配置的模型一律不计价并点名，不会偷偷用内置价 |
| 面板不见了 | 右侧栏「开始」页的入口胶囊（或标签条的 `+`）里选「峰谷计费」；整个右侧栏被收起时先展开它 |

## 开发者

- `lib/pricing.js` —— **计价核心（纯函数）**：官方 provider 白名单与渠道闸门、模型族（前缀 / 别名 / 关键字推断）、价表纪元（`PRICE_EPOCHS`，改价只追加纪元）、峰谷与节假日判时、下一次换档时刻。
- `lib/holidays.js` —— 法定放假日期表（按年登记，只放假日）+ ICU 农历推导与自检（`validateHolidays` 用 `Intl` 的 `zh-CN-u-ca-chinese` 交叉核对表里的农历节日）。
- `lib/index.js` —— Host 半区，注册 `deepseekBilling` 远程服务（`summary` / `status` / `setPrices` / `setPricingMode` / `setRate`）；负责账户折叠、官方目录核对与手动覆盖状态。
- `lib/client.js` —— Client 半区，手写 `__ModuleLoader__.load` 格式；纯 DOM 构建面板，用官方 `ctx.sidebarRightTabs.register({ id, kind, title, guide, priority })` + `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)` 注册成官方右侧栏标签页（正文先行、类型后行；正文注册自己兜异常，槽位缺失时不留半注册）。
- `test/pricing.test.mjs` —— 计价核心单测：渠道闸门、族解析、纪元边界、峰谷与节假日判时、手动价两种模式、农历自检。
- `test/client-smoke.test.mjs` —— 客户端半区冒烟：用最小 DOM/React/ModuleLoader 桩把真实 bundle 跑一遍。**改动 `lib/client.js` 后务必跑它**——client 是手写 bundle，`node --check` 只能证明语法，证明不了能挂载（v0.4.0 开发中确实出现过「语法通过但面板空白」）。
- `cordis.patch.yml` —— bundle 层注册行。

**改价的正确姿势**：在 `lib/pricing.js` 的 `PRICE_EPOCHS` **追加**一条纪元（带 `from` 生效时刻与 `source` 出处），不要修改历史纪元——计价按事件时刻查表，改历史会让过去的账目跳变。改时区规则同理只动 `PEAK_WINDOWS` / `PEAK_FROM` / `WEEKEND_FROM`；节假日按年补 `lib/holidays.js` 的 `HOLIDAY_RANGES`。

Client 改动由 `dsh-client-hmr` 自动热重载（必要时 Ctrl+F5），Host 改动必须重启 DSH。

## 更新日志

### v0.5.0
- **页脚精简**：只保留「当前价表纪元 + 会话 id + 子代理会话数」，以及两类「钱没算进来」的 ⚠ 点名（非官方渠道未计价、官方模型缺价）；汇率、节假日校准、provider 未知、模型名认不出等诊断不再占版面（放假安排缺年份时仍会提示一次）。
- **明细卡按主会话 / 子代理拆分**：在「总消耗」之外新增「主会话消耗」与「子代理总消耗」两行（token 口径 = 缓存命中 + 未命中 + 输出）。宿主聚合相应改为分流统计。
- **删除无人使用的产出**：`meta.families`、`meta.catalog`（含 providers / official / advertised 等）、`d.byModel`（宿主聚了整张模型表但面板从不显示）、`d.sessions`、`status.now`、`rowFor()` 的 `hitKind`、`fxSource`，以及 `nonDeepModels` / `providerUnknownModels` 两张只服务已删提示的映射表。
- **性能**：节假日 ICU 农历自检（逐日扫一年、约 45ms）从每次 `summary` 移到测试，运行时不再承担这笔开销。

### v0.4.0
- **只认官方渠道**：新增 provider 闸门 —— 只有 `deepseek-official`（API key）与 `deepseek-account`（平台账号）参与计价；外部接入的 provider 与取不到 provider 的旧记录都不计价，并在页脚分列交代。删除了原先「凡 `deepseek-` 开头都按官方价」的 `PROVIDER_PREFIXES` 兜底。
- **模型跟随官方目录**：价表表单改由 `ctx.llm.listModels()` 的官方目录驱动（按族分组、族下列出官方模型名），官方新增/改名无需改代码；族外的官方新名字按 `flash` / `pro` 关键字推断并标注「推断」。
- **价表纪元**：单一价表常量改为 `PRICE_EPOCHS` 分段表（2026-08-17 峰谷生效；2026-09-10 12:00 官方降价），按**事件自身时刻**查表 —— 官方改价不再追溯重算历史时段。Flash 闲时价随官方公告由 0.05/1.5/4.5 降为 **0.02/1/4**（Pro 不变）。
- **法定节假日**：新增 `lib/holidays.js`（按年登记放假日，2026 年取自国办发明电〔2025〕7 号），放假日全天按闲时；用 Node 自带的 ICU 农历做交叉自检。调休不做特殊处理（已在面板与文档标注）。
- **手动价两种模式**：新增「内置价表优先 / 只用手动价」切换；保存即把该行六个值**整体快照**为手动记录（不再有半内置半手动的中间态），单行可「恢复内置价」。本地持久化升为 `{v:2, mode, prices}`，三代旧结构与客户端重复的别名表随之删除。
- **删除冗余**：`DEBUG_DIAG` / `debugLog` / `diag` 诊断管道、无 CSS 规则的 `pvcst-rows` / `pvcst-msg` 类名、宿主 `FAMILIES` / `ALIASES` / `PROVIDER_PREFIXES` 与客户端 `ALIAS_TO_PATTERN` 的重复真源。
- **测试**：新增 `test/pricing.test.mjs`（17 例）覆盖渠道闸门、族解析、纪元边界、峰谷与节假日判时、手动价两种模式；新增 `test/client-smoke.test.mjs`（5 例）用最小 DOM/React/ModuleLoader 桩把**真实 bundle** 跑一遍（注册 → apply → 挂载 → `renderData` → 展开 `renderForm`）。`npm test` 串跑两套。
- 计价核心抽到新文件 `lib/pricing.js`（纯函数，可单测），`lib/index.js` 只保留账户折叠与 Remote 服务。

### v0.3.0
- 适配 DSH `0.2.0-rc` 线：peer 范围改为 **`>=0.2.0-rc.1 <0.3.0`**，并镜像到 `devDependencies`；新增 `locale/en.json` + `locale/zh.json` 展示元数据（插件页标题 / 描述），随 `exports["./locale/*.json"]` 与 `files` 发布。
- 删除（宿主兼容分支）：两代旧价格结构读取（v0.1.24 的四值、更早的 `hit` / `miss` / `out`）与 `setPrices` 的 `bucket` 分支 —— 只保留六值接口。
- 删除 `session.log` 兜底与 `sessionPersistence.readFrom()` 分支（`0.2.0-rc.2` 上均不存在）。
- 删除只写不读的 `priceRevision` 计数器；`bumpPriceRevision` 的两次 clear 保留。
- 删除失效的 `[data-vsc-pplist]` 外挂 CSS 规则与旧 `aliases` 持久化键清理。
- 客户端保留一次性的 `localStorage` 旧结构归一化 —— 那是用户数据迁移，不是 API 兼容。

### v0.2.1
- **修复（桌面端右侧栏没有任何入口）**：v0.2.0 在 `apply` 时**一次性** `ctx.get("sidebarRightTabs")`，取不到就 `return`；而客户端各 entry 的 `apply` 顺序/并发**并不保证**，服务本身与 `sidebar.right.pane.tab` 槽位（由 `ui-sidebar-right` 自己 `slots.inject` 声明）都可能晚一拍出现 —— 注册被静默丢弃，右侧栏「开始」页再也不出现本插件胶囊。实测桌面端 `0.2.0-rc.2` 即如此；`0.2.0-rc.1` 的加载实测能过，说明这是时序敏感的偶发路径（我逐行比对过 rc.1 与 rc.2 的 `dsh-client-ui-sidebar-right`，`register()` 校验完全相同，不是 API 变更）。
- 现在：`ctx.inject(["sidebarRightTabs"], …)` **依赖驱动** + **有界重试**（0/50/120/300/700/1200/2000/3000/5000/8000 ms）+ **失败时打印一次可诊断的原因**（正文槽位、类型注册各自的失败原因分别记录，重试用尽才报一次）。
- 验证：`node --check`；与 file-explorer 侧同一处修复对称。

### v0.2.0
- **改造：只走官方右侧栏链路，删除 ui-beautify 依赖与标题栏降级入口**。此前面板注册在 ui-beautify 提供的 `sidebarPanel` 服务上，因此**关掉 / 卸载 ui-beautify 后本插件没有任何右侧栏入口**，只剩会话标题栏的「💰 计费」浮动卡片。现在直接调官方服务：`ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title, guide })` + `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)`（可选标题槽位 `sidebar.right.pane.tab.title`）。这两个服务由 `@deepseek-ai/dsh-web-app` 的 `ui-sidebar-right` 行提供，每个 web / 桌面 profile 都有，**与 ui-beautify 无关**。
- 删除：ui-beautify 可选依赖（`ctx.inject(['sidebarPanel'])` + `internal/service` 事件 + 1s 兜底轮询的幂等绑定器）、独立浮动卡（拖动 / 缩放 / 位置记忆）、会话标题栏「💰 计费」入口及其 CSS。
- 健壮性：正文槽位注册自己 try/catch —— 槽位未声明时放弃注册并返回，不再让异常冒泡出 `ctx.effect` 中断整个 `apply`（否则后半段的会话探测也会丢）。
- 标签正文里不再渲染面板自带的「×」（关闭交给官方标签条）。
- 验证：官方服务桩契约 harness（注册形状 / 失败路径 / 拆卸三个注册）+ 真实 `0.2.0-rc.1` 宿主**移除 ui-beautify 后**的加载实测。

### v0.1.31
- **适配桌面版**：peer 由 `^0.1.7-rc.1` 放宽为 **`>=0.1.7-rc.1 <0.3.0`**。桌面应用跑 DSH `0.2.0-rc.1`，旧范围上界 `<0.2.0-0` 不含它，而应用自有 profile 对 peer 不兼容的 bundle **静默跳过、不报错**，现象就是「右侧栏计费标签页不见了」。放宽后同时覆盖 web 宿主 `0.1.7-rc.2` 与桌面 `0.2.0-rc.1`。
- 走廊核对（`0.1.7-rc.1 → 0.1.7-rc.2 → 0.2.0-rc.1`）：本插件调用的 `llm.listProviders()` / `llm.listModels()` 签名未变（仅 JSDoc 变动；新增的 `ACCOUNT_QUOTA_EXCEEDED_CODE`、`projectToolUpdates`、`toolUpdate` 均为加法）；`sessions` / `sessionPersistence` / `sessionQuery`、`slots.inject` / `slots.register`、`theme`、`sidebarRight` / `sidebarRightTabs`、`ctx.remote.$mount` 的 CONTRIBUTION 校验全部未变，无需改代码。
- 桌面版安装方式：`desktop` profile 由桌面应用独占，`dsh plugin --profile desktop ...` 会被 CLI 拒绝；请在桌面应用的**插件**页用**绝对路径**添加本插件目录。

### v0.1.30
- 迁移：对齐 DSH `0.1.7-rc.1`（自 `0.1.7-alpha.2`）。本插件用到的 host 服务 `llm` / `sessions` / `sessionPersistence` / `sessionQuery` 与 `@deepseek-ai/dsh-typert-protocol` 的 Remote 契约在 `alpha.2 → rc.1` 之间**逐字节未变**；`@deepseek-ai/dsh-llm` 唯一的改动是 typert 类型声明表里移除了 `team-message` 成员（本插件不引用）。无需改代码，peer 对齐 `^0.1.7-rc.1`。
- 验证：隔离 `DSH_HOME` 冷启动 rc.1 → 模块已注册、客户端产物 HTTP 200 且含 `__ModuleLoader__.load`；`node --check` 通过。

### v0.1.29
- 修复：DSH 0.1.7 的 Typert codec 契约变更（strict codec 必须带 `create()` 工厂，运行时调用 `codec.create().parse(value)`）。原 `codec.schema` 写法导致 `ctx.remote.$mount()` 失败、计费面板取不到数据。`strictCodec()` 改为提供 `create`。peer 对齐 `^0.1.7-alpha.2`。

### v0.1.28
- 适配 DSH 0.1.5-rc.2 的持久化接口（`readFrom()` 已移除、`list()` 返回 `{header, revision}` 快照），恢复子代理 / 冷会话计费；修复改价后子代理账目沿用旧价；修复清空价格输入框不会清掉宿主覆盖值；peer 对齐 `^0.1.5-rc.2`。

### v0.1.27
- 修复：手动配置价格后「本次窗口费用」不变（覆盖表的键与真实模型 id 不匹配 + 已折过的历史不重算）；改价改为整体丢弃账户后全量重折。

### v0.1.26
- 修复：本轮费用恒为 ¥0 的根因是模型名认不出——匹配改为「族前缀 → 显式别名 → provider 前缀兜底」三档；价格档位拆成未命中输入 / 缓存命中输入 / 输出六值。

### v0.1.25
- 新增：用 `ctx.llm.listProviders()` / `listModels()` 与官方模型目录交叉核对，页脚点名「认得但缺价」「供应商广告了但认不出」两类提示；修复页脚因暂时性死区抛 `ReferenceError`。

### v0.1.24 及更早
- **v0.1.24**：模型识别从精确名改为按族前缀匹配，不再因新模型名静默不计价；计价结论分 `priced` / `recognized` / `unknown` 三类；价格覆盖改为四值独立；去掉「恢复官方」按钮。
- **v0.1.23**：新增未装 ui-beautify 时的标题栏按钮 + 浮动卡片；两个入口自动切换。
- **v0.1.22**：dock 集成改用 cordis 规范写法 `ctx.inject(['dock'], (c) => …)`。
- **v0.1.21**：窄宽度改为容器查询逐级遮挡；修复内联字号样式被 CSSOM 丢弃；补 `deepseek-v4.1-flash-expires-on-0910` 价表；删除别名通道。
- **v0.1.20**：价表日期与「是否已手动覆盖」改由宿主单一真源提供；峰值系数统一由 `PEAK_MULTIPLIER` 计算。
- **v0.1.19**：修复历史 / 冷会话计费窗口、多模型归因、切换会话时的聚合错误；新增 `summary(debug)`。
- **v0.1.18**：适配 DSH 0.1.2-rc.1，会话事件改用按需读取 API；修复无手动覆盖时面板「加载失败」。
- **v0.1.17**：费用卡标注「本地预估价 · 实际以 API 平台账单为准」。
- **v0.1.16**：修复已从内存卸载的旧会话窗口为空或缺少根会话。
- **v0.1.15**：费用卡说明零金额的原因。
- **v0.1.14**：刷新按钮移到「Token 明细」标题右侧。
- **v0.1.13**：面板跟随当前会话切换；状态卡增加手动刷新。
- **v0.1.12**：插件面板芯片行的「···」按钮移到最前。
- **v0.1.11**：Token 明细增加「总消耗」行。
- **v0.1.10**：价格配置表单重构，消除换行与大字号畸形。
- **v0.1.9**：子代理计费改为持久化日志聚合，已结束的子代理也计入。
- **v0.1.8**：界面按 Apple HIG 打磨，卡片改用毛玻璃表层。
- **v0.1.7**：费用卡精简为「模型名 + 金额」。
- **v0.1.6**：面板改为纯 DOM 构建，修复多标签切换的渲染竞争。
- **v0.1.5**：尝试 `flushSync` 同步提交渲染（未解决，被 v0.1.6 取代）。
- **v0.1.4**：移除调试贴片，面板复用同一挂载点。
- **v0.1.3**：修复面板注册后立即被注销（清理函数写成了立即执行）。
- **v0.1.2**：新增页面内调试贴片。
- **v0.1.1**：只挂载插件面板，移除会话头部入口；修复客户端 `inject` 缺少 `remote`。
- **v0.1.0**：初版（峰谷判定 + 官方价表计价 + 插件面板 + 价格配置）。

## License

MIT
