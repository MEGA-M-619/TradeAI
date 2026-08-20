-- Phase 3A: diagnostic sessions (Diagnostic Engine foundation).
--
-- Extracted from `prisma migrate diff --from-empty --to-schema` and
-- reduced to the statements not already applied by earlier migrations,
-- exactly as 20260819000015_circuits_measurements was produced.
--
-- Deliberately independent of every ai_assessment* table: no citation-
-- style FK into those tables exists, and nothing in lib/ai/executor.ts
-- reads or writes these. There is no CHECK constraint enforcing "at most
-- one confirmed cause per diagnostic_session" or the confirmed-cause ->
-- diagnosed-session transition -- both are deterministic invariants
-- enforced in application code (see
-- lib/db/repositories/diagnosticCauseRepository.ts), not the database.

-- CreateEnum
CREATE TYPE "diagnostic_session_status" AS ENUM ('open', 'investigating', 'diagnosed', 'abandoned');

-- CreateEnum
CREATE TYPE "diagnostic_cause_status" AS ENUM ('candidate', 'confirmed', 'ruled_out');

-- CreateTable
CREATE TABLE "diagnostic_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "symptom" TEXT NOT NULL,
    "status" "diagnostic_session_status" NOT NULL DEFAULT 'open',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "diagnostic_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnostic_candidate_causes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "diagnostic_session_id" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    "status" "diagnostic_cause_status" NOT NULL DEFAULT 'candidate',
    "recommended_next_test" TEXT,
    "resolving_measurement_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "diagnostic_candidate_causes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "diagnostic_sessions_organization_id_idx" ON "diagnostic_sessions"("organization_id");

-- CreateIndex
CREATE INDEX "diagnostic_sessions_job_id_idx" ON "diagnostic_sessions"("job_id");

-- CreateIndex
CREATE INDEX "diagnostic_candidate_causes_organization_id_idx" ON "diagnostic_candidate_causes"("organization_id");

-- CreateIndex
CREATE INDEX "diagnostic_candidate_causes_diagnostic_session_id_idx" ON "diagnostic_candidate_causes"("diagnostic_session_id");

-- AddForeignKey
ALTER TABLE "diagnostic_sessions" ADD CONSTRAINT "diagnostic_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_sessions" ADD CONSTRAINT "diagnostic_sessions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_sessions" ADD CONSTRAINT "diagnostic_sessions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_candidate_causes" ADD CONSTRAINT "diagnostic_candidate_causes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_candidate_causes" ADD CONSTRAINT "diagnostic_candidate_causes_diagnostic_session_id_fkey" FOREIGN KEY ("diagnostic_session_id") REFERENCES "diagnostic_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_candidate_causes" ADD CONSTRAINT "diagnostic_candidate_causes_resolving_measurement_id_fkey" FOREIGN KEY ("resolving_measurement_id") REFERENCES "measurements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnostic_candidate_causes" ADD CONSTRAINT "diagnostic_candidate_causes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
