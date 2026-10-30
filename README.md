# 快手广告批量上计划 & 日常盯盘工作台

磁力引擎开放平台（MAPI / DSP）的投放提效工具。网页端先行，后续打包为 Windows exe。

当前进度：**P0 完成**（授权闭环 + 只读盯盘）。详见 [`docs/快手广告工作台-技术方案.md`](docs/快手广告工作台-技术方案.md)。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + Ant Design 5 + ECharts + TanStack Query |
| 后端 | NestJS 10 + Prisma 5 + SQLite |
| 共享层 | `@wkbd/shared`（枚举、限额、错误分类、类型定义） |

前后端同语言是刻意的选择 —— 桌面化时后端无需改造，Electron 直接 `fork` 这个 Node 进程即可。

---

## 目录结构

```
.
├── packages/shared/          共享常量与类型（限额、错误分类、枚举）
├── apps/server/              NestJS 后端
│   ├── prisma/schema.prisma  数据模型
│   └── src/
│       ├── common/           加密、路径、ID 归一化、解析工具、全局异常
│       ├── prisma/           Prisma 服务
│       ├── mapi/             ★ 开放平台统一网关
│       │   ├── mapi-http.ts         底层 HTTP
│       │   ├── token.service.ts     token 托管与续期
│       │   ├── rate-limiter.service.ts  三层令牌桶 + 自适应降速
│       │   ├── error-classifier.ts  错误分类
│       │   └── mapi.gateway.ts      唯一出口（限流/重试/审计）
│       ├── modules/          oauth / settings / account / report / system
│       └── scheduler/        定时任务
└── apps/web/                 React 前端
    └── src/pages/            SetupPage / AccountsPage / DashboardPage
```

---

## 快速开始

### 1. 环境要求

- Node.js ≥ 20

### 2. 安装依赖

```bash
npm install
```

> 若安装过程中 esbuild 的 postinstall 报 `EBUSY`（Windows 文件占用），
> 重新执行一次 `npm install` 即可，二进制实际已就位，不影响使用。

### 3. 初始化

```bash
npm run setup      # 构建 shared + 生成 Prisma Client + 建库
```

`setup` 会在 `apps/server/.data/` 下建立 SQLite 数据库与主密钥文件。

### 4. 配置

```bash
cp apps/server/.env.example apps/server/.env
```

`.env` 里的 `KUAI_APP_ID` / `KUAI_APP_SECRET` **可以留空** —— 启动后在「接入设置」页面填写即可，效果等同，且 secret 会用 AES-256-GCM 加密后落库。

### 5. 启动

```bash
npm run dev        # 同时启动后端(7801) 与前端(5173)
```

打开 <http://localhost:5173>

---

## 已实现能力（P0）

### 授权闭环

**核心模型：一次授权 = 一份「授权凭证」，凭证下可挂 N 个广告账户。**

围绕授权有**两个正交维度**，必须分开看 —— 这是本项目最容易踩的坑：

**① 授权入口（选平台与授权类型）—— 跳到哪个平台，由我们拼链接时决定**

官方现行授权页只有一个域名：`developers.e.kuaishou.com/tools/authorize`，
由必填参数 **`oauth_type`** 区分授权类型（**漏传会报「授权类型不应为空」，无法授权**）：

| 入口 | oauth_type | 覆盖范围 | 登录平台 |
|---|---|---|---|
| **磁力罗盘**（推荐） | `advertiser` | 罗盘下全部账户（页面选「用户授权」） | 罗盘 |
| 广告主 | `advertiser` | 该广告主体下的投放账户（页面选「账户授权」） | 磁力智投 |
| 代理商 | `agent` | 管辖范围内全部广告主账户，1 个 token（需双向授权） | 代理商平台 |

