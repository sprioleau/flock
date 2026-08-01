import type { Metadata } from "next";
import { EmailEditorPanel } from "./EmailEditorPanel";

export const metadata: Metadata = {
  title: "Editor — Flock",
};

export default function EditorPage() {
  return (
    <div className="flex h-dvh flex-col">
      <EmailEditorPanel />
    </div>
  );
}
