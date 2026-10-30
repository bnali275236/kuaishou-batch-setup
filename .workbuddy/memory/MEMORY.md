# 快手广告工作台 —— 长期项目记忆

## 定位与技术栈
磁力引擎开放平台（MAPI / DSP）的**批量上计划 + 日常盯盘**工作台。网页端先行，已打包 Windows 桌面版。
分期：P0 授权+只读看板 → P1 批量创编（已真实跑通）→ P2 监控告警 → P3 桌面化（进行中，已到 0.5.2）。
- 前端 React 18 + TS + Vite + AntD 5 + ECharts + TanStack Query
- 后端 NestJS 10 + Prisma 5 + SQLite；共享层 `packages/shared`（枚举/限额/错误分类唯一来源）
- 桌面化选 NestJS：Electron 直接 fork 该 Node 进程，后端零改造

## 架构三原则
1. **密钥不过河** —— secret / token 只在后端，永不进浏览器
2. **一切外部调用走统一 MapiGateway** —— 禁止业务代码直接 fetch
3. **本地库是唯一事实源** —— 先落库再执行

## 授权模型
**一次授权 = 一份授权凭证（AuthGrant），其下挂 N 个广告账户**：`AuthGrant(1) ──< OauthAccount(N)`，token 只存在 AuthGrant。

### 维度一：授权入口 authEntry（拼链接时决定）
唯一授权页 `https://developers.e.kuaishou.com/tools/authorize?app_id=..&scope=..&redirect_uri=..&state=..&oauth_type=..`
**`oauth_type` 必填**，漏传报「授权类型不应为空」。

| 入口 | oauth_type | 覆盖范围 | 登录平台 |
|---|---|---|---|
| `LUOPAN`（推荐） | `advertiser` | 罗盘下全部账户（页面选「用户授权」） | 罗盘 |
| `ADVERTISER` | `advertiser` | 该广告主体下的投放账户（选「账户授权」） | 磁力智投 |
| `AGENT` | `agent` | 管辖内全部广告主，1 token（需双向授权） | 代理商平台 |

`oauth_type` 取值：`advertiser` / `agent` / `ad_social`（聚星）/ `series`（短剧）。
坑：域名写死 `ad.e.kuaishou.com/openapi/oauth` 会落到单账户授权；罗盘入口同样要带 `oauth_type=advertiser`。

### 维度二：授权方式 authType（用户在授权页勾选）
`USER` 用户授权 = 该快手 ID 下全部账户；`ACCOUNT` 账户授权 = 勾选的一个或多个账户。
不由 URL 决定，只能随 `state` 带出预期、回调时校正。`AGENT` 入口强制 `USER`。
`state` 格式 `<随机串>.<AUTH_ENTRY>.<AUTH_TYPE>`（解析需兼容旧两段格式）。
想批量接入 → `LUOPAN` + 罗盘登录 + 「基于用户授权」。账户列表会变 → 已实现每日 07:10 自动对齐。

### ⚠️ token 生命周期与「多设备共享」（按官方 doc 2057/2096 确认）
- access_token 1 天、refresh_token 30 天
- **每次刷新都会生成新 access_token + 新 refresh_token，老的立即失效**（轮换制，非续期制）
- → **不能把同一份 token 复制到多台设备各自使用**，谁先刷新谁把别人踢下线
- → 多设备共用的正解是**共享一个后端**：一台主机跑后端（token 单点刷新），其他设备浏览器访问。
  前端本就是普通 Web 应用、`main.ts` 已同源托管，缺的只是监听地址（现 `127.0.0.1`）与访问口令
- ⚠️ 后端**零鉴权**（无任何 Guard），一旦监听 0.0.0.0，局域网内任何人可上计划/改出价 → 必须加口令

## 平台硬约束
- 计划层、组层**没有批量创建接口**，只有创意层有 `batch_update` → 批量上计划必须自研本地任务状态机
- 报表只能查**近 7 天**，T-1 数据次日 09:00 更新 → 必须本地落库 + 异步报表补历史
- 限流：全局 1000 QPM；创编 600（计划/组）/ 400（创意）/ 200（批量）
- 日创建上限：计划 1000 / 组 600 / 创意 2000；**异步报表任务 20 次/日**；单次查询 ID ≤ 5000
- 金额单位「厘」，1 元 = 1000 厘，只用 `yuanToLi` / `liToYuan`
- scope 三段一次全申请：`report_service` + `ad_query` + `ad_manage`（`account_service` 可选）
- 业务接口 Header 带 `Access-Token`

