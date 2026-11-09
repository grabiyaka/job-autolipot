-- Поиски через агента (задача hunt): сайт поиска, описания и затраты прогона.
-- PipelineTask.hunt не требует SQL: в SQLite enum хранится как TEXT.
ALTER TABLE "searches" ADD COLUMN "site" TEXT;
ALTER TABLE "search_runs" ADD COLUMN "described" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "search_runs" ADD COLUMN "costMicros" INTEGER NOT NULL DEFAULT 0;
