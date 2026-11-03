-- CreateTable
CREATE TABLE "searches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "location" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "searches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "search_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "searchId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME NOT NULL,
    "pages" INTEGER NOT NULL,
    "seen" INTEGER NOT NULL,
    "fresh" INTEGER NOT NULL,
    "created" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL,
    "invalid" INTEGER NOT NULL,
    "stopped" TEXT NOT NULL,
    "error" TEXT,
    CONSTRAINT "search_runs_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "searches" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "searches_userId_idx" ON "searches"("userId");

-- CreateIndex
CREATE INDEX "search_runs_searchId_startedAt_idx" ON "search_runs"("searchId", "startedAt");
