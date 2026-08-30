"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_EMAIL_DESIGN_DOC_LENGTH,
  type BrandColor,
  type BrandEmailDesignDoc,
} from "@/lib/brand-kit";
import { cn } from "@/lib/utils";
import { EmailDesignDocView } from "./EmailDesignDocView";

/*
  In-place editor over email-design.md — the standing brand guidance the agent
  reads (the CEILING over the structured kit). A preview/edit toggle: preview
  renders through {@link EmailDesignDocView} (hex → swatch chips resolved
  against the kit's authored palette); edit is a plain textarea with a live
  char budget. Save persists via updateBrandEmailDesignDoc; clearing the box
  and saving stores `null`, handing the doc back to the next scrape.

  Prop-driven so it works on any brand surface — most importantly the /brand
  workspace, where the studio editor store (its old source for the session id)
  is not mounted. The caller supplies the session id, the stored doc, and the
  kit palette; `sessionId === null` disables saving (an unresolved session,
  never a real edit).
*/
export function EmailDesignDocEditor({
  sessionId,
  emailDesignDoc,
  colors,
}: {
  sessionId: string | null;
  emailDesignDoc: BrandEmailDesignDoc | undefined;
  colors: BrandColor[] | undefined;
}) {
  const updateBrandEmailDesignDoc = useMutation(api.brandKits.updateBrandEmailDesignDoc);

  const storedMarkdown = emailDesignDoc?.markdown ?? "";

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(storedMarkdown);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasJustSaved, setHasJustSaved] = useState(false);

  /*
    Reseed the draft whenever the STORED doc changes identity (a save, a
    re-scrape, another tab) — adjusted during render, not in an effect, so the
    textarea never flashes the previous value. Compared by value: the kit is
    rebuilt on every Convex update even when the doc is untouched.
  */
  const [seededFrom, setSeededFrom] = useState(storedMarkdown);
  if (seededFrom !== storedMarkdown) {
    setSeededFrom(storedMarkdown);
    setDraft(storedMarkdown);
    setHasJustSaved(false);
  }

  const isOverBudget = draft.length > MAX_EMAIL_DESIGN_DOC_LENGTH;
  const isDirty = draft !== storedMarkdown;
  const canSave = sessionId !== null && !isSaving && !isOverBudget && isDirty;

  const handleDraftChange = (value: string): void => {
    setDraft(value);
    setErrorMessage(null);
    setHasJustSaved(false);
  };

  const handleSave = async (): Promise<void> => {
    if (sessionId === null || isSaving || isOverBudget) {
      return;
    }
    setIsSaving(true);
    setErrorMessage(null);
    try {
      /*
        An empty box clears the doc (null); anything else is stored verbatim.
      */
      await updateBrandEmailDesignDoc({
        sessionId,
        markdown: draft.trim().length === 0 ? null : draft,
      });
      setHasJustSaved(true);
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof ConvexError
          ? String(error.data)
          : "Couldn't save the email design guidance. Try again.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  /*
    Client-side download of the current draft as a .md file — no server round
    trip, so it works on unsaved edits too.
  */
  const handleDownload = (): void => {
    const blob = new Blob([draft], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "email-design.md";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-2" data-testid="email-design-doc-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground">
          Email design guidance
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setIsEditing((previous) => !previous)}
          >
            {isEditing ? "Preview" : "Edit"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDownload}
            disabled={draft.length === 0}
          >
            Download .md
          </Button>
        </div>
      </div>

      {isEditing ? (
        <Textarea
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value)}
          placeholder="How emails for this brand should look and feel — layout, spacing, when to use each color (write #ffc400 and it becomes a swatch)…"
          className="min-h-48 font-mono text-sm"
          disabled={isSaving}
          aria-label="Email design guidance markdown"
          data-testid="email-design-doc-textarea"
        />
      ) : (
        <div className="rounded-lg border border-border bg-background p-3">
          <EmailDesignDocView markdown={draft} colors={colors} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            "text-xs",
            isOverBudget ? "text-destructive" : "text-muted-foreground",
          )}
          data-testid="email-design-doc-budget"
        >
          {draft.length.toLocaleString()} / {MAX_EMAIL_DESIGN_DOC_LENGTH.toLocaleString()}
        </span>
        <div className="flex items-center gap-2">
          {hasJustSaved && !isDirty ? (
            <span className="text-xs text-muted-foreground">Saved</span>
          ) : null}
          <Button type="button" size="sm" onClick={handleSave} disabled={!canSave}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {errorMessage !== null ? (
        <p className="text-xs text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
