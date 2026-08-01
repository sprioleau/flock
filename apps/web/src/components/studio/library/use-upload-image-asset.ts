"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useEditorStore } from "@/lib/editor-store";

/**
 * The one client-side image-upload path, shared by every surface that lets a
 * user pick a file (property panel's Upload button, the Asset Library's
 * Upload button), following docs/uploading-storing-files-convex.md:
 *
 *   generateUploadUrl (mutation) → POST file bytes → { storageId }
 *   → assets.register (Content Studio Stage S: every upload joins the
 *     session's library, kind "uploaded", named after the file; registration
 *     resolves the plain https serving URL)
 *
 * What happens with the resolved URL is the caller's business: the property
 * panel commits it as the selected image block's src; the library does
 * nothing further — registration alone makes the asset appear in the
 * reactive grid.
 *
 * `uploadImageAsset` throws on failure (callers own error presentation —
 * inline message vs toast). `isUploading` counts in-flight uploads, so it
 * stays true across a multi-file batch without flickering between files.
 */
export function useUploadImageAsset() {
  // The anonymous session id — the library owner every upload registers under.
  const sessionId = useEditorStore((state) => state.authorId);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const registerAsset = useMutation(api.assets.register);
  const [pendingUploadCount, setPendingUploadCount] = useState(0);

  const isUploading = pendingUploadCount > 0;

  async function uploadImageAsset(file: File): Promise<{ url: string }> {
    setPendingUploadCount((count) => count + 1);
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
        // The store connects before any upload surface can render — this is
        // a wiring bug, not a user-recoverable state.
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
      return { url };
    } finally {
      setPendingUploadCount((count) => count - 1);
    }
  }

  return { isUploading, uploadImageAsset };
}
