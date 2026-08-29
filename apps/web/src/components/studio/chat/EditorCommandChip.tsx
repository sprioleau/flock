"use client";

import {
  BotIcon,
  FilePlusIcon,
  HistoryIcon,
  ImageIcon,
  MailIcon,
  MonitorIcon,
  PaletteIcon,
  PanelRightOpenIcon,
  RedoIcon,
  SmartphoneIcon,
  UndoIcon,
} from "lucide-react";
import type { EditorCommandDataPart } from "@/lib/chat-contract";

/**
 * A `data-editor-command` part: the typed command the server dispatched and
 * the client executed (Phase 3.4). Rendered as a subtle confirmation chip.
 */

const MAX_PROMPT_CHIP_LENGTH = 60;

/** openPanel enum value → the human surface name in the confirmation chip. */
const PANEL_CHIP_LABELS: Readonly<Record<string, string>> = {
  theme: "theme picker",
  "brand-kit": "brand kit",
  library: "asset library",
  agents: "agent personas",
  recommendations: "recommendations history",
  history: "version history",
  blocks: "blocks tab",
  properties: "properties tab",
  "send-test": "send-test dialog",
};

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
    case "openPanel":
      return {
        icon: <PanelRightOpenIcon className="size-3" />,
        label: `Opened the ${PANEL_CHIP_LABELS[command.panel] ?? command.panel}`,
      };
    case "undo":
      return { icon: <UndoIcon className="size-3" />, label: "Undid the last change" };
    case "redo":
      return { icon: <RedoIcon className="size-3" />, label: "Redid the last change" };
    case "goToVersion":
      return {
        icon: <HistoryIcon className="size-3" />,
        label: `Restored version ${command.version}`,
      };
    case "createDraft":
      return {
        icon: <FilePlusIcon className="size-3" />,
        label: command.count === 1 ? "Created a new draft" : `Created ${command.count} new drafts`,
      };
    case "createPersona":
      return {
        icon: <BotIcon className="size-3" />,
        label: `Created persona “${command.name}”`,
      };
    /*
      Unreachable in practice, and present so the switch stays exhaustive:
      applyThemeToDraft is `resultSource: "client"`, so the server writes no
      command part for it at all — the browser answers it directly and the
      ordinary tool chip renders. Same standing as createDraft above.
    */
    case "applyThemeToDraft":
      return {
        icon: <PaletteIcon className="size-3" />,
        label: `Applied the “${command.theme}” theme`,
      };
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
