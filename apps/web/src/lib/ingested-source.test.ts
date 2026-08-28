import { describe, expect, it } from "vitest";
import type { FlockChatMessage } from "./chat-contract";
import { getHasIngestedSourceInTurn } from "./ingested-source";

/*
  The one fact that decides whether a composed draft may quietly reuse the
  user's existing copy. Getting it wrong in either direction is a real defect:
  a false negative reinstates the reported bug (an email about a fetched site,
  written out of the draft next to it), and a false positive strips the
  carry-over out of "make me another version of this", which is the case the
  carry-over exists for.
*/

function userMessage(text: string): FlockChatMessage {
  return { id: `user_${text.length}`, role: "user", parts: [{ type: "text", text }] };
}

function assistantWithArticle({
  id,
  isOk,
}: {
  id: string;
  isOk: boolean;
}): FlockChatMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-readWebPage",
        toolCallId: `call_${id}`,
        state: "output-available",
        input: { url: "https://sprioleau.dev" },
        output: isOk
          ? {
              isFound: true,
              data: {
                isOk: true,
                page: {
                  title: "San'Quan Prioleau",
                  sourceName: "sprioleau.dev",
                  canonicalUrl: "https://sprioleau.dev",
                  blocks: [{ kind: "paragraph", text: "Projects: Flock, Dobble Go, teeny.fun." }],
                  lists: [],
                  structuredData: [],
                  images: [],
                  sections: [],
                  isTruncated: false,
                  pageType: "portfolio" as const,
                  confidence: "high" as const,
                  sourceSummary: "A portfolio listing three projects.",
                  isPlanUsable: true,
                },
              },
            }
          : {
              isFound: true,
              data: { isOk: false, reason: "paywalled", message: "That page is paywalled." },
            },
      },
    ],
  };
}

describe("getHasIngestedSourceInTurn", () => {
  it("is true once this turn has actually read a page", () => {
    const messages = [
      userMessage("create a draft based on my portfolio: sprioleau.dev"),
      assistantWithArticle({ id: "a1", isOk: true }),
    ];
    expect(getHasIngestedSourceInTurn({ messages })).toBe(true);
  });

  it("is false when the page could not be read", () => {
    /*
      A refusal is a SUCCESSFUL tool call carrying isOk: false. Nothing was
      read, so nothing external is competing with the source draft — treating
      it as an ingestion would strip the carry-over for no benefit.
    */
    const messages = [
      userMessage("build one from this link"),
      assistantWithArticle({ id: "a1", isOk: false }),
    ];
    expect(getHasIngestedSourceInTurn({ messages })).toBe(false);
  });

  it("is false when the only ingestion happened in an earlier turn", () => {
    /*
      The scoping decision, pinned. "Now give me another version of that draft"
      is a request about the DRAFT, and an ingestion two turns ago is not
      evidence otherwise — see the module header for the failure this trades
      against.
    */
    const messages = [
      userMessage("read sprioleau.dev"),
      assistantWithArticle({ id: "a1", isOk: true }),
      userMessage("now make me another version of this draft"),
    ];
    expect(getHasIngestedSourceInTurn({ messages })).toBe(false);
  });

  it("is false for a turn that only edited the email", () => {
    const messages = [userMessage("make the heading bigger")];
    expect(getHasIngestedSourceInTurn({ messages })).toBe(false);
  });
});
