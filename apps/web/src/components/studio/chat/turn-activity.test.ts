import { describe, expect, it } from "vitest";
import type { FlockChatMessage } from "@/lib/chat-contract";
import {
  describeTurnActivity,
  FALLBACK_ACTIVITY_PHRASE,
  getActivityLabel,
  getActivityPhrase,
  getBlockTypeLabel,
  getIsKnownTool,
  getNonBlockTargetLabel,
  getTargetBlockId,
  SLOW_TURN_THRESHOLD_MS,
  toTurnParts,
  type TurnPart,
} from "./turn-activity";

/**
 * The narration engine's contract. The load-bearing assertions are the ones
 * about LEAKAGE — an internal tool name reaching the screen is the one failure
 * mode here that a user would notice and that no type checks.
 */

/** Every tool name the chat contract can produce a part for. */
const ALL_TOOL_NAMES = [
  "updateBlockProperties",
  "replaceBlockProperties",
  "updateDocumentSettings",
  "applyTheme",
  "addBlock",
  "addSection",
  "restoreBlocks",
  "removeBlock",
  "moveBlock",
  "reorderChildren",
  "placeBlockBeside",
  "unplaceBlockBeside",
  "updateText",
  "styleTextSpan",
  "scaffoldSection",
  "showPreview",
  "sendTestEmail",
  "generateImage",
  "openPanel",
  "undo",
  "redo",
  "goToVersion",
  "createDraft",
  "createPersona",
  "getBlockDetails",
  "fetchWebContent",
  "fetchPersonHighlight",
  "askForClarification",
  "proposeSectionVariations",
  "proposeEdits",
  "listAssets",
] as const;

describe("getActivityPhrase", () => {
  it("covers every tool the chat contract can stream", () => {
    const unmappedToolNames = ALL_TOOL_NAMES.filter((toolName) => !getIsKnownTool(toolName));
    expect(unmappedToolNames).toEqual([]);
  });

  it("phrases every step in the present while it runs and the past once it lands", () => {
    for (const toolName of ALL_TOOL_NAMES) {
      const phrase = getActivityPhrase({ toolName });
      expect(phrase.present.length).toBeGreaterThan(0);
      expect(phrase.past.length).toBeGreaterThan(0);
      expect(phrase.present).not.toBe(phrase.past);
    }
  });

  it("starts every phrase with a capital letter, like a sentence", () => {
    for (const toolName of ALL_TOOL_NAMES) {
      const phrase = getActivityPhrase({ toolName });
      expect(phrase.present[0]).toBe(phrase.present[0]?.toUpperCase());
      expect(phrase.past[0]).toBe(phrase.past[0]?.toUpperCase());
    }
  });

  it("never speaks a camelCase tool name, verbatim or de-camel-cased", () => {
    // Scoped to the multi-word identifiers, which is where a leak is both
    // possible and unmistakable. The two single-word names ("undo", "redo")
    // are ordinary English the copy is entitled to use.
    const camelCaseToolNames = ALL_TOOL_NAMES.filter((toolName) => /[A-Z]/.test(toolName));
    expect(camelCaseToolNames.length).toBeGreaterThan(20);
    for (const toolName of camelCaseToolNames) {
      const spokenWords = toolName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
      const phrase = getActivityPhrase({ toolName });
      for (const text of [phrase.present, phrase.past]) {
        expect(text.toLowerCase()).not.toContain(toolName.toLowerCase());
        expect(text.toLowerCase()).not.toContain(spokenWords);
      }
    }
  });

  it("pluralises a multi-draft step from its arguments", () => {
    expect(getActivityPhrase({ toolName: "createDraft", input: { count: 1 } }).present).toBe(
      "Starting a new draft",
    );
    expect(getActivityPhrase({ toolName: "createDraft", input: { count: 3 } }).present).toBe(
      "Starting new drafts",
    );
  });

  it("falls back to the shared phrase when arguments have not streamed in yet", () => {
    expect(getActivityPhrase({ toolName: "createDraft" }).present).toBe("Starting a new draft");
    expect(getActivityPhrase({ toolName: "createDraft", input: "not an object" }).present).toBe(
      "Starting a new draft",
    );
  });
});

