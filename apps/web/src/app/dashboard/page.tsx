import type { Metadata } from "next";
import { DashboardShell } from "@/components/dashboard/DashboardShell";

export const metadata: Metadata = {
  title: "Your emails — Flock",
  description: "Everything you've made in Flock, ready to pick back up.",
};

/**
 * The post-sign-in landing page.
 *
 * Deliberately NOT server-gated. The list itself is empty for a caller with no
 * identity (convex/canvases.ts `listMyCanvases` resolves the owner server-side
 * and returns nothing when it cannot), so a signed-out visitor sees the empty
 * state and a way in rather than a redirect loop. Gating here would also mean
 * two places deciding who may see this page, which is how the retired access
 * gate went wrong (see the note in app/page.tsx).
 */
export default function DashboardPage() {
  return <DashboardShell />;
}
