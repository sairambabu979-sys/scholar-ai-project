-- CreateEnum
CREATE TYPE "TaskLinkMethod" AS ENUM ('url', 'suggested', 'manual');

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "course_code" TEXT,
    "workflow_state" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description_text" TEXT,
    "description_links" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "html_url" TEXT,
    "due_at" TIMESTAMPTZ(3),
    "unlock_at" TIMESTAMPTZ(3),
    "lock_at" TIMESTAMPTZ(3),
    "submission_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "points_possible" DOUBLE PRECISION,
    "rubric" JSONB,
    "is_quiz" BOOLEAN NOT NULL DEFAULT false,
    "locked_for_user" BOOLEAN NOT NULL DEFAULT false,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "version_hash" TEXT NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "graded_at" TIMESTAMPTZ(3),
    "late" BOOLEAN,
    "missing" BOOLEAN,
    "excused" BOOLEAN,
    "attempt" INTEGER,
    "synced_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "submission_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "method" "TaskLinkMethod" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confirmed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_contexts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "requirements" TEXT NOT NULL,
    "sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "due_date" DATE,
    "due_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "version_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "courses_integration_id_external_id_key" ON "courses"("integration_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "courses_user_id_id_key" ON "courses"("user_id", "id");

-- CreateIndex
CREATE INDEX "assignments_user_id_due_at_idx" ON "assignments"("user_id", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_integration_id_external_id_key" ON "assignments"("integration_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_user_id_id_key" ON "assignments"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_snapshots_assignment_id_key" ON "submission_snapshots"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_snapshots_user_id_assignment_id_key" ON "submission_snapshots"("user_id", "assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_links_task_id_key" ON "task_links"("task_id");

-- CreateIndex
CREATE INDEX "task_links_assignment_id_idx" ON "task_links"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_links_user_id_task_id_key" ON "task_links"("user_id", "task_id");

-- CreateIndex
CREATE UNIQUE INDEX "manual_contexts_task_id_key" ON "manual_contexts"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "manual_contexts_user_id_task_id_key" ON "manual_contexts"("user_id", "task_id");

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_user_id_integration_id_fkey" FOREIGN KEY ("user_id", "integration_id") REFERENCES "integrations"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_user_id_integration_id_fkey" FOREIGN KEY ("user_id", "integration_id") REFERENCES "integrations"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_user_id_course_id_fkey" FOREIGN KEY ("user_id", "course_id") REFERENCES "courses"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_snapshots" ADD CONSTRAINT "submission_snapshots_user_id_assignment_id_fkey" FOREIGN KEY ("user_id", "assignment_id") REFERENCES "assignments"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_user_id_assignment_id_fkey" FOREIGN KEY ("user_id", "assignment_id") REFERENCES "assignments"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_contexts" ADD CONSTRAINT "manual_contexts_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
