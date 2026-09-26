-- Document picker (#1038). One connection per person per system (Paperless-ngx
-- or Papra) with the API token encrypted at rest. The picker searches the
-- source and imports picked documents on request only; nothing polls.
CREATE TABLE "document_source_connections" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "system" VARCHAR(16) NOT NULL,
  "base_url" VARCHAR(2048) NOT NULL,
  "organization_id" VARCHAR(128),
  "token_encrypted" TEXT NOT NULL,
  "last_verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_source_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_source_connections_user_id_system_key"
  ON "document_source_connections" ("user_id", "system");

ALTER TABLE "document_source_connections"
  ADD CONSTRAINT "document_source_connections_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
