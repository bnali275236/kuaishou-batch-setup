-- CreateTable
CREATE TABLE "AppConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "appId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuthGrant" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "label" TEXT,
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

-- CreateTable
CREATE TABLE "OauthAccount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "advertiserId" TEXT NOT NULL,
    "accountName" TEXT,
    "grantId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "whiteListJson" TEXT,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OauthAccount_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "AuthGrant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "action" TEXT NOT NULL,
    "advertiserId" TEXT,
    "path" TEXT,
    "requestJson" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "code" INTEGER,
    "message" TEXT,
    "kind" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SyncWatermark" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "advertiserId" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "lastSyncAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "AuthGrant_status_idx" ON "AuthGrant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OauthAccount_advertiserId_key" ON "OauthAccount"("advertiserId");

-- CreateIndex
CREATE INDEX "OauthAccount_grantId_idx" ON "OauthAccount"("grantId");

-- CreateIndex
CREATE INDEX "OauthAccount_status_idx" ON "OauthAccount"("status");

-- CreateIndex
CREATE INDEX "AuditLog_advertiserId_createdAt_idx" ON "AuditLog"("advertiserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncWatermark_advertiserId_reportType_key" ON "SyncWatermark"("advertiserId", "reportType");
