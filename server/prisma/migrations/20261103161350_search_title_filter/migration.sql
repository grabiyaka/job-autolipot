-- AlterTable
ALTER TABLE "searches" ADD COLUMN "excludeTitle" TEXT;
ALTER TABLE "searches" ADD COLUMN "includeTitle" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_search_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "searchId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME NOT NULL,
    "pages" INTEGER NOT NULL,
    "seen" INTEGER NOT NULL,
    "fresh" INTEGER NOT NULL,
    "filtered" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL,
    "invalid" INTEGER NOT NULL,
    "stopped" TEXT NOT NULL,
    "error" TEXT,
    CONSTRAINT "search_runs_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "searches" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_search_runs" ("created", "duplicates", "error", "finishedAt", "fresh", "id", "invalid", "pages", "searchId", "seen", "startedAt", "stopped") SELECT "created", "duplicates", "error", "finishedAt", "fresh", "id", "invalid", "pages", "searchId", "seen", "startedAt", "stopped" FROM "search_runs";
DROP TABLE "search_runs";
ALTER TABLE "new_search_runs" RENAME TO "search_runs";
CREATE INDEX "search_runs_searchId_startedAt_idx" ON "search_runs"("searchId", "startedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
