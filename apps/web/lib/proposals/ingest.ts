/**
 * Case study ingestion pipeline (F1-002).
 *
 * Flow: PDF buffer → text extraction → ~500-token chunks → OpenAI
 * text-embedding-3-small embeddings → pgvector storage → eval harness.
 *
 * pdf-parse is a Node-only module; it is loaded via eval("require") so
 * Next.js webpack does not attempt to bundle it for the client.
 *
 * OpenAI SDK is forbidden in company apps — embeddings are fetched via the
 * native fetch API instead.
 */

import { buildDb } from "@/lib/db";
import { evaluateRetrievalQuality } from "./eval-harness";

// OpenAI embedding model specified in tech stack.
const EMBEDDING_MODEL = "text-embedding-3-small";
// Target chunk size: ~500 tokens ≈ 2 000 characters (4 chars / token approximation).
const TARGET_CHUNK_CHARS = 2000;
// Minimum content length to store as a chunk.
const MIN_CHUNK_CHARS = 50;

interface PdfParseResult {
  text: string;
  numpages: number;
}

export interface IngestOptions {
  caseStudyId: string;
  orgId: string;
  pdfBuffer: Buffer;
  filename: string;
  uploadedBy: string;
}

export interface IngestResult {
  chunkCount: number;
  qualityScore: number;
  pageCount: number;
}

export interface CreateCaseStudyParams {
  orgId: string;
  filename: string;
  title: string;
  fileId: string | null;
  uploadedBy: string;
}

/** Extract text and page count from a PDF buffer using pdf-parse. */
async function parsePdfBuffer(buffer: Buffer): Promise<{ text: string; numPages: number }> {
  // eval("require") prevents webpack from bundling this Node-only module.
  // eslint-disable-next-line no-eval
  const pdfParse = eval("require")("pdf-parse") as (buf: Buffer) => Promise<PdfParseResult>;
  const result = await pdfParse(buffer);
  return { text: result.text, numPages: result.numpages };
}

/** Split text into overlapping chunks of approximately TARGET_CHUNK_CHARS characters. */
function chunkText(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const chunks: string[] = [];
  let currentWords: string[] = [];
  let currentLen = 0;

  for (const word of words) {
    currentWords.push(word);
    currentLen += word.length + 1;
    if (currentLen >= TARGET_CHUNK_CHARS) {
      const chunk = currentWords.join(" ").trim();
      if (chunk.length >= MIN_CHUNK_CHARS) {
        chunks.push(chunk);
      }
      // 10% overlap: keep the last ~10% of words to preserve context.
      const overlapCount = Math.max(1, Math.floor(currentWords.length * 0.1));
      currentWords = currentWords.slice(-overlapCount);
      currentLen = currentWords.reduce((acc, w) => acc + w.length + 1, 0);
    }
  }

  // Flush remaining words.
  if (currentWords.length > 0) {
    const chunk = currentWords.join(" ").trim();
    if (chunk.length >= MIN_CHUNK_CHARS) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

/** Call OpenAI embeddings API via fetch (SDK is banned in company apps). */
async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `OpenAI embeddings error ${response.status}: ${detail.slice(0, 200)}`,
    );
  }
  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

/** Write an entry to the admin_audit_log table (via @nexus/admin-console). */
async function writeAuditEntry(params: {
  userId: string;
  action: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const db = buildDb();
  await db.execute(
    `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    params.userId,
    params.action,
    params.targetType,
    params.targetId,
    JSON.stringify(params.payload),
  );
}

/**
 * Create a new case study record in pending state.
 * Returns the new record's UUID.
 */
export async function createCaseStudy(params: CreateCaseStudyParams): Promise<string> {
  const db = buildDb();
  const rows = await db.query<{ id: string }>(
    `INSERT INTO proposals_case_studies (org_id, filename, title, file_id, uploaded_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    params.orgId,
    params.filename,
    params.title,
    params.fileId,
    params.uploadedBy,
  );
  return rows[0].id;
}

/**
 * Full ingestion pipeline: parse PDF → chunk → embed → store → evaluate.
 *
 * Updates the case study record throughout; on failure, sets status to
 * 'failed' with an error_message and re-throws so the caller can surface
 * the error to the user.
 */
export async function ingestCaseStudy(options: IngestOptions): Promise<IngestResult> {
  const { caseStudyId, orgId, pdfBuffer, filename, uploadedBy } = options;
  const db = buildDb();

  // Mark as processing.
  await db.execute(
    `UPDATE proposals_case_studies
     SET status = 'processing', updated_at = now()
     WHERE id = $1`,
    caseStudyId,
  );

  try {
    // 1. Parse PDF.
    const { text, numPages } = await parsePdfBuffer(pdfBuffer);
    if (!text || text.trim().length === 0) {
      throw new Error("PDF produced no extractable text — the file may be scanned or encrypted.");
    }

    // 2. Chunk text into ~500-token segments.
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new Error("Text chunking produced no segments.");
    }

    // 3. Generate embeddings and store each chunk.
    for (let idx = 0; idx < chunks.length; idx++) {
      const embedding = await generateEmbedding(chunks[idx]);
      const tokenCount = Math.round(chunks[idx].length / 4);
      const embeddingLiteral = `[${embedding.join(",")}]`;
      await db.execute(
        `INSERT INTO proposals_case_study_chunks
           (case_study_id, org_id, chunk_index, content, token_count, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        caseStudyId,
        orgId,
        idx,
        chunks[idx],
        tokenCount,
        embeddingLiteral,
      );
    }

    // 4. Evaluate retrieval quality.
    const qualityScore = await evaluateRetrievalQuality(caseStudyId, orgId);

    // 5. Mark as embedded with final metadata.
    await db.execute(
      `UPDATE proposals_case_studies
       SET status = 'embedded',
           chunk_count = $1,
           page_count = $2,
           retrieval_quality_score = $3,
           updated_at = now()
       WHERE id = $4`,
      chunks.length,
      numPages,
      qualityScore,
      caseStudyId,
    );

    // 6. Audit trail via @nexus/admin-console.
    await writeAuditEntry({
      userId: uploadedBy,
      action: "case_study.embedded",
      targetType: "case_study",
      targetId: caseStudyId,
      payload: {
        filename,
        chunkCount: chunks.length,
        pageCount: numPages,
        qualityScore,
      },
    }).catch((auditErr) => {
      console.error(`[proposals/ingest] audit write failed: ${auditErr}`);
    });

    console.log(
      JSON.stringify({
        event: "case_study.embedded",
        caseStudyId,
        chunkCount: chunks.length,
        pageCount: numPages,
        qualityScore,
      }),
    );

    return { chunkCount: chunks.length, qualityScore, pageCount: numPages };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.execute(
      `UPDATE proposals_case_studies
       SET status = 'failed', error_message = $1, updated_at = now()
       WHERE id = $2`,
      message.slice(0, 500),
      caseStudyId,
    ).catch(() => undefined);

    await writeAuditEntry({
      userId: uploadedBy,
      action: "case_study.ingest_failed",
      targetType: "case_study",
      targetId: caseStudyId,
      payload: { filename, error: message.slice(0, 200) },
    }).catch(() => undefined);

    console.error(
      JSON.stringify({ event: "case_study.ingest_failed", caseStudyId, error: message.slice(0, 200) }),
    );

    throw err;
  }
}
