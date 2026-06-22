/**
 * Proposals domain schema — case study library (F1-002).
 *
 * Requires pgvector extension (Neon Postgres or Supabase Postgres with pgvector).
 * Embedding dimension 1536 matches OpenAI text-embedding-3-small.
 * Picked up by packages/db/migrate.ts via the *_DDL constant convention.
 */
export const PROPOSALS_DDL = `
-- Enable pgvector (no-op if already enabled; graceful warning if unavailable on dev/test).
DO $$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pgvector extension not available: %. Chunks table will use text for embedding column.', SQLERRM;
END;
$$;

CREATE TABLE IF NOT EXISTS proposals_case_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT gen_random_uuid(),
  filename text NOT NULL DEFAULT '',
  file_id text,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  page_count integer,
  chunk_count integer NOT NULL DEFAULT 0,
  retrieval_quality_score numeric(5,4),
  error_message text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill columns for tables that predate this schema version.
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS filename text NOT NULL DEFAULT '';
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS file_id text;
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS page_count integer;
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0;
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS retrieval_quality_score numeric(5,4);
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS uploaded_by uuid;
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE proposals_case_studies ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_proposals_case_studies_org_status
  ON proposals_case_studies (org_id, status, created_at DESC);

-- Create chunks table using vector(1536) when pgvector is available, text otherwise.
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS proposals_case_study_chunks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_study_id uuid NOT NULL,
    org_id uuid NOT NULL DEFAULT gen_random_uuid(),
    chunk_index integer NOT NULL,
    content text NOT NULL,
    token_count integer NOT NULL DEFAULT 0,
    embedding vector(1536),
    created_at timestamptz NOT NULL DEFAULT now()
  );
EXCEPTION WHEN OTHERS THEN
  CREATE TABLE IF NOT EXISTS proposals_case_study_chunks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_study_id uuid NOT NULL,
    org_id uuid NOT NULL DEFAULT gen_random_uuid(),
    chunk_index integer NOT NULL,
    content text NOT NULL,
    token_count integer NOT NULL DEFAULT 0,
    embedding text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
END;
$$;

-- Backfill org_id on chunks table if it predates this schema version.
ALTER TABLE proposals_case_study_chunks ADD COLUMN IF NOT EXISTS org_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS idx_proposals_chunks_case_study_id
  ON proposals_case_study_chunks (case_study_id, chunk_index);
`;
