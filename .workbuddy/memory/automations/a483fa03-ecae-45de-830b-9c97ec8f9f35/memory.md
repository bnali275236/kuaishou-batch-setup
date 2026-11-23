# 每日基建自动化执行记录（daily-build）

## 2026-11-11 09:48
- 退出码 **1**，未建任何计划
- 根因：**后端 127.0.0.1:7801 未启动**（netstat 无监听，node fetch 直连 ECONNREFUSED，进程表无 server 进程）
- 脚本首步调素材榜即 `fetch failed` → 走失败分支，钉钉群已收到「复投计划未创建 / 素材榜拉取失败」告警卡片
- 按"在线才重试"的约束未重试；未尝试拉起后端（长驻服务需用户双击 启动网页版.cmd，会话内起的进程会被回收）
- 昨日 `date is not defined` 崩溃点本次未触发（未走到该分支），幂等仍不认 DONE 的问题未复核

## 2026-11-10 09:58
- 退出码 **1**（非 PARTIAL，属脚本自身运行时 bug）
- 建计划本身成功：任务 id=15「跑量复投-1110（自动）」status=DONE 18/18，386/387 各 7 条素材，计划 12595671753 / 12595671903 已确认投放中
- 失败点：`tools/daily-build.cjs:361` `ReferenceError: date is not defined`（效果台账 recordAction 里用了未定义变量），崩溃在钉钉 pushDingtalk 之前 → **卡片未推送**，台账未登记
- ⚠️ 幂等缺陷：`alreadyDone()` 只认 RUNNING/SUCCESS/PARTIAL，**不认 DONE** → 当日重跑会重复建 2 条计划。故本次未执行"失败重试一次"，避免重复投放
- 待用户决定是否修脚本（本任务约束为只读，未改任何文件）
