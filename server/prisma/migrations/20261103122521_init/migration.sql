-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "description" TEXT,
    "raw" TEXT,
    "score" INTEGER,
    "why" TEXT,
    "redFlags" TEXT,
    "status" TEXT NOT NULL DEFAULT 'found',
    "postedAt" DATETIME,
    "foundAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "sessionId" TEXT,
    "screenshotBefore" TEXT,
    "screenshotAfter" TEXT,
    "result" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "questions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "answer" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "telegramMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" DATETIME,
    CONSTRAINT "questions_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "answers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions"("userId");

-- CreateIndex
CREATE INDEX "auth_sessions_expiresAt_idx" ON "auth_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_url_key" ON "jobs"("url");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_company_idx" ON "jobs"("company");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_source_externalId_key" ON "jobs"("source", "externalId");

-- CreateIndex
CREATE INDEX "applications_jobId_idx" ON "applications"("jobId");

-- CreateIndex
CREATE INDEX "applications_status_idx" ON "applications"("status");

-- CreateIndex
CREATE INDEX "questions_applicationId_idx" ON "questions"("applicationId");

-- CreateIndex
CREATE INDEX "questions_status_idx" ON "questions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "answers_key_key" ON "answers"("key");
