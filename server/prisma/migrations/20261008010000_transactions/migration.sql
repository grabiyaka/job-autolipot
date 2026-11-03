ALTER TABLE "subscribers"
  ADD COLUMN "maintenanceBalanceKopeks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "verifiedReadingHundredths" INTEGER,
  ADD COLUMN "verifiedAt" TEXT,
  ADD COLUMN "verifiedByTransactionId" TEXT,
  ADD CONSTRAINT "subscribers_verified_reading_nonnegative"
    CHECK ("verifiedReadingHundredths" IS NULL OR "verifiedReadingHundredths" >= 0),
  ADD CONSTRAINT "subscribers_verification_complete"
    CHECK (("verifiedReadingHundredths" IS NULL AND "verifiedAt" IS NULL AND "verifiedByTransactionId" IS NULL)
      OR ("verifiedReadingHundredths" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "verifiedByTransactionId" IS NOT NULL));

CREATE TABLE "transactions" (
  "id" TEXT NOT NULL,
  "sequence" SERIAL NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "subscriberId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
  "snapshot" JSONB NOT NULL,
  "reversesId" TEXT,
  "amendsId" TEXT,
  "bankReference" TEXT,
  CONSTRAINT "transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transactions_snapshot_object" CHECK (jsonb_typeof("snapshot") = 'object'),
  CONSTRAINT "transactions_reading_nonnegative" CHECK (
    COALESCE(("snapshot" #>> '{effect,before,readingHundredths}')::BIGINT >= 0, FALSE)
    AND COALESCE(("snapshot" #>> '{effect,after,readingHundredths}')::BIGINT >= 0, FALSE)),
  CONSTRAINT "transactions_state_addition" CHECK (
    COALESCE(("snapshot" #>> '{effect,before,balanceKopeks}')::BIGINT
      + ("snapshot" #>> '{effect,change,balanceKopeks}')::BIGINT
      = ("snapshot" #>> '{effect,after,balanceKopeks}')::BIGINT, FALSE)
    AND COALESCE(("snapshot" #>> '{effect,before,maintenanceBalanceKopeks}')::BIGINT
      + ("snapshot" #>> '{effect,change,maintenanceBalanceKopeks}')::BIGINT
      = ("snapshot" #>> '{effect,after,maintenanceBalanceKopeks}')::BIGINT, FALSE)
    AND COALESCE(("snapshot" #>> '{effect,before,readingHundredths}')::BIGINT
      + ("snapshot" #>> '{effect,change,readingHundredths}')::BIGINT
      = ("snapshot" #>> '{effect,after,readingHundredths}')::BIGINT, FALSE)),
  CONSTRAINT "transactions_link_exclusive" CHECK ("reversesId" IS NULL OR "amendsId" IS NULL),
  CONSTRAINT "transactions_no_self_link" CHECK ("reversesId" IS DISTINCT FROM "id" AND "amendsId" IS DISTINCT FROM "id")
);

CREATE UNIQUE INDEX "transactions_sequence_key" ON "transactions"("sequence");
CREATE UNIQUE INDEX "transactions_idempotencyKey_key" ON "transactions"("idempotencyKey");
CREATE UNIQUE INDEX "transactions_reversesId_key" ON "transactions"("reversesId");
CREATE UNIQUE INDEX "transactions_subscriberId_bankReference_key" ON "transactions"("subscriberId", "bankReference");
CREATE INDEX "transactions_subscriberId_effectiveAt_sequence_idx" ON "transactions"("subscriberId", "effectiveAt", "sequence");

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_subscriberId_fkey"
  FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversesId_fkey"
  FOREIGN KEY ("reversesId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amendsId_fkey"
  FOREIGN KEY ("amendsId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION reject_transaction_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Transaction history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "transactions_append_only"
  BEFORE UPDATE OR DELETE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION reject_transaction_mutation();