> `oauth_type` 全部取值：`advertiser`（广告主/罗盘）/ `agent`（代理商）/ `ad_social`（聚星）/ `series`（短剧）。
> ⚠️ 两次踩坑记录：① 域名写死成 `ad.e.kuaishou.com/openapi/oauth` → 罗盘链接落到磁力智投；
> ② 以为罗盘入口不传 `oauth_type` → 页面报「授权类型不应为空」。
> 官方文档（2025-12-29 更新）明确：罗盘用户授权流程与广告主一致，`oauth_type=advertiser`。

**② 授权方式（选范围）—— 覆盖几个账户，由用户在快手授权页上勾选**

| 方式 | 生效范围 |
|---|---|
| 基于用户授权 | 该快手 ID（**磁力罗盘 / 代理商**）下的**全部**广告账户 |
| 基于快手广告账户授权 | **勾选的一个或多个**广告账户 |

授权方式**不由 URL 参数决定**，我们只能把预期随 `state` 带出去、回调时校正标签。
（代理商入口没有这个选择，一份 token 天然覆盖管辖内全部账户。）

因此一次授权可能覆盖 N 个账户 → 凭证必须独立建表，否则 N 个账户行会各存一份完全相同的 token 密文，既浪费又会造成「同一份 token 被刷新 N 次 / 部分账户拿旧 token」的一致性问题。

- 开发者应用配置（界面填写，secret 加密落库、响应掩码回显）
- **三入口选择**，每个入口标注跳转平台、域名、覆盖范围与分步操作指引
- 授权链接实时预览（展示域名与参数，可核对将跳到哪个平台）
- scope 可勾选（核心三段强制申请，`account_service` 可选）
- OAuth 回调自动兑换 token → 建立凭证 → 挂载账户
- 账户自动发现（`approval/list` 分页拉取，失败时凭证照样入库、token 不丢）
- 手工兑换通道（回调地址不可达时的兜底）+ 仅复制链接
- 凭证/账户两级纠错：改名、**更正授权入口**、更正授权方式、启停、移除
- 单主体入口只纳管到 1 个账户时，主动提示「是不是该走罗盘入口」

### Token 生命周期

- access_token 到期前 30 分钟自动续期（每 10 分钟巡检一次）
- **按凭证刷新**：一份凭证（不论覆盖 1 个还是 500 个账户）只刷新一次，其下账户同时生效
- refresh_token 30 天到期前 7 天开始告警
- 失效凭证自动标记「需重新授权」，前端顶栏高亮提醒
- 每天 07:10 自动与平台对齐账户列表：罗盘里新增的账户自动纳管，已解绑的自动停用

### 盯盘看板
- 多账户选择 + 日期范围（受近 7 天限制约束）
- 按天 / 按小时粒度切换
- 关键指标卡：花费、曝光、点击、点击率、行为数、行为成本
- 分时走势图（花费柱 + 点击折线，双轴）
- 账户明细表（支持排序、单账户错误隔离）
- 手动刷新 / 每 5 分钟自动刷新

### 账户管理
- **按授权凭证分组展示**（Collapse）：每份凭证一行，展开即该凭证下的账户明细
- 凭证级：对齐账户、刷新 token、改名、更正授权方式、启停、移除
- 账户级：同步白名单、启停、移除
- 白名单能力同步（创编前判断哪些能力可用）
- 配额水位与凭证/账户两层健康度实时展示

### 基础设施（为 P1 铺路）
- **MapiGateway**：业务侧所有外部调用的唯一出口，统一限流、重试、token 续期、审计
- **授权类调用单独留痕**：`access_token` / `refresh_token` / `approval/list` 没有 advertiserId，
  不走网关，但同样写审计 —— 授权出问题时这是唯一能回溯「发了什么、平台回了什么」的地方
- **三层令牌桶**：全局 1000 QPM / 创编 600 / 创意 400 / 批量 200 / 单账户 600
- **自适应降速**：超时率 15% 主动降速，20% 暂停 1 分钟（对齐平台阈值）
- **错误分类**：RETRYABLE / PARAM / PERMISSION / TOKEN_INVALID，前端据此给出可操作提示
- **全量审计**：每次调用留痕，请求体脱敏（secret / token / auth_code 不入库）

