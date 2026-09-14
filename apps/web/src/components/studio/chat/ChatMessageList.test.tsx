import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FlockChatMessage } from "@/lib/chat-contract";
import { ChatMessageList } from "./ChatMessageList";

function assistantMessage(text: string, createdAtMs = 1): FlockChatMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    metadata: { createdAtMs },
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

  it("keeps a completed brand-kit artifact between older and newer messages", () => {
    const markup = renderToStaticMarkup(
      <ChatMessageList
        messages={[
          assistantMessage("The PostHog scrape is starting", 100),
          { ...assistantMessage("Show me the Resend brand kit", 300), id: "assistant-2" },
        ]}
        error={undefined}
        isAwaitingResponse={false}
        isTurnInProgress={false}
        onApprovalResponse={vi.fn()}
        brandKitArtifact={<div data-testid="brand-kit-artifact">PostHog brand kit</div>}
        brandKitArtifactCreatedAtMs={200}
      />,
    );

    expect(markup.indexOf("The PostHog scrape is starting")).toBeLessThan(
      markup.indexOf('data-testid="brand-kit-artifact"'),
    );
    expect(markup.indexOf('data-testid="brand-kit-artifact"')).toBeLessThan(
      markup.indexOf("Show me the Resend brand kit"),
    );
  });
});
