export const NAV_CONFIG = {
  primary: [
    { label: "Case Study Library", href: "/library" },
    { label: "New Proposal", href: "/rfp/upload" },
    { label: "My Proposals", href: "/proposals" },
    { label: "Win Rate", href: "/analytics" },
  ],
  groups: [
    {
      label: "Settings",
      items: [{ label: "Brand Profile", href: "/settings/brand" }],
    },
  ],
} as const;
