/*
  Warnings:

  - Added the required column `userId` to the `answers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `jobs` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_answers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "answers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_answers" ("answer", "createdAt", "id", "key", "origin", "question", "updatedAt") SELECT "answer", "createdAt", "id", "key", "origin", "question", "updatedAt" FROM "answers";
DROP TABLE "answers";
ALTER TABLE "new_answers" RENAME TO "answers";
CREATE UNIQUE INDEX "answers_userId_key_key" ON "answers"("userId", "key");
CREATE TABLE "new_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_jobs" ("company", "description", "externalId", "foundAt", "id", "location", "postedAt", "raw", "redFlags", "score", "source", "status", "title", "updatedAt", "url", "why") SELECT "company", "description", "externalId", "foundAt", "id", "location", "postedAt", "raw", "redFlags", "score", "source", "status", "title", "updatedAt", "url", "why" FROM "jobs";
DROP TABLE "jobs";
ALTER TABLE "new_jobs" RENAME TO "jobs";
CREATE INDEX "jobs_userId_status_idx" ON "jobs"("userId", "status");
CREATE INDEX "jobs_userId_company_idx" ON "jobs"("userId", "company");
CREATE UNIQUE INDEX "jobs_userId_url_key" ON "jobs"("userId", "url");
CREATE UNIQUE INDEX "jobs_userId_source_externalId_key" ON "jobs"("userId", "source", "externalId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
