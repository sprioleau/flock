import { describe, expect, it } from "vitest";
import { checkDocumentIntegrity } from "@flock/email-sdk";
import {
  HtmlEmailImportError,
  MAX_HTML_IMPORT_BYTES,
  importHtmlEmail,
} from "./html-email-import";

describe("importHtmlEmail", () => {
  it("sanitizes active content and maps a static table email to an editable document", () => {
    const result = importHtmlEmail({
      html: `<!doctype html><html><head><style>body{background:url(javascript:bad)}</style></head><body>
        <table><tr><td><h1>Launch day</h1><p><strong>Welcome</strong> to the update.</p>
          <a href="https://example.com" style="background-color:#111;color:#fff">Read more</a>
          <img src="https://cdn.example.com/hero.png" alt="Launch illustration" width="640">
          <script>alert('xss')</script><img src="javascript:bad" alt="bad">
        </td></tr></table></body></html>`,
    });

    expect(result.document.root.childrenIds).toHaveLength(1);
    const blockTypes = Object.values(result.document).map((block) => block.type);
    expect(blockTypes).toEqual(expect.arrayContaining(["section", "row", "column", "text", "button", "image"]));
    expect(checkDocumentIntegrity(result.document).isValid).toBe(true);
    expect(result.sanitizedHtml).not.toMatch(/script|javascript:|<style/i);
    expect(result.sanitizedHtml).toContain("https://cdn.example.com/hero.png");
    expect(result.report.unsupportedFeatures).toContain("style");
    expect(result.report.warnings.some((warning) => warning.code === "active-content-removed")).toBe(true);
    expect(
      result.report.warnings.filter(
        (warning) => warning.detail === "<script> was removed from the import.",
      ),
    ).toHaveLength(1);
    expect(result.report.warnings.some((warning) => warning.code === "unsafe-url-removed")).toBe(true);
  });

  it("drops tracking pixels while retaining normal remote images", () => {
    const result = importHtmlEmail({
      html: `<body><p>Hi</p><img src="https://example.com/open.gif" width="1" height="1"><img src="https://example.com/hero.jpg" width="600" height="300"></body>`,
    });

    const images = Object.values(result.document).filter((block) => block.type === "image");
    expect(images).toHaveLength(1);
    expect((images[0] as { properties: { src: string } }).properties.src).toBe("https://example.com/hero.jpg");
    expect(result.report.warnings.some((warning) => warning.code === "tracking-pixel-removed")).toBe(true);
  });

  it("keeps relative URLs out of the editable document unless a source URL is provided", () => {
    const withoutBase = importHtmlEmail({ html: `<body><img src="/hero.png"><a href="/read">Read</a></body>` });
    expect(Object.values(withoutBase.document).some((block) => block.type === "image" || block.type === "link")).toBe(false);
    expect(withoutBase.report.warnings.some((warning) => warning.code === "relative-url-removed")).toBe(true);

    const withBase = importHtmlEmail({
      html: `<body><img src="/hero.png" alt="Hero"><a href="/read">Read</a></body>`,
      baseUrl: "https://example.com/newsletter",
    });
    expect(Object.values(withBase.document).some((block) => block.type === "image")).toBe(true);
    expect(Object.values(withBase.document).some((block) => block.type === "link")).toBe(true);
  });

  it("rejects empty and oversized input before parsing", () => {
    expect(() => importHtmlEmail({ html: "   " })).toThrowError(new HtmlEmailImportError("empty", "Paste an HTML email before importing it."));
    expect(() => importHtmlEmail({ html: "x".repeat(MAX_HTML_IMPORT_BYTES + 1) })).toThrowError(
      new HtmlEmailImportError("too-large", "That HTML file is larger than 512 KB."),
    );
  });
});
