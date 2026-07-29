"use client";

import { useRef, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { Loader2, Upload } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEndCoalescing } from "./usePanelDispatch";
import { useLiveDraft } from "./useLiveDraft";

/**
 * The image block's `src` control: an editable URL field plus an Upload
 * button backed by Convex file storage (docs/uploading-storing-files-convex.md):
 *
 *   generateUploadUrl (mutation) → POST file bytes → { storageId }
 *   → getFileUrl (query) → plain https URL → onCommitSrc(url)
 *
 * Blocks store the plain URL string — no Convex coupling in the SDK.
 *
 * URL edits follow the panel's live-commit pattern (useLiveDraft) but skip
 * drafts that aren't absolute http(s) URLs — the SDK schema documents that
 * email clients can't load relative or data: URLs, so partial/invalid text
 * never reaches the store. Blur resyncs an invalid draft to the last
 * committed value.
 */

export interface ImageSourceFieldProps {
  src: string;
  helpText?: string;
  onCommitSrc: (src: string) => void;
}

function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:";
}

export function ImageSourceField({ src, helpText, onCommitSrc }: ImageSourceFieldProps) {
  const convex = useConvex();
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const endCoalescing = useEndCoalescing();
  const { draft, setDraft, handleFocus, handleBlur } = useLiveDraft<string>({
    value: src,
    onCommit: (next) => {
      const trimmed = next.trim();
      if (isAbsoluteHttpUrl(trimmed)) {
        onCommitSrc(trimmed);
      }
    },
    onGestureEnd: endCoalescing,
  });
  const isDraftInvalid = draft.trim() !== "" && !isAbsoluteHttpUrl(draft.trim());

  async function uploadFile(file: File) {
    setIsUploading(true);
    setUploadError(null);
    try {
      const postUrl = await generateUploadUrl();
      const response = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) {
        throw new Error(`Upload failed with status ${response.status}`);
      }
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      const url = await convex.query(api.files.getFileUrl, { storageId });
      if (url === null) {
        throw new Error("Uploaded file has no serving URL");
      }
      onCommitSrc(url);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="space-y-1.5" data-slot="panel-field">
      <Label htmlFor="image-source-url-input" title={helpText} className="text-xs text-muted-foreground">
        Source
      </Label>
      <Input
        id="image-source-url-input"
        value={draft}
        placeholder="https://…"
        className="font-mono text-xs"
        aria-label="Image source URL"
        aria-invalid={isDraftInvalid}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
      {isDraftInvalid ? (
        <p className="text-xs text-muted-foreground">
          Must be an absolute http(s) URL — reverts on blur until valid.
        </p>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        id="image-upload-file-input"
        aria-label="Choose image file to upload"
        tabIndex={-1}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Allow re-selecting the same file later.
          event.target.value = "";
          if (file !== undefined) {
            void uploadFile(file);
          }
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={isUploading}
        onClick={() => fileInputRef.current?.click()}
      >
        {isUploading ? <Loader2 className="animate-spin" /> : <Upload />}
        {isUploading ? "Uploading…" : "Upload image"}
      </Button>
      {uploadError !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {uploadError}
        </p>
      ) : null}
    </div>
  );
}
