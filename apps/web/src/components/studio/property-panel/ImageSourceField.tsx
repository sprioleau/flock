"use client";

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { ImagesIcon, Loader2, Upload } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEditorStore } from "@/lib/editor-store";
import { requestUiSurfaceOpen } from "@/lib/ui-surfaces";
import { useEndCoalescing } from "./usePanelDispatch";
import { useLiveDraft } from "./useLiveDraft";

/**
 * The image block's `src` control: an editable URL field plus an Upload
 * button backed by Convex file storage (docs/uploading-storing-files-convex.md):
 *
 *   generateUploadUrl (mutation) → POST file bytes → { storageId }
 *   → assets.register (Content Studio Stage S: every upload joins the
 *     session's library, kind "uploaded", named after the file; registration
 *     resolves the plain https serving URL) → onCommitSrc(url)
 *
 * Blocks store the plain URL string — no Convex coupling in the SDK.
 *
 * Beside Upload, a "From library" CTA opens the asset library through the
 * agent-parity ui-surfaces seam (requestUiSurfaceOpen("library") — the same
 * path as the chat's openPanel command). Because this image block is the
 * current selection, the library's insert flow is already in pick-for-this-
 * block mode: its button reads "Insert into selected image" and dispatches
 * ONE updateBlockProperties { src, alt } — the normal property spine, a
 * single undo step.
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
  // The anonymous session id — the library owner every upload registers under.
  const sessionId = useEditorStore((state) => state.authorId);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const registerAsset = useMutation(api.assets.register);
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
      if (sessionId === null) {
        // The store connects before the panel can render an image block —
        // this is a wiring bug, not a user-recoverable state.
        throw new Error("No session yet — try again in a moment");
      }
      // Registration subsumes the getFileUrl step: the file joins the
      // session's library AND resolves its durable serving URL in one call.
      const { url } = await registerAsset({
        sessionId,
        storageId,
        kind: "uploaded",
        name: file.name,
      });
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
      <div className="flex gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-w-0 flex-1"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {isUploading ? <Loader2 className="animate-spin" /> : <Upload />}
          {isUploading ? "Uploading…" : "Upload image"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-w-0 flex-1"
          aria-label="Choose an image from your asset library"
          data-testid="image-source-from-library"
          onClick={() => requestUiSurfaceOpen("library")}
        >
          <ImagesIcon />
          From library
        </Button>
      </div>
      {uploadError !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {uploadError}
        </p>
      ) : null}
    </div>
  );
}
