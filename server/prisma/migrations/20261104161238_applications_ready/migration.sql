-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_applications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "sessionId" TEXT,
    "screenshotBefore" TEXT,
    "screenshotAfter" TEXT,
    "result" TEXT,
    "note" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_applications" ("costMicros", "finishedAt", "id", "inputTokens", "jobId", "outputTokens", "result", "screenshotAfter", "screenshotBefore", "sessionId", "startedAt", "status") SELECT "costMicros", "finishedAt", "id", "inputTokens", "jobId", "outputTokens", "result", "screenshotAfter", "screenshotBefore", "sessionId", "startedAt", "status" FROM "applications";
DROP TABLE "applications";
ALTER TABLE "new_applications" RENAME TO "applications";
CREATE INDEX "applications_jobId_idx" ON "applications"("jobId");
CREATE INDEX "applications_status_idx" ON "applications"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "questions_telegramMessageId_idx" ON "questions"("telegramMessageId");