---

## 已实现能力（P1：批量上计划）

### 创编链路

一条创编行 = 一条完整的 **计划 → 广告组 → 创意** 链路。当前支持三种营销目标：

| 营销目标 | `campaign.type` | 链路特有字段 |
|---|---|---|
| 应用安装 | 2 | 应用 ID、应用包 ID |
| 应用活跃 | 7 | 应用 ID、应用包 ID |
| 收集销售线索 | 5 | 落地页形态、投放链接 / 建站 ID |

切换营销目标时，表格列**随之增减**（而不是让用户对着一堆用不上的列发呆）。

### 上计划页

- 双模式：**向导模式**（默认，对照磁力智投官方批量创建版式）/ **表格模式**（逐行微调），可随时切换
- 向导模式按官方页面分区：**广告组基本信息**、**定向**、**创意基本信息**（行动号召、创意标签回车添加（上限 10 个、单个 ≤10 字，支持「引用上次内容」，随 `creative_tag` 下发））、**创意素材**、**文案**、**转化路径**
- **广告组基本信息字段全部对齐创建接口文档**（计划 2259 / 组 2262）：广告类型（展示/搜索，搜索本期未实现）、投放方式（常规/全自动 `auto_manage`）、版位（智能优选与具体版位互斥：主站 上下滑大屏 6 / 双列信息流 7 加白 / 激励视频 24 加白 / 开屏 27 白名单，联盟 5 / 10）、竞价策略（成本优先 / 最大转化=计划 `bid_type=1`，**预算不限不支持最大转化**，自动切统一预算并提示；此时组层自动 MCB 且免出价）、出价类型（CPC/oCPM）、优化目标（激活 180/付费 190/次留 346/7日付费 739 等，ROI 目标要求 `roi_ratio`）、**深度优化目标双出价**（`deep_conversion_type`+`deep_conversion_bid`，白名单）、投放平台（不限/安卓/iOS，文档无鸿蒙）、下载方式（`app_download_type` 直接/落地页下载，落地页下载选下载中间页）、优先应用商店下载（`use_app_market`+`app_store` 默认全选）、每日预算（不限/统一）、排期（长期投放开始日期自动取当天/设定起止）、投放时段（全天/特定时间 = 168 格周×小时拖动表格 → `schedule_time`）、创意展现方式（`show_mode` 优选/轮播）、广告组名称统一配置
- **素材选择弹窗**：从账户视频库挑选，顶部筛选栏（名称/ID 搜索 + 上传时间区间 + 排序：近7天消耗/昨日消耗/今日消耗/上传时间），小封面网格直接展示**今日/昨日/近7天消耗**（来自素材维度实时报表聚合），右下角分页支持每页 10/30/50 条切换——默认按近7天消耗降序，首页即消耗 Top N；一个素材一条链路，多条文案按行序轮转
  - 平台边界（实测）：`/v1/report/material_report` 必须带 `view_type=5`，响应无 code 外壳，起始日期不得早于 T-7 —— 因此只有近 7 天口径，30 天/历史累计需后续接异步报表
- **落地页选择弹窗**（销售线索）：单选 + 搜索，替代手抄建站 ID
- 表格批量填写，一次 20～100 行；行复制 / 删除；「批量填充」抽屉可一次性刷一列
- **从 Excel 粘贴**：首行能对上列名别名就按列名映射，否则按固定列序映射（列序在界面上明写，不靠猜）
- **空单元格跳过而非写空值** —— 写空值会把默认值覆盖成空，反而制造一堆无意义的校验错误
- 提交前必过校验，有 ERROR 直接禁用提交按钮
- 底部常驻操作条：创建后状态（暂停/直接投放）/ 提交前校验 / 干跑 / 提交创建

### 提交前校验（`plan.validator`）

把「必然失败」的行拦在本地，省掉一次平台往返和一个失败条目：

