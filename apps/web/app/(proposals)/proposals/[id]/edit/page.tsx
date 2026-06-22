"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

interface ProposalSection {
  section: string;
  content: string;
}

interface ProposalData {
  id: string;
  title: string;
  clientName: string | null;
  createdAt: string;
  sections: ProposalSection[];
}

const SECTION_LABELS: Record<string, string> = {
  scope: "Scope of Work",
  pricing: "Pricing & Investment",
  timeline: "Project Timeline",
  bio: "Team & Credentials",
};

function sectionLabel(section: string): string {
  return (
    SECTION_LABELS[section.toLowerCase()] ??
    section.charAt(0).toUpperCase() + section.slice(1).replace(/_/g, " ")
  );
}

function EditorToolbar({
  editor,
}: {
  editor: ReturnType<typeof useEditor>;
}): JSX.Element | null {
  if (!editor) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: "0.25rem",
        padding: "0.375rem 0.5rem",
        borderBottom: "1px solid #e0e0e0",
        flexWrap: "wrap",
      }}
    >
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBold().run()}
        style={{
          padding: "2px 8px",
          fontSize: "13px",
          fontWeight: editor.isActive("bold") ? "bold" : "normal",
          border: "1px solid #ccc",
          borderRadius: "3px",
          background: editor.isActive("bold") ? "#e8e8e8" : "white",
          cursor: "pointer",
        }}
        title="Bold"
      >
        B
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        style={{
          padding: "2px 8px",
          fontSize: "13px",
          fontStyle: "italic",
          border: "1px solid #ccc",
          borderRadius: "3px",
          background: editor.isActive("italic") ? "#e8e8e8" : "white",
          cursor: "pointer",
        }}
        title="Italic"
      >
        I
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        style={{
          padding: "2px 8px",
          fontSize: "13px",
          border: "1px solid #ccc",
          borderRadius: "3px",
          background: editor.isActive("bulletList") ? "#e8e8e8" : "white",
          cursor: "pointer",
        }}
        title="Bullet list"
      >
        • List
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        style={{
          padding: "2px 8px",
          fontSize: "13px",
          border: "1px solid #ccc",
          borderRadius: "3px",
          background: editor.isActive("orderedList") ? "#e8e8e8" : "white",
          cursor: "pointer",
        }}
        title="Numbered list"
      >
        1. List
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().setParagraph().run()}
        style={{
          padding: "2px 8px",
          fontSize: "13px",
          border: "1px solid #ccc",
          borderRadius: "3px",
          background: editor.isActive("paragraph") ? "#e8e8e8" : "white",
          cursor: "pointer",
        }}
        title="Paragraph"
      >
        ¶
      </button>
    </div>
  );
}

function SectionEditor({
  section,
  content,
  onChange,
}: {
  section: string;
  content: string;
  onChange: (section: string, html: string) => void;
}): JSX.Element {
  const editor = useEditor({
    extensions: [StarterKit],
    content: content || "<p></p>",
    onUpdate({ editor: ed }) {
      onChange(section, ed.getHTML());
    },
    editorProps: {
      attributes: {
        style:
          "min-height: 140px; padding: 0.75rem; outline: none; font-size: 14px; line-height: 1.6;",
      },
    },
  });

  return (
    <div className="card" style={{ marginBottom: "1.5rem", padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid #e0e0e0" }}>
        <strong>{sectionLabel(section)}</strong>
      </div>
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

export default function ProposalEditPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [proposal, setProposal] = useState<ProposalData | null>(null);
  const [sections, setSections] = useState<ProposalSection[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();

    fetch(`/proposals/${id}/export?format=json`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then((res) => {
        if (res.status === 401) throw new Error("Not authenticated — please log in.");
        if (res.status === 404) throw new Error("Proposal not found.");
        if (!res.ok) throw new Error(`Server error (${res.status}).`);
        return res.json() as Promise<ProposalData>;
      })
      .then((data) => {
        setProposal(data);
        setSections(data.sections);
        setLoading(false);
      })
      .catch((err: unknown) => {
        const e = err as Error;
        if (e.name !== "AbortError") {
          setFetchError(e.message ?? "Failed to load proposal.");
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [id]);

  const handleSectionChange = useCallback(
    (section: string, html: string) => {
      setSections((prev) =>
        prev.map((s) => (s.section === section ? { ...s, content: html } : s)),
      );
      setSaveStatus("idle");
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!id || saving) return;
    setSaving(true);
    setSaveStatus("idle");

    try {
      const res = await fetch(`/proposals/${id}/export`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections }),
      });

      if (res.status === 401) throw new Error("Not authenticated.");
      if (!res.ok) throw new Error(`Save failed (${res.status}).`);

      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }, [id, saving, sections]);

  if (loading) {
    return (
      <main>
        <h1>Proposal Editor</h1>
        <p>Loading proposal…</p>
      </main>
    );
  }

  if (fetchError || !proposal) {
    return (
      <main>
        <h1>Proposal Editor</h1>
        <div className="empty">
          <p>{fetchError ?? "Proposal not found."}</p>
          <a href="/proposals" className="btn secondary">
            Back to proposals
          </a>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>{proposal.title}</h1>
      <p>
        {proposal.clientName ? `Client: ${proposal.clientName} · ` : ""}
        Edit each section below, then save your changes and export as DOCX.
      </p>

      <div className="toolbar">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="btn"
        >
          {saving ? "Saving…" : "Save Changes"}
        </button>
        <a
          href={`/proposals/${id}/export`}
          className="btn secondary"
          download
        >
          Download DOCX
        </a>
        {saveStatus === "saved" && (
          <span className="muted">Changes saved.</span>
        )}
        {saveStatus === "error" && (
          <span style={{ color: "var(--color-error, #dc2626)" }}>
            Save failed — please try again.
          </span>
        )}
      </div>

      {sections.length === 0 ? (
        <div className="empty">
          <p>
            No sections found for this proposal. Generate proposal content first,
            then return here to review and edit each section.
          </p>
        </div>
      ) : (
        sections.map((sec) => (
          <SectionEditor
            key={sec.section}
            section={sec.section}
            content={sec.content}
            onChange={handleSectionChange}
          />
        ))
      )}
    </main>
  );
}
