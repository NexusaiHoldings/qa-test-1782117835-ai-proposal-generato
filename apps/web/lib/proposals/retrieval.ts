import { Pool } from 'pg';

export interface CaseStudyChunk {
  id: string;
  case_study_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface RetrievedChunk {
  id: string;
  case_study_id: string;
  chunk_index: number;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

export const CASE_STUDY_CHUNKS_DDL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS case_study_chunks (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  case_study_id uuid  NOT NULL,
  chunk_index integer NOT NULL,
  content     text    NOT NULL,
  embedding   vector(1536),
  metadata    jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_study_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_case_study_chunks_embedding
  ON case_study_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_case_study_chunks_case_study_id
  ON case_study_chunks (case_study_id);
`;

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

export async function computeEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      // token limit for text-embedding-3-small is 8191 tokens; truncate input conservatively
      input: text.slice(0, 32000),
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI embeddings error ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  const embedding = data.data[0]?.embedding;
  if (!embedding || embedding.length === 0) {
    throw new Error('Received empty embedding from OpenAI');
  }
  return embedding;
}
export async function retrieveRelevantChunks(
  rfpText: string,
  topK: number = 3,
): Promise<RetrievedChunk[]> {
  const embedding = await computeEmbedding(rfpText);
  const embeddingLiteral = `[${embedding.join(',')}]`;
  const pool = getPool();
  const client = await pool.connect();

  try {
    const result = await client.query<{
      id: string;
      case_study_id: string;
      chunk_index: number;
      content: string;
      similarity: number;
      metadata: Record<string, unknown>;
    }>(
      `SELECT
         id,
         case_study_id,
         chunk_index,
         content,
         metadata,
         1 - (embedding <=> $1::vector) AS similarity
       FROM case_study_chunks
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [embeddingLiteral, topK],
    );

    return result.rows.map((row) => ({
      id: row.id,
      case_study_id: row.case_study_id,
      chunk_index: row.chunk_index,
      content: row.content,
      similarity: typeof row.similarity === 'string' ? parseFloat(row.similarity) : row.similarity,
      metadata: row.metadata ?? {},
    }));
  } finally {
    client.release();
  }
}
export async function upsertCaseStudyChunk(params: {
  case_study_id: string;
  chunk_index: number;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<CaseStudyChunk> {
  const embedding = await computeEmbedding(params.content);
  const embeddingLiteral = `[${embedding.join(',')}]`;
  const pool = getPool();
  const client = await pool.connect();

  try {
    const result = await client.query<CaseStudyChunk>(
      `INSERT INTO case_study_chunks (case_study_id, chunk_index, content, embedding, metadata)
       VALUES ($1, $2, $3, $4::vector, $5)
       ON CONFLICT (case_study_id, chunk_index)
       DO UPDATE SET
         content   = EXCLUDED.content,
         embedding = EXCLUDED.embedding,
         metadata  = EXCLUDED.metadata
       RETURNING id, case_study_id, chunk_index, content, metadata, created_at`,
      [
        params.case_study_id,
        params.chunk_index,
        params.content,
        embeddingLiteral,
        JSON.stringify(params.metadata ?? {}),
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Upsert did not return a row');
    }
    return row;
  } finally {
    client.release();
  }
}
export async function getChunkById(chunkId: string): Promise<CaseStudyChunk | null> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    const result = await client.query<CaseStudyChunk>(
      `SELECT id, case_study_id, chunk_index, content, metadata, created_at
       FROM case_study_chunks
       WHERE id = $1`,
      [chunkId],
    );
    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
}
export async function scoreRetrievalPrecision(
  rfpText: string,
  threshold: number = 0.7,
  topK: number = 3,
): Promise<{ precision: number; retrieved: RetrievedChunk[] }> {
  const retrieved = await retrieveRelevantChunks(rfpText, topK);
  const relevant = retrieved.filter((chunk) => chunk.similarity >= threshold);
  const precision = retrieved.length > 0 ? relevant.length / retrieved.length : 0;
  return { precision, retrieved };
}
