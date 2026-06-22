/**
 * generate_proposal_draft — confirm-gated mutation tool handler.
 *
 * RAG pipeline:
 *   1. Embed the RFP requirements string via text-embedding-3-small
 *   2. Retrieve top-3 case study chunks via pgvector cosine similarity
 *   3. Inject chunks as grounded context into GPT structured generation
 *   4. Write scope / pricing / timeline / bio sections to proposals_generated
 */

import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

interface CaseStudyChunk {
  readonly id: string;
  readonly chunk_text: string;
  readonly similarity: number;
}

interface ProposalSections {
  readonly scope: string;
  readonly pricing: string;
  readonly timeline: string;
  readonly bio: string;
}

interface GatewayEmbeddingResponse {
  readonly data: Array<{ readonly embedding: number[] }>;
}

interface GatewayChatResponse {
  readonly choices: Array<{
    readonly message: {
      readonly content: string | null;
    };
  }>;
}

export async function handleGenerateProposalDraft(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const proposalId = args["proposal_id"] as string | undefined;
  const rfpRequirements = args["rfp_requirements"] as string | undefined;
  const clientName = (args["client_name"] as string | undefined) ?? "the client";

  if (!proposalId || !rfpRequirements) {
    return {
      status: 400,
      body: "proposal_id and rfp_requirements are required",
    };
  }

  // Step 1: Embed the RFP requirements
  let embedding: number[];
  try {
    embedding = await embedText(rfpRequirements);
  } catch (e) {
    return {
      status: 502,
      body: `Embedding service unavailable: ${String(e)}`,
    };
  }

  // Step 2: Retrieve top-3 case study chunks via pgvector cosine similarity
  let chunks: CaseStudyChunk[];
  try {
    chunks = await retrieveTopChunks(ctx, embedding, 3);
  } catch (e) {
    return {
      status: 500,
      body: `Case study retrieval failed: ${String(e)}`,
    };
  }

  // Step 3: Generate structured proposal sections via GPT
  let sections: ProposalSections;
  try {
    sections = await generateProposalSections(rfpRequirements, clientName, chunks);
  } catch (e) {
    return {
      status: 502,
      body: `Proposal generation failed: ${String(e)}`,
    };
  }

  // Step 4: Persist the generated proposal sections
  try {
    await upsertProposalGenerated(ctx, proposalId, sections);
  } catch (e) {
    return {
      status: 500,
      body: `Failed to save proposal: ${String(e)}`,
    };
  }

  return {
    status: 200,
    body: {
      proposal_id: proposalId,
      sections,
      retrieved_chunks: chunks.length,
    },
  };
}

async function embedText(text: string): Promise<number[]> {
  const gatewayUrl = process.env["OPENAI_GATEWAY_URL"] ?? "https://api.openai.com";
  const apiKey = process.env["OPENAI_API_KEY"] ?? "";

  const response = await fetch(`${gatewayUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding API returned ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as GatewayEmbeddingResponse;
  const embedding = json.data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("Embedding API returned unexpected shape");
  }
  return embedding;
}

async function retrieveTopChunks(
  ctx: HandlerContext,
  embedding: number[],
  topK: number,
): Promise<CaseStudyChunk[]> {
  const vectorLiteral = `[${embedding.join(",")}]`;
  const rows = await ctx.db.query<CaseStudyChunk>(
    `SELECT id, chunk_text,
            1 - (embedding <=> $1::vector) AS similarity
     FROM case_study_chunks
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    vectorLiteral,
    topK,
  );
  return rows;
}

async function generateProposalSections(
  rfpRequirements: string,
  clientName: string,
  chunks: CaseStudyChunk[],
): Promise<ProposalSections> {
  const gatewayUrl = process.env["OPENAI_GATEWAY_URL"] ?? "https://api.openai.com";
  const apiKey = process.env["OPENAI_API_KEY"] ?? "";

  const contextBlock = chunks
    .map((c, i) => `[Case Study ${i + 1}]\n${c.chunk_text}`)
    .join("\n\n");

  const systemPrompt = `You are a professional proposal writer. Using the provided case study excerpts as grounded context, generate a structured proposal for the client. Return ONLY a JSON object with keys: scope, pricing, timeline, bio. Each value is a plain-text string (1-3 paragraphs). Do not include markdown.`;

  const userPrompt = `Client: ${clientName}

RFP Requirements:
${rfpRequirements}

Relevant Case Studies:
${contextBlock}

Generate the proposal sections now.`;

  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`Chat API returned ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as GatewayChatResponse;
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Chat API returned empty content");
  }

  let parsed: Partial<ProposalSections>;
  try {
    parsed = JSON.parse(content) as Partial<ProposalSections>;
  } catch {
    throw new Error(`Chat API returned non-JSON content: ${content.slice(0, 200)}`);
  }

  return {
    scope: parsed.scope ?? "",
    pricing: parsed.pricing ?? "",
    timeline: parsed.timeline ?? "",
    bio: parsed.bio ?? "",
  };
}

async function upsertProposalGenerated(
  ctx: HandlerContext,
  proposalId: string,
  sections: ProposalSections,
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO proposals_generated (id, proposal_id, scope, pricing, timeline, bio, generated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, NOW())
     ON CONFLICT (proposal_id)
     DO UPDATE SET scope = EXCLUDED.scope,
                   pricing = EXCLUDED.pricing,
                   timeline = EXCLUDED.timeline,
                   bio = EXCLUDED.bio,
                   generated_at = NOW()`,
    proposalId,
    sections.scope,
    sections.pricing,
    sections.timeline,
    sections.bio,
  );
}