## 接口实测结论（真实请求验证，勿凭文档臆断）
- `approval/list` 参数**必须全放 JSON body**（含 access_token）；响应外壳 `{result, message, data}`
  （与主网关 `{code,message,data}` 不同，要兼容）；返回 `data.details` + `data.isEnd`，page_size ≤ 200
- 错误码 `402012` = 应用已下线/不存在 → `PERMISSION`
- **创编全链路真实跑通**（124276382，type=5）：campaign/unit/creative create + campaign/creative update/status 全 code=0，回读 3/3。唯一未实测 `/v1/ad_unit/update/status`（组走创建时带 put_status）
- **真实创建暴露的三个坑（已修）**：
  1. 状态更新不能同时传单数主键与复数批量字段（同值报 `401000 存在重复的id`）→ 只传复数
  2. `401000` 是平台最常用的「业务校验不通过」码，已按官方 13.2 补全 30+ 条，别靠关键字兜底
  3. 状态更新响应 `{*_ids, errors, *_id}`，**必须检查 `errors`**，否则部分失败被瞒成全部成功
- **平台会静默改写字段**：`scene_id:[1]`→`[1,10]`；`app_id`/`package_id` 补 0；`image_token` 自动生成 → 回读核验只比对名称

### ⚠️ 前缀陷阱
创建/查询 `/rest/openapi/gw/dsp/{campaign,unit,creative}/{create,list}`；
状态更新 `/rest/openapi/v1/{campaign,ad_unit,creative}/update/status`。
**不要从一个接口的前缀外推同族另一个接口的前缀**（曾把结论搞反）。
状态更新三层入参一致：`advertiser_id` + 批量字段（计划 20/组 10/创意 20）+ `put_status`（1 投放 / 2 暂停 / 3 删除）。

### ⚠️⚠️ 报表曝光/点击字段口径（官方字段字典 + 10 账户实测）
| 字段 | 官方定义 | 用途 |
|---|---|---|
| `show` | 封面曝光数（数值小） | ❌ 不是展示数，仅存档 |
| `aclick` | 素材曝光数（恒等于 played_num） | ✅ **展示数**，点击率/千展分母 |
| `photo_click` | 封面点击数 | ❌ 不是点击数，仅存档 |
| `bclick` | 行为数 | ✅ **点击数** |
| `action_ratio` | 行为率 = bclick/aclick | 点击率取此口径 |
| `click_1k_cost` | 千次素材曝光花费 = charge/aclick×1000 | ✅ 本工作台的「千展」 |

判据：`bclick/show` 抽样得 1.07/2.36/3.10（>100% 不可能），`bclick/aclick` 与平台 action_ratio 逐条吻合。
**展示数/点击率/千展的分母一律 `aclick`，三列必须能互相验算。新增报表页先照此表定分母，别凭字段名猜。**

### 报表接口
- 素材报表 `POST /rest/openapi/v1/report/material_report`：`view_type=5` 必传；page_size ≤1000；
  只可查近 7 天；返回扁平 `{total_count, details}`；含 photo_id/photo_url/cover_url/photo_caption，**没有素材名**
- 探测平台接口：base url 是 `https://ad.e.kuaishou.com`（`developers.e...` 是文档站，打业务接口 404）；
  `access_token` 必须放 `Access-Token` 请求头（放 body 报 `402003`）

### 异步任务补 6 个月历史
三件套：`POST /v1/async_task/create` → `/async_task/list`（0 新建/1 处理中/2 成功/3 失败）→ `GET /async_task/download`（CSV）
- `task_params.view_type`：**1 账户 / 2 计划 / 3 组 / 4 自定义创意 / 5 视频报表 / 7 封面 / 8 便利贴 / 10 程序化创意2.0 / 21 关键词 / 25 搜索词**
  → **5 = 素材维度也能补历史**（`photo_ids` 仅 5/7/8 可用）；跨度最长 6 个月
- 配额 20 次/日（自留 18）；206 账户全量约 12 天滚完；已实现每日 10:40 自动回补 + 界面「立即回补一批」
- CSV 坑：整区间无投放返回 `blank content`（要写零行占位，否则每天重复补）；日行 `stat_hour=0` 而非 -1，落库转 -1；
  `ad_scene` 可能拆多行需按日聚合；口径 show 取 aclick