- 账户 ID、计划名长度、日期格式与「不早于今天」、`scheduleTime` 168 位
- 预算下限（计划 ≥ 500 元、组 ≥ 100 元）、组预算 ≥ 出价
- 出价类型分支：CPC 走 `bidYuan`（0.2～100 元）；OCPM / MCB 走 `cpaBidYuan` + `ocpxActionType`
- 定向容器非空；创意素材类型与素材 ID 匹配（组图必须 3 张）
- 同账户内计划名重复检测
- 按营销目标分支校验链路参数（type 2/7/5/30/16/35）

校验结果按行返回（行号 + 字段 + 级别 + 原因），并附「各账户将创建多少条」与「今日已用配额」。

### 请求映射（`plan.mapper`）

三个刻意的设计决定：

1. **金额换算只在这里发生**（1 元 = 1000 厘），其余代码一律用元
2. **只下发有值的字段** —— `null` / `undefined` / 空串 / 空数组一律剔除，避免用空值覆盖平台侧默认
3. 必填容器字段给默认值：官方硬约束「`target` 非空时 `behavior_type` 必填且无默认值」，故兜底为 `0`

### 批量任务引擎（`task.service`）

计划层和广告组层**没有**批量创建接口，所以「批量上计划」在 API 层面必然是本地循环编排：

- 提交时把每行展开成 3 个条目（`seq = 层号×10000 + 行号`，保证计划先于组、组先于创意）
- 先建条目拿自增 ID，再回填 `parentId`，父子关系不靠猜
- 后台**串行**执行，每轮检查暂停标志；**父级未成功则子级直接标 SKIPPED**，不白调接口
- 创建成功后回填平台 ID，供回读核验使用
- **断点续跑**：进程重启后自动续跑未完成任务；只重试失败项，成功项不重复提交（幂等键约束）
- **日配额预检**：按今日已成功条目核对平台上限（计划 1000 / 组 600 / 创意 2000）

任务与条目状态机：

```
任务：PENDING → RUNNING → DONE | PARTIAL | FAILED | PAUSED | CANCELLED
条目：PENDING → RUNNING → SUCCEEDED | FAILED | SKIPPED
```

### 创建后状态（默认暂停）

上计划页底部有「创建后：暂停（推荐）/ 直接投放」开关，默认**暂停**。
批量创建 100 条一旦默认投放，就是真实预算风险。

这里有个平台层面的硬约束，决定了实现必须分两步走：

| 层级 | 创建接口能否指定状态 | 做法 |
|---|---|---|
| 广告组 | ✅ 有 `put_status`（不传默认填充 **1=投放中**） | 创建时直接下发 `put_status=2` |
| 计划 | ❌ 创建接口**没有**状态字段 | 创建成功后补一次 `/v1/campaign/update/status` |
| 创意 | ❌ 创建接口**没有**状态字段 | 创建成功后补一次 `/v1/creative/update/status` |

关键推论：**只要组是暂停的，计划就不可能产生消耗**（没有投放中的组，计划起不了量）。
所以「暂停」这个保证由组层单独完成即可，计划/创意层的补调用属于
「把后台显示状态也一并对齐」，属于锦上添花 ——
因此它**失败只降级为警告**（写进任务的 `lastError`），绝不把已创建成功的条目翻成失败。

### 回读核验

创建完不等于落库成功。按「账户 + 层级」分组批量回读（一次 200 个 ID，不逐个查），
核验状态：`NONE` / `PENDING` / `OK` / `MISMATCH` / `NOT_FOUND`，
名称与提交值不一致时把两边都记进 `verifyDiff`。

> 定时任务每 10 分钟扫一次「已创建但未核验」的任务 —— 刚创建完立刻回读会拿到「平台查不到」，那是假警报，不是失败。

### 任务中心

