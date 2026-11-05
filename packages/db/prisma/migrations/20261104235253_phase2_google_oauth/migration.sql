-- CreateTable
CREATE TABLE "token_envelopes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "key_id" TEXT NOT NULL,
    "sealed_payload" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "has_refresh_token" BOOLEAN NOT NULL,
    "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "token_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "session_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "sealed_code_verifier" TEXT NOT NULL,
    "app_origin" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "requested_scopes" TEXT[],
    "return_path" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "token_envelopes_integration_id_key" ON "token_envelopes"("integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "token_envelopes_user_id_integration_id_key" ON "token_envelopes"("user_id", "integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_hash_key" ON "oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "oauth_states_user_id_created_at_idx" ON "oauth_states"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states"("expires_at");

-- AddForeignKey
ALTER TABLE "token_envelopes" ADD CONSTRAINT "token_envelopes_user_id_integration_id_fkey" FOREIGN KEY ("user_id", "integration_id") REFERENCES "integrations"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
