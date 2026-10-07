import { describe, expect, it, vi } from "vitest";
import {
  collectBrowserSemanticEvidence,
  describeBrowserSemanticEvidence,
  type BrowserSemanticAXNode,
  type BrowserSemanticSession,
  type BrowserSemanticPage,
} from "./browser-semantic";

function makePage(nodes: BrowserSemanticAXNode[], options: { shouldThrow?: boolean; shouldFailDetach?: boolean } = {}) {
  const detach = vi.fn(async () => {
    if (options.shouldFailDetach) {
      throw new Error("detach failed");
    }
  });
  const send = vi.fn(async (method: "Page.getFrameTree" | "Accessibility.getFullAXTree") => {
    if (options.shouldThrow) {
      throw new Error("CDP unavailable");
    }
    return method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main-frame" } } } : { nodes };
  });
  const page: BrowserSemanticPage = {
    async createCDPSession() {
      return { send: send as unknown as BrowserSemanticSession["send"], detach };
    },
  };
  return { page, detach, send };
}

describe("collectBrowserSemanticEvidence", () => {
  it("extracts bounded headings, paragraph copy and CTA labels without repeated descendant text", async () => {
    const { page, send, detach } = makePage([
      { nodeId: "0", role: { value: "main" }, childIds: ["1", "2", "4", "6"] },
      { nodeId: "1", parentId: "0", role: { value: "heading" }, name: { value: "A calmer way to manage projects" }, properties: [{ name: "level", value: { value: 1 } }] },
      { nodeId: "2", parentId: "0", role: { value: "paragraph" }, childIds: ["3"] },
      { nodeId: "3", parentId: "2", role: { value: "staticText" }, name: { value: "We help small teams plan clearly and spend more time doing meaningful work." } },
      { nodeId: "4", parentId: "0", role: { value: "button" }, name: { value: "Start your free trial" } },
      { nodeId: "5", role: { value: "main" }, name: { value: "Main content" } },
      { nodeId: "6", role: { value: "img" }, name: { value: "Team planning around a table" } },
    ]);

    const evidence = await collectBrowserSemanticEvidence(page);

    expect(send).toHaveBeenCalledWith("Accessibility.getFullAXTree", { frameId: "main-frame" });
    expect(detach).toHaveBeenCalledOnce();
    expect(evidence).toMatchObject({
      headline: "A calmer way to manage projects",
      firstParagraph: "We help small teams plan clearly and spend more time doing meaningful work.",
      ctaLabels: ["Start your free trial"],
      landmarks: ["Main content"],
      imageDescriptions: ["Team planning around a table"],
      isUsable: true,
    });
    expect(evidence.text).not.toContain(evidence.firstParagraph);
  });

  it("excludes ignored nodes and reports an empty tree as unusable", async () => {
    const { page } = makePage([
      { nodeId: "1", ignored: true, ignoredReasons: [{ name: "ariaHiddenSubtree" }], role: { value: "heading" }, name: { value: "Ignored heading with enough words" } },
      { nodeId: "2", parentId: "1", role: { value: "paragraph" }, name: { value: "Ignored ancestor copy that should never enter usable evidence." } },
    ]);

    await expect(collectBrowserSemanticEvidence(page)).resolves.toMatchObject({
      headline: null,
      isUsable: false,
    });
  });

  it("keeps exposed semantic descendants of ignored presentational wrappers", async () => {
    const { page } = makePage([
      { nodeId: "1", ignored: true, ignoredReasons: [{ name: "presentationalRole" }], role: { value: "generic" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Useful exposed heading under a wrapper" }, properties: [{ name: "level", value: { value: 1 } }] },
    ]);

    await expect(collectBrowserSemanticEvidence(page)).resolves.toMatchObject({
      headline: "Useful exposed heading under a wrapper",
      isUsable: true,
    });
  });

  it("does not treat navigation links as usable brand copy", async () => {
    const { page } = makePage([
      { nodeId: "1", role: { value: "navigation" }, name: { value: "Primary navigation" } },
      { nodeId: "2", parentId: "1", role: { value: "link" }, name: { value: "Learn more about our services" } },
      { nodeId: "3", parentId: "1", role: { value: "link" }, name: { value: "Contact the team today" } },
    ]);

    const evidence = await collectBrowserSemanticEvidence(page);

    expect(evidence.controlLabels).toContain("Learn more about our services");
    expect(evidence.isUsable).toBe(false);
    expect(describeBrowserSemanticEvidence(evidence)).toBeNull();
  });

  it("prefers the H1 then main headings and gathers list items without repeating their text", async () => {
    const { page } = makePage([
      { nodeId: "1", role: { value: "heading" }, name: { value: "Sidebar heading" }, properties: [{ name: "level", value: { value: 2 } }] },
      { nodeId: "2", role: { value: "main" }, childIds: ["3", "4"] },
      { nodeId: "3", parentId: "2", role: { value: "heading" }, name: { value: "Main section heading" }, properties: [{ name: "level", value: { value: 2 } }] },
      { nodeId: "4", parentId: "2", role: { value: "list" }, childIds: ["5", "6"] },
      { nodeId: "5", parentId: "4", role: { value: "listItem" }, name: { value: "Plan the work with a clear weekly rhythm" } },
      { nodeId: "6", parentId: "4", role: { value: "listItem" }, name: { value: "Share progress with the whole team" } },
      { nodeId: "7", parentId: "2", role: { value: "heading" }, name: { value: "The right work, at the right time" }, properties: [{ name: "level", value: { value: 1 } }] },
    ]);

    const evidence = await collectBrowserSemanticEvidence(page);
    const description = describeBrowserSemanticEvidence(evidence);

    expect(evidence.headline).toBe("The right work, at the right time");
    expect(evidence.headings).toEqual([
      { level: 2, text: "Main section heading" },
      { level: 1, text: "The right work, at the right time" },
    ]);
    expect(evidence.lists).toEqual([[
      "Plan the work with a clear weekly rhythm",
      "Share progress with the whole team",
    ]]);
    expect(evidence.isUsable).toBe(true);
    expect(description).toContain("Headings: H2 Main section heading | H1 The right work, at the right time");
    expect(description!.length).toBeLessThanOrEqual(8_000);
  });

  it("caps the tree and each evidence collection", async () => {
    const nodes = Array.from({ length: 2_100 }, (_, index) => ({
      nodeId: String(index),
      role: { value: "staticText" },
      name: { value: `Distinct semantic text item number ${index}` },
    }));
    const { page } = makePage(nodes);

    const evidence = await collectBrowserSemanticEvidence(page);

    expect(evidence.text).toHaveLength(30);
  });

  it("degrades softly and detaches the session when CDP fails", async () => {
    const { page, detach } = makePage([], { shouldThrow: true });

    await expect(collectBrowserSemanticEvidence(page)).resolves.toMatchObject({ isUsable: false });
    expect(detach).toHaveBeenCalledOnce();
  });

  it("preserves evidence when detaching the session fails", async () => {
    const { page } = makePage([
      { nodeId: "1", role: { value: "heading" }, name: { value: "A useful semantic heading" } },
    ], { shouldFailDetach: true });

    await expect(collectBrowserSemanticEvidence(page)).resolves.toMatchObject({
      headline: "A useful semantic heading",
      isUsable: true,
    });
  });
});
