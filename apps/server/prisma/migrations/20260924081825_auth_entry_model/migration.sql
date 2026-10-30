-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuthGrant" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "label" TEXT,
    "authEntry" TEXT NOT NULL DEFAULT 'LUOPAN',
    "authType" TEXT NOT NULL DEFAULT 'ACCOUNT',
    "declaredAuthType" TEXT,
    "subjectId" TEXT,
    "subjectName" TEXT,
    "scopesJson" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "accessTokenExpiresAt" DATETIME NOT NULL,
    "refreshTokenExpiresAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "lastSyncedAt" DATETIME,
    "accountCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AuthGrant" ("accessTokenEnc", "accessTokenExpiresAt", "accountCount", "authType", "createdAt", "declaredAuthType", "id", "label", "lastError", "lastSyncedAt", "refreshTokenEnc", "refreshTokenExpiresAt", "scopesJson", "status", "subjectId", "subjectName", "updatedAt") SELECT "accessTokenEnc", "accessTokenExpiresAt", "accountCount", "authType", "createdAt", "declaredAuthType", "id", "label", "lastError", "lastSyncedAt", "refreshTokenEnc", "refreshTokenExpiresAt", "scopesJson", "status", "subjectId", "subjectName", "updatedAt" FROM "AuthGrant";
DROP TABLE "AuthGrant";
ALTER TABLE "new_AuthGrant" RENAME TO "AuthGrant";
CREATE INDEX "AuthGrant_status_idx" ON "AuthGrant"("status");
CREATE INDEX "AuthGrant_authEntry_idx" ON "AuthGrant"("authEntry");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
