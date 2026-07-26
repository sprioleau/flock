"use client";

import { useState } from "react";
import { MessagesSquareIcon, PanelLeftCloseIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const EXPANDED_WIDTH_PX = 360;
const COLLAPSED_WIDTH_PX = 48;

/**
 * Phase 3 seam: the left chat panel. Collapsible (collapsed by default until
 * the AI chat lands in Phase 3) with an animated width transition; the rail
 * and the panel body cross-fade so neither state pops in.
 */
export function ChatPanelPlaceholder() {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <aside
      className="relative shrink-0 overflow-hidden border-r bg-background transition-[width] duration-300 ease-in-out"
      style={{ width: isExpanded ? EXPANDED_WIDTH_PX : COLLAPSED_WIDTH_PX }}
    >
      {/* Collapsed rail */}
      <div
        className={cn(
          "absolute inset-y-0 left-0 flex w-12 flex-col items-center py-3 transition-opacity duration-200",
          isExpanded ? "pointer-events-none opacity-0" : "opacity-100 delay-100",
        )}
        aria-hidden={isExpanded}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Expand chat panel"
          title="Chat (coming in Phase 3)"
          tabIndex={isExpanded ? -1 : 0}
          onClick={() => setIsExpanded(true)}
        >
          <MessagesSquareIcon />
        </Button>
      </div>

      {/* Expanded panel body (fixed inner width so text never reflows mid-animation) */}
      <div
        className={cn(
          "flex h-full flex-col transition-opacity duration-200",
          isExpanded ? "opacity-100 delay-100" : "pointer-events-none opacity-0",
        )}
        style={{ width: EXPANDED_WIDTH_PX }}
        aria-hidden={!isExpanded}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
          <h1 className="font-heading text-sm font-semibold">Tandem</h1>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Collapse chat panel"
            tabIndex={isExpanded ? 0 : -1}
            onClick={() => setIsExpanded(false)}
          >
            <PanelLeftCloseIcon />
          </Button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <MessagesSquareIcon className="size-8 text-muted-foreground/50" />
          <div>
            <p className="text-sm font-medium">Chat coming in Phase 3</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Describe your email and your partner will build it with you.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-end gap-2 border-t p-3">
          <Textarea
            disabled
            placeholder="Describe your email…"
            className="min-h-9 resize-none"
            aria-label="Chat message"
          />
          <Button disabled size="icon-sm" aria-label="Send message" tabIndex={isExpanded ? 0 : -1}>
            <SendIcon />
          </Button>
        </div>
      </div>
    </aside>
  );
}