describe("getActivityPhrase — unmapped tools", () => {
  /** The seam another agent's tool rename lands on. */
  const UNMAPPED_TOOL_NAMES = ["createDraftV2", "rewriteSubjectLine", "someNewTool", ""];

  it("renders neutral copy, never the tool's own name", () => {
    for (const toolName of UNMAPPED_TOOL_NAMES) {
      expect(getActivityPhrase({ toolName })).toEqual(FALLBACK_ACTIVITY_PHRASE);
    }
    expect(FALLBACK_ACTIVITY_PHRASE.present).toBe("Working on your email");
    expect(FALLBACK_ACTIVITY_PHRASE.past).toBe("Updated your email");
  });

  it("does not leak the name de-camel-cased into words either", () => {
    const label = getActivityLabel({ toolName: "rewriteSubjectLine", isComplete: false });
    expect(label.toLowerCase()).not.toContain("rewrite");
    expect(label.toLowerCase()).not.toContain("subject line");
  });

  it("still tenses correctly", () => {
    expect(getActivityLabel({ toolName: "someNewTool", isComplete: false })).toBe(
      "Working on your email",
    );
    expect(getActivityLabel({ toolName: "someNewTool", isComplete: true })).toBe(
      "Updated your email",
    );
  });

  it("contributes no target, since its arguments are unvetted", () => {
    // A mapped tool reads these fields; an unmapped one must not, because
    // nothing guarantees they hold something a user should read.
    expect(getNonBlockTargetLabel({ toolName: "showPreview", input: { mode: "desktop" } })).toBe(
      "desktop",
    );
    expect(
      getNonBlockTargetLabel({ toolName: "someNewTool", input: { mode: "desktop" } }),
    ).toBeUndefined();
    expect(
      getNonBlockTargetLabel({ toolName: "someNewTool", input: { panel: "brand-kit" } }),
    ).toBeUndefined();
  });
});

describe("getActivityLabel", () => {
  it("tenses a mapped step by whether it landed", () => {
    expect(getActivityLabel({ toolName: "addSection", isComplete: false })).toBe(
      "Adding a section",
    );
    expect(getActivityLabel({ toolName: "addSection", isComplete: true })).toBe("Added a section");
  });
});

describe("getNonBlockTargetLabel", () => {
  it("names a panel in the words the user sees on it", () => {
    expect(getNonBlockTargetLabel({ toolName: "openPanel", input: { panel: "brand-kit" } })).toBe(
      "brand kit",
    );
  });

  it("omits an unrecognised panel value rather than showing the raw enum", () => {
    expect(
      getNonBlockTargetLabel({ toolName: "openPanel", input: { panel: "future-panel" } }),
    ).toBeUndefined();
  });

  it("reads a recipient, a version and a draft count", () => {
    expect(
      getNonBlockTargetLabel({ toolName: "sendTestEmail", input: { to: "sam@example.com" } }),
    ).toBe("sam@example.com");
    expect(getNonBlockTargetLabel({ toolName: "goToVersion", input: { version: 4 } })).toBe(
      "version 4",
    );
    expect(getNonBlockTargetLabel({ toolName: "createDraft", input: { count: 3 } })).toBe(
      "3 drafts",
    );
    expect(getNonBlockTargetLabel({ toolName: "createDraft", input: { count: 1 } })).toBeUndefined();
  });

  it("uses a persona's own name only for the step that creates one", () => {
    expect(getNonBlockTargetLabel({ toolName: "createPersona", input: { name: "Ada" } })).toBe(
      "Ada",
    );
    expect(
      getNonBlockTargetLabel({ toolName: "generateImage", input: { name: "Ada" } }),
    ).toBeUndefined();
  });

  it("tolerates missing and malformed arguments", () => {
    expect(getNonBlockTargetLabel({ toolName: "openPanel" })).toBeUndefined();
    expect(getNonBlockTargetLabel({ toolName: "openPanel", input: null })).toBeUndefined();
    expect(getNonBlockTargetLabel({ toolName: "openPanel", input: 42 })).toBeUndefined();
  });
});

describe("getTargetBlockId", () => {
  it("reads a blockId only when the arguments carry one", () => {
    expect(getTargetBlockId({ blockId: "btn_x9k3" })).toBe("btn_x9k3");
    expect(getTargetBlockId({ blockId: 7 })).toBeUndefined();
    expect(getTargetBlockId(undefined)).toBeUndefined();
    expect(getTargetBlockId("btn_x9k3")).toBeUndefined();
  });
});

