/**
 * Pricing engine for proposal day-rate breakdowns, milestones, and add-ons.
 *
 * Feature F1-006: Dynamic Pricing and Scope Builder.
 * Inputs: project type (from RFP extraction) + prospect company size (inferred from RFP).
 * Output: PricingConfig stored in proposals_generated.pricing_config JSONB.
 */

import type { Db } from "@nexus/identity-and-access/api/_lib/db";

export type CompanySizeCategory = "startup" | "smb" | "enterprise";

export interface PricingLineItem {
  role: string;
  dailyRate: number;
  days: number;
  total: number;
  description: string;
}

export interface PricingMilestone {
  name: string;
  description: string;
  durationWeeks: number;
  paymentPercentage: number;
  deliverables: string[];
}

export interface PricingAddOn {
  id: string;
  name: string;
  description: string;
  unitPrice: number;
  selected: boolean;
}

export interface PricingConfig {
  projectType: string;
  companySizeCategory: CompanySizeCategory;
  currency: string;
  lineItems: PricingLineItem[];
  milestones: PricingMilestone[];
  addOns: PricingAddOn[];
  subtotal: number;
  discount: number;
  total: number;
  notes: string;
  generatedAt: string;
}

export interface ProposalRow {
  id: string;
  title: string;
  status: string;
  pricing_config: PricingConfig | null;
  project_type: string | null;
  prospect_company_size: string | null;
  user_id: string;
  created_at: string;
}

// ── internal lookup tables ────────────────────────────────────────────────────

const RATE_MULTIPLIER: Record<CompanySizeCategory, number> = {
  startup: 0.85,
  smb: 1.0,
  enterprise: 1.35,
};

const BASE_DAY_RATES: Record<string, number> = {
  "Senior Partner": 3200,
  "Engagement Manager": 2400,
  "Senior Consultant": 1900,
  Consultant: 1500,
  "Business Analyst": 1100,
};

type RoleTemplate = { role: string; days: number; description: string };

const PROJECT_TEMPLATES: Record<string, RoleTemplate[]> = {
  strategy: [
    { role: "Senior Partner", days: 8, description: "Executive engagement and strategic framing" },
    { role: "Engagement Manager", days: 20, description: "Work-stream leadership and client management" },
    { role: "Senior Consultant", days: 35, description: "Analysis, frameworks, and deliverable production" },
    { role: "Business Analyst", days: 25, description: "Data gathering, benchmarking, and presentation support" },
  ],
  transformation: [
    { role: "Senior Partner", days: 10, description: "Executive sponsorship and steering committee" },
    { role: "Engagement Manager", days: 40, description: "Programme management and change leadership" },
    { role: "Senior Consultant", days: 60, description: "Work-stream delivery and stakeholder management" },
    { role: "Consultant", days: 50, description: "Process re-design and implementation support" },
    { role: "Business Analyst", days: 40, description: "Current-state mapping and requirements capture" },
  ],
  analytics: [
    { role: "Engagement Manager", days: 15, description: "Analytics programme direction" },
    { role: "Senior Consultant", days: 30, description: "Data architecture and modelling" },
    { role: "Consultant", days: 40, description: "Dashboard build and insight generation" },
    { role: "Business Analyst", days: 35, description: "Data collection, cleansing, and validation" },
  ],
  technology: [
    { role: "Engagement Manager", days: 20, description: "Technical programme oversight" },
    { role: "Senior Consultant", days: 45, description: "Solution architecture and technical design" },
    { role: "Consultant", days: 60, description: "Implementation and configuration" },
    { role: "Business Analyst", days: 30, description: "Requirements and UAT support" },
  ],
  operations: [
    { role: "Senior Partner", days: 6, description: "Senior advisory and exec alignment" },
    { role: "Engagement Manager", days: 25, description: "Operations programme management" },
    { role: "Senior Consultant", days: 40, description: "Process improvement and lean delivery" },
    { role: "Consultant", days: 35, description: "Implementation and change management" },
    { role: "Business Analyst", days: 30, description: "Process mapping and measurement" },
  ],
  general: [
    { role: "Engagement Manager", days: 20, description: "Project management and client liaison" },
    { role: "Senior Consultant", days: 40, description: "Core analytical and advisory work" },
    { role: "Consultant", days: 35, description: "Research, analysis, and deliverable support" },
    { role: "Business Analyst", days: 25, description: "Data gathering and documentation" },
  ],
};

const STANDARD_ADDONS: Array<{ id: string; name: string; description: string; basePrice: number }> = [
  {
    id: "workshop_facilitation",
    name: "Executive Workshop Facilitation",
    description: "Full-day structured workshop with C-suite stakeholders (up to 12 participants)",
    basePrice: 8000,
  },
  {
    id: "implementation_support",
    name: "90-Day Implementation Support Retainer",
    description: "Monthly check-in, ad-hoc advisory, and risk monitoring post-engagement",
    basePrice: 12000,
  },
  {
    id: "board_pack",
    name: "Board-Ready Deliverable Pack",
    description: "Pitch-deck, one-page briefing note, and appendices formatted for board presentation",
    basePrice: 4500,
  },
  {
    id: "benchmark_report",
    name: "Industry Benchmarking Report",
    description: "Bespoke benchmarking against 5 comparator organisations with qualitative commentary",
    basePrice: 6500,
  },
  {
    id: "change_comms",
    name: "Change Communications Package",
    description: "Stakeholder engagement plan, comms templates, and town-hall facilitation script",
    basePrice: 5000,
  },
];

