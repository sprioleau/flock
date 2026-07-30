"use client";

import {
  CheckIcon,
  LoaderCircleIcon,
  MailIcon,
  MonitorIcon,
  PencilIcon,
  SearchIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type { ToolUIPart } from "ai";
import type { BlockId } from "@tandem/email-sdk";
import { Button } from "@/components/ui/button";
import type { TandemChatTools } from "@/lib/chat-contract";
import { useEditorStore } from "@/lib/editor-store";
import { cn } from "@/lib/utils";

/**
 * One tool call rendered as a compact chip: "updateBlockProperties · button"
 * plus a state affordance (streaming spinner → applied check, or Approve/Deny
 * buttons for approval-gated tools like sendTestEmail). Failed calls
 * (output-error) render as a friendly error card instead — see
 * {@link FailedToolPart}.
 *
 * Block ids are NEVER user-facing: when an op targets a block, the chip shows
 * the block's TYPE (looked up live from the document), not its raw id.
 */

type TandemToolPart = ToolUIPart<TandemChatTools>;

const READ_ONLY_TOOL_NAMES = new Set(["getBlockDetails", "fetchWebContent"]);

function getToolName(part: TandemToolPart): string {
  return part.type.slice("tool-".length);
}

/** The op's target blockId, if its input carries one (not user-facing). */
function getTargetBlockId(part: TandemToolPart): BlockId | undefined {
  const input = part.input as Record<string, unknown> | undefined;
  return typeof input?.blockId === "string" ? (input.blockId as BlockId) : undefined;
}

/** Human-readable non-block target: a recipient, a viewport mode… */
function getNonBlockTargetLabel(part: TandemToolPart): string | undefined {
  const input = part.input as Record<string, unknown> | undefined;
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input.mode === "string") {
    return input.mode;
  }
  if (typeof input.to === "string") {
    return input.to;
  }
  return undefined;
}

function getToolIcon(part: TandemToolPart): React.ReactNode {
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
  return <PencilIcon className="size-3" />;
}

/**
 * Everything technical about a failed tool part — tool name, raw error text,
 * raw args JSON (which may contain block ids) — flattened into one string
 * that ONLY ever renders inside the collapsed "Details" disclosure.
 */
function getRawFailureDetails(part: TandemToolPart & { state: "output-error" }): string {
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
  part: TandemToolPart & { state: "output-error" };
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

function StateBadge({ part }: { part: TandemToolPart }) {
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
function getStatusText(part: TandemToolPart): string | undefined {
  const toolName = getToolName(part);
  if (part.state === "output-available" && toolName === "sendTestEmail") {
    return "sent";
  }
  if (part.state === "approval-responded") {
    return part.approval.approved ? "approved, executing…" : "denied";
  }
  if (part.state === "output-denied") {
    return "denied";
  }
  return undefined;
}

export interface ToolPartChipProps {
  part: TandemToolPart;
  onApprovalResponse: (input: { approvalId: string; isApproved: boolean }) => void;
  /** True while this part's turn is still in flight (a retry may follow). */
  isRetryPending?: boolean;
}

export function ToolPartChip({ part, onApprovalResponse, isRetryPending = false }: ToolPartChipProps) {
  const toolName = getToolName(part);
  const targetBlockId = getTargetBlockId(part);
  // "· button", "· text"… — the target block's type, not its id. Undefined
  // when the block is gone (removed/reverted later): the chip just omits it.
  const targetBlockType = useEditorStore((state) =>
    targetBlockId === undefined ? undefined : state.doc[targetBlockId]?.type,
  );
  const targetLabel = targetBlockType ?? getNonBlockTargetLabel(part);
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
        <span className="font-mono">
          {isReadOnlyTool ? "reading" : toolName}
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