- 任务列表（4 秒轮询、进度条、状态标签）
- 明细：层级 / 名称 / 账户 / 状态 / 核验 / 平台 ID / 失败原因
- **失败原因附可操作建议**：PARAM → 改哪里；PERMISSION → 联系运营加白；TOKEN_INVALID → 重新授权；DEPENDENCY → 先修父级；RETRYABLE → 直接重试
- 操作：暂停 / 继续 / 回读核验 / 重试失败项

---

## 关键设计取舍

**1. 为什么后端必须存在？**
`secret` 一旦进浏览器就等于公开。所有开放平台调用都走后端，前端只对接自家 API。

**2. 为什么 token 挂在「授权凭证」上而不是「广告账户」上？**
快手的授权单位是**授权主体**，不是账户。用磁力罗盘账号走「基于用户授权」，一次就能覆盖该罗盘下全部账户；
即便走「基于账户授权」也能多选。若把 token 存在账户行上，罗盘授权 500 个账户就会写 500 份相同的密文，
刷新时还要靠批次去重来兜底 —— 属于把「一对多」硬塞进「一对一」。现在的模型是：
`AuthGrant(1) ──< OauthAccount(N)`，刷新一次、全部生效，账户列表变更也只影响挂载关系。

**3. 为什么授权入口必须做成显式选项，而不是写死一个域名？**
授权链接有两处极易踩坑：域名（写死 `ad.e.kuaishou.com/openapi/oauth` 会让罗盘链接落到
磁力智投单账户授权页）和必填参数 `oauth_type`（漏传页面直接报「授权类型不应为空」）。
现在入口是显式枚举（`LUOPAN` / `ADVERTISER` / `AGENT`），
链接拼接、`state` 声明、凭证落库、界面提示全部围绕它展开，
并且授权链接会实时预览域名与参数，方便核对。

**4. 为什么批量上计划必须自研任务编排？**
计划层和广告组层**没有**批量创建接口，只有创意层有 `batch_update`。所谓「批量上计划」在 API 层面就是循环调用，因此必须做成「本地任务状态机 + 断点续跑 + 幂等键」，而不是一个同步接口。

**5. 为什么报表不能只做透传？**
实时报表只能查近 7 天，T-1 数据次日 09:00 才更新完成。所以盯盘 = 实时增量 + 本地落库 + 异步报表（补历史）三通道组合。

**6. 金额单位**
平台所有金额字段单位是「厘」，1 元 = 1000 厘。`@wkbd/shared` 提供 `yuanToLi` / `liToYuan`，转换只在这两个函数里发生。

