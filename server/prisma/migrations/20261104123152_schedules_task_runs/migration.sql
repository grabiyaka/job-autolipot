-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Dublin',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "options" TEXT,
    "lastRunAt" DATETIME,
    "lastStatus" TEXT,
    "lastSummary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "schedules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "task_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "scheduleId" TEXT,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    CONSTRAINT "task_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "task_runs_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "schedules_userId_task_key" ON "schedules"("userId", "task");

-- CreateIndex
CREATE INDEX "task_runs_userId_startedAt_idx" ON "task_runs"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "task_runs_status_idx" ON "task_runs"("status");
