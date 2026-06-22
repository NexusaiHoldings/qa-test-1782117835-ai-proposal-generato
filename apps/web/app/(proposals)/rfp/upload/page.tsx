import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { parseRFP, type RFPRequirements } from "@/lib/proposals/rfp-parser";

async function processRFPAction(formData: FormData): Promise<void> {
  "use server";

  let requirements: RFPRequirements | null = null;
  let errorMsg: string | null = null;

  try {
    const textContent = formData.get("rfpText") as string | null;
    const pdfFile = formData.get("rfpFile") as File | null;

    if (pdfFile && pdfFile.size > 0) {
      const arrayBuffer = await pdfFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      requirements = await parseRFP({ type: "pdf", buffer });
    } else if (textContent?.trim()) {
      requirements = await parseRFP({ type: "text", content: textContent.trim() });
    } else {
      errorMsg = "Please upload a PDF file or paste RFP text before submitting.";
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : "Extraction failed";
  }

  if (requirements) {
    cookies().set("rfp_extraction_result", JSON.stringify(requirements), {
      maxAge: 600,
      httpOnly: true,
      sameSite: "lax",
    });
    redirect("/rfp/upload?done=1");
  } else {
    redirect(
      `/rfp/upload?error=${encodeURIComponent(errorMsg ?? "Unknown error")}`
    );
  }
}

export default async function RfpUploadPage({
  searchParams,
}: {
  searchParams: { done?: string; error?: string };
}) {
  const isDone = searchParams.done === "1";
  const errorMessage = searchParams.error
    ? decodeURIComponent(searchParams.error)
    : null;

  let requirements: RFPRequirements | null = null;
  if (isDone) {
    const cookieStore = cookies();
    const resultCookie = cookieStore.get("rfp_extraction_result");
    if (resultCookie?.value) {
      try {
        requirements = JSON.parse(resultCookie.value) as RFPRequirements;
      } catch {
        requirements = null;
      }
    }
  }

  return (
    <main>
      <h1>RFP Ingestion &amp; Requirement Extractor</h1>
      <p>
        Upload a PDF or paste RFP text to extract evaluation criteria, budget
        signals, deliverable requirements, and timeline constraints.
      </p>

      {errorMessage && (
        <p style={{ color: "var(--color-destructive, #b91c1c)" }}>
          {errorMessage}
        </p>
      )}

      {!requirements ? (
        <form action={processRFPAction} encType="multipart/form-data">
          <div className="card">
            <label htmlFor="rfpFile">
              <strong>Upload PDF</strong>
            </label>
            <input id="rfpFile" type="file" name="rfpFile" accept=".pdf" />
          </div>
          <div className="card">
            <label htmlFor="rfpText">
              <strong>Or paste RFP text</strong>
            </label>
            <textarea
              id="rfpText"
              name="rfpText"
              rows={14}
              placeholder="Paste your RFP document text here..."
              style={{ width: "100%", fontFamily: "monospace", fontSize: "0.85rem" }}
            />
          </div>
          <button type="submit">Extract Requirements</button>
        </form>
      ) : (
        <section>
          <h2>{requirements.title}</h2>
          <p className="muted">
            Extracted {new Date(requirements.extractedAt).toLocaleString()} · ID:{" "}
            {requirements.rfpId}
          </p>
          <a href="/rfp/upload" className="btn secondary">
            Extract Another RFP
          </a>

          {requirements.evaluationCriteria.length > 0 && (
            <div className="card">
              <h3>Evaluation Criteria</h3>
              <table>
                <thead>
                  <tr>
                    <th>Criterion</th>
                    <th>Weight</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {requirements.evaluationCriteria.map((ec, idx) => (
                    <tr key={idx}>
                      <td>{ec.criterion}</td>
                      <td>{ec.weight ?? "—"}</td>
                      <td>{ec.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {requirements.budgetSignals.length > 0 && (
            <div className="card">
              <h3>Budget Signals</h3>
              <table>
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th>Currency</th>
                    <th>Type</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {requirements.budgetSignals.map((bs, idx) => (
                    <tr key={idx}>
                      <td>{bs.amount ?? "—"}</td>
                      <td>{bs.currency ?? "—"}</td>
                      <td>{bs.budgetType}</td>
                      <td>{bs.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {requirements.deliverableRequirements.length > 0 && (
            <div className="card">
              <h3>Deliverable Requirements</h3>
              <table>
                <thead>
                  <tr>
                    <th>Deliverable</th>
                    <th>Deadline</th>
                    <th>Format</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {requirements.deliverableRequirements.map((dr, idx) => (
                    <tr key={idx}>
                      <td>{dr.deliverable}</td>
                      <td>{dr.deadline ?? "—"}</td>
                      <td>{dr.format ?? "—"}</td>
                      <td>{dr.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {requirements.timelineConstraints.length > 0 && (
            <div className="card">
              <h3>Timeline Constraints</h3>
              <table>
                <thead>
                  <tr>
                    <th>Phase</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Milestone</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {requirements.timelineConstraints.map((tc, idx) => (
                    <tr key={idx}>
                      <td>{tc.phase ?? "—"}</td>
                      <td>{tc.startDate ?? "—"}</td>
                      <td>{tc.endDate ?? "—"}</td>
                      <td>{tc.milestone ?? "—"}</td>
                      <td>{tc.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
