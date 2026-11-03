-- Rename existing values without rewriting users, sessions, or immutable audit snapshots.
-- Enum additions must be committed before the new default can use them.
BEGIN;

ALTER TYPE "UserRole" RENAME VALUE 'operator' TO 'manager';
ALTER TYPE "UserRole" RENAME VALUE 'subscriber' TO 'guest';
ALTER TYPE "UserRole" ADD VALUE 'admin' BEFORE 'manager';
ALTER TYPE "UserRole" ADD VALUE 'foreign' AFTER 'guest';

ALTER TABLE "users" DROP CONSTRAINT "users_role_subscriber_check";
ALTER TABLE "users" ADD CONSTRAINT "users_role_subscriber_check"
  CHECK ("subscriberId" IS NULL OR "role" = 'guest');

COMMIT;

ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'foreign';
