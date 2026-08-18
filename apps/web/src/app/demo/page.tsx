import type { Metadata } from "next";
import { DemoBootstrap } from "@/components/studio/demo/DemoBootstrap";

export const metadata: Metadata = {
  title: "Demo — Flock",
  description:
    "A scripted run of the thing Flock is for: two named agents reviewing an email while you edit it.",
};

/**
 * /demo — the front door for a stranger.
 *
 * Deliberately a shell around one client component and nothing else: the work
 * is a Convex mutation and three localStorage writes, all of which belong to
 * the browser (see DemoBootstrap for the whole design, and
 * docs/proposals/demo-mode.md Part II for why this is a preset over the real
 * studio rather than a second application).
 */
export default function DemoPage() {
  return <DemoBootstrap />;
}