describe("getBlockTypeLabel", () => {
  it("renames the block types whose internal word means nothing to a user", () => {
    expect(getBlockTypeLabel("root")).toBe("whole email");
    expect(getBlockTypeLabel("row")).toBe("layout row");
    expect(getBlockTypeLabel("code")).toBe("custom code");
  });

  it("passes through the types that are already plain English", () => {
    expect(getBlockTypeLabel("button")).toBe("button");
    expect(getBlockTypeLabel("image")).toBe("image");
  });

  it("says nothing when the block is gone", () => {
    expect(getBlockTypeLabel(undefined)).toBeUndefined();
  });
});

describe("describeTurnActivity", () => {
  const describe_ = (parts: TurnPart[], overrides: { elapsedMs?: number } = {}) =>
    describeTurnActivity({
      isTurnInProgress: true,
      parts,
      elapsedMs: overrides.elapsedMs ?? 0,
    });

  it("says nothing when no turn is running", () => {
    expect(
      describeTurnActivity({ isTurnInProgress: false, parts: [], elapsedMs: 0 }),
    ).toBeNull();
  });

  it("announces thinking before anything comes back", () => {
    expect(describe_([])).toEqual({ phase: "waiting", message: "Thinking it through…" });
  });

  it("still counts as waiting while the opened message is empty", () => {
    // The assistant message opens with an empty text part before a single
    // token arrives — that must not read as "the agent is writing".
    expect(describe_([{ kind: "text", hasContent: false }])?.phase).toBe("waiting");
  });

  it("acknowledges a slow wait instead of repeating itself", () => {
    expect(describe_([], { elapsedMs: SLOW_TURN_THRESHOLD_MS - 1 })?.message).toBe(
      "Thinking it through…",
    );
    expect(describe_([], { elapsedMs: SLOW_TURN_THRESHOLD_MS })?.message).toBe(
      "Still thinking — this one needs a moment…",
    );
  });

  it("stays quiet while prose is streaming — the words are their own narration", () => {
    expect(describe_([{ kind: "text", hasContent: true }])).toBeNull();
  });

  it("stays quiet while a step is running — its chip already says what it is", () => {
    expect(describe_([{ kind: "step", isSettled: false }])).toBeNull();
    expect(
      describe_([
        { kind: "step", isSettled: true },
        { kind: "step", isSettled: false },
      ]),
    ).toBeNull();
  });

  it("fills the silence after a step lands and before the next one starts", () => {
    expect(describe_([{ kind: "step", isSettled: true }])).toEqual({
      phase: "next-step",
      message: "Working out the next step…",
    });
  });

  it("treats a written widget as a landed step", () => {
    expect(describe_([{ kind: "step", isSettled: true }, { kind: "other" }])?.phase).toBe(
      "next-step",
    );
  });

  it("ignores a trailing empty text part left behind after a step", () => {
    expect(
      describe_([
        { kind: "step", isSettled: true },
        { kind: "text", hasContent: false },
      ])?.phase,
    ).toBe("next-step");
  });
});

describe("toTurnParts", () => {
  /** Hand-built parts in the wire shapes the transcript actually receives. */
  const parts = [
    { type: "text", text: "" },
    { type: "text", text: "Sure — adding that now." },
    { type: "tool-addSection", state: "input-streaming" },
    { type: "tool-addSection", state: "output-available" },
    { type: "tool-updateText", state: "output-error" },
    { type: "tool-sendTestEmail", state: "approval-requested" },
    { type: "data-editor-command" },
  ] as unknown as FlockChatMessage["parts"];

  it("projects prose, steps and everything else onto the indicator's view", () => {
    expect(toTurnParts(parts)).toEqual([
      { kind: "text", hasContent: false },
      { kind: "text", hasContent: true },
      { kind: "step", isSettled: false },
      { kind: "step", isSettled: true },
      { kind: "step", isSettled: true },
      { kind: "step", isSettled: false },
      { kind: "other" },
    ]);
  });

  it("counts a denied step as settled — the agent is no longer on it", () => {
    const denied = [{ type: "tool-sendTestEmail", state: "output-denied" }] as unknown as
      FlockChatMessage["parts"];
    expect(toTurnParts(denied)).toEqual([{ kind: "step", isSettled: true }]);
  });
});
