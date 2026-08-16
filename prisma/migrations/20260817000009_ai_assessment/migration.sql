-- Phase 3: AI/vision-assisted assessment -- tables.
--
-- Extracted from `prisma migrate diff --from-empty --to-schema` and
-- reduced to the statements not already applied by earlier migrations,
-- exactly as 20260815000004_customers_jobs and 20260816000006_evidence
-- were produced. (The live-DB `--from-config-datasource` variant still
-- can't run here: it fails introspecting `public.users`' cross-schema FK
-- to `auth.users`.)

-- CreateEnum
CREATE TYPE "assessment_status" AS ENUM ('queued', 'running', 'complete', 'insufficient_evidence', 'failed');

-- CreateEnum
CREATE TYPE "assessment_model_tier" AS ENUM ('standard', 'escalation');

-- CreateEnum
CREATE TYPE "assessment_failure_category" AS ENUM ('quota_exceeded', 'sha_mismatch', 'model_error', 'schema_violation', 'citation_violation', 'timeout', 'unknown');

-- CreateEnum
CREATE TYPE "finding_kind" AS ENUM ('observation', 'hypothesis');

-- CreateEnum
CREATE TYPE "confidence_level" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "safety_severity" AS ENUM ('advisory', 'mandatory', 'stop_work');

-- CreateEnum
CREATE TYPE "verdict_kind" AS ENUM ('confirmed', 'rejected', 'amended', 'unresolved');

-- CreateTable
CREATE TABLE "ai_assessment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "assessment_status" NOT NULL DEFAULT 'queued',
    "model_tier" "assessment_model_tier" NOT NULL DEFAULT 'standard',
    "model_id" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "model_params" JSONB,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    "stop_reason" TEXT,
    "raw_response" JSONB,
    "insufficient_reason" TEXT,
    "failure_category" "assessment_failure_category",
    "error_message" TEXT,
    "claimed_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_assessment_input" (
    "assessment_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "ordinal_ref" TEXT NOT NULL,
    "sha256_verified" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_assessment_input_pkey" PRIMARY KEY ("assessment_id","evidence_id")
);

-- CreateTable
CREATE TABLE "ai_assessment_finding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assessment_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "finding_kind" NOT NULL,
    "ref" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "confidence" "confidence_level" NOT NULL,
    "rationale" TEXT NOT NULL,
    "what_would_change_my_mind" TEXT,
    "safety_categories" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_assessment_finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_assessment_citation" (
    "assessment_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,

    CONSTRAINT "ai_assessment_citation_pkey" PRIMARY KEY ("assessment_id","finding_id","evidence_id")
);

-- CreateTable
CREATE TABLE "ai_assessment_test" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assessment_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "test" TEXT NOT NULL,
    "rules_in_if_positive" TEXT NOT NULL,
    "rules_out_if_negative" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_assessment_test_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_assessment_question" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assessment_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "why_it_matters" TEXT NOT NULL,
    "answers_would_rule_in" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_assessment_question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_assessment_safety_warning" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assessment_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "rule_id" TEXT NOT NULL,
    "severity" "safety_severity" NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_assessment_safety_warning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_verdict" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "verdict" "verdict_kind" NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "technician_verdict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_ledger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "assessment_id" UUID,
    "billing_period" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_assessment_organization_id_idx" ON "ai_assessment"("organization_id");

-- CreateIndex
CREATE INDEX "ai_assessment_job_id_idx" ON "ai_assessment"("job_id");

