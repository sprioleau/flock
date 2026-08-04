import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_PROVIDER_LABELS } from "@/lib/chat-provider";

const updateAppSettingsMock = vi.hoisted(() => vi.fn());
vi.mock("./app-settings", () => ({
  updateAppSettings: updateAppSettingsMock,
  useAppSettings: vi.fn(),
  getAppSettings: vi.fn(),
}));

import { ChatProviderSetting } from "./SettingsFab";

/**
 * The owner-only "which service answers your chat messages" control.
 *
 * WHY THE TREE IS INSPECTED RATHER THAN RENDERED: this suite has no DOM
 * (vitest.config.ts pins `environment: "node"`) and a Base UI menu only mounts
 * its content into a portal after a real click, which no server renderer can
 * do. So the component — which takes props and uses no hooks — is called as a
 * plain function and the element tree it returns is walked. That answers the
 * two questions that matter (is the control there at all, and what does
 * choosing an option persist) without pretending to test the popup mechanics,
 * which are the browser pass's job.
 *
 * THE HEADLINE TEST is "absent, not disabled". A greyed-out row would announce
 * that a hidden capability exists; `null` means the menu simply ends where it
 * always did.
 */

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

/** The one element carrying an `onValueChange` — the radio group. */
function findRadioGroup(node: ReactNode): ElementWithProps {
  const groups = collectElements(node).filter(
    (element) => typeof element.props.onValueChange === "function",
  );
  expect(groups).toHaveLength(1);
  return groups[0]!;
}

function radioValues(node: ReactNode): unknown[] {
  return collectElements(node)
    .filter((element) => typeof element.props["data-testid"] === "string")
    .filter((element) => "value" in element.props)
    .map((element) => element.props.value);
}

function selectValue(node: ReactNode, value: unknown): void {
  const group = findRadioGroup(node);
  (group.props.onValueChange as (next: unknown, details: unknown) => void)(value, {});
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

describe("the chat-service control, without an owner override", () => {
  it("is absent — not a disabled row, nothing at all", () => {
    expect(ChatProviderSetting({ isUnlocked: false, chatProviderId: null })).toBeNull();
  });

  it("stays absent even when a provider is already pinned in this browser", () => {
    // Anyone can write the localStorage value; that must not conjure the
    // control, and the server ignores the request either way.
    expect(ChatProviderSetting({ isUnlocked: false, chatProviderId: "openrouter" })).toBeNull();
  });

  it("takes its separator with it, so the menu just ends", () => {
    const tree = ChatProviderSetting({ isUnlocked: false, chatProviderId: null });
    expect(collectElements(tree)).toHaveLength(0);
  });
});

describe("the chat-service control, with an owner override", () => {
  beforeEach(() => {
    updateAppSettingsMock.mockReset();
  });

  it("is present", () => {
    const tree = ChatProviderSetting({ isUnlocked: true, chatProviderId: null });
    expect(tree).not.toBeNull();
    expect(collectElements(tree).length).toBeGreaterThan(0);
  });

  it("offers exactly three choices, because 'no choice' is one of them", () => {
    const tree = ChatProviderSetting({ isUnlocked: true, chatProviderId: null });
    expect(radioValues(tree)).toHaveLength(3);
  });

  it("shows the deployment default as selected when nothing is pinned", () => {
    const tree = ChatProviderSetting({ isUnlocked: true, chatProviderId: null });
    const group = findRadioGroup(tree);
    expect(group.props.value).toBe("deployment-default");
    expect(radioValues(tree)).toContain("deployment-default");
  });

  it("shows the pinned provider as selected", () => {
    expect(
      findRadioGroup(ChatProviderSetting({ isUnlocked: true, chatProviderId: "openrouter" }))
        .props.value,
    ).toBe("openrouter");
  });

  it("persists the provider id when a service is chosen", () => {
    const tree = ChatProviderSetting({ isUnlocked: true, chatProviderId: null });

    selectValue(tree, "openrouter");
    expect(updateAppSettingsMock).toHaveBeenLastCalledWith({ chatProviderId: "openrouter" });

    selectValue(tree, "gemini");
    expect(updateAppSettingsMock).toHaveBeenLastCalledWith({ chatProviderId: "gemini" });
  });

  it("persists NULL for the deployment default, not the default provider's id", () => {
    // The distinction is real: null follows the deployment if its provider
    // changes; "gemini" would pin this browser to Gemini for ever.
    const tree = ChatProviderSetting({ isUnlocked: true, chatProviderId: "openrouter" });
    selectValue(tree, "deployment-default");
    expect(updateAppSettingsMock).toHaveBeenLastCalledWith({ chatProviderId: null });
  });

  it("falls back to the deployment default for a value it does not recognise", () => {
    const tree = ChatProviderSetting({ isUnlocked: true, chatProviderId: null });
    selectValue(tree, "some-retired-provider");
    expect(updateAppSettingsMock).toHaveBeenLastCalledWith({ chatProviderId: null });
  });

  it("names services the way people do, never by their internal ids", () => {
    const text = visibleText(ChatProviderSetting({ isUnlocked: true, chatProviderId: null }));
    expect(text).toContain(CHAT_PROVIDER_LABELS.gemini);
    expect(text).toContain(CHAT_PROVIDER_LABELS.openrouter);
    expect(text).toContain("Automatic");
    expect(text).not.toMatch(/\bgemini\b/);
    expect(text).not.toMatch(/\bopenrouter\b/);
  });

  it("explains what it does without mentioning keys, quotas, or env vars", () => {
    const text = visibleText(ChatProviderSetting({ isUnlocked: true, chatProviderId: null }));
    expect(text).toContain("Which service answers your chat messages");
    expect(text).not.toMatch(/api key|quota|rate limit|env|environment variable|override|cookie/i);
  });

  it("says the row is the reader's alone, without naming a mechanism", () => {
    const text = visibleText(ChatProviderSetting({ isUnlocked: true, chatProviderId: null }));
    expect(text).toContain("yours only");
    expect(text).not.toMatch(/FLOCK_|admin|superuser/i);
  });

  it("keeps the menu open while switching services", () => {
    const items = collectElements(
      ChatProviderSetting({ isUnlocked: true, chatProviderId: null }),
    ).filter((element) => typeof element.props["data-testid"] === "string");
    for (const item of items) {
      expect(item.props.closeOnClick).toBe(false);
    }
  });
});
