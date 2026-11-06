-- 账户名称同步时间：支持周期性刷新「平台侧已改名」的账户
-- （此前只补 accountName 为空的账户，已改名但本地有旧名称的账户永远不会更新）
ALTER TABLE "OauthAccount" ADD COLUMN "nameSyncedAt" DATETIME;
