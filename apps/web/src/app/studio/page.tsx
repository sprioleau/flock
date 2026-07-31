import { ConvexHttpClient } from "convex/browser";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { api } from "@convex/_generated/api";
import { StudioShell } from "@/components/studio/StudioShell";

export const metadata: Metadata = {
  title: "Studio — Tandem",
  description: "Build your email: chat on the left, live canvas on the right.",
};

export default async function StudioPage({ searchParams }: PageProps<"/studio">) {
  const resolvedSearchParams = await searchParams;
  const rawDocumentKey = resolvedSearchParams.doc;
  const rawCanvasKey = resolvedSearchParams.canvas;
  const canvasKey = Array.isArray(rawCanvasKey) ? rawCanvasKey[0] : rawCanvasKey;

  // `?canvas=<id>` share link (and no more-specific `?doc=`): resolve the
  // canvas to its most recently updated draft server-side and land on the
  // normal `?doc=` URL — the drafts bar then shows all of its siblings. An
  // unresolvable canvas (bogus id, empty canvas, Convex unreachable) falls
  // back to plain /studio, which creates a fresh draft; when the access gate
  // is enabled the proxy has already bounced invalid canvas links to /gate.
  if (rawDocumentKey === undefined && canvasKey !== undefined && canvasKey.length > 0) {
    const documentId = await resolveCanvasEntryDocument(canvasKey);
    redirect(documentId !== null ? `/studio?doc=${documentId}` : "/studio");
  }

  // Suspense boundary: StudioShell reads useSearchParams (?doc=<id>).
  return (
    <Suspense>
      <StudioShell />
    </Suspense>
  );
}

/** Canvas → entry draft over Convex HTTP; null (never a throw) on any failure. */
async function resolveCanvasEntryDocument(canvasKey: string): Promise<string | null> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl === undefined) {
    return null;
  }
  try {
    const convexClient = new ConvexHttpClient(convexUrl);
    return await convexClient.query(api.documents.getCanvasEntryDocument, { canvasKey });
  } catch {
    return null;
  }
}
