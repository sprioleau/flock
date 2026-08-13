import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The display-name row in your own avatar's popover: a name you can read,
 * turned into a field only when you ask for one.
 *
 * WHY THE TREE IS INSPECTED RATHER THAN RENDERED: this suite has no DOM
 * (vitest.config.ts pins `environment: "node"`) and no testing-library, so the
 * row is called as a plain function and the element tree it returns is walked —
 * the pattern its siblings use (BlockSuggestionPill, ChatProviderSetting).
 * Unlike those, this component owns state, so `useState` is replaced with the
 * smallest possible stand-in (see {@link harness}) and "re-rendering" is calling
 * the function again. That buys the questions that actually matter here — does
 * choosing the pencil open a field, does the check persist what was typed — and
 * leaves focus, caret position and the popover's own dismissal to the browser
 * pass, which is the only place they are real.
 */

/**
 * A one-file React: `useState` slots kept by call order, mutated in place by
 * the setters, and re-read on the next call of the component. `rewind()` is the
 * start of a render; `reset()` is a fresh mount.
 */
const harness = vi.hoisted(() => {
  const slots: unknown[] = [];
  let cursor = 0;
  return {
    reset(): void {
      slots.length = 0;
      cursor = 0;
    },
    rewind(): void {
      cursor = 0;
    },
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const slot = cursor;
      cursor += 1;
      if (slot >= slots.length) {
        slots[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      return [
        slots[slot],
        (next: unknown): void => {
          slots[slot] =
            typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[slot]) : next;
        },
      ];
    },
  };
});

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, useState: harness.useState };
});

const setNickname = vi.hoisted(() => vi.fn());
vi.mock("@/lib/presence", () => ({
  useSetNickname: () => setNickname,
  useOptionalPresenceRoster: () => null,
}));

import { DisplayNameRow } from "./PresenceFacepile";

interface ElementWithProps extends ReactElement {
  props: Record<string, unknown>;
}

/** Every element in a returned tree, fragments and arrays flattened. */
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

/** All human-readable strings in the tree, for copy assertions. */
function visibleText(node: ReactNode): string {
  const parts: string[] = [];
  const visit = (current: ReactNode): void => {
    if (typeof current === "string") {
      parts.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child as ReactNode);
      }
      return;
    }
    if (!isValidElement(current)) {
      return;
    }
    visit((current as ElementWithProps).props.children as ReactNode);
  };
  visit(node);
  return parts.join(" ");
}

const CURRENT_NAME = "Swift Otter";

/** One render of the row, from whatever state the last one left behind. */
function render(name: string = CURRENT_NAME): ReactNode {
  harness.rewind();
  return DisplayNameRow({ name });
}

/** Icon-only controls are addressed the way a screen reader would find them. */
function findByLabel(node: ReactNode, label: string): ElementWithProps | undefined {
  return collectElements(node).find((element) => element.props["aria-label"] === label);
}

/** The name field, present only while editing. */
function findField(node: ReactNode): ElementWithProps | undefined {
  return collectElements(node).find(
    (element) => element.props["data-testid"] === "presence-nickname-input",
  );
}

function press(node: ReactNode, label: string): void {
  const control = findByLabel(node, label);
  expect(control).toBeDefined();
  (control!.props.onClick as () => void)();
}

function type(node: ReactNode, value: string): void {
  const field = findField(node);
  expect(field).toBeDefined();
  (field!.props.onChange as (event: unknown) => void)({ target: { value } });
}

/** A keypress as the field would see it, so dismissal can be asserted. */
function makeKeyEvent(key: string) {
  return { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

function pressKey(node: ReactNode, event: ReturnType<typeof makeKeyEvent>): void {
  const field = findField(node);
  expect(field).toBeDefined();
  (field!.props.onKeyDown as (event: unknown) => void)(event);
}

beforeEach(() => {
  harness.reset();
  setNickname.mockReset();
});

describe("the display-name row, at rest", () => {
  it("shows the name as text — no field to mistake for unsaved work", () => {
    const tree = render();
    expect(visibleText(tree)).toContain(CURRENT_NAME);
    expect(findField(tree)).toBeUndefined();
    expect(findByLabel(tree, "Edit display name")).toBeDefined();
    expect(findByLabel(tree, "Save display name")).toBeUndefined();
  });
});

describe("the display-name row, on choosing the pencil", () => {
  it("opens a field prefilled with the current name", () => {
    press(render(), "Edit display name");
    expect(findField(render())?.props.value).toBe(CURRENT_NAME);
  });

  it("swaps the pencil for the submit action, so there is one control, not two", () => {
    press(render(), "Edit display name");
    const editing = render();
    expect(findByLabel(editing, "Save display name")).toBeDefined();
    expect(findByLabel(editing, "Edit display name")).toBeUndefined();
  });
});

describe("submitting the display name", () => {
  it("persists the trimmed name and closes the field", () => {
    press(render(), "Edit display name");
    type(render(), "  Nimble Ibex  ");
    press(render(), "Save display name");

    expect(setNickname).toHaveBeenCalledTimes(1);
    expect(setNickname).toHaveBeenCalledWith("Nimble Ibex");
    expect(findField(render())).toBeUndefined();
  });

  it("submits on Enter, so the keyboard never has to find the icon", () => {
    press(render(), "Edit display name");
    type(render(), "Nimble Ibex");
    const event = makeKeyEvent("Enter");
    pressKey(render(), event);

    expect(setNickname).toHaveBeenCalledWith("Nimble Ibex");
    // Otherwise the keypress also reaches whatever form or dialog is outside.
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("reverts to the auto-generated name when the box is emptied", () => {
    press(render(), "Edit display name");
    type(render(), "   ");
    press(render(), "Save display name");

    // "" is the presence layer's "drop the nickname override" (presence.tsx),
    // which is the only way back to the session-derived name.
    expect(setNickname).toHaveBeenCalledWith("");
    expect(findField(render())).toBeUndefined();
  });

  it("writes nothing when the name comes back unchanged", () => {
    press(render(), "Edit display name");
    type(render(), `  ${CURRENT_NAME}  `);
    press(render(), "Save display name");

    expect(setNickname).not.toHaveBeenCalled();
    // Still finished, though — the user asked to be done with the field.
    expect(findField(render())).toBeUndefined();
  });
});

describe("abandoning the edit", () => {
  it("restores the original name on Escape, and keeps the popover open", () => {
    press(render(), "Edit display name");
    type(render(), "Something else entirely");
    const event = makeKeyEvent("Escape");
    pressKey(render(), event);

    const restored = render();
    expect(findField(restored)).toBeUndefined();
    expect(visibleText(restored)).toContain(CURRENT_NAME);
    expect(setNickname).not.toHaveBeenCalled();
    // Base UI's dismiss hook would otherwise take the same keypress and close
    // the whole popover out from under the person still editing.
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});
