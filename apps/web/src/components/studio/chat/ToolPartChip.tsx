"use client";

import {
  BotIcon,
  CheckIcon,
  FilePlusIcon,
  HistoryIcon,
  LayoutTemplateIcon,
  LoaderCircleIcon,
  MailIcon,
  MessageCircleQuestionIcon,
  MonitorIcon,
  PanelRightOpenIcon,
  PencilIcon,
  RedoIcon,
  SearchIcon,
  SmartphoneIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UndoIcon,
  XIcon,
} from "lucide-react";
import type { ToolUIPart } from "ai";
import { Button } from "@/components/ui/button";
import type { FlockChatTools } from "@/lib/chat-contract";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";
import {
  getActivityLabel,
  getBlockTypeLabel,
  getNonBlockTargetLabel,
  getTargetBlockId,
  READ_ONLY_TOOL_NAMES,
} from "./turn-activity";

/**
 * One step of a turn rendered as a compact chip: "Adding a section" while it
 * runs, "Added a section" once it lands, plus a state affordance (spinner →
 * check, or Approve/Deny buttons for approval-gated steps like sending a test
 * email). Failed steps (output-error) render as a friendly error card instead
 * — see {@link FailedToolPart}.
 *
 * Nothing internal is user-facing here (owner principle): when a step targets
 * a block, the chip shows the block's TYPE (looked up live from the document),
 * never its raw id — and the chip's label comes from the narration engine in
 * turn-activity.ts, never from the internal tool name. Raw names stay confined
 * to data-* attributes and the failed card's collapsed "Details" disclosure.
 */

type FlockToolPart = ToolUIPart<FlockChatTools>;

function getToolName(part: FlockToolPart): string {
  return part.type.slice("tool-".length);
}

/**
 * True once the step has actually landed — the one signal that flips the
 * chip's copy from present to past tense. A denied step never happened, so it
 * stays in the present ("Sending a test email · denied").
 */
function getIsPartComplete(part: FlockToolPart): boolean {
  return part.state === "output-available";
}

function getToolIcon(part: FlockToolPart): React.ReactNode {
  const toolName = getToolName(part);
  if (READ_ONLY_TOOL_NAMES.has(toolName)) {
    return <SearchIcon className="size-3" />;
  }
  if (toolName === "showPreview") {
    const input = part.input as { mode?: string } | undefined;
    return input?.mode === "desktop" ? (
      <MonitorIcon className="size-3" />
    ) : (
      <SmartphoneIcon className="size-3" />
    );
  }
  if (toolName === "sendTestEmail") {
    return <MailIcon className="size-3" />;
  }
  if (toolName === "openPanel") {
    return <PanelRightOpenIcon className="size-3" />;
  }
  if (toolName === "undo") {
    return <UndoIcon className="size-3" />;
  }
  if (toolName === "redo") {
    return <RedoIcon className="size-3" />;
  }
  if (toolName === "goToVersion") {
    return <HistoryIcon className="size-3" />;
  }
  if (toolName === "createDraft") {
    return <FilePlusIcon className="size-3" />;
  }
  if (toolName === "createPersona") {
    return <BotIcon className="size-3" />;
  }
  if (toolName === "askForClarification") {
    return <MessageCircleQuestionIcon className="size-3" />;
  }
  if (toolName === "proposeSectionVariations") {
    return <LayoutTemplateIcon className="size-3" />;
  }
  if (toolName === "proposeEdits") {
    return <SparklesIcon className="size-3" />;
  }
  return <PencilIcon className="size-3" />;
}

/**
 * Everything technical about a failed tool part — tool name, raw error text,
 * raw args JSON (which may contain block ids) — flattened into one string
 * that ONLY ever renders inside the collapsed "Details" disclosure.
 */
function getRawFailureDetails(part: FlockToolPart & { state: "output-error" }): string {
  const rawArgs = part.input ?? part.rawInput;
  const detailLines = [`tool: ${getToolName(part)}`, `error: ${part.errorText}`];
  if (rawArgs !== undefined) {
    detailLines.push(`input: ${JSON.stringify(rawArgs, null, 2)}`);
  }
  return detailLines.join("\n");
}

