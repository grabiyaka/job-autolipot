-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "profileRevision" INTEGER;
ALTER TABLE "jobs" ADD COLUMN "trackerId" TEXT;

-- CreateTable
CREATE TABLE "tracker_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "etag" TEXT,
    "markdown" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL,
    CONSTRAINT "tracker_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "tracker_profiles_userId_key" ON "tracker_profiles"("userId");
