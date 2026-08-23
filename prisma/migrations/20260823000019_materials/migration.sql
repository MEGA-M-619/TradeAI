-- Materials: manual-entry job material line items.
--
-- Extracted from `prisma migrate diff --from-empty --to-schema` and
-- reduced to the statements not already applied by earlier migrations,
-- exactly as 20260816000006_evidence and 20260819000015_circuits_measurements
-- were produced.
--
-- Deliberately independent of every AiAssessment/Measurement/Diagnostic
-- table: nothing here is read or written by lib/ai/executor.ts, and no
-- other table has a foreign key into materials -- a row is
-- hard-deletable, not tombstoned, because there is no dangling-reference
-- case to explain.
--
-- unit_cost_cents is integer cents, not a decimal/float price -- see the
-- doc comment on Material in schema.prisma.

-- CreateEnum
CREATE TYPE "material_source" AS ENUM ('manual');

-- CreateTable
CREATE TABLE "materials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit_cost_cents" INTEGER NOT NULL,
    "source" "material_source" NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "materials_organization_id_idx" ON "materials"("organization_id");

-- CreateIndex
CREATE INDEX "materials_job_id_idx" ON "materials"("job_id");

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