/**
 * A failed tool call (schema-rejected op, exhausted repair round-trip, or a
 * failed client-side apply) rendered like the transcript's friendly turn-error
 * bubble: short human copy up front, the raw error + args behind a collapsed
 * "Details" disclosure. Block ids, tool names, and raw JSON never appear
 * outside the disclosure. While the turn is still in flight the copy says the
 * agent is retrying (the error round-trips to the model in-loop); once the
 * turn settles without a successful retry it reads as a final failure.
 */
function FailedToolPart({
  part,
  isRetryPending,
}: {
  part: FlockToolPart & { state: "output-error" };
  isRetryPending: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5",
        "px-3 py-2 text-xs text-destructive",
      )}
      data-tool-chip={getToolName(part)}
      data-tool-state={part.state}
    >
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>
          {isRetryPending
            ? "The agent tried an edit that didn't validate and is retrying."
            : "That change couldn't be applied."}
        </p>
        <details className="mt-1 text-destructive/70">
          <summary className="cursor-pointer select-none">Details</summary>
          <p className="mt-1 break-words whitespace-pre-wrap">{getRawFailureDetails(part)}</p>
        </details>
      </div>
    </div>
  );
}

function StateBadge({ part }: { part: FlockToolPart }) {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" />;
    case "output-available":
      return <CheckIcon className="size-3 text-green-600" />;
    case "approval-responded":
      return part.approval.approved ? (
        <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" />
      ) : (
        <XIcon className="size-3 text-muted-foreground" />
      );
    case "output-denied":
      return <XIcon className="size-3 text-muted-foreground" />;
    default:
      return null;
  }
}

/** Short trailing status text for terminal states. */
function getStatusText(part: FlockToolPart): string | undefined {
  if (part.state === "approval-responded") {
    return part.approval.approved ? "approved, executing…" : "denied";
  }
  if (part.state === "output-denied") {
    return "denied";
  }
  return undefined;
}

export interface ToolPartChipProps {
  part: FlockToolPart;
  onApprovalResponse: (input: { approvalId: string; isApproved: boolean }) => void;
  /** True while this part's turn is still in flight (a retry may follow). */
  isRetryPending?: boolean;
}

export function ToolPartChip({ part, onApprovalResponse, isRetryPending = false }: ToolPartChipProps) {
  const toolName = getToolName(part);
  const targetBlockId = getTargetBlockId(part.input);
  // "· button", "· text"… — the target block's type, not its id. Undefined
  // when the block is gone (removed/reverted later): the chip just omits it.
  const targetBlockType = useEditorStore((state) =>
    targetBlockId === undefined ? undefined : state.doc[targetBlockId]?.type,
  );
  const targetLabel =
    getBlockTypeLabel(targetBlockType) ?? getNonBlockTargetLabel({ toolName, input: part.input });
  const isReadOnlyTool = READ_ONLY_TOOL_NAMES.has(toolName);
  const statusText = getStatusText(part);
  const isApprovalRequested = part.state === "approval-requested";

  // Failed tool calls never render the normal chip — no tool name, block id,
  // or raw error outside the friendly copy + collapsed Details disclosure.
  if (part.state === "output-error") {
    return <FailedToolPart part={part} isRetryPending={isRetryPending} />;
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border px-2 py-1.5 text-xs",
        isReadOnlyTool && "border-dashed text-muted-foreground",
      )}
      data-tool-chip={toolName}
      data-tool-state={part.state}
    >
      <div className="flex items-center gap-1.5">
        {getToolIcon(part)}
        <span className="min-w-0">
          {getActivityLabel({
            toolName,
            input: part.input,
            // undo/redo report whether a step actually happened; the chip must
            // not say "Undid the last change" when the answer was no.
            output: part.state === "output-available" ? part.output : undefined,
            isComplete: getIsPartComplete(part),
          })}
          {targetLabel !== undefined && (
            <span className="text-muted-foreground"> · {targetLabel}</span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {statusText !== undefined && (
            <span className="text-muted-foreground">{statusText}</span>
          )}
          <StateBadge part={part} />
        </span>
      </div>
      {isApprovalRequested && (
        <div className="flex gap-1.5">
          <Button
            size="xs"
            onClick={() =>
              onApprovalResponse({ approvalId: part.approval.id, isApproved: true })
            }
          >
            Approve
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              onApprovalResponse({ approvalId: part.approval.id, isApproved: false })
            }
          >
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}
