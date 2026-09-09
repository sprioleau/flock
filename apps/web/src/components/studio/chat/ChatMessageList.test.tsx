import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FlockChatMessage } from "@/lib/chat-contract";
import { ChatMessageList } from "./ChatMessageList";

function assistantMessage(text: string): FlockChatMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text }],
  } as FlockChatMessage;
}

describe("ChatMessageList assistant prose", () => {
  it("renders Markdown emphasis, lists, and line breaks instead of raw markers", () => {
    const markup = renderToStaticMarkup(
      <ChatMessageList
        messages={[assistantMessage("**Bold**\n\n- First item\n- Second item\n\nLine one  \nLine two") ]}
        error={undefined}
        isAwaitingResponse={false}
        isTurnInProgress={false}
        onApprovalResponse={vi.fn()}
      />,
    );

    expect(markup).toContain("<strong>Bold</strong>");
    expect(markup).toContain("<li>First item</li>");
    expect(markup).toContain("<li>Second item</li>");
    expect(markup).toMatch(/Line one<br\/>\s*Line two/);
    expect(markup).not.toContain("**Bold**");
  });
});
