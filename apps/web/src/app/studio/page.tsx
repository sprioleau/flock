import type { Metadata } from "next";
import { StudioShell } from "@/components/studio/StudioShell";

export const metadata: Metadata = {
  title: "Studio — Tandem",
  description: "Build your email: chat on the left, live canvas on the right.",
};

export default function StudioPage() {
  return <StudioShell />;
}
