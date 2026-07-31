"use client";

import { ImageIcon, MailIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";
import type { EditorCommandDataPart } from "@/lib/chat-contract";

/**
 * A `data-editor-command` part: the typed command the server dispatched and
 * the client executed (Phase 3.4). Rendered as a subtle confirmation chip.
 */

const MAX_PROMPT_CHIP_LENGTH = 60;

function toChipContent(command: EditorCommandDataPart["command"]): {
  icon: React.ReactNode;
  label: string;
} {
  switch (command.type) {
    case "showPreview":
      return {
        icon:
          command.mode === "desktop" ? (
            <MonitorIcon className="size-3" />
          ) : (
            <SmartphoneIcon className="size-3" />
          ),
        label: `Canvas switched to ${command.mode} preview`,
      };
    case "sendTestEmail":
      return { icon: <MailIcon className="size-3" />, label: `Test email sent to ${command.to}` };
    case "generateImage": {
      const truncatedPrompt =
        command.prompt.length > MAX_PROMPT_CHIP_LENGTH
          ? `${command.prompt.slice(0, MAX_PROMPT_CHIP_LENGTH)}…`
          : command.prompt;
      return {
        icon: <ImageIcon className="size-3" />,
        label: `Generated image: “${truncatedPrompt}”`,
      };
    }
  }
}

export function EditorCommandChip({ data }: { data: EditorCommandDataPart }) {
  const { icon, label } = toChipContent(data.command);

  return (
    <div
      className="flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground"
      data-editor-command={data.command.type}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}
