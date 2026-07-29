"use client";

import {
  CheckIcon,
  LoaderCircleIcon,
  MailIcon,
  MonitorIcon,
  PencilIcon,
  SearchIcon,
  SmartphoneIcon,
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
 * plus a state affordance (streaming spinner → applied check / failed cross,
 * or Approve/Deny buttons for approval-gated tools like sendTestEmail).
 *
 * Block ids are NEVER user-facing: when an op targets a block, the chip shows
 * the block's TYPE (looked up live from the document), not its raw id.
 */

type TandemToolPart = ToolUIPart<TandemChatTools>;

const READ_ONLY_TOOL_NAMES = new Set(["getBlockDetails"]);

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

/** First error message out of a structured apply-failure tool result. */
function getFailureMessage(errorText: string): string {
  try {
    const parsed: unknown = JSON.parse(errorText);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { errors?: unknown }).errors)
    ) {
      const [firstError] = (parsed as { errors: { message?: unknown }[] }).errors;
      if (typeof firstError?.message === "string") {
        return firstError.message;
      }
    }
  } catch {
    // fall through to the raw text
  }
  return errorText;
}

function StateBadge({ part }: { part: TandemToolPart }) {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return <LoaderCircleIcon className="size-3 animate-spin text-muted-foreground" />;
    case "output-available":
      return <CheckIcon className="size-3 text-green-600" />;
    case "output-error":
      return <XIcon className="size-3 text-destructive" />;
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
    return "queued (sending lands in Phase 8)";
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
}

export function ToolPartChip({ part, onApprovalResponse }: ToolPartChipProps) {
  const toolName = getToolName(part);
  const targetBlockId = getTargetBlockId(part);
  // "· button", "· text"… — the target block's type, not its id. Undefined
  // when the block is gone (removed/reverted later): the chip just omits it.
  const targetBlockType = useEditorStore((state) =>
    targetBlockId === undefined ? undefined : state.doc[targetBlockId]?.type,
  );
  const targetLabel = targetBlockType ?? getNonBlockTargetLabel(part);
  const isReadOnlyTool = READ_ONLY_TOOL_NAMES.has(toolName);
  const hasFailed = part.state === "output-error";
  const statusText = getStatusText(part);
  const isApprovalRequested = part.state === "approval-requested";

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border px-2 py-1.5 text-xs",
        isReadOnlyTool && "border-dashed text-muted-foreground",
        hasFailed && "border-destructive/50 bg-destructive/5",
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
      {hasFailed && part.errorText !== undefined && (
        <p className="text-destructive">{getFailureMessage(part.errorText)}</p>
      )}
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
