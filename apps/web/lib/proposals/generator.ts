import { Pool } from 'pg';
import { retrieveRelevantChunks, RetrievedChunk } from './retrieval';

export interface ParsedRFP {
  id: string;
  title: string;
  client_name: string;
  requirements: string;
  budget_range?: string | null;
  timeline?: string | null;
  full_text: string;
}

export interface ProposalSections {
  scope: string;
  pricing: string;
  timeline: string;
  team_bio: string;
}

export interface GroundingClaim {
  section: keyof ProposalSections;
  claim: string;
  supporting_chunk_id: string;
  confidence: number;
}

export interface GroundingReport {
  claims: GroundingClaim[];
  ungrounded_count: number;
  grounding_score: number;
}

export interface GeneratedProposal {
  id: string;
  rfp_id: string;
  sections: ProposalSections;
  retrieved_chunk_ids: string[];
  grounding_report: GroundingReport;
  model_used: string;
  created_at: Date;
}

export const PROPOSALS_GENERATED_DDL = `
CREATE TABLE IF NOT EXISTS proposals_generated (
  id                  uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_id              uuid  NOT NULL,
  sections            jsonb NOT NULL,
  retrieved_chunk_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  grounding_report    jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_used          text  NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proposals_generated_rfp_id
  ON proposals_generated (rfp_id);
CREATE INDEX IF NOT EXISTS idx_proposals_generated_created_at
  ON proposals_generated (created_at DESC);
`;

export const PROPOSALS_RFPS_DDL = `
CREATE TABLE IF NOT EXISTS proposals_rfps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  client_name  text NOT NULL,
  requirements text NOT NULL,
  budget_range text,
  timeline     text,
  full_text    text NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proposals_rfps_created_at
  ON proposals_rfps (created_at DESC);
`;

const GENERATION_MODEL = 'gpt-5.4-mini';

let _pool: Pool | null = null;

function getDbPool(): Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

