-- Phase 2: evidence (job photos).
--
-- Extracted from `prisma migrate diff --from-empty --to-schema` and
-- reduced to the statements not already applied by earlier migrations,
-- exactly as 20260815000004_customers_jobs was produced. (The live-DB
-- `--from-config-datasource` variant still can't run here: it fails
-- introspecting `public.users`' cross-schema FK to `auth.users`.)
--
-- `id` has no database default on purpose. The storage key is
-- `{organization_id}/{job_id}/{id}`, so the application generates the id
-- up front and writes the row and its key in a single insert, rather than
-- inserting and then updating the key.

-- CreateEnum
CREATE TYPE "evidence_kind" AS ENUM ('photo');

-- CreateEnum
CREATE TYPE "evidence_upload_status" AS ENUM ('pending', 'ready');

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "kind" "evidence_kind" NOT NULL DEFAULT 'photo',
    "upload_status" "evidence_upload_status" NOT NULL DEFAULT 'pending',
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "client_sha256" TEXT,
    "caption" TEXT,
    "captured_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "evidence_storage_key_key" ON "evidence"("storage_key");

-- CreateIndex
CREATE INDEX "evidence_organization_id_idx" ON "evidence"("organization_id");

-- CreateIndex
CREATE INDEX "evidence_job_id_idx" ON "evidence"("job_id");

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_deleted_by_user_id_fkey" FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
