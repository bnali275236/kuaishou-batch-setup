-- 盯盘看板历史数据本地留存：账户维度日报（含小时行）
CREATE TABLE "ReportDailyStat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "advertiserId" TEXT NOT NULL,
    "statDate" TEXT NOT NULL,
    "statHour" INTEGER NOT NULL DEFAULT -1,
    "charge" REAL NOT NULL DEFAULT 0,
    "show" INTEGER NOT NULL DEFAULT 0,
    "aclick" INTEGER NOT NULL DEFAULT 0,
    "photoClick" INTEGER NOT NULL DEFAULT 0,
    "bclick" INTEGER NOT NULL DEFAULT 0,
    "conversionNum" INTEGER NOT NULL DEFAULT 0,
    "activation" INTEGER NOT NULL DEFAULT 0,
    "registerCount" INTEGER NOT NULL DEFAULT 0,
    "payCount" INTEGER NOT NULL DEFAULT 0,
    "payFirstDayCount" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ReportDailyStat_statDate_idx" ON "ReportDailyStat"("statDate");

-- CreateIndex
CREATE INDEX "ReportDailyStat_advertiserId_statDate_idx" ON "ReportDailyStat"("advertiserId", "statDate");

-- CreateIndex
CREATE UNIQUE INDEX "ReportDailyStat_advertiserId_statDate_statHour_key" ON "ReportDailyStat"("advertiserId", "statDate", "statHour");
