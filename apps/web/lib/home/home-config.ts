/**
 * home-config — the company's root surface (company-root-landing-001).
 * Written by provisioning (_step_substrate_install) from CTO home_mode
 * + CMO positioning. Do NOT hand-edit.
 */
export interface HomeCta {
  label: string;
  href: string;
}

export interface HomeConfig {
  mode: "landing" | "conversation";
  headline?: string;
  subhead?: string;
  primaryCta?: HomeCta;
  secondaryCta?: HomeCta;
}

export const homeConfig: HomeConfig = {
  "mode": "landing",
  "headline": "Win More Engagements. Spend Zero Weekends on Proposals.",
  "subhead": "An AI-native proposal engine that grounds every output in the consultant's own verified case studies via RAG \u2014 so independent B2B consultants can respond to a 48-72 hour RFP deadline in under 10 minutes instead of a lost weekend, without ha"
};
