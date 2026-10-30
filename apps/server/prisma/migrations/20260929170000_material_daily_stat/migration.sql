-- 素材日报：素材看板的历史数据底座，永久留存不清理
-- 唯一键 = 账户 × 素材 × 日期（同日重复同步走 upsert 覆盖）
CREATE TABLE "MaterialDailyStat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "advertiserId" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "statDate" TEXT NOT NULL,
    "materialName" TEXT,
    "photoUrl" TEXT,
    "coverUrl" TEXT,
    "caption" TEXT,
    "materialType" INTEGER,
    "charge" REAL NOT NULL DEFAULT 0,
    "show" INTEGER NOT NULL DEFAULT 0,
    "photoClick" INTEGER NOT NULL DEFAULT 0,
    "bclick" INTEGER NOT NULL DEFAULT 0,
    "activation" INTEGER NOT NULL DEFAULT 0,
    "registerCount" INTEGER NOT NULL DEFAULT 0,
    "conversionNum" INTEGER NOT NULL DEFAULT 0,
    "playedNum" INTEGER NOT NULL DEFAULT 0,
    "play3sRatio" REAL NOT NULL DEFAULT 0,
    "playEndRatio" REAL NOT NULL DEFAULT 0,
    "rawJson" TEXT,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MaterialDailyStat_advertiserId_photoId_statDate_key" ON "MaterialDailyStat"("advertiserId", "photoId", "statDate");

-- CreateIndex
CREATE INDEX "MaterialDailyStat_statDate_idx" ON "MaterialDailyStat"("statDate");

-- CreateIndex
CREATE INDEX "MaterialDailyStat_photoId_idx" ON "MaterialDailyStat"("photoId");

-- CreateIndex
CREATE INDEX "MaterialDailyStat_advertiserId_statDate_idx" ON "MaterialDailyStat"("advertiserId", "statDate");