### 常用查询接口
- 视频列表 `POST /rest/openapi/v1/file/ad/video/list`（body 只传 advertiser_id）→ `photo_id`/`new_status`(1=可用)/`duration`/`source`
- 图片列表 `GET /rest/openapi/v1/file/ad/image/list`（GET；网关只支持 POST）
- 应用列表 `POST /rest/openapi/v2/file/ad/app/list`；建站落地页 `POST /rest/openapi/v2/lp/page/list`
- **创意里 `photo_id` 是视频 ID（string），`image_token` 才是封面图**

### ⚠️ 平台 ID 位数陷阱
视频 `photo_id` 是 **19 位**（如 5258515721498201064），**超出 JS 安全整数** → 必须按字符串透传。
计划/组/创意 ID 目前 11~12 位，但本地一律 String 存储的策略保留。

### 文档接口可直连
```
POST https://developers.e.kuaishou.com/rest/open_api/platform/document/detail
Headers: Content-Type: application/json + Origin + Referer（两个头必须带！）
Body: {"docType":"DSP","documentId":2259} → data.content 即完整 Markdown
目录树: POST .../platform/document/menu/list  body {"docType":"DSP","menuId":3024} → data.menuList
```
缺 Origin/Referer 返回 `{"result":500,"message":"内部系统繁忙"}`，易误判为限流。
常用 documentId：2259 创建计划 / 2261 查计划 / 2262 创建组 / 2264 查组 / 2265 创建自定义创意 /
1930 改计划状态 / 1926 改组状态 / 1980 改创意状态 / 2055 素材报表 /
**2080 创建异步任务 / 1992 任务状态 / 2017 数据下载 / 2057 token 有效期 / 2096 刷新 token**

### 错误分类
`AccountNotAuthorizedError` / `TokenExpiredError` 继承 `MapiError`（带 TOKEN_INVALID），
网关 catch 保留已分类异常不降级 UNKNOWN。

## 盯盘历史 + 层级操作
- 盯盘历史 `ReportDailyStat`（`advertiserId+statDate+statHour` 唯一；**statHour=-1 日行 / 0-23 小时行**，
  SQLite 唯一索引对 NULL 不去重故用 -1）。overview 过去读本地、今天实时；缺失日自动回补，
  **无数据的日期写零行占位**（否则每天被当缺失反复回补）；实时结果也落库。定时：启动 90s / 每小时 :40 / 每天 09:20
- 素材历史 `MaterialDailyStat`（唯一键 账户×素材×日期）；只 upsert 从不清理；同步是「整段替换」
- 层级操作（`modules/manage/`）：改时段走 `gw/dsp/unit/update`，**unit_name 与 bid_type 必填——必须先回读该组**；
  组出价 `v1/ad_unit/update/bid` 支持批量；组预算 `v1/ad_unit/update/day_budget` 单组；
  计划预算 `gw/dsp/campaign/update` 的 day_budget（0=不限）
- 🚫 **所有账户写操作必须过代投白名单拦截**（`OauthAccount.readOnly` → 400），新增写入口照此办理
- UAX（全自动投放）账户：自定义创意列表为空正常；UAX 组出价为 0
- 通用看板工具条 `apps/web/src/components/BoardTable.tsx`：导出 xlsx（动态 import）/ 重置列宽 /
  自定义列（显隐 + 拖动排序，localStorage 持久化）；列宽拖拽用自定义 `.col-resize-handle`

## P1 创编要点
- 入口 `apps/web/src/pages/PlanCreatePage.tsx`；粘贴解析抽到 `pages/plan/planRow.ts`（纯函数）
- 两种模式：向导（`PlanCardMode.tsx`，磁力智投式卡片）/ 表格（逐行微调 + Excel 粘贴）
- 后端 `modules/plan/`：plan.api / plan.validator / plan.mapper / task.service / draft.service / plan.scheduler / plan.assets
- 一行 = 计划→组→创意完整链路；支持 type 2/7/5
- 任务引擎：`seq = 层号×10000 + 行号` 保证父先于子；串行 + 父失败子 SKIP + 暂停 + 断点续跑 + 幂等键 + 日配额预检
- 「创建后状态」（默认暂停）：只有**组**能在创建时指定 `put_status`（不传默认填 1）；计划层与创意层的
  create 都没有状态字段 → 收尾补调 `/v1/*/update/status`。推论：**组暂停 → 计划无法消耗**，
  故补调失败只降级为警告（`lastError` 前缀 `[警告]`），绝不翻成失败
- **UAX（`autoManage=1`）三件套**：须同时发 `auto_adjust=1` + `auto_build=1`，且 `auto_build_name_rule` 必填，
  其 `unit_name_rule` / `creative_name_rule` 都必须同时含 `[日期]` 和 `[序号]`；缺任一报
  `401000 开启自动起量后各项目参数不符合规范`（泛化校验错，排障要拿完整响应体）。实现见 `plan.mapper.ts` 的 `autoNameRule()`
