import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginPlayground } from "./LoginPlayground";

describe("LoginPlayground", () => {
  it("renders an email collaboration scene and a distinct responsive login dock", () => {
    const markup = renderToStaticMarkup(
      <LoginPlayground loginDock={<form aria-label="Real login form" />} />,
    );

    expect(markup).toContain('data-testid="login-playground"');
    expect(markup).toContain('aria-label="Live email collaboration showcase"');
    expect(markup).toContain('data-testid="login-dock"');
    expect(markup).toContain('aria-label="Real login form"');
    expect(markup).toContain("lg:fixed");
    expect(markup).toContain("lg:bottom-6");
    expect(markup).toContain("lg:left-6");
  });

  it("keeps mock cursors inert and explains the simulation through accessible activity text", () => {
    const markup = renderToStaticMarkup(<LoginPlayground loginDock={<div>Sign in</div>} />);

    expect(markup.match(/data-mock-agent-cursor=/g)).toHaveLength(3);
    expect(markup).toContain('data-testid="mock-agent-cursor-layer"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("pointer-events-none");
    expect(markup).toContain('aria-label="Collaboration activity"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Simulated collaboration");
  });

  it("offers one constrained visitor action without mounting a real editor", () => {
    const markup = renderToStaticMarkup(<LoginPlayground loginDock={<div>Sign in</div>} />);

    expect(markup).toContain("Try a clearer headline");
    expect(markup).not.toContain("contenteditable");
    expect(markup).not.toContain("data-frames-scroller");
    expect(markup).not.toContain("SMS");
    expect(markup).not.toContain("WhatsApp");
  });
});
