/**
 * Server-side DOCX builder for proposal export.
 * Uses the `docx` npm package to generate formatted Word documents in-memory.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

export interface ProposalSection {
  section: string;
  content: string;
}

export interface ProposalData {
  id: string;
  title: string;
  clientName: string | null;
  sections: ProposalSection[];
  createdAt: Date;
}

const SECTION_ORDER = ["scope", "pricing", "timeline", "bio"];

const SECTION_TITLES: Record<string, string> = {
  scope: "Scope of Work",
  pricing: "Pricing & Investment",
  timeline: "Project Timeline",
  bio: "Team & Credentials",
};

function sectionDisplayTitle(section: string): string {
  const key = section.toLowerCase();
  if (SECTION_TITLES[key]) return SECTION_TITLES[key];
  return section.charAt(0).toUpperCase() + section.slice(1).replace(/_/g, " ");
}

function htmlToText(html: string): string {
  return html
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "$1\n")
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "$1")
    .replace(/<em[^>]*>(.*?)<\/em>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToDocxParagraphs(html: string): Paragraph[] {
  const text = htmlToText(html);
  const lines = text.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return [
      new Paragraph({
        children: [
          new TextRun({
            text: "(No content provided)",
            italics: true,
            size: 24,
            font: "Calibri",
            color: "888888",
          }),
        ],
        spacing: { after: 120 },
      }),
    ];
  }

  return lines.map(
    (line) =>
      new Paragraph({
        children: [
          new TextRun({
            text: line.trim(),
            size: 24,
            font: "Calibri",
            color: "1a1a2e",
          }),
        ],
        spacing: { after: 120 },
      }),
  );
}

export async function buildProposalDocx(proposal: ProposalData): Promise<Buffer> {
  const sortedSections = [...proposal.sections].sort((a, b) => {
    const idxA = SECTION_ORDER.indexOf(a.section.toLowerCase());
    const idxB = SECTION_ORDER.indexOf(b.section.toLowerCase());
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.section.localeCompare(b.section);
  });

  const docChildren: Paragraph[] = [];

  // Cover title
  docChildren.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: proposal.title || "Proposal",
          bold: true,
          size: 52,
          font: "Calibri",
          color: "1a1a2e",
        }),
      ],
      spacing: { after: 240 },
    }),
  );

  if (proposal.clientName) {
    docChildren.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: `Prepared for: ${proposal.clientName}`,
            size: 28,
            font: "Calibri",
            color: "555555",
          }),
        ],
        spacing: { after: 120 },
      }),
    );
  }

  const dateStr = proposal.createdAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  docChildren.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: dateStr,
          size: 20,
          font: "Calibri",
          color: "888888",
          italics: true,
        }),
      ],
      spacing: { after: 480 },
    }),
  );

  // Horizontal rule
  docChildren.push(
    new Paragraph({
      border: {
        bottom: {
          color: "cccccc",
          space: 1,
          style: BorderStyle.SINGLE,
          size: 6,
        },
      },
      spacing: { after: 480 },
      children: [],
    }),
  );

  // Proposal sections
  for (const sec of sortedSections) {
    docChildren.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({
            text: sectionDisplayTitle(sec.section),
            bold: true,
            size: 32,
            font: "Calibri",
            color: "1a1a2e",
          }),
        ],
        spacing: { before: 360, after: 200 },
        border: {
          bottom: {
            color: "e0e0e0",
            space: 1,
            style: BorderStyle.SINGLE,
            size: 4,
          },
        },
      }),
    );

    const contentParas = htmlToDocxParagraphs(sec.content);
    for (const para of contentParas) {
      docChildren.push(para);
    }

    // Section spacing
    docChildren.push(new Paragraph({ children: [], spacing: { after: 240 } }));
  }

  // Confidentiality footer
  docChildren.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "Confidential — This proposal is intended solely for the named recipient.",
          size: 18,
          font: "Calibri",
          color: "aaaaaa",
          italics: true,
        }),
      ],
      spacing: { before: 480 },
    }),
  );

  const doc = new Document({
    creator: "Nexus Proposals",
    title: proposal.title,
    description: proposal.clientName
      ? `Proposal for ${proposal.clientName}`
      : "Proposal",
    styles: {
      default: {
        document: {
          run: {
            font: "Calibri",
            size: 24,
            color: "1a1a2e",
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children: docChildren,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