-- CreateIndex
CREATE INDEX "ai_assessment_status_claimed_at_idx" ON "ai_assessment"("status", "claimed_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_assessment_job_id_version_key" ON "ai_assessment"("job_id", "version");

-- CreateIndex
CREATE INDEX "ai_assessment_input_organization_id_idx" ON "ai_assessment_input"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_assessment_input_assessment_id_ordinal_ref_key" ON "ai_assessment_input"("assessment_id", "ordinal_ref");

-- CreateIndex
CREATE INDEX "ai_assessment_finding_organization_id_idx" ON "ai_assessment_finding"("organization_id");

-- CreateIndex
CREATE INDEX "ai_assessment_finding_assessment_id_idx" ON "ai_assessment_finding"("assessment_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_assessment_finding_assessment_id_id_key" ON "ai_assessment_finding"("assessment_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_assessment_finding_assessment_id_ref_key" ON "ai_assessment_finding"("assessment_id", "ref");

-- CreateIndex
CREATE INDEX "ai_assessment_citation_organization_id_idx" ON "ai_assessment_citation"("organization_id");

-- CreateIndex
CREATE INDEX "ai_assessment_test_organization_id_idx" ON "ai_assessment_test"("organization_id");

-- CreateIndex
CREATE INDEX "ai_assessment_test_assessment_id_idx" ON "ai_assessment_test"("assessment_id");

-- CreateIndex
CREATE INDEX "ai_assessment_question_organization_id_idx" ON "ai_assessment_question"("organization_id");

-- CreateIndex
CREATE INDEX "ai_assessment_question_assessment_id_idx" ON "ai_assessment_question"("assessment_id");

-- CreateIndex
CREATE INDEX "ai_assessment_safety_warning_organization_id_idx" ON "ai_assessment_safety_warning"("organization_id");

-- CreateIndex
CREATE INDEX "ai_assessment_safety_warning_assessment_id_idx" ON "ai_assessment_safety_warning"("assessment_id");

-- CreateIndex
CREATE UNIQUE INDEX "technician_verdict_finding_id_key" ON "technician_verdict"("finding_id");

-- CreateIndex
CREATE INDEX "technician_verdict_organization_id_idx" ON "technician_verdict"("organization_id");

-- CreateIndex
CREATE INDEX "technician_verdict_assessment_id_idx" ON "technician_verdict"("assessment_id");

-- CreateIndex
CREATE INDEX "ai_usage_ledger_organization_id_billing_period_idx" ON "ai_usage_ledger"("organization_id", "billing_period");

-- AddForeignKey
ALTER TABLE "ai_assessment" ADD CONSTRAINT "ai_assessment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assessment" ADD CONSTRAINT "ai_assessment_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assessment" ADD CONSTRAINT "ai_assessment_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assessment_input" ADD CONSTRAINT "ai_assessment_input_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "ai_assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assessment_input" ADD CONSTRAINT "ai_assessment_input_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assessment_finding" ADD CONSTRAINT "ai_assessment_finding_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "ai_assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- THE citation-integrity constraint: a citation can only reference a
-- (assessment_id, evidence_id) pair that already exists in
-- ai_assessment_input -- i.e. evidence actually sent to the model in that
-- run. See prisma/schema.prisma's AiAssessmentCitation doc comment.
ALTER TABLE "ai_assessment_citation" ADD CONSTRAINT "ai_assessment_citation_assessment_id_finding_id_fkey" FOREIGN KEY ("assessment_id", "finding_id") REFERENCES "ai_assessment_finding"("assessment_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assessment_citation" ADD CONSTRAINT "ai_assessment_citation_assessment_id_evidence_id_fkey" FOREIGN KEY ("assessment_id", "evidence_id") REFERENCES "ai_assessment_input"("assessment_id", "evidence_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assessment_test" ADD CONSTRAINT "ai_assessment_test_assessment_id_finding_id_fkey" FOREIGN KEY ("assessment_id", "finding_id") REFERENCES "ai_assessment_finding"("assessment_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assessment_question" ADD CONSTRAINT "ai_assessment_question_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "ai_assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_assessment_safety_warning" ADD CONSTRAINT "ai_assessment_safety_warning_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "ai_assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_verdict" ADD CONSTRAINT "technician_verdict_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_verdict" ADD CONSTRAINT "technician_verdict_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "ai_assessment_finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_verdict" ADD CONSTRAINT "technician_verdict_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "ai_assessment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
