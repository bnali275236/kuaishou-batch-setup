# 快手广告工作台 —— 长期项目记忆

## 定位与技术栈
磁力引擎开放平台（MAPI/DSP）批量上计划+盯盘工作台。React18+TS+Vite+AntD5+ECharts / NestJS10+Prisma5+SQLite / `packages/shared` 为枚举·限额·错误分类唯一来源。Electron 直接 fork 后端进程。版本已发行至 **0.6.2**。
**运行形态（2026-11-06 起）**：主用「网页版」——双击仓库根目录 `启动网页版.cmd`（纯 ASCII，仅调 `node tools/web-launch.cjs`），后者设 `DATA_DIR=%APPDATA%/快手投放工作台` + `WEB_DIST=apps/web/dist` + 迁移 → 启动后端 7801 同源托管前端。数据与桌面版完全同源；**桌面版与网页版不可同时运行**（token 轮换互踢）。停止：`停止网页版.cmd`。
⚠️ 批处理坑：**.cmd 必须纯 ASCII + CRLF 换行**。中文路径/中文提示在 GBK 控制台下会被读花（曾出现 DATA_DIR 静默失效→连到空开发库、前端 404；LF 换行→单词被截断报 `'ishou' 不是内部命令`）。所有中文路径逻辑放 Node 脚本里（Node 固定 UTF-8）。
已推 Gitee 私有仓库 `Sakura777777/kuaishou-batch-setup`（凭据在 Windows 凭据管理器，直接 git push 即可）。
⚠️ 工具会话里起的后端进程会被回收，长驻服务必须由用户双击启动（或做开机自启）。

## 架构三原则
1 密钥不过河（secret/token 只在后端）2 一切外部调用走统一 MapiGateway 3 本地库是唯一事实源（先落库再执行）

## 授权模型
`AuthGrant(1)──<OauthAccount(N)`，token 只存 AuthGrant。授权页 `developers.e.kuaishou.com/tools/authorize`，**oauth_type 必填**（advertiser/agent/ad_social/series）。
入口：`LUOPAN`（推荐，罗盘+用户授权覆盖全部账户）/ `ADVERTISER`（磁力智投账户授权）/ `AGENT`（agent，强制 USER）。authType 随 state 带出：USER=全部账户 / ACCOUNT=勾选账户；state=`<随机>.<entry>.<type>`（解析兼容两段）。批量接入=LUOPAN+罗盘+「基于用户授权」；账户清单每日 07:10 自动对齐。

## ⚠️ token 生命周期
access 1 天 / refresh 30 天，**刷新即轮换（旧的立即失效）**→ 不能多设备复制 token，只能共享一个后端。约 3 周不启动 refresh 到点就死（NEED_REAUTH + 402005）；`refreshTokenExpiresAt` 不可当真实有效期（刷新失败时被写成 now+30d）。可用性只看 `AuthGrant.status`/`lastError`/返回码（402005 refresh 错 / 402012 应用下线）。**数据全空先查 grant status**，OauthAccount 全 ACTIVE 不代表能用。

## 平台硬约束
计划/组层无批量创建接口（仅创意 batch_update）→ 自研本地任务状态机；实时报表仅近 7 天（T-1 次日 09:00 更新）→ 本地落库+异步补历史；限流 1000 QPM（创编 600/400/200）；异步报表任务 20 次/日；金额单位厘（yuanToLi/liToYuan）；scope 三段一次全申请；业务接口 Access-Token 头。

