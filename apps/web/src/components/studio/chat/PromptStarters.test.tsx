import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_BRAND_KIT } from "@/lib/brand-kit";
import { PROMPT_STARTERS } from "@/lib/prompt-starters";

/*
  The chips' SHAPE, checked the way this app checks components: there is no DOM
  here (vitest.config.ts pins `environment: "node"`), so the component is called
  as a plain function over stubbed hooks and the element tree it returns is
  walked. Layout is CSS and belongs to the browser pass; what this suite can
  prove is the two things that would be real bugs:

  - a chip that SENDS instead of inserting — the never-auto-send rule is what
    makes a starter trustworthy, and it is one wrong import away from breaking;
  - a chip whose click hands over anything other than its own prompt, verbatim.

  The list's own content and gating are lib/prompt-starters.test.ts's job; this
  file only proves the component is a faithful map over it.
*/

const hasSavedKitRef = { current: false };

vi.mock("../brand-kit/useActiveBrandKit", () => ({
  useActiveBrandKit: () => ({
    brandKit: MOCK_BRAND_KIT,
    hasSavedKit: hasSavedKitRef.current,
    isBoundToCanvas: hasSavedKitRef.current,
  }),
}));

const handOffPromptToComposer = vi.hoisted(() => vi.fn(() => true));
const sendPromptThroughComposer = vi.hoisted(() => vi.fn(() => true));

vi.mock("./composer-handoff", () => ({
  handOffPromptToComposer,
  sendPromptThroughComposer,
}));

import { PromptStarters } from "./PromptStarters";

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

function collectElements(node: ReactNode): ElementWithProps[] {
  const found: ElementWithProps[] = [];
  const visit = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    const element = current as ElementWithProps;
    found.push(element);
    visit(element.props.children as ReactNode);
  };
  visit(node);
  return found;
}

/* The chips as a user meets them: buttons, named by the text they show. */
function collectChips(node: ReactNode): { label: string; element: ElementWithProps }[] {
  return collectElements(node)
    .filter((element) => element.type === "button")
    .map((element) => ({ label: String(element.props.children), element }));
}

function clickChipLabelled(node: ReactNode, label: string): void {
  const chip = collectChips(node).find((candidate) => candidate.label === label);
  expect(chip, `no chip labelled "${label}"`).toBeDefined();
  (chip!.element.props.onClick as () => void)();
}

beforeEach(() => {
  hasSavedKitRef.current = false;
  handOffPromptToComposer.mockClear();
  sendPromptThroughComposer.mockClear();
});

describe("clicking a starter", () => {
  it("INSERTS the prompt and never sends it", () => {
    clickChipLabelled(PromptStarters(), "Rewrite the opening");

    expect(handOffPromptToComposer).toHaveBeenCalledTimes(1);
    /* The SEND seam exists on the same module and is deliberately unused here:
       these prompts carry specifics the user is meant to replace, so firing one
       unread would be asking the model to guess. */
    expect(sendPromptThroughComposer).not.toHaveBeenCalled();
  });

  it("hands over that chip's own prompt, verbatim", () => {
    const expected = PROMPT_STARTERS.find((starter) => starter.id === "restyle-theme");
    clickChipLabelled(PromptStarters(), expected!.label);
    expect(handOffPromptToComposer).toHaveBeenCalledWith(expected!.prompt);
  });
});

describe("the chips", () => {
  it("shows the brand chip only while the canvas has no saved kit", () => {
    const brandStarter = PROMPT_STARTERS.find((starter) => starter.id === "brand-from-website");
    const labelsWithoutKit = collectChips(PromptStarters()).map((chip) => chip.label);

    hasSavedKitRef.current = true;
    const labelsWithKit = collectChips(PromptStarters()).map((chip) => chip.label);

    expect(labelsWithoutKit).toContain(brandStarter!.label);
    /* Proves the hook actually reaches the pure selection — a component that
       ignored it would show the same four chips for ever. */
    expect(labelsWithKit).not.toContain(brandStarter!.label);
  });

  it("uses plain buttons, never a Base UI control", () => {
    /* Base UI warnings are thrown errors in production; the sibling chat
       surfaces hold the same line. */
    for (const chip of collectChips(PromptStarters())) {
      expect(chip.element.type).toBe("button");
      expect(chip.element.props.type).toBe("button");
    }
  });

  it("carries the full prompt as its tooltip, so nothing lands unseen", () => {
    for (const chip of collectChips(PromptStarters())) {
      const starter = PROMPT_STARTERS.find((candidate) => candidate.label === chip.label);
      expect(chip.element.props.title).toBe(starter!.prompt);
    }
  });
});
