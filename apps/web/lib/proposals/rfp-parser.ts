import crypto from "node:crypto";

export interface EvaluationCriterion {
  criterion: string;
  weight?: string;
  notes?: string;
}

export interface BudgetSignal {
  amount?: string;
  currency?: string;
  budgetType: "fixed" | "range" | "not_specified";
  notes?: string;
}

export interface DeliverableRequirement {
  deliverable: string;
  deadline?: string;
  format?: string;
  notes?: string;
}

export interface TimelineConstraint {
  phase?: string;
  startDate?: string;
  endDate?: string;
  milestone?: string;
  notes?: string;
}

export interface RFPRequirements {
  rfpId: string;
  title: string;
  evaluationCriteria: EvaluationCriterion[];
  budgetSignals: BudgetSignal[];
  deliverableRequirements: DeliverableRequirement[];
  timelineConstraints: TimelineConstraint[];
  extractedAt: string;
}

export type ParseRFPInput =
  | { type: "pdf"; buffer: Buffer }
  | { type: "text"; content: string };

interface LLMExtractionResult {
  title?: string;
  evaluationCriteria?: EvaluationCriterion[];
  budgetSignals?: BudgetSignal[];
  deliverableRequirements?: DeliverableRequirement[];
  timelineConstraints?: TimelineConstraint[];
}

type PdfParseResult = { text: string; numpages: number };
type PdfParseFn = (buf: Buffer) => Promise<PdfParseResult>;

export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // webpackIgnore prevents Next.js from bundling pdf-parse for the client runtime
  const pdfParse = (
    await import(/* webpackIgnore: true */ "pdf-parse")
  ).default as PdfParseFn;
  const result = await pdfParse(buffer);
  return result.text;
}

async function callLLM(systemPrompt: string, userContent: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not configured");
  }
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response");
  }
  return content;
}

export async function extractRFPRequirements(
  text: string
): Promise<Omit<RFPRequirements, "rfpId" | "extractedAt">> {
  const systemPrompt = `You are an expert analyst of Request for Proposal (RFP) documents.
Extract all structured requirements from the provided RFP text and return a single JSON object with:
- title: string (the RFP project name or title)
- evaluationCriteria: array of {criterion: string, weight?: string, notes?: string}
- budgetSignals: array of {amount?: string, currency?: string, budgetType: "fixed"|"range"|"not_specified", notes?: string}
- deliverableRequirements: array of {deliverable: string, deadline?: string, format?: string, notes?: string}
- timelineConstraints: array of {phase?: string, startDate?: string, endDate?: string, milestone?: string, notes?: string}
Extract every explicit and implicit requirement. Return only the JSON object.`;

  const truncated =
    text.length > 12000
      ? `${text.slice(0, 12000)}\n...[document truncated for length]`
      : text;

  const rawJson = await callLLM(systemPrompt, truncated);
  const parsed = JSON.parse(rawJson) as LLMExtractionResult;

  return {
    title: parsed.title ?? "Untitled RFP",
    evaluationCriteria: Array.isArray(parsed.evaluationCriteria)
      ? parsed.evaluationCriteria
      : [],
    budgetSignals: Array.isArray(parsed.budgetSignals) ? parsed.budgetSignals : [],
    deliverableRequirements: Array.isArray(parsed.deliverableRequirements)
      ? parsed.deliverableRequirements
      : [],
    timelineConstraints: Array.isArray(parsed.timelineConstraints)
      ? parsed.timelineConstraints
      : [],
  };
}

export async function parseRFP(input: ParseRFPInput): Promise<RFPRequirements> {
  const text =
    input.type === "pdf"
      ? await extractTextFromPdf(input.buffer)
      : input.content;

  if (!text.trim()) {
    throw new Error("No text content found in the provided input");
  }

  const requirements = await extractRFPRequirements(text);

  return {
    ...requirements,
    rfpId: crypto.randomUUID(),
    extractedAt: new Date().toISOString(),
  };
}