## 接口实测（勿凭文档臆断）
- approval/list 参数全放 JSON body；外壳 `{result,message,data}`，返回 details+isEnd，page≤200
- 401000=业务校验不通过（已按官方 13.2 补 30+ 条，别关键字兜底）；402012=应用下线
- 状态更新只传复数主键（单复数同传报 401000 重复id）；必须检查响应 `errors`（否则部分失败被瞒成成功）
- 平台会静默改写字段（scene_id/app_id/image_token）→ 回读只比对名称
- **前缀陷阱**：创建/查询 `gw/dsp/{campaign,unit,creative}/*`；状态更新 `v1/{campaign,ad_unit,creative}/update/status`，不可互相外推；三层入参一致：advertiser_id+批量字段+put_status(1/2/3)
- **报表口径**：show=封面曝光（勿用）；**aclick=素材曝光=展示数**（点击率/千展分母）；photo_click 勿用；bclick=点击数；click_1k_cost=千展。三列须可互相验算
- 素材报表 material_report：view_type=5 必传、page≤1000、近 7 天、无素材名
- 业务接口 base=`ad.e.kuaishou.com`；token 放 Access-Token 头（放 body 报 402003）
- 异步任务三件套 create/list/download；view_type：1 账户 / 5 视频（**素材维度可补 6 个月**，photo_ids 仅 5/7/8 可用）；CSV 坑：无投放返回 blank content 要写零行、stat_hour=0 落库转 -1、ad_scene 拆多行按日聚合
- 视频 photo_id 19 位超 JS 安全整数→字符串透传；创意里 photo_id=视频 ID、image_token=封面
- 文档直连：POST `developers.e.../platform/document/detail`，须带 Origin+Referer，body `{docType:"DSP",documentId}`；常用 2259/2262/2265/2080/1992/2017/2057/2096
- `AccountNotAuthorizedError`/`TokenExpiredError` 继承 MapiError，网关保留已分类异常不降级 UNKNOWN

## 盯盘/层级操作
`ReportDailyStat`（账户+日期+statHour 唯一，**-1=日行**）；缺失日写零行占位；定时启动 90s / 每小时 :40 / 09:20。`MaterialDailyStat` 整段替换。改时段须先回读组（unit_name+bid_type 必填）；组出价可批量；组/计划预算单组（计划 0=不限）。🚫 所有账户写操作过 readOnly 拦截。UAX 账户创意列表空正常、组出价 0。

## P1 创编
一行=计划→组→创意链路（type 2/7/5）；任务引擎 seq=层×10000+行，父失败子 SKIP、断点续跑、幂等键。只有**组**能创建时带 put_status → 计划/创意收尾补调 update/status，失败降级警告（[警告] 前缀）。UAX 三件套：auto_adjust=1+auto_build=1+auto_build_name_rule（须含[日期][序号]）。**payload 建任务时冻结** → 重试前必须 `refreshFailedPayloads()` 重建。

## 工程约定
新平台调用须登记 `MAPI_PATHS`；ID 一律 String 存储（toId 还原）；server tsconfig `incremental:false`；发版递增 electron 版本号；xlsx chunk 体积警告良性。迁移用 `prisma migrate deploy`（CLI 在根 `node_modules/prisma/build/index.js`）。

## ⚠️ 打包护栏（单次调用删>50 文件即抛错）
vite emptyOutDir 关掉、由 stage.js `pruneUnreferencedAssets()` 清（须扫全部文本防误删 xlsx chunk）；staging 不跑 prisma generate 改 copyOver（打包前先 db:generate）；electron-builder 尾部 exit 1 无害，只看 `release/快手投放工作台 Setup <ver>.exe` 是否生成。

## ⚠️ 升级白屏（0.5.1 事故已根治）
根因 express.static 缓存 index.html → 新 bundle hash 失配 → MIME 白屏。三层根治：no-store / clearCacheOnUpgrade / 加载失败兜底提示。排障用 `--remote-debugging-port`+CDP；GUI 验活用 `Start-Process explorer.exe`。诊断脚本在 `.tmp-diag/`。

## 账户现状
124276382 已失效（**token 有效 ≠ 账户在授权范围内**）。现用罗盘凭证 #6（LUOPAN+USER）127 账户 ACTIVE。账户名称同步（0.6.2）：`OauthAccount.nameSyncedAt`，回填先补缺失、再刷 >24h 最旧优先；账户行有「刷新名称」按钮（POST /api/oauth/accounts/:id/refresh-name）。

## 待确认
告警通道（P2 用）：企微 / 飞书 / 邮件；素材看板 6 个月回溯方案已定未实施。
