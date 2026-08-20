-- Phase 4: circuits and structured measurements (Intelligence Layer
-- foundation).
--
-- Extracted from `prisma migrate diff --from-empty --to-schema` and
-- reduced to the statements not already applied by earlier migrations,
-- exactly as 20260816000006_evidence was produced.
--
-- Deliberately independent of every Phase 3 ai_assessment* table: no
-- citation-style FK into these tables exists yet, and nothing in
-- lib/ai/executor.ts reads or writes them. `measurements.result` has no
-- CHECK constraint tying it to value/expected_min/expected_max -- that
-- computation belongs to the deterministic rule engine
-- (lib/diagnostics/measurementRules.ts), not the database.

-- CreateEnum
CREATE TYPE "measurement_test_type" AS ENUM ('voltage_ac', 'voltage_dc', 'continuity', 'resistance', 'current_ac', 'current_dc', 'insulation_resistance', 'ground_impedance');

-- CreateEnum
CREATE TYPE "measurement_result" AS ENUM ('pass', 'fail', 'inconclusive', 'not_applicable');

-- CreateTable
CREATE TABLE "circuits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "panel_label" TEXT,
    "breaker_rating" INTEGER,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "circuits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "measurements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "circuit_id" UUID,
    "evidence_id" UUID,
    "recorded_by_user_id" UUID NOT NULL,
    "test_type" "measurement_test_type" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "expected_min" DOUBLE PRECISION,
    "expected_max" DOUBLE PRECISION,
    "result" "measurement_result",
    "note" TEXT,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "measurements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "circuits_organization_id_idx" ON "circuits"("organization_id");

-- CreateIndex
CREATE INDEX "circuits_customer_id_idx" ON "circuits"("customer_id");

-- CreateIndex
CREATE INDEX "measurements_organization_id_idx" ON "measurements"("organization_id");

-- CreateIndex
CREATE INDEX "measurements_job_id_idx" ON "measurements"("job_id");

-- CreateIndex
CREATE INDEX "measurements_circuit_id_idx" ON "measurements"("circuit_id");

-- AddForeignKey
ALTER TABLE "circuits" ADD CONSTRAINT "circuits_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "circuits" ADD CONSTRAINT "circuits_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_circuit_id_fkey" FOREIGN KEY ("circuit_id") REFERENCES "circuits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
