CREATE TABLE "subscribers" (
    "id" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "villageName" TEXT NOT NULL,
    "meterNumber" TEXT NOT NULL,
    "readingHundredths" INTEGER NOT NULL,
    "balanceKopeks" INTEGER NOT NULL,
    "waterTariffKopeks" INTEGER NOT NULL,
    "drainageTariffKopeks" INTEGER NOT NULL,
    "hasWater" BOOLEAN NOT NULL,
    "hasDrainage" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "subscribers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscribers_reading_nonnegative" CHECK ("readingHundredths" >= 0),
    CONSTRAINT "subscribers_water_tariff_nonnegative" CHECK ("waterTariffKopeks" >= 0),
    CONSTRAINT "subscribers_drainage_tariff_nonnegative" CHECK ("drainageTariffKopeks" >= 0),
    CONSTRAINT "subscribers_version_nonnegative" CHECK ("version" >= 0)
);

CREATE TABLE "readings" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "readings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "readings_snapshot_object" CHECK (jsonb_typeof("snapshot") = 'object')
);

CREATE UNIQUE INDEX "subscribers_accountNumber_key" ON "subscribers"("accountNumber");
CREATE UNIQUE INDEX "subscribers_meterNumber_key" ON "subscribers"("meterNumber");
CREATE UNIQUE INDEX "readings_idempotencyKey_key" ON "readings"("idempotencyKey");
CREATE INDEX "readings_subscriberId_createdAt_idx" ON "readings"("subscriberId", "createdAt");

ALTER TABLE "readings" ADD CONSTRAINT "readings_subscriberId_fkey"
  FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- History is append-only even when accessed outside this application's repository.
CREATE FUNCTION reject_reading_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Reading history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "readings_append_only"
  BEFORE UPDATE OR DELETE ON "readings"
  FOR EACH ROW EXECUTE FUNCTION reject_reading_mutation();
