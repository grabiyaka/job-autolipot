-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_searches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "location" TEXT,
    "includeTitle" TEXT,
    "excludeTitle" TEXT,
    "easyApplyOnly" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "searches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_searches" ("createdAt", "enabled", "excludeTitle", "id", "includeTitle", "keywords", "location", "source", "updatedAt", "userId") SELECT "createdAt", "enabled", "excludeTitle", "id", "includeTitle", "keywords", "location", "source", "updatedAt", "userId" FROM "searches";
DROP TABLE "searches";
ALTER TABLE "new_searches" RENAME TO "searches";
CREATE INDEX "searches_userId_idx" ON "searches"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
