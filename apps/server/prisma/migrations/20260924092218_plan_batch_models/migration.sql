-- CreateTable
CREATE TABLE "PlanDraft" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "campaignType" INTEGER NOT NULL DEFAULT 2,
    "rowsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BatchTask" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "draftId" INTEGER,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BatchTaskItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taskId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "parentId" INTEGER,
    "rowNo" INTEGER NOT NULL DEFAULT 0,
    "payloadJson" TEXT NOT NULL,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "platformId" TEXT,
    "idemKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCode" INTEGER,
    "errorKind" TEXT,
    "errorMessage" TEXT,
    "verifyStatus" TEXT NOT NULL DEFAULT 'NONE',
    "verifyDiff" TEXT,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BatchTaskItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "BatchTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BatchTask_status_idx" ON "BatchTask"("status");

-- CreateIndex
CREATE INDEX "BatchTask_createdAt_idx" ON "BatchTask"("createdAt");

-- CreateIndex
CREATE INDEX "BatchTaskItem_taskId_status_idx" ON "BatchTaskItem"("taskId", "status");

-- CreateIndex
CREATE INDEX "BatchTaskItem_advertiserId_idx" ON "BatchTaskItem"("advertiserId");

-- CreateIndex
CREATE INDEX "BatchTaskItem_verifyStatus_idx" ON "BatchTaskItem"("verifyStatus");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskItem_taskId_idemKey_key" ON "BatchTaskItem"("taskId", "idemKey");
