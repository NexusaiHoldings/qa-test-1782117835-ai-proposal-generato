/**
 * /library — Case Study Library Manager (F1-002).
 *
 * Consultants upload PDF case studies here. The ingestion pipeline chunks each
 * PDF into ~500-token segments, embeds them with OpenAI text-embedding-3-small,
 * and stores them in proposals_case_study_chunks (pgvector).
 *
 * Gate: proposal generation is blocked until ≥ 3 case studies have been
 * successfully embedded, as mandated by the COO research direction.
 */

import type { JSX } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/admin-auth";
import { buildDb } from "@/lib/db";
import { buildEventBus } from "@/lib/events";
import { handleRegisterFile } from "@nexus/files-and-media";
import { createCaseStudy, ingestCaseStudy } from "@/lib/proposals/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIN_EMBEDDED_FOR_PROPOSALS = 3;

interface CaseStudyRow {
  id: string;
  filename: string;
  title: string;
  status: string;
  chunk_count: number;
  retrieval_quality_score: string | null;
  error_message: string | null;
  created_at: string;
}

// ── Server Action ────────────────────────────────────────────────────────────

async function uploadCaseStudy(formData: FormData): Promise<void> {
  "use server";

  const user = await getSessionUser();
  if (!user) return;

  const file = formData.get("pdf") as File | null;
  const rawTitle = (formData.get("title") as string | null) ?? "";
  const title = rawTitle.trim();

  if (!file || file.size === 0 || !title) return;

  const orgId = process.env.DEFAULT_ORG_ID ?? user.id;
  const db = buildDb();
  const events = buildEventBus();

  // Sanitise filename for use as a storage key segment.
  const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storageKey = `proposals/${orgId}/${Date.now()}-${safeFilename}`;

  // Register the file with @nexus/files-and-media for audit + scan tracking.
  await handleRegisterFile(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { db: db as any, events: events as any },
    {
      user_id: user.id,
      filename: file.name,
      mime_type: file.type || "application/pdf",
      size_bytes: file.size,
      storage_key: storageKey,
    },
  );

  // Create the case study record in pending state.
  const caseStudyId = await createCaseStudy({
    orgId,
    filename: file.name,
    title,
    fileId: storageKey,
    uploadedBy: user.id,
  });

  // Run the ingestion pipeline synchronously (suitable for MVP; production
  // would offload to a Vercel Cron or queue to avoid serverless timeout).
  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await ingestCaseStudy({
      caseStudyId,
      orgId,
      pdfBuffer: buffer,
      filename: file.name,
      uploadedBy: user.id,
    });
  } catch {
    // Errors are already persisted to the case study record by ingestCaseStudy.
  }

  revalidatePath("/library");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }): JSX.Element {
  const colorMap: Record<string, string> = {
    pending: "#6b7280",
    processing: "#2563eb",
    embedded: "#16a34a",
    failed: "#dc2626",
  };
  const color = colorMap[status] ?? "#6b7280";
  return (
    <span style={{ color, fontWeight: 600, textTransform: "capitalize" }}>
      {status}
    </span>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function LibraryPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const orgId = process.env.DEFAULT_ORG_ID ?? user.id;
  const db = buildDb();

  const studies = await db.query<CaseStudyRow>(
    `SELECT id, filename, title, status, chunk_count, retrieval_quality_score,
            error_message, created_at
     FROM proposals_case_studies
     WHERE org_id = $1
     ORDER BY created_at DESC`,
    orgId,
  );

  const embeddedCount = studies.filter((s) => s.status === "embedded").length;
  const gateBlocked = embeddedCount < MIN_EMBEDDED_FOR_PROPOSALS;
  const remaining = MIN_EMBEDDED_FOR_PROPOSALS - embeddedCount;

  return (
    <main>
      <h1>Case Study Library</h1>
      <p>
        Upload PDF case studies to power RAG-based proposal generation. Embeddings are generated
        automatically with OpenAI text-embedding-3-small.
      </p>

      {gateBlocked && (
        <div
          className="card"
          style={{ borderColor: "#f59e0b", background: "#fffbeb", marginBottom: "1.5rem" }}
        >
          <strong style={{ color: "#b45309" }}>Proposal generation is blocked</strong>
          <p className="muted" style={{ marginTop: "0.25rem" }}>
            {embeddedCount} of {MIN_EMBEDDED_FOR_PROPOSALS} required case studies are embedded.
            Upload and process{" "}
            {remaining === 1 ? "1 more case study" : `${remaining} more case studies`} to unlock
            proposal generation.
          </p>
        </div>
      )}

      {!gateBlocked && (
        <div
          className="card"
          style={{ borderColor: "#16a34a", background: "#f0fdf4", marginBottom: "1.5rem" }}
        >
          <strong style={{ color: "#15803d" }}>Proposal generation is available</strong>
          <p className="muted" style={{ marginTop: "0.25rem" }}>
            {embeddedCount} case{embeddedCount === 1 ? "" : "s"} embedded and ready for retrieval.
          </p>
        </div>
      )}

      <form action={uploadCaseStudy}>
        <div className="toolbar">
          <input
            type="text"
            name="title"
            placeholder="Case study title"
            required
            maxLength={200}
            style={{ minWidth: "18rem" }}
          />
          <input
            type="file"
            name="pdf"
            accept=".pdf,application/pdf"
            required
          />
          <button type="submit">Upload &amp; Embed</button>
        </div>
      </form>

      {studies.length === 0 ? (
        <div className="empty">
          <p>No case studies yet. Upload your first PDF to get started.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Chunks</th>
              <th>Retrieval Quality</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {studies.map((study) => (
              <tr key={study.id}>
                <td>
                  <strong>{study.title}</strong>
                  <br />
                  <span className="muted">{study.filename}</span>
                </td>
                <td>
                  <StatusBadge status={study.status} />
                  {study.error_message && (
                    <p
                      className="muted"
                      style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}
                      title={study.error_message}
                    >
                      {study.error_message.slice(0, 80)}
                      {study.error_message.length > 80 ? "…" : ""}
                    </p>
                  )}
                </td>
                <td>{study.chunk_count > 0 ? study.chunk_count : "—"}</td>
                <td>
                  {study.retrieval_quality_score != null
                    ? `${(parseFloat(study.retrieval_quality_score) * 100).toFixed(1)}%`
                    : "—"}
                </td>
                <td className="muted">
                  {new Date(study.created_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
