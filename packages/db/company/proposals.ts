/**
 * Proposals domain schema — case study library (F1-002).
 *
 * Requires pgvector extension (Neon Postgres or Supabase Postgres with pgvector).
 * Embedding dimension 1536 matches OpenAI text-embedding-3-small.
 * Picked up by packages/db/migrate.ts via the *_DDL constant convention.
 */
export const PROPOSALS_DDL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS proposals_case_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  filename text NOT NULL,
  file_id text,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  page_count integer,
  chunk_count integer NOT NULL DEFAULT 0,
  retrieval_quality_score numeric(5,4),
  error_message text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposals_case_studies_org_status
  ON proposals_case_studies (org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS proposals_case_study_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_study_id uuid NOT NULL REFERENCES proposals_case_studies(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  token_count integer NOT NULL DEFAULT 0,
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposals_chunks_case_study_id
  ON proposals_case_study_chunks (case_study_id, chunk_index);
`;