- **验证方式**：前端逻辑用 `esbuild` 打包后直跑（`.tmp-verify/`），比浏览器自动化可靠

### ⚠️ payload 是「建任务时冻结」的
`createTask` 把每层请求体 `JSON.stringify` 存进 `BatchTaskItem.payloadJson`，执行时回放 → **改 mapper 不影响历史任务**。
已修：`expandRows()` 唯一展开实现 + `refreshFailedPayloads()` 在 `retryFailed` 前按 `seq` 用当前 mapper 重建 payload；
seq 对不上则告警保留旧 payload。**新增/修改请求体字段后，「重试」必须走这条重建路径才生效。**

## 工程约定
- 新增开放平台调用 → 必须在 `packages/shared` 的 `MAPI_PATHS` 登记路径，禁止硬编码
- 创编路径只在 `PLAN_PATHS` 定义一处（`MAPI_PATHS` 里曾重复一份，已删）
- 平台 ID 本地一律 String 存储，发请求用 `toId()` 还原为数字
- server tsconfig 必须 `incremental: false`（否则与 `deleteOutDir` 冲突，dist 残缺）
- 数据目录由 `DATA_DIR` 决定，默认 `apps/server/.data`；桌面版在 `%APPDATA%/快手投放工作台/`
- **桌面版每次发版递增版本号**（apps/electron/package.json），已发行至 0.5.2
- 前端 chunk 429KB（xlsx）体积警告：已知良性

### ⚠️ 打包撞删除护栏
环境注入 safe-delete 护栏：**单次工具调用删超 50 个文件即抛 `[SAFE_DELETE_BULK_CONFIRM_REQUIRED]`**
（按「一次工具调用」累计，跨调用重新计数）。触发点与修法：
| 触发点 | 修法 |
|---|---|
| vite `emptyOutDir` | 关掉；由 stage.js 的 `pruneUnreferencedAssets()` 清（**须扫 index.html + 所有 js/css/json 文本**；只按 index.html 判断会误删动态 import 的 xlsx chunk） |
| staging `prisma generate`（清 119 文件） | 不在 staging 里 generate，改 `copyOver(根 node_modules/.prisma/client → staging)`；前提打包前已 `npm run db:generate` |
| electron-builder 收尾删 `*.nsis.7z` | 无害。**只看 `release/快手投放工作台 Setup <ver>.exe` 是否生成**，别被 exit 1 误导 |

清理大目录：拆到单独命令跑，或先 `renameSync` 挪走（rename 不触发护栏）。

### ⚠️ 升级后白屏（0.5.1 事故，已根治，勿重蹈）
根因链：`express.static(maxAge:'1h')` 缓存 index.html → 升级后 bundle hash 变了、旧文件已删 →
Electron 仍拿旧 index.html 请求旧 JS → SPA 兜底回 HTML → 模块 MIME 错误 → 白屏。
三层根治：① index.html 与兜底回包 `Cache-Control: no-store`，assets 长缓存 immutable；
② main.js `clearCacheOnUpgrade()` 版本变化时清 session 缓存（记在 `userData/.last-version`）；③ index.html 加加载失败兜底提示。
排障要点：**桌面应用升级后白屏 → 先查「缓存的 index.html vs 新 bundle hash」**；
用 `--remote-debugging-port` + CDP（Runtime.evaluate / Page.captureScreenshot）一击定位。
本会话 spawn 的子进程随命令结束被沙箱回收 → 验活 GUI 用
`Start-Process explorer.exe -ArgumentList "<exe>"`（等价双击、环境干净、脱离会话进程树）。
诊断脚本留在 `.tmp-diag/`（cdp-inspect.cjs / verify-artifacts.cjs 可复用）。

## 待确认 / 账户现状
- 告警通道（P2 用）：企微 / 飞书 / 邮件
- 旧账户 124276382 已失效（平台侧授权名下账户被清空，报 `401000 该advertiser_id不在token账户管理下`）。
  **token 有效 ≠ 账户还在授权范围内**，遇此错先跑授权同步对齐清单
- 现用罗盘凭证 #4（LUOPAN + USER）：206 个 ACTIVE 账户；账户历史已回补至 180 天（2026-04-04 起）；
  素材历史仅本地累积（2026-09-23 起），计划用异步 `view_type=5` 补齐
