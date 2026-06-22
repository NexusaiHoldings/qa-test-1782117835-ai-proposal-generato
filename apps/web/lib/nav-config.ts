export type NavLink = {
  label: string;
  href: string;
};

export type NavGroup = {
  label: string;
  links: NavLink[];
};

export type NavConfig = {
  primary: NavLink[];
  groups: NavGroup[];
};

export const NAV_CONFIG: NavConfig = {
  primary: [
    { label: "Home", href: "/" },
    { label: "Case Study Library", href: "/library" },
    { label: "My Proposals", href: "/proposals" },
  ],
  groups: [
    {
      label: "Proposals",
      links: [
        { label: "New Proposal", href: "/rfp/upload" },
        { label: "Win Rate", href: "/analytics" },
      ],
    },
    {
      label: "Settings",
      links: [{ label: "Brand Profile", href: "/settings/brand" }],
    },
  ],
};
