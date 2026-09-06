export type PromptDispatchAction = "send" | "queue";

export interface PromptDispatchDecisionInput {
  isAgentBusy: boolean;
  hasQueuedMessages: boolean;
}

export function getPromptDispatchAction({
  isAgentBusy,
  hasQueuedMessages,
}: PromptDispatchDecisionInput): PromptDispatchAction {
  return isAgentBusy || hasQueuedMessages ? "queue" : "send";
}
