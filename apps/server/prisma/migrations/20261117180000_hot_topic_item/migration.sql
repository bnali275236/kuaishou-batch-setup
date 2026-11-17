-- 实时热点：各平台热榜最新快照（每次抓取按平台整表替换，历史不入库——看实时即可）
CREATE TABLE "HotTopicItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "platform" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "hotValue" TEXT,
    "url" TEXT,
    "fetchedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "HotTopicItem_platform_rank_key" ON "HotTopicItem"("platform", "rank");
CREATE INDEX "HotTopicItem_platform_idx" ON "HotTopicItem"("platform");
