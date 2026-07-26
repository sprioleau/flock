"use client";

import { MessagesSquareIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Phase 3 seam: the left chat panel. Wave 1 ships the empty state with a
 * disabled composer; the AI chat (streamed ops) replaces the body in Phase 3.
 */
export function ChatPanelPlaceholder() {
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-r bg-background">
      <div className="flex h-12 shrink-0 items-center border-b px-4">
        <h1 className="font-heading text-sm font-semibold">Tandem</h1>
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
        <Button disabled size="icon-sm" aria-label="Send message">
          <SendIcon />
        </Button>
      </div>
    </aside>
  );
}
