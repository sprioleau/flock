"use client";

import { useRef, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { Loader2, Upload } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The image block's `src` control: a readonly URL display plus an Upload
 * button backed by Convex file storage (docs/uploading-storing-files-convex.md):
 *
 *   generateUploadUrl (mutation) → POST file bytes → { storageId }
 *   → getFileUrl (query) → plain https URL → onCommitSrc(url)
 *
 * Blocks store the plain storage URL string — no Convex coupling in the SDK.
 */

export interface ImageSourceFieldProps {
  src: string;
  helpText?: string;
  onCommitSrc: (src: string) => void;
}

export function ImageSourceField({ src, helpText, onCommitSrc }: ImageSourceFieldProps) {
  const convex = useConvex();
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
      <Label title={helpText} className="text-xs text-muted-foreground">
        Source
      </Label>
      <Input value={src} readOnly className="font-mono text-xs" aria-label="Image source URL" />
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
