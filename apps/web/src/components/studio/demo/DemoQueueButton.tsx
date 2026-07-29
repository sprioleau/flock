"use client";

import { WandSparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/editor-store";
import { useAppSettings } from "./app-settings";
import { composeDemoPrompts } from "./demo-prompts";

export interface DemoQueueButtonProps {
  /** True while a turn is running or an approval is pending (mirrors the composer's gate). */
  isAgentBusy: boolean;
  hasQueuedMessages: boolean;
  /** Sends one message into the thread now (the panel's history-recording send). */
  sendUserMessage: (text: string) => void;
  /** Appends one message to the FIFO queue. */
  enqueueMessage: (text: string) => void;
  /** Keeps the control out of the tab order while the panel is collapsed. */
  isPanelExpanded: boolean;
}

/**
 * Demo mode's one chat-side control: composes 6 natural-language prompts
 * from the CURRENT document (composeDemoPrompts) and runs them as REAL chat
 * turns — the first sends immediately, the rest join the message queue,
 * whose auto-drain already enforces the demo's pacing: each agent turn fully
 * completes before the next prompt sends, leaving room to edit blocks while
 * turns land. Every turn gets its own batchId, so the existing per-turn
 * revert chips cover the cleanup story.
 *
 * Mirrors the composer's own busy gate: when the agent is mid-turn (or
 * messages are already queued) ALL 6 prompts queue FIFO-fairly instead.
 *
 * Renders nothing unless the settings FAB's "Demo mode" toggle is on.
 */
export function DemoQueueButton({
  isAgentBusy,
  hasQueuedMessages,
  sendUserMessage,
  enqueueMessage,
  isPanelExpanded,
}: DemoQueueButtonProps) {
  const { isDemoModeEnabled } = useAppSettings();
  if (!isDemoModeEnabled) {
    return null;
  }

  const queueDemoMessages = (): void => {
    const prompts = composeDemoPrompts(useEditorStore.getState().doc);
    const [firstPrompt, ...restPrompts] = prompts;
    if (firstPrompt === undefined) {
      return;
    }
    if (isAgentBusy || hasQueuedMessages) {
      for (const prompt of prompts) {
        enqueueMessage(prompt);
      }
      return;
    }
    sendUserMessage(firstPrompt);
    for (const prompt of restPrompts) {
      enqueueMessage(prompt);
    }
  };

  return (
    <div className="shrink-0 border-t px-3 py-2">
      <Button
        variant="outline"
        size="sm"
        className="w-full gap-1.5 border-dashed text-muted-foreground hover:text-foreground"
        tabIndex={isPanelExpanded ? 0 : -1}
        onClick={queueDemoMessages}
        data-testid="demo-queue-button"
      >
        <WandSparklesIcon className="size-3.5" />
        Queue demo messages
      </Button>
    </div>
  );
}