---

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/system/health` | 配额水位 + 凭证/账户两层健康度 |
| GET/POST/DELETE | `/api/settings/app` | 开发者应用配置 |
| GET | `/api/oauth/authorize-url?authEntry=LUOPAN\|ADVERTISER\|AGENT&authType=USER\|ACCOUNT` | 生成授权链接 |
| GET | `/api/oauth/callback` | 快手授权回调（返回 HTML 页面） |
| POST | `/api/oauth/exchange` | 手工兑换 auth_code |
| GET | `/api/oauth/grants` | **授权凭证列表** |
| POST | `/api/oauth/grants/:id/sync` | 对齐该凭证下的账户列表 |
| POST | `/api/oauth/grants/:id/refresh` | 刷新该凭证 token |
| PATCH | `/api/oauth/grants/:id` | 改名 / 更正授权入口 / 更正授权方式 |
| PATCH | `/api/oauth/grants/:id/enabled` | 启停凭证 |
| DELETE | `/api/oauth/grants/:id` | 移除凭证（级联其下账户） |
| POST | `/api/oauth/resync` | 对齐全部凭证（可传 `grantId` 限定） |
| GET | `/api/oauth/accounts` | 账户列表（含所属凭证信息） |
| POST | `/api/oauth/accounts/:id/refresh` | 刷新所属凭证 token |
| PATCH | `/api/oauth/accounts/:id/enabled` | 启停账户 |
| DELETE | `/api/oauth/accounts/:id` | 移除账户 |
| GET | `/api/accounts/:id/info` | 账户资质信息 |
| GET | `/api/accounts/:id/fund` | 余额与当日消耗 |
| POST | `/api/accounts/:id/white-list/sync` | 同步白名单能力 |
| GET | `/api/report/meta` | 数据边界说明 |
| POST | `/api/report/overview` | 多账户总览 |
| POST | `/api/report/trend` | 分时趋势 |
| POST | `/api/report/level/:level` | 单层级报表（account/campaign/unit/creative） |
| GET | `/api/plan/drafts` | 创编草稿列表 |
| GET/POST/PUT/DELETE | `/api/plan/drafts[/:id]` | 草稿增删改查 |
| POST | `/api/plan/validate` | 提交前校验（逐行问题 + 各账户创建数 + 今日配额） |
| POST | `/api/plan/tasks` | 创建批量任务（`dryRun=true` 为干跑） |
| GET | `/api/plan/tasks` | 任务列表 |
| GET | `/api/plan/tasks/:id` | 任务详情（含条目明细） |
| POST | `/api/plan/tasks/:id/pause\|resume\|cancel` | 暂停 / 继续 / 取消 |
| POST | `/api/plan/tasks/:id/retry-failed` | 只重试失败项 |
| POST | `/api/plan/tasks/:id/verify` | 回读核验 |

---

## 已知限制与下一步

**需要你确认后我才能继续的：**

1. **回调地址怎么解决** —— 服务默认只监听 `127.0.0.1`，而回调是快手服务器来访问。
   三种走法：① 登记公网域名 + HTTPS 做中转；② 内网穿透（ngrok / frp）；
   ③ 干脆只用「手工兑换」（从浏览器地址栏复制 auth_code）。
   在你确认前，手工兑换通路已经能跑通全流程。

**实测记录（2026-09-24，已核对）：**

- `approval/list` 的传参方式已用真实请求验证：
  全部参数（含 `access_token`）放 JSON body → 通过参数校验并进入鉴权；
  把 `access_token` 放请求头 → 被拒（「查询分页参数必传」）。**结论：必须放 body**。
- 该接口错误响应的外壳是 `{result, message, data}`，与主网关的 `{code, message, data}` **不同**，
  代码已兼容两种（`readStatus()` 同时读 `code` 与 `result`）。
- 错误码 `402012 应用已下线或者不存在` 已纳入 `ERROR_CODE_MAP`，归类为 `PERMISSION`。
- **凭证主干链路已端到端验证**（账户 `124276382`）：`access_token` / `approval_list` / `refresh_token`
  均返回 `code=0`；`report/account_report` 返回真实数据（约 1s）。
  → 说明「凭证 → 网关 → 平台 → 响应解析」整条主干是通的。
- **创编路径族的可达性已验证**：`/rest/openapi/gw/dsp/campaign/list` 用真实 token 调用返回 `code=0`（约 460ms）。
  这证实「智能化创编」这一路径族在当前应用下确实存在且已授权 ——
  `campaign/unit/creative` 的 `create` 共用同一前缀与网关，「路径族选错」这个最大风险已排除。
  但 `create` 本身**仍未实测**（见上方待确认项 1）。

**⚠️ 前缀陷阱（2026-09-24 按官方文档逐条核实，纠正了一个反了的结论）：**

创建/查询 与 状态更新 **不在同一个前缀下** —— 同一个业务对象，两个前缀：

| 层级 | 创建 / 查询 | 状态更新 |
|---|---|---|
| 计划 | `/rest/openapi/**gw/dsp**/campaign/{create,list}` | `/rest/openapi/**v1**/campaign/update/status` |
| 广告组 | `/rest/openapi/**gw/dsp**/unit/{create,list}` | `/rest/openapi/**v1**/ad_unit/update/status` |
| 创意 | `/rest/openapi/**gw/dsp**/creative/{create,list}` | `/rest/openapi/**v1**/creative/update/status` |

> 踩坑经过：我一度按「创建是 `gw/dsp`，那更新也应该是 `gw/dsp`」外推出一条
> `/gw/dsp/campaign/update/status` 并写进常量，还把真正正确的三条 `/v1/` 路径
> 当成「重复的死代码」删掉了。后来拉官方文档（「3.3.4 修改广告计划状态」等）
> 才发现方向完全反了。**不要从一个接口的前缀外推同族另一个接口的前缀。**
>
> 状态更新接口的入参形状三层一致：`advertiser_id` + 主键（`campaign_id` 等）
> + 批量字段（`campaign_ids`，计划 20 / 组 10 / 创意 20）+ `put_status`（1 投放 / 2 暂停 / 3 删除）。
> 返回的是**实际改成功的 ID 列表**，不是布尔值 —— 平台可能只成功一部分。

**✅ 真实创建全链路实测（2026-09-24，账户 124276382，营销目标 = 收集销售线索 type=5）：**

用真实素材跑了一条完整的「计划 → 组 → 创意」链路，三层全部创建成功并回读核验通过：

| # | 调用 | 结果 | 耗时 |
|---|---|---|---|
| 1 | `campaign/create` | ✅ code=0，计划 ID `11632789152` | 427ms |
| 2 | `unit/create` | ⚠️ 401000「建议出价范围 1~15 元」 | — |
| 3 | `campaign/update/status` | ⚠️ 401000「存在重复的 id」 | — |
| 4 | `unit/create`（修出价后） | ✅ code=0，组 ID `39354902490` | 770ms |
| 5 | `creative/create` | ✅ code=0，创意 ID `322989435349` | 1043ms |
| 6 | `campaign/update/status`（修 bug 后） | ✅ code=0 | 246ms |
| 7 | `creative/update/status` | ✅ code=0 | 268ms |

回读核验：`checked=3, ok=3, mismatch=0, missing=0`；
反查三层 `put_status` 均为 **2（暂停）** —— **「创建即暂停」端到端生效**。测试对象已删除。

这次实测抓出三个真问题（均已修复）：

1. **状态更新不能同时传单数主键和复数批量字段** —— 文档说「二选一或同时填均可」，
   但同值同时填会报 `401000 存在重复的id`。现在统一只传复数形式。
2. **`401000` 未进错误码表** —— 它是平台最常用的「业务校验不通过」码
   （出价越界、ID 重复都用它），之前靠消息关键字兜底，
   而「建议出价**范围**在」不含「选择**取值范围**」这个词，于是漏判成「未知错误」。
   现已按官方「13.2 报错 code 枚举值」补全整张表（限流/权限/参数/凭证四类共 30 余条）。
3. **状态更新返回的 `errors` 字段没被检查** —— 响应是
   `{campaign_ids, errors, campaign_id}`，只读成功列表会把「部分失败」瞒成「全部成功」。
   现在显式检查 `errors` 并在任务上告警。

> **顺带验证了一个设计决定是对的**：平台会**静默改写**你提交的字段
> （提交 `scene_id:[1]`，平台存成 `[1,10]`；`app_id`/`package_id` 补 0；`image_token` 自动生成）。
> 所以回读核验**只比对名称**，不逐字段比对 —— 否则每次创建都会被误报为 MISMATCH。

**文档接口可直连（别再折腾 SPA 渲染了）：**

```
POST https://developers.e.kuaishou.com/rest/open_api/platform/document/detail
Headers: Content-Type: application/json
         Origin: https://developers.e.kuaishou.com
         Referer: https://developers.e.kuaishou.com/
