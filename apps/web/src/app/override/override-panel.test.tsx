import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OverridePanelView, type OverridePanelViewProps } from "./OverridePanel";
import {
  OVERRIDE_EMPTY_PASSWORD_MESSAGE,
  OVERRIDE_REJECTED_FALLBACK_MESSAGE,
  OVERRIDE_THROTTLED_FALLBACK_MESSAGE,
} from "./override-client";

/**
 * What the /override page actually puts on screen, per state.
 *
 * This repo has no DOM test environment and no testing-library (see
 * vitest.config.ts: `environment: "node"`), so the panel is split into a
 * stateful shell and a pure `OverridePanelView`, and the view is rendered to
 * static markup here. That covers the questions worth asking of this page —
 * which copy appears, whether the server's message survives untouched, whether
 * the release affordance is offered — without adding a dependency.
 *
 * NOT covered here, and left for the browser pass: that submitting the form
 * calls the handler, that focus and the disabled states feel right, and that
 * the password manager stays out of the way.
 */

function renderPanel(overrides: Partial<OverridePanelViewProps> = {}): string {
  const props: OverridePanelViewProps = {
    isChecking: false,
    isUnlocked: false,
    isBusy: false,
    password: "",
    notice: null,
    onPasswordChange: vi.fn(),
    onSubmit: vi.fn(),
    onRelease: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<OverridePanelView {...props} />);
}

/** Markup with entities decoded, so assertions can use the real characters. */
function text(markup: string): string {
  return markup
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#x2019;", "’");
}

describe("the /override page, while the status is unknown", () => {
  it("says it is checking rather than showing a form it may have to replace", () => {
    const markup = renderPanel({ isChecking: true });
    expect(text(markup)).toContain("Checking this browser…");
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain("Give it back");
  });
});

describe("the /override page, locked", () => {
  it("offers a password field that no manager is invited to fill", () => {
    const markup = renderPanel();
    expect(markup).toContain('type="password"');
    // React 19 emits the prop's camelCase spelling verbatim; HTML attribute
    // names are case-insensitive, so the browser still reads `autocomplete`.
    expect(markup.toLowerCase()).toContain('autocomplete="off"');
    // Base UI's Input generates its own id when none is given — the explicit
    // one is what keeps the <label for> pointing at this field.
    expect(markup).toContain('id="override-password"');
  });

  it("states plainly what unlocking does, in user-facing words", () => {
    const markup = text(renderPanel());
    expect(markup).toContain(
      "Enter the owner password to lift the daily limit on AI requests in this browser.",
    );
    expect(markup).toContain(">Unlock<");
  });

  it("shows a rejection in the server's exact words", () => {
    const markup = text(
      renderPanel({
        notice: { tone: "error", message: OVERRIDE_REJECTED_FALLBACK_MESSAGE },
      }),
    );
    expect(markup).toContain("That password didn&#x27;t match.".replaceAll("&#x27;", "'"));
    expect(markup).toContain('role="alert"');
    // The page adds nothing of its own about why it did not match.
    expect(markup).not.toMatch(/deploy|configur|env var|not set up/i);
  });

  it("shows the attempt limiter's message as its own thing", () => {
    const markup = text(
      renderPanel({
        notice: { tone: "error", message: OVERRIDE_THROTTLED_FALLBACK_MESSAGE },
      }),
    );
    expect(markup).toContain("Too many attempts. Wait a minute and try again.");
    expect(markup).not.toContain(OVERRIDE_REJECTED_FALLBACK_MESSAGE);
  });

  it("asks for a password before spending an attempt on an empty box", () => {
    const markup = text(
      renderPanel({ notice: { tone: "error", message: OVERRIDE_EMPTY_PASSWORD_MESSAGE } }),
    );
    expect(markup).toContain("Enter the password to continue.");
  });

  it("confirms a release in the server's words and asks again", () => {
    const markup = text(
      renderPanel({ notice: { tone: "success", message: "Credit limit restored." } }),
    );
    expect(markup).toContain("Credit limit restored.");
    expect(markup).toContain('type="password"');
    // A confirmation is not an error.
    expect(markup).not.toContain('role="alert"');
  });

  it("marks the field invalid and points at the message for screen readers", () => {
    const markup = renderPanel({
      notice: { tone: "error", message: OVERRIDE_REJECTED_FALLBACK_MESSAGE },
    });
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="override-notice"');
    expect(markup).toContain('id="override-notice"');
  });

  it("shows progress on the button while a submission is in flight", () => {
    const markup = text(renderPanel({ isBusy: true, password: "typed" }));
    expect(markup).toContain("Unlocking…");
    expect(markup).toContain("disabled");
  });
});

describe("the /override page, already unlocked", () => {
  it("says what this browser has, and offers to give it back", () => {
    const markup = text(renderPanel({ isUnlocked: true }));
    expect(markup).toContain("This browser has owner access.");
    expect(markup).toContain(
      "AI requests made here aren’t counted against the daily limit",
    );
    expect(markup).toContain("Give it back");
    // Nothing to re-enter — the password field is gone entirely.
    expect(markup).not.toContain('type="password"');
  });

  it("repeats the server's confirmation after a successful unlock", () => {
    const markup = text(
      renderPanel({
        isUnlocked: true,
        notice: { tone: "success", message: "Credit limit lifted on this browser." },
      }),
    );
    expect(markup).toContain("Credit limit lifted on this browser.");
  });

  it("shows progress while handing the override back", () => {
    const markup = text(renderPanel({ isUnlocked: true, isBusy: true }));
    expect(markup).toContain("Giving it back…");
    expect(markup).toContain("disabled");
  });

  it("says what giving it back costs, so it is not a one-way door in the dark", () => {
    const markup = text(renderPanel({ isUnlocked: true }));
    expect(markup).toContain("puts this browser back on the normal daily limit");
    expect(markup).toContain("unlock it again whenever you like");
  });
});

describe("the /override page, in every state", () => {
  const everyState: OverridePanelViewProps[] = (
    [
      { isChecking: true },
      {},
      { notice: { tone: "error", message: OVERRIDE_REJECTED_FALLBACK_MESSAGE } },
      { notice: { tone: "error", message: OVERRIDE_THROTTLED_FALLBACK_MESSAGE } },
      { isUnlocked: true },
      { isUnlocked: true, isBusy: true },
    ] satisfies Partial<OverridePanelViewProps>[]
  ).map((overrides) => ({
    isChecking: false,
    isUnlocked: false,
    isBusy: false,
    password: "",
    notice: null,
    onPasswordChange: vi.fn(),
    onSubmit: vi.fn(),
    onRelease: vi.fn(),
    ...overrides,
  }));

  it("never names the secret, the cookie, or the endpoint (owner law)", () => {
    for (const props of everyState) {
      const markup = renderToStaticMarkup(<OverridePanelView {...props} />);
      expect(markup).not.toMatch(/FLOCK_|OVERRIDE_PASSWORD|flock_owner_override|api\/auth/i);
      expect(markup).not.toMatch(/hasOwnerOverride|process\.env|HMAC/i);
    }
  });

  it("uses semantic colour tokens only, never a raw colour (owner law)", () => {
    for (const props of everyState) {
      const markup = renderToStaticMarkup(<OverridePanelView {...props} />);
      expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(markup).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/i);
      // Tailwind's palette scale (red-500, zinc-800…) is a raw colour too.
      expect(markup).not.toMatch(
        /\b(?:text|bg|border|ring)-(?:red|green|blue|yellow|zinc|slate|gray|neutral|stone|amber|emerald)-\d{2,3}\b/,
      );
    }
  });
});
