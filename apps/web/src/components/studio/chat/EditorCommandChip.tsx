"use client";

import { MailIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";
import type { EditorCommandDataPart } from "@/lib/chat-contract";

/**
 * A `data-editor-command` part: the typed command the server dispatched and
 * the client executed (Phase 3.4). Rendered as a subtle confirmation chip.
 */
export function EditorCommandChip({ data }: { data: EditorCommandDataPart }) {
  const { command } = data;
  const isShowPreview = command.type === "showPreview";
  const icon = isShowPreview ? (
    command.mode === "desktop" ? (
      <MonitorIcon className="size-3" />
    ) : (
      <SmartphoneIcon className="size-3" />
    )
  ) : (
    <MailIcon className="size-3" />
  );
  const label = isShowPreview
    ? `Canvas switched to ${command.mode} preview`
    : `Test email to ${command.to} queued (sending lands in Phase 8)`;

  return (
    <div
      className="flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground"
      data-editor-command={command.type}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}