Body: {"docType":"DSP","documentId":2259}
→ data.content 就是完整的 Markdown 文档（字段表全在）
```

> `Origin` / `Referer` 两个头**必须带**，否则返回 `{"result":500,"message":"内部系统繁忙"}` ——
> 这个报错会让人误以为是接口故障或限流，其实是缺头。
> 目录树用 `POST /rest/open_api/platform/document/menu/list`，body 带 `{docType, menuId}`。

**P1 待做（批量上计划，收尾项）：**
- 用真实凭证跑一次完整创建 + 回读核验（**需要你确认是否需要「创建即暂停」**）
- 资产中心（素材 / 应用 / 落地页 / 人群包本地索引）—— 目前素材 ID 需手工填
- 创编模板中心（命名规则、预算出价模板、定向模板）
- 任务结果导出（Excel）

**P2 待做（监控告警）：**
- 数据落库 + 水位线增量同步
- 小时/天宽表
- 规则引擎 + 告警推送（企微/飞书/邮件）
- 一键处置

**P3 待做（桌面化）：**
- Electron 主进程壳（fork 本后端进程 + 动态端口 + 单实例锁）
- `electron-builder` 打 NSIS 安装包
- secret 改用 Windows DPAPI（`safeStorage`）存储

---

## 验收自查

```
✓ 后端零类型错误编译；前端 tsc --noEmit 零错误 + vite build 通过
✓ 数据库迁移成功（AppConfig / AuthGrant / OauthAccount / AuditLog / SyncWatermark）
✓ secret 密文落库（v1:iv:tag:cipher），接口响应掩码
✓ 三条授权链接域名与参数全部正确（oauth_type 为官方必填参数，漏传报「授权类型不应为空」）：
    LUOPAN      → developers.e.kuaishou.com/tools/authorize&oauth_type=advertiser
    ADVERTISER  → developers.e.kuaishou.com/tools/authorize&oauth_type=advertiser
    AGENT       → developers.e.kuaishou.com/tools/authorize&oauth_type=agent
