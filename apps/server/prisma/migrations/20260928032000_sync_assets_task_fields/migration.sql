-- 同步第 15~20 轮新增的资产表与任务字段（PlanDraft.formJson、BatchTask.rowsJson/hidden、TargetPackage/CopyPackage/MonitorPackage）
-- AlterTable
ALTER TABLE "PlanDraft" ADD COLUMN "formJson" TEXT;

-- CreateTable
CREATE TABLE "TargetPackage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "targetingJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CopyPackage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "titlesJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MonitorPackage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "clickUrl" TEXT NOT NULL DEFAULT '',
    "impressionUrl" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BatchTask" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "draftId" INTEGER,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "initialStatus" TEXT NOT NULL DEFAULT 'PAUSED',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "rowsJson" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_BatchTask" ("createdAt", "draftId", "dryRun", "failed", "finishedAt", "id", "initialStatus", "lastError", "name", "skipped", "startedAt", "status", "succeeded", "totalItems", "updatedAt") SELECT "createdAt", "draftId", "dryRun", "failed", "finishedAt", "id", "initialStatus", "lastError", "name", "skipped", "startedAt", "status", "succeeded", "totalItems", "updatedAt" FROM "BatchTask";
DROP TABLE "BatchTask";
ALTER TABLE "new_BatchTask" RENAME TO "BatchTask";
CREATE INDEX "BatchTask_status_idx" ON "BatchTask"("status");
CREATE INDEX "BatchTask_createdAt_idx" ON "BatchTask"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

