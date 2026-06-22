/**
 * /proposals/[id]/pricing — Dynamic Pricing and Scope Builder (F1-006).
 *
 * Displays AI-suggested day-rate breakdowns, milestone schedules, and optional
 * add-ons for a proposal. Consultants can select add-ons and save the config
 * back to proposals_generated.pricing_config (JSONB).
 */

import type { JSX } from "react";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { buildDb } from "@/lib/db";
import { getSessionUser } from "@/lib/admin-auth";
import {
  suggestPricingBreakdown,
  getProposalById,
  saveProposalPricing,
  countProposalsThisPeriod,
  type PricingConfig,
  type PricingAddOn,
  type ProposalRow,
} from "@/lib/proposals/pricing-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── formatting helpers ────────────────────────────────────────────────────────

function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ── page component ────────────────────────────────────────────────────────────

export default async function PricingPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const db = buildDb();

  let proposal: ProposalRow | null = null;
  try {
    proposal = await getProposalById(params.id, db);
  } catch {
    // proposals_generated table may not exist yet in this environment
  }

  if (proposal !== null && proposal.user_id !== user.id) {
    redirect("/proposals");
  }

  const pricing: PricingConfig =
    proposal?.pricing_config ??
    suggestPricingBreakdown(
      proposal?.project_type ?? null,
      proposal?.prospect_company_size ?? null,
    );

  let proposalCount = 0;
  try {
    proposalCount = await countProposalsThisPeriod(user.id, db);
  } catch {
    // non-fatal
  }

  // ── server action ─────────────────────────────────────────────────────────

  async function savePricing(formData: FormData): Promise<void> {
    "use server";
    const db2 = buildDb();
    const baseConfigRaw = formData.get("base_config") as string | null;
    if (!baseConfigRaw) return;

    let base: PricingConfig;
    try {
      base = JSON.parse(baseConfigRaw) as PricingConfig;
    } catch {
      return;
    }

    const selectedIds = new Set(formData.getAll("addon_selected").map(String));
    const notes = String(formData.get("notes") ?? "").trim();

    const updatedAddOns: PricingAddOn[] = base.addOns.map((addon) => ({
      ...addon,
      selected: selectedIds.has(addon.id),
    }));

    const addOnTotal = updatedAddOns
      .filter((a) => a.selected)
      .reduce((sum, a) => sum + a.unitPrice, 0);

    const total = base.subtotal + addOnTotal - base.discount;

    const updated: PricingConfig = {
      ...base,
      addOns: updatedAddOns,
      total,
      notes,
      generatedAt: base.generatedAt,
    };

    try {
      await saveProposalPricing(params.id, updated, db2);
    } catch {
      // non-fatal if proposals_generated does not exist in this environment
    }
    revalidatePath(`/proposals/${params.id}/pricing`);
  }

  // ── derived display values ────────────────────────────────────────────────

  const selectedAddOnTotal = pricing.addOns
    .filter((a) => a.selected)
    .reduce((sum, a) => sum + a.unitPrice, 0);
  const displayTotal = pricing.subtotal + selectedAddOnTotal - pricing.discount;
  const totalDays = pricing.lineItems.reduce((sum, li) => sum + li.days, 0);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <main>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <Link href="/proposals" className="muted" style={{ fontSize: "0.875rem" }}>
          ← Back to Proposals
        </Link>
        <span className="muted" style={{ fontSize: "0.75rem" }}>
          {proposalCount} proposal{proposalCount !== 1 ? "s" : ""} this month
        </span>
      </div>

      <h1>Pricing &amp; Scope Builder</h1>
      <p>
        {proposal ? (
          <>
            AI-suggested pricing for <strong>{proposal.title}</strong>.{" "}
            Select add-ons and confirm to lock the scope into your proposal.
          </>
        ) : (
          <>
            Demo pricing breakdown &mdash; no proposal record found for this ID.
            Select add-ons and save to store your configuration.
          </>
        )}
      </p>

      {/* Project context badge */}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
        <span className="card" style={{ padding: "0.25rem 0.75rem", fontSize: "0.8rem" }}>
          Type: <strong>{capitalize(pricing.projectType)}</strong>
        </span>
        <span className="card" style={{ padding: "0.25rem 0.75rem", fontSize: "0.8rem" }}>
          Company size: <strong>{capitalize(pricing.companySizeCategory)}</strong>
        </span>
        <span className="card" style={{ padding: "0.25rem 0.75rem", fontSize: "0.8rem" }}>
          Currency: <strong>{pricing.currency}</strong>
        </span>
      </div>

      <form action={savePricing}>
        {/* Hidden base config for server action reconstruction */}
        <input type="hidden" name="base_config" value={JSON.stringify(pricing)} />

        {/* ── Day-rate breakdown ─────────────────────────────────────────── */}
        <section>
          <h2>Day-Rate Breakdown</h2>
          <p className="muted">
            Suggested staffing based on project type and prospect size. Total engagement: {totalDays} days.
          </p>
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Day Rate</th>
                <th>Days</th>
                <th>Subtotal</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {pricing.lineItems.map((item) => (
                <tr key={item.role}>
                  <td>
                    <strong>{item.role}</strong>
                  </td>
                  <td>{formatCurrency(item.dailyRate, pricing.currency)}</td>
                  <td>{item.days}</td>
                  <td>{formatCurrency(item.total, pricing.currency)}</td>
                  <td className="muted">{item.description}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>
                  <strong>Fees subtotal</strong>
                </td>
                <td>
                  <strong>{formatCurrency(pricing.subtotal, pricing.currency)}</strong>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </section>

        {/* ── Milestone schedule ─────────────────────────────────────────── */}
        <section>
          <h2>Milestone Schedule</h2>
          <p className="muted">Payment milestones tied to delivery phases.</p>
          <div style={{ display: "grid", gap: "1rem" }}>
            {pricing.milestones.map((ms, idx) => (
              <div key={idx} className="card">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                  }}
                >
                  <div>
                    <strong>
                      {idx + 1}. {ms.name}
                    </strong>
                    <p className="muted" style={{ margin: "0.25rem 0" }}>
                      {ms.description}
                    </p>
                    <span className="muted" style={{ fontSize: "0.8rem" }}>
                      {ms.durationWeeks} week{ms.durationWeeks !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <strong>
                      {formatCurrency((pricing.subtotal * ms.paymentPercentage) / 100, pricing.currency)}
                    </strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      {ms.paymentPercentage}% on completion
                    </div>
                  </div>
                </div>
                <ul style={{ marginTop: "0.5rem" }}>
                  {ms.deliverables.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* ── Optional add-ons ──────────────────────────────────────────── */}
        <section>
          <h2>Optional Add-Ons</h2>
          <p className="muted">Select services to include in the proposal scope.</p>
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {pricing.addOns.map((addon) => (
              <label key={addon.id} className="card" style={{ cursor: "pointer", display: "flex", gap: "1rem", alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  name="addon_selected"
                  value={addon.id}
                  defaultChecked={addon.selected}
                  style={{ marginTop: "0.2rem", flexShrink: 0 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
                    <strong>{addon.name}</strong>
                    <span>{formatCurrency(addon.unitPrice, pricing.currency)}</span>
                  </div>
                  <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                    {addon.description}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </section>

        {/* ── Notes ─────────────────────────────────────────────────────── */}
        <section>
          <h2>Pricing Notes</h2>
          <textarea
            name="notes"
            rows={4}
            placeholder="Add any pricing notes, assumptions, or exclusions for the client…"
            defaultValue={pricing.notes}
            style={{ width: "100%" }}
          />
        </section>

        {/* ── Totals summary ─────────────────────────────────────────────── */}
        <div className="card" style={{ marginTop: "1.5rem" }}>
          <table style={{ width: "100%" }}>
            <tbody>
              <tr>
                <td>Fees subtotal</td>
                <td style={{ textAlign: "right" }}>{formatCurrency(pricing.subtotal, pricing.currency)}</td>
              </tr>
              {pricing.discount > 0 && (
                <tr>
                  <td className="muted">Discount</td>
                  <td style={{ textAlign: "right" }} className="muted">
                    −{formatCurrency(pricing.discount, pricing.currency)}
                  </td>
                </tr>
              )}
              {selectedAddOnTotal > 0 && (
                <tr>
                  <td className="muted">Selected add-ons</td>
                  <td style={{ textAlign: "right" }} className="muted">
                    +{formatCurrency(selectedAddOnTotal, pricing.currency)}
                  </td>
                </tr>
              )}
              <tr>
                <td>
                  <strong>Total engagement fee</strong>
                </td>
                <td style={{ textAlign: "right" }}>
                  <strong>{formatCurrency(displayTotal, pricing.currency)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: "1.5rem", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <button type="submit">Save Pricing Configuration</button>
          <Link href="/proposals" className="btn secondary">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}
