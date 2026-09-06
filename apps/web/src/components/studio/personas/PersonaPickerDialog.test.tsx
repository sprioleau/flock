import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  PERSONA_DETAIL_SCROLL_REGION_CLASS_NAME,
  PersonaDefinitionView,
  PersonaMarkdown,
  PersonaRow,
  getPersonaListMetadata,
  type PersonaPayload,
} from "./PersonaPickerDialog";
import { parsePersonaMarkdownToForm } from "@/lib/personas/parse-persona-markdown";

const PERSONA: PersonaPayload = {
  slug: "accessibility",
  name: "Accessibility checker",
  color: "#0d9488",
  capabilityMode: "advisory",
  personaMarkdown: [
    "---",
    "name: Accessibility checker",
    "description: Finds barriers in every email",
    "---",
    "You look for accessibility issues.",
  ].join("\n"),
  cooldownSeconds: 60,
  isBuiltIn: true,
};

describe("agent picker list", () => {
  it("uses the description as the useful, single-line agent metadata", () => {
    expect(getPersonaListMetadata(PERSONA, "Finds barriers in every email")).toBe(
      "Finds barriers in every email",
    );
  });

  it("falls back to capability and review cadence when an agent has no description", () => {
    expect(getPersonaListMetadata(PERSONA, null)).toBe("advisory · checks every 60s");
  });

  it("marks the selected list item while keeping selection and enablement controls accessible", () => {
    const markup = renderToStaticMarkup(
      <PersonaRow
        persona={PERSONA}
        isEnabled
        isSelected
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain('role="listitem"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('aria-label="Edit Accessibility checker"');
    expect(markup).toContain('aria-label="Disable Accessibility checker"');
    expect(markup).toContain("Finds barriers in every email");
    expect(markup).not.toContain("View definition");
  });

  it("renders safe inline formatting without interpreting arbitrary HTML", () => {
    const markup = renderToStaticMarkup(
      <PersonaMarkdown text={"**Bold** and [docs](https://example.com)\n\n- one\n- two\n\n<script>alert(1)</script>"} />,
    );

    expect(markup).toContain("<strong>Bold</strong>");
    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain("<ul");
    expect(markup).toContain("<li>one</li>");
    expect(markup).not.toContain("<script>");
  });

  it("keeps the detail content scrollable while the right-side summary stays stable", () => {
    expect(PERSONA_DETAIL_SCROLL_REGION_CLASS_NAME).toContain("flex-1");
    expect(PERSONA_DETAIL_SCROLL_REGION_CLASS_NAME).toContain("overflow-y-auto");

    const markup = renderToStaticMarkup(
      <PersonaDefinitionView
        persona={PERSONA}
        model={parsePersonaMarkdownToForm(PERSONA.personaMarkdown)}
      />,
    );

    expect(markup).toContain('aria-label="Accessibility checker definition"');
    expect(markup).toContain("You look for accessibility issues.");
    expect(markup).not.toContain("overflow-y-auto");
  });
});
