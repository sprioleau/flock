"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_IMAGE_STYLE_DOC_LENGTH } from "@/lib/brand-kit-extraction/assemble-image-style-doc";
import type { BrandColor, BrandImageStyleDoc } from "@/lib/brand-kit";
import { cn } from "@/lib/utils";
import { ImageStyleDocView } from "./ImageStyleDocView";

export function ImageStyleDocEditor({
  sessionId,
  imageStyleDoc,
  colors,
}: {
  sessionId: string | null;
  imageStyleDoc: BrandImageStyleDoc | undefined;
  colors: BrandColor[] | undefined;
}) {
  const updateBrandImageStyleDoc = useMutation(
    api.brandKits.updateBrandImageStyleDoc,
  );
  const storedMarkdown = imageStyleDoc?.markdown ?? "";
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(storedMarkdown);
  const [seededFrom, setSeededFrom] = useState(storedMarkdown);
  const [isSaving, setIsSaving] = useState(false);
  const [hasJustSaved, setHasJustSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (seededFrom !== storedMarkdown) {
    setSeededFrom(storedMarkdown);
    setDraft(storedMarkdown);
    setHasJustSaved(false);
  }

  const isOverBudget = draft.length > MAX_IMAGE_STYLE_DOC_LENGTH;
  const isDirty = draft !== storedMarkdown;
  const canSave = sessionId !== null && !isSaving && !isOverBudget && isDirty;

  async function handleSave(): Promise<void> {
    if (sessionId === null || isSaving || isOverBudget) {
      return;
    }
    setIsSaving(true);
    setErrorMessage(null);
    try {
      await updateBrandImageStyleDoc({
        sessionId,
        markdown: draft.trim().length === 0 ? null : draft,
      });
      setHasJustSaved(true);
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof ConvexError
          ? String(error.data)
          : "Couldn't save the image style guidance. Try again.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  function handleDownload(): void {
    const blob = new Blob([draft], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "image-style.md";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="image-style-doc-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground">
          Image style guidance
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setIsEditing((value) => !value)}
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
          onChange={(event) => {
            setDraft(event.target.value);
            setErrorMessage(null);
            setHasJustSaved(false);
          }}
          placeholder="How imagery for this brand should look and feel…"
          className="min-h-48 font-mono text-sm"
          disabled={isSaving}
          aria-label="Image style guidance markdown"
          data-testid="image-style-doc-textarea"
        />
      ) : (
        <div className="rounded-lg border border-border bg-background p-3">
          <ImageStyleDocView markdown={draft} colors={colors} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            "text-xs",
            isOverBudget ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {draft.length.toLocaleString()} /{" "}
          {MAX_IMAGE_STYLE_DOC_LENGTH.toLocaleString()}
        </span>
        <div className="flex items-center gap-2">
          {hasJustSaved && !isDirty ? (
            <span className="text-xs text-muted-foreground">Saved</span>
          ) : null}
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!canSave}
          >
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
