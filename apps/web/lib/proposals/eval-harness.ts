/**
 * Retrieval quality evaluation for the case study library (F1-002).
 *
 * Computes a [0, 1] quality score for a newly embedded case study by testing
 * whether the document's chunks are semantically cohesive and distinguishable
 * from other documents in the corpus.
 *
 * Strategy:
 *  - Single document in corpus → intra-doc coherence (avg cosine similarity
 *    between adjacent chunks; proxy for embedding quality).
 *  - Multiple documents → cross-doc discrimination (leave-one-out: for each
 *    sample chunk, check if its nearest neighbor belongs to the same document).
 */

import { buildDb } from "@/lib/db";

interface ChunkRow {
  id: string;
  embedding: string | null;
  case_study_id: string;
}

/** Parse a pgvector output string "[0.1,-0.2,...]" into a number array. */
function parseEmbeddingVector(raw: string): number[] {
  return raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((s) => parseFloat(s.trim()))
    .filter((n) => !isNaN(n));
}

/** Cosine similarity between two equal-length vectors. Returns 0 on degenerate input. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let k = 0; k < a.length; k++) {
    dot += a[k] * b[k];
    normA += a[k] * a[k];
    normB += b[k] * b[k];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Compute intra-document coherence score for a case study that is the only
 * document in the corpus. Measures average cosine similarity between adjacent
 * chunk embeddings as a proxy for embedding quality.
 */
async function computeCoherenceScore(
  caseStudyId: string,
  sampleChunks: ChunkRow[],
): Promise<number> {
  const embeddings = sampleChunks
    .filter((c) => c.embedding != null && c.embedding.length > 2)
    .map((c) => parseEmbeddingVector(c.embedding!));

  if (embeddings.length < 2) {
    return embeddings.length === 1 ? 0.5 : 0.0;
  }

  let totalSim = 0;
  let pairs = 0;
  for (let idx = 0; idx < embeddings.length - 1; idx++) {
    totalSim += cosineSimilarity(embeddings[idx], embeddings[idx + 1]);
    pairs++;
  }
  const avgSim = pairs > 0 ? totalSim / pairs : 0;
  // Map cosine sim [-1, 1] → [0, 1], clamped.
  return Math.min(1.0, Math.max(0.0, (avgSim + 1) / 2));
}

/**
 * Compute cross-document discrimination score when multiple case studies exist.
 * For each of up to 5 sample chunks, retrieves the 3 nearest neighbors from all
 * org chunks (excluding self). Score = fraction where at least one neighbor
 * belongs to the same case study (recall@3).
 */
async function computeDiscriminationScore(
  caseStudyId: string,
  orgId: string,
  sampleChunks: ChunkRow[],
): Promise<number> {
  const db = buildDb();
  const sample = sampleChunks.filter((c) => c.embedding != null).slice(0, 5);
  if (sample.length === 0) return 0.5;

  let hits = 0;
  for (const chunk of sample) {
    const neighbors = await db.query<{ case_study_id: string }>(
      `SELECT case_study_id
       FROM proposals_case_study_chunks
       WHERE org_id = $1
         AND id <> $2
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $3::vector
       LIMIT $4`,
      orgId,
      chunk.id,
      chunk.embedding,
      3,
    );
    if (neighbors.some((n) => n.case_study_id === caseStudyId)) {
      hits++;
    }
  }
  return sample.length > 0 ? hits / sample.length : 0.5;
}

/**
 * Evaluate the retrieval quality of an embedded case study.
 * Returns a score in [0, 1] where 1.0 is perfect retrieval quality.
 */
export async function evaluateRetrievalQuality(
  caseStudyId: string,
  orgId: string,
): Promise<number> {
  const db = buildDb();

  // Fetch a representative sample of embedded chunks.
  const sampleChunks = await db.query<ChunkRow>(
    `SELECT id, embedding::text AS embedding, case_study_id
     FROM proposals_case_study_chunks
     WHERE case_study_id = $1
       AND embedding IS NOT NULL
     ORDER BY chunk_index
     LIMIT $2`,
    caseStudyId,
    10,
  );

  if (sampleChunks.length === 0) return 0.0;
  if (sampleChunks.length === 1) return 0.5;

  // Determine whether other embedded documents exist in this org's corpus.
  const otherStudies = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM proposals_case_studies
     WHERE org_id = $1
       AND id <> $2
       AND status = 'embedded'`,
    orgId,
    caseStudyId,
  );
  const otherCount = parseInt(otherStudies[0]?.cnt ?? "0", 10);

  if (otherCount === 0) {
    return computeCoherenceScore(caseStudyId, sampleChunks);
  }
  return computeDiscriminationScore(caseStudyId, orgId, sampleChunks);
}
