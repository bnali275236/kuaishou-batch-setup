-- CreateTable
CREATE TABLE "CreativeAttribute" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "advertiserId" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "creativeName" TEXT,
    "campaignId" TEXT,
    "unitId" TEXT,
    "description" TEXT,
    "plcDescription" TEXT,
    "categoryName" TEXT,
    "tagsJson" TEXT,
    "actionBarText" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShareConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "passwordHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ShareConfig" ("createdAt", "enabled", "id", "passwordHash", "updatedAt") SELECT "createdAt", "enabled", "id", "passwordHash", "updatedAt" FROM "ShareConfig";
DROP TABLE "ShareConfig";
ALTER TABLE "new_ShareConfig" RENAME TO "ShareConfig";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CreativeAttribute_advertiserId_idx" ON "CreativeAttribute"("advertiserId");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeAttribute_advertiserId_creativeId_key" ON "CreativeAttribute"("advertiserId", "creativeId");