✓ 不传 / 非法 authEntry 均安全回落 LUOPAN，不报错
✓ 代理商入口强制 authType=USER（该入口无授权方式可选）
✓ state 编码/解析双向验证 + 向后兼容旧格式 <随机>.<AUTH_TYPE>
✓ 未配置时接口返回 428 + NOT_CONFIGURED，前端可识别
✓ 三层令牌桶水位正常（全局 / 查询 / 创编 / 创意 / 批量 分桶隔离）
✓ 授权类调用已留痕，requestJson 中 secret / auth_code 均为 ***
✓ 真实请求验证 approval/list 传参方式（body 正确、header 会被拒）
✓ 错误分类改进：402012 由 UNKNOWN 修正为 PERMISSION

P1（批量上计划）：
✓ 前后端零类型错误；vite build 通过
✓ 粘贴解析器 23 项断言全过（带表头 / 不带表头 / type=5 链路 / 空单元格回落默认值 / 边界）
✓ 校验器逐行逐字段验证（2 行数据 → 11 错 2 警）
✓ 请求映射验证：1000 元 → 1000000 厘；空字段被剔除；type=16 固定 conversion_type=6
✓ 任务引擎父子依赖验证：计划失败 → 组/创意标 SKIPPED 且 attempts=0（不白调接口）
✓ 干跑任务：状态 DONE，skipped=3
✓ 失败分类验证：未授权账户 → TOKEN_INVALID（而非 UNKNOWN），前端可给出正确处置建议
✓ 真实平台验证：`/gw/dsp/campaign/list` 返回 code=0（账户 124276382）
✓ 映射器字段逐个对照官方文档核实（组层 40+ 字段、创意层 27 字段、target 子字段全部吻合）
✓ 创建后状态：暂停模式落库 `put_status=2`、投放模式 `put_status=1`；计划/创意层请求体不含状态字段（符合契约）
✓ 三层状态更新路径按官方文档核实并纠正（`/v1/` 而非 `/gw/dsp/`）
✓ **真实创建全链路**：计划/组/创意三层真实创建成功，回读核验 3/3 通过
✓ **创建即暂停真实生效**：反查三层 `put_status` 均为 2
✓ 修出 3 个真问题：状态更新重复传 ID、401000 未入错误码表、状态更新响应 errors 未检查
✓ 按官方「报错 code 枚举值」补全错误码表（30+ 条），前端失败建议覆盖限流/权限/参数/凭证四类
```