function buildRAGPrompt(rfp: ParsedRFP, chunks: RetrievedChunk[]): string {
  const chunksContext = chunks
    .map(
      (chunk, idx) =>
        `[CASE STUDY ${idx + 1} — ID: ${chunk.id}]\n${chunk.content}\n(Similarity score: ${(chunk.similarity * 100).toFixed(1)}%)`,
    )
    .join('\n\n---\n\n');

  return `You are a senior proposal writer for a consulting firm. Generate a structured business proposal based on the RFP below.

CRITICAL RULE: Every credential, result, or expertise claim you make MUST be grounded in the provided case studies. Do NOT fabricate any outcome, certification, client name, or metric not explicitly present in the context.

## RFP Details
Title: ${rfp.title}
Client: ${rfp.client_name}
Budget Range: ${rfp.budget_range ?? 'Not specified'}
Requested Timeline: ${rfp.timeline ?? 'Not specified'}

Requirements:
${rfp.requirements}

## Grounding Context — Relevant Case Studies
${chunksContext}

## Task
Return a single JSON object with exactly these four keys. Every sentence that makes a specific claim MUST include an inline citation like [CASE STUDY 1] referencing one of the case studies above.

{
  "scope": "Detailed project scope statement. Cite specific capabilities proven in the case studies.",
  "pricing": "Structured pricing proposal. Justify estimates by referencing comparable work from the case studies.",
  "timeline": "Phased timeline with milestones. Anchor durations to timelines visible in the case studies.",
  "team_bio": "Team biographies. Only list expertise and past projects that appear in the case studies."
}

Return ONLY the JSON object — no markdown fences, no preamble, no trailing text.`;
}
async function callGenerationModel(prompt: string): Promise<ProposalSections> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GENERATION_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a professional proposal writer. Respond with valid JSON only. Never fabricate credentials.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI chat completions error ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const raw = data.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('Empty response from generation model');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Model returned non-JSON content: ${raw.slice(0, 300)}`);
  }

  const obj = parsed as Record<string, unknown>;
  const required = ['scope', 'pricing', 'timeline', 'team_bio'] as const;
  for (const field of required) {
    if (typeof obj[field] !== 'string') {
      throw new Error(`Generated proposal is missing required section "${field}"`);
    }
  }

  return {
    scope: obj.scope as string,
    pricing: obj.pricing as string,
    timeline: obj.timeline as string,
    team_bio: obj.team_bio as string,
  };
}
function verifyGrounding(sections: ProposalSections, chunks: RetrievedChunk[]): GroundingReport {
  const claims: GroundingClaim[] = [];
  let ungroundedCount = 0;
  const sectionKeys: Array<keyof ProposalSections> = ['scope', 'pricing', 'timeline', 'team_bio'];

  for (const section of sectionKeys) {
    const text = sections[section];
    const refs = [...text.matchAll(/\[CASE STUDY (\d+)\]/gi)];

    if (refs.length === 0) {
      ungroundedCount += 1;
      claims.push({
        section,
        claim: `Section "${section}" contains no grounding citations`,
        supporting_chunk_id: '',
        confidence: 0,
      });
    } else {
      for (const match of refs) {
        const chunkIdx = parseInt(match[1], 10) - 1;
        const chunk = chunks[chunkIdx];
        if (chunk) {
          claims.push({
            section,
            claim: `Grounded citation to case study ${match[1]}`,
            supporting_chunk_id: chunk.id,
            confidence: chunk.similarity,
          });
        } else {
          ungroundedCount += 1;
          claims.push({
            section,
            claim: `Out-of-range citation ${match[0]} (only ${chunks.length} chunks available)`,
            supporting_chunk_id: '',
            confidence: 0,
          });
        }
      }
    }
  }

  const groundedClaims = claims.filter((c) => c.supporting_chunk_id !== '');
  const groundingScore = claims.length > 0 ? groundedClaims.length / claims.length : 0;
  return { claims, ungrounded_count: ungroundedCount, grounding_score: groundingScore };
}
async function storeGeneratedProposal(params: {
  rfp_id: string;
  sections: ProposalSections;
  retrieved_chunk_ids: string[];
  grounding_report: GroundingReport;
}): Promise<GeneratedProposal> {
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    const result = await client.query<{
      id: string;
      rfp_id: string;
      sections: ProposalSections;
      retrieved_chunk_ids: string[];
      grounding_report: GroundingReport;
      model_used: string;
      created_at: Date;
    }>(
      `INSERT INTO proposals_generated
         (rfp_id, sections, retrieved_chunk_ids, grounding_report, model_used)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, rfp_id, sections, retrieved_chunk_ids, grounding_report, model_used, created_at`,
      [
        params.rfp_id,
        JSON.stringify(params.sections),
        params.retrieved_chunk_ids,
        JSON.stringify(params.grounding_report),
        GENERATION_MODEL,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('Insert into proposals_generated returned no row');
    }
    return row;
  } finally {
    client.release();
  }
}
async function getRFPById(rfpId: string): Promise<ParsedRFP | null> {
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    const result = await client.query<ParsedRFP>(
      `SELECT id, title, client_name, requirements, budget_range, timeline, full_text
       FROM proposals_rfps
       WHERE id = $1`,
      [rfpId],
    );
    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
}

export async function generateProposalDraft(
  rfpId: string,
  options?: { topK?: number; minGroundingScore?: number },
): Promise<GeneratedProposal> {
  const topK = options?.topK ?? 3;
  const minGroundingScore = options?.minGroundingScore ?? 0.5;

  const rfp = await getRFPById(rfpId);
  if (!rfp) {
    throw new Error(`RFP not found: ${rfpId}`);
  }

  // Retrieve top-K case-study chunks via pgvector cosine similarity
  const searchText = `${rfp.title} ${rfp.requirements} ${rfp.full_text}`;
  const chunks = await retrieveRelevantChunks(searchText, topK);

  if (chunks.length === 0) {
    throw new Error(
      'No case study chunks found. Embed case studies before generating proposals.',
    );
  }

  // Build grounded RAG prompt and call generation model
  const prompt = buildRAGPrompt(rfp, chunks);
  const sections = await callGenerationModel(prompt);

  // Verify every section cites retrieved evidence
  const groundingReport = verifyGrounding(sections, chunks);

  if (groundingReport.grounding_score < minGroundingScore) {
    throw new Error(
      `Proposal grounding score ${groundingReport.grounding_score.toFixed(2)} is below minimum ` +
        `${minGroundingScore}. ${groundingReport.ungrounded_count} section(s) lack citations.`,
    );
  }

  return storeGeneratedProposal({
    rfp_id: rfpId,
    sections,
    retrieved_chunk_ids: chunks.map((c) => c.id),
    grounding_report: groundingReport,
  });
}
export async function getGeneratedProposal(proposalId: string): Promise<GeneratedProposal | null> {
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    const result = await client.query<GeneratedProposal>(
      `SELECT id, rfp_id, sections, retrieved_chunk_ids, grounding_report, model_used, created_at
       FROM proposals_generated
       WHERE id = $1`,
      [proposalId],
    );
    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
}
export async function listProposalsByRFP(rfpId: string): Promise<GeneratedProposal[]> {
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    const result = await client.query<GeneratedProposal>(
      `SELECT id, rfp_id, sections, retrieved_chunk_ids, grounding_report, model_used, created_at
       FROM proposals_generated
       WHERE rfp_id = $1
       ORDER BY created_at DESC`,
      [rfpId],
    );
    return result.rows;
  } finally {
    client.release();
  }
}
