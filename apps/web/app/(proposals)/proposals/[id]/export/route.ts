/**
 * GET  /proposals/[id]/export          — stream a DOCX file to the client
 * GET  /proposals/[id]/export?format=json — return proposal JSON for the editor
 * PUT  /proposals/[id]/export          — persist section edits to proposals_generated
 */

import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { handleSession } from "@nexus/identity-and-access";
import { buildDb } from "@/lib/db";
import { buildEventBus } from "@/lib/events";
import {
  buildProposalDocx,
  type ProposalData,
  type ProposalSection,
} from "@/lib/proposals/docx-builder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SessionUser {
  user_id: string;
  email: string;
  session_id: string;
}

interface ProposalRow {
  id: string;
  title: string;
  client_name: string | null;
  created_at: string;
}

interface SectionRow {
  section: string;
  content: string;
}

async function getSessionUser(
  request: NextRequest,
): Promise<SessionUser | null> {
  let authHeader = request.headers.get("authorization");

  if (!authHeader) {
    const cookieStore = cookies();
    const token = cookieStore.get("session_token")?.value;
    if (token) authHeader = `Bearer ${token}`;
  }

  if (!authHeader) return null;

  const result = await handleSession({
    authorizationHeader: authHeader,
    ctx: { db: buildDb(), events: buildEventBus() },
  });

  if (result.status !== 200) return null;

  const body =
    typeof result.body === "string"
      ? (JSON.parse(result.body) as unknown as SessionUser)
      : (result.body as unknown as SessionUser);

  return body;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = params;
  const format = request.nextUrl.searchParams.get("format");
  const db = buildDb();

  let proposalRows: ProposalRow[];
  try {
    proposalRows = await db.query<ProposalRow>(
      "SELECT id, title, client_name, created_at FROM proposals WHERE id = $1",
      id,
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "proposal_fetch_error",
        proposalId: id,
        error: String(err),
      }),
    );
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }

  if (proposalRows.length === 0) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  const proposalRow = proposalRows[0];

  let sectionRows: SectionRow[];
  try {
    sectionRows = await db.query<SectionRow>(
      "SELECT section, content FROM proposals_generated WHERE proposal_id = $1 ORDER BY section",
      id,
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "proposal_sections_fetch_error",
        proposalId: id,
        error: String(err),
      }),
    );
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }

  if (format === "json") {
    return NextResponse.json({
      id: proposalRow.id,
      title: proposalRow.title,
      clientName: proposalRow.client_name,
      createdAt: proposalRow.created_at,
      sections: sectionRows,
    });
  }

  const proposalData: ProposalData = {
    id: proposalRow.id,
    title: proposalRow.title,
    clientName: proposalRow.client_name,
    sections: sectionRows,
    createdAt: new Date(proposalRow.created_at),
  };

  let buffer: Buffer;
  try {
    buffer = await buildProposalDocx(proposalData);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "docx_build_error",
        proposalId: id,
        error: String(err),
      }),
    );
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }

  const fileName = `proposal-${id.slice(0, 8)}.docx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(buffer.length),
    },
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = params;

  let body: { sections: ProposalSection[] };
  try {
    body = (await request.json()) as { sections: ProposalSection[] };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.sections) || body.sections.length === 0) {
    return NextResponse.json(
      { error: "sections must be a non-empty array" },
      { status: 400 },
    );
  }

  for (const sec of body.sections) {
    if (typeof sec.section !== "string" || typeof sec.content !== "string") {
      return NextResponse.json(
        { error: "Each section must have string section and content fields" },
        { status: 400 },
      );
    }
  }

  const db = buildDb();

  try {
    await db.execute("BEGIN");

    for (const sec of body.sections) {
      await db.execute(
        `INSERT INTO proposals_generated (proposal_id, section, content, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (proposal_id, section)
         DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
        id,
        sec.section,
        sec.content,
      );
    }

    await db.execute("COMMIT");
  } catch (err) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // best-effort rollback
    }
    console.error(
      JSON.stringify({
        event: "proposal_save_error",
        proposalId: id,
        error: String(err),
      }),
    );
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