// ── helpers ───────────────────────────────────────────────────────────────────

function detectProjectType(raw: string | null): string {
  if (!raw) return "general";
  const lower = raw.toLowerCase();
  if (lower.includes("strategy") || lower.includes("strategic")) return "strategy";
  if (lower.includes("transform") || lower.includes("change programme")) return "transformation";
  if (lower.includes("analytics") || lower.includes("data") || lower.includes("insight")) return "analytics";
  if (lower.includes("tech") || lower.includes("digital") || lower.includes("software") || lower.includes("it ")) return "technology";
  if (lower.includes("operat") || lower.includes("process") || lower.includes("lean") || lower.includes("effici")) return "operations";
  return "general";
}

function detectCompanySize(raw: string | null): CompanySizeCategory {
  if (!raw) return "smb";
  const lower = raw.toLowerCase();
  if (
    lower.includes("startup") ||
    lower.includes("early stage") ||
    lower.includes("seed") ||
    lower.includes("<50") ||
    lower.includes("small company") ||
    lower.includes("sole trader")
  )
    return "startup";
  if (
    lower.includes("enterprise") ||
    lower.includes("large") ||
    lower.includes("corporate") ||
    lower.includes(">500") ||
    lower.includes("plc") ||
    lower.includes("ftse")
  )
    return "enterprise";
  return "smb";
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Generate an AI-suggested pricing breakdown from project type and company size.
 * Uses lookup tables calibrated for UK consulting day-rates.
 */
export function suggestPricingBreakdown(
  rawProjectType: string | null,
  rawCompanySize: string | null,
): PricingConfig {
  const projectType = detectProjectType(rawProjectType);
  const companySizeCategory = detectCompanySize(rawCompanySize);
  const multiplier = RATE_MULTIPLIER[companySizeCategory];
  const template = PROJECT_TEMPLATES[projectType] ?? PROJECT_TEMPLATES.general;

  const lineItems: PricingLineItem[] = template.map((item) => {
    const baseRate = BASE_DAY_RATES[item.role] ?? 1500;
    const dailyRate = Math.round(baseRate * multiplier);
    return { role: item.role, dailyRate, days: item.days, total: dailyRate * item.days, description: item.description };
  });

  const subtotal = lineItems.reduce((sum, li) => sum + li.total, 0);
  const totalDays = lineItems.reduce((sum, li) => sum + li.days, 0);
  const durationWeeks = Math.max(4, Math.ceil((totalDays / 5) * 0.6));

  const milestones: PricingMilestone[] = [
    {
      name: "Kick-off & Discovery",
      description: "Stakeholder interviews, current-state assessment, and project scoping",
      durationWeeks: Math.max(1, Math.floor(durationWeeks * 0.2)),
      paymentPercentage: 30,
      deliverables: ["Kick-off deck", "Scoping document", "Interview findings summary"],
    },
    {
      name: "Analysis & Design",
      description: "Core analytical work, hypothesis testing, and solution design",
      durationWeeks: Math.max(2, Math.floor(durationWeeks * 0.5)),
      paymentPercentage: 40,
      deliverables: ["Detailed analysis workbook", "Opportunity register", "Draft recommendations"],
    },
    {
      name: "Recommendations & Handover",
      description: "Final report, presentation of recommendations, and knowledge transfer",
      durationWeeks: Math.max(1, Math.ceil(durationWeeks * 0.3)),
      paymentPercentage: 30,
      deliverables: [
        "Final report",
        "Executive presentation",
        "Implementation roadmap",
        "Handover documentation",
      ],
    },
  ];

  const addOns: PricingAddOn[] = STANDARD_ADDONS.map((addon) => ({
    id: addon.id,
    name: addon.name,
    description: addon.description,
    unitPrice: Math.round(addon.basePrice * multiplier),
    selected: false,
  }));

  return {
    projectType,
    companySizeCategory,
    currency: "GBP",
    lineItems,
    milestones,
    addOns,
    subtotal,
    discount: 0,
    total: subtotal,
    notes: "",
    generatedAt: new Date().toISOString(),
  };
}

/** Fetch a proposal record by UUID. Returns null if not found. */
export async function getProposalById(
  proposalId: string,
  db: Db,
): Promise<ProposalRow | null> {
  const rows = await db.query<ProposalRow>(
    `SELECT id, title, status, pricing_config, project_type, prospect_company_size, user_id, created_at
       FROM proposals_generated
      WHERE id = $1
      LIMIT 1`,
    proposalId,
  );
  return rows[0] ?? null;
}

/** Persist the pricing configuration for a proposal. */
export async function saveProposalPricing(
  proposalId: string,
  config: PricingConfig,
  db: Db,
): Promise<void> {
  await db.execute(
    `UPDATE proposals_generated
        SET pricing_config = $2::jsonb,
            updated_at     = NOW()
      WHERE id = $1`,
    proposalId,
    JSON.stringify(config),
  );
}

/**
 * Count proposals created by a user in the current calendar month.
 * Used by the CFO-requested usage-based pricing tier tracking.
 */
export async function countProposalsThisPeriod(
  userId: string,
  db: Db,
): Promise<number> {
  const rows = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
       FROM proposals_generated
      WHERE user_id   = $1
        AND created_at >= date_trunc('month', NOW())`,
    userId,
  );
  return parseInt(rows[0]?.cnt ?? "0", 10);
}
