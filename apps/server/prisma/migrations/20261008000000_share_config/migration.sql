-- 局域网共享配置（单行表）
-- 与 AppConfig 同样只存一行（id=1），口令用 scrypt 哈希后落库
CREATE TABLE "ShareConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "passwordHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
