import type { Metadata } from "next";
import { SpikeEditor } from "./SpikeEditor";

export const metadata: Metadata = {
  title: "Spike A — Resend Editor Role",
};

export default function SpikeEditorPage() {
  return <SpikeEditor />;
}
