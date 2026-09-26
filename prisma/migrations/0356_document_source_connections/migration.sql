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

-- Source instance (#1038 review): the same id in two Paperless-ngx (or two
-- Papra) instances is two documents. A nullable origin joins every source key;
-- keys stored without one (v1.39.2 imports) keep matching any instance, which
-- the application decides at lookup time. NULLS NOT DISTINCT keeps two keys
-- without an instance colliding exactly as before (PG15+; the stack runs 16).
ALTER TABLE "inbound_documents" ADD COLUMN "source_instance" VARCHAR(512);
DROP INDEX IF EXISTS "inbound_documents_user_source_key";
CREATE UNIQUE INDEX "inbound_documents_user_source_key"
  ON "inbound_documents" ("user_id", "source_system", "source_instance", "source_id")
  NULLS NOT DISTINCT
  WHERE "source_id" IS NOT NULL;

ALTER TABLE "document_source_aliases" ADD COLUMN "source_instance" VARCHAR(512);
DROP INDEX IF EXISTS "document_source_aliases_user_id_source_system_source_id_key";
CREATE UNIQUE INDEX "document_source_aliases_user_id_source_system_source_instance_source_id_key"
  ON "document_source_aliases" ("user_id", "source_system", "source_instance", "source_id")
  NULLS NOT DISTINCT;

ALTER TABLE "document_import_keys" ADD COLUMN "source_instance" VARCHAR(512);
DROP INDEX IF EXISTS "document_import_keys_user_id_source_system_source_id_key";
CREATE UNIQUE INDEX "document_import_keys_user_id_source_system_source_instance_source_id_key"
  ON "document_import_keys" ("user_id", "source_system", "source_instance", "source_id")
  NULLS NOT DISTINCT;
