# 自动化执行记录 · 快手日终小结（23:30）

## 2026-11-07 首跑
- 命令 `node tools/monitor.cjs --eod` 退出码 0，钉钉卡片已推送成功（dws success=true）。
- **但数据全空**：386/387 两个账户 `/api/report/level/account` 均返回 HTTP 502，
  `kind=TOKEN_INVALID`「本地鉴权检查未通过，未调用平台接口」。
- 排查（只读）：7801 在线（root=200）；grant #6 状态 ACTIVE，access 有效至 11-08 15:09（京），
  refresh 剩 29 天；**127 个 OauthAccount 全部为 DISABLED**，activeAccountCount=0，
  lastSyncedAt = 11-07 07:10（京）→ 判断为当日 07:10 账户同步把全部账户置灰。
- 处置决定：**未重试**。理由：退出码非失败；重试为确定性同结果（账户状态未变）；
  且 `eod()` 无去重键，重试会向真实群再推一张 0 消耗误报卡。
- 结论：当日卡片「消耗 0 / 激活 0」是取数失败，非真实零消耗，不可作为经营结论。
- 待用户处理：UI 账户管理「同步账户」或重新罗盘授权恢复 ACTIVE，再手动重跑 eod 补数据。

## 复用要点
- 遇 502/TOKEN_INVALID 先查 `/api/oauth/accounts` 的 status 分布，不要只看 grant.status
  与 accessTokenExpiresAt（两者都正常时账户仍可能全 DISABLED）。
- `eod` 无当日去重，重跑即重复发群；`daily` 有 state.sent 去重。

## 2026-11-08 第二跑
- 退出码 0，钉钉卡片推送成功（dws success=true），但数据仍异常：
  386/387 均报 `/api/report/level/account → HTTP 502`。
- 账户状态已恢复：127 个 OauthAccount 全部 ACTIVE（昨日全 DISABLED 的问题已解决）。
- **新根因：grant #6 = NEED_REAUTH**，lastError=「刷新 token 失败[402005]：refresh token错误」。
  符合记忆中「约 3 周不启动 refresh 到点就死」的轮换失效模式。
  accessExp 显示 11-09T06:39Z 不可信（刷新失败时被写坏，见长期记忆）。
- 处置：**未重试**（退出码 0 + 结果确定性相同 + eod 无去重，重试只会再发一张异常卡）。
- 待用户处理：重新走罗盘授权（developers.e.kuaishou.com/tools/authorize，oauth_type 必填）
  恢复 grant，之后手动重跑 `node tools/monitor.cjs --eod` 补发当日真实数据。
