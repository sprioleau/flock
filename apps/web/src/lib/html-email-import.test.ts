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

  it("preserves safe background images and straightforward background colors on layout blocks", () => {
    const result = importHtmlEmail({
      html: `<body><table style="background-image:url('https://cdn.example.com/section.jpg');background-size:cover;background-position:center;background-repeat:no-repeat;background-color:#f8f5ef">
        <tr style="background:url(https://cdn.example.com/row.jpg);background-color:#0b6b4f"><td background="https://cdn.example.com/column.jpg" bgcolor="#ffffff" style="background-repeat:repeat-x"><p>Seasonal offer</p></td></tr>
      </table></body>`,
    });

    const section = Object.values(result.document).find((block) => block.type === "section") as {
      properties: Record<string, unknown>;
    };
    const row = Object.values(result.document).find((block) => block.type === "row") as {
      properties: Record<string, unknown>;
    };
    const column = Object.values(result.document).find((block) => block.type === "column") as {
      properties: Record<string, unknown>;
    };

    expect(section.properties).toMatchObject({
      backgroundImageUrl: "https://cdn.example.com/section.jpg",
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      innerBackgroundColor: "#f8f5ef",
    });
    expect(row.properties).toMatchObject({
      backgroundImageUrl: "https://cdn.example.com/row.jpg",
      backgroundColor: "#0b6b4f",
    });
    expect(column.properties).toMatchObject({
      backgroundImageUrl: "https://cdn.example.com/column.jpg",
      backgroundColor: "#ffffff",
      backgroundRepeat: "repeat-x",
    });
  });

  it("recovers a background-bearing cell and linked image inside email wrapper tables", () => {
    const result = importHtmlEmail({
      html: `<body><div role="article"><table><tbody><tr><td><table><tbody><tr><td style="background-image:url('https://cdn.example.com/hero.jpg');background-size:cover;background-position:center top;background-repeat:no-repeat;background-color:#221100"><table><tbody><tr><td><a href="https://example.com"><img src="https://cdn.example.com/logo.png" width="106" height="106" alt="Logo"></a><p>Hero copy</p></td></tr></tbody></table></td></tr></tbody></table></td></tr></tbody></table></div></body>`,
    });

    const blocks = Object.values(result.document);
    expect(blocks.some((block) =>
      ["section", "row", "column"].includes(block.type) &&
      "backgroundImageUrl" in block.properties &&
      block.properties.backgroundImageUrl === "https://cdn.example.com/hero.jpg" &&
      block.properties.backgroundPosition === "top center"
    )).toBe(true);
    expect(blocks.some((block) =>
      block.type === "image" &&
      block.properties.src === "https://cdn.example.com/logo.png" &&
      block.properties.href === "https://example.com/"
    )).toBe(true);

    const backgroundColumn = blocks.find((block) =>
      block.type === "column" &&
      "backgroundImageUrl" in block.properties &&
      block.properties.backgroundImageUrl === "https://cdn.example.com/hero.jpg"
    ) as { childrenIds: string[] } | undefined;
    expect(backgroundColumn).toBeDefined();
    expect(backgroundColumn?.childrenIds.some((childId) =>
      result.document[childId]?.type === "image"
    )).toBe(true);
    expect(backgroundColumn?.childrenIds.some((childId) =>
      result.document[childId]?.type === "text"
    )).toBe(true);
  });

  it("rejects unsafe, malformed, merged, gradient, and multilayer backgrounds with warnings", () => {
    const result = importHtmlEmail({
      html: `<body><table style="background-image:url(javascript:bad),url(https://cdn.example.com/second.jpg)"><tr><td style="background-image:linear-gradient(red,blue)"><p>Safe copy</p></td></tr></table>
        <div style="background-image:url({{hero_url}})">More copy</div><div background="file:///tmp/hero.jpg">Other copy</div></body>`,
      baseUrl: "https://example.com/newsletter",
    });

    const layoutBlocks = Object.values(result.document).filter((block) =>
      block.type === "section" || block.type === "row" || block.type === "column",
    );
    expect(layoutBlocks.some((block) => "backgroundImageUrl" in block.properties)).toBe(false);
    expect(result.report.warnings.some((warning) => warning.code === "unsafe-url-removed")).toBe(true);
    expect(result.report.warnings.some((warning) => warning.code === "unsupported-feature")).toBe(true);
  });

  it("turns a linked image into one image block and keeps the image when the href is unsafe", () => {
    const result = importHtmlEmail({
      html: `<body><a href="https://example.com/product"><img src="https://cdn.example.com/product.png" width="640" height="320" alt="Product"></a>
        <a href="javascript:bad"><img src="https://cdn.example.com/safe.png" width="300" height="150" alt="Safe"></a></body>`,
    });

    const images = Object.values(result.document).filter((block) => block.type === "image") as Array<{
      properties: Record<string, unknown>;
    }>;
    expect(images).toHaveLength(2);
    expect(images[0].properties).toMatchObject({
      src: "https://cdn.example.com/product.png",
      href: "https://example.com/product",
      width: 640,
      alt: "Product",
    });
    expect(images[1].properties).toMatchObject({
      src: "https://cdn.example.com/safe.png",
      width: 300,
      alt: "Safe",
    });
    expect(images[1].properties.href).toBeUndefined();
    expect(result.report.warnings.some((warning) => warning.code === "unsafe-url-removed")).toBe(true);
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

  it("applies a bounded stylesheet cascade with id, class, element, and inline precedence", () => {
    const result = importHtmlEmail({
      html: `<html><head><style>
        p { color: #111111; font-family: Arial, sans-serif; font-size: 14px; padding: 4px; }
        .copy { color: #222222; font-size: 16px; }
        #hero-copy { color: #333333; font-size: 18px; }
        h1 { font-weight: 700; text-align: center; }
      </style></head><body><table><tr><td><p id="hero-copy" class="copy" style="font-size:20px">Hero copy</p><h1>Launch</h1></td></tr></table></body></html>`,
    });

    const textBlocks = Object.values(result.document).filter((block) => block.type === "text") as Array<{
      properties: { text: { content: Array<{ content?: Array<{ marks?: Array<{ type: string; attrs?: Record<string, string> }> }> }> }; textAlign?: string; paddingTop?: number; };
    }>;
    const hero = textBlocks.find((block) => JSON.stringify(block.properties.text).includes("Hero copy"));
    expect(hero?.properties.text.content[0]?.content?.[0]?.marks).toEqual([
      { type: "textStyle", attrs: { color: "#333333", fontFamily: "Arial, sans-serif", fontSize: "20px" } },
    ]);
    expect(hero?.properties.paddingTop).toBe(4);
    expect(textBlocks.some((block) => block.properties.textAlign === "center")).toBe(true);
  });

  it("rejects unsafe and unsupported stylesheet constructs while keeping inline content", () => {
    const result = importHtmlEmail({
      html: `<html><head><style>
        .safe { color: #123456; }
        .safe:hover { color: expression(alert(1)); }
        [data-x="y"] { color: red; }
        .bad { background-image: url(javascript:alert(1)); }
        @import url(https://evil.example/style.css);
        .line { line-height: 1.5; text-transform: uppercase; margin: 10px; }
      </style></head><body><p class="safe line">Safe content</p></body></html>`,
    });

    const textBlock = Object.values(result.document).find((block) => block.type === "text") as {
      properties: { text: { content: Array<{ content?: Array<{ marks?: Array<{ type: string; attrs?: Record<string, string> }> }> }> }; };
    };
    expect(JSON.stringify(textBlock.properties.text)).toContain("#123456");
    expect(JSON.stringify(textBlock.properties.text)).not.toContain("expression");
    expect(result.report.unsupportedFeatures).toContain("stylesheet");
    expect(result.report.warnings.some((warning) => warning.code === "unsupported-feature")).toBe(true);
  });

  it("does not leak nested at-rule declarations into the global cascade", () => {
    const result = importHtmlEmail({
      html: `<html><head><style>
        p { color: #123456; }
        @media screen and (max-width: 600px) { p { color: #ff0000; } }
        @supports (display: grid) { p { color: #00ff00; } }
        @font-face { font-family: Evil; src: url(https://evil.example/font.woff2); }
      </style></head><body><p>Stable copy</p></body></html>`,
    });

    const textBlock = Object.values(result.document).find((block) => block.type === "text") as {
      properties: { text: unknown };
    };
    expect(JSON.stringify(textBlock.properties.text)).toContain("#123456");
    expect(JSON.stringify(textBlock.properties.text)).not.toContain("#ff0000");
    expect(JSON.stringify(textBlock.properties.text)).not.toContain("#00ff00");
    expect(result.report.unsupportedFeatures).toContain("stylesheet");
  });

  it("keeps a safe rule after a semicolon at-rule", () => {
    const result = importHtmlEmail({
      html: `<html><head><style>@import url("https://example.com/type.css"); .copy { color: #123456; }</style></head><body><p class="copy">Stable copy</p></body></html>`,
    });

    const textBlock = Object.values(result.document).find((block) => block.type === "text") as {
      properties: { text: unknown };
    };
    expect(JSON.stringify(textBlock.properties.text)).toContain("#123456");
    expect(result.report.unsupportedFeatures).toContain("stylesheet");
  });

  it("omits a decimal font size that the editable text schema cannot represent", () => {
    const result = importHtmlEmail({
      html: `<html><head><style>.copy { color: #123456; font-size: 13.5px; }</style></head><body><p class="copy">Stable copy</p></body></html>`,
    });

    expect(JSON.stringify(result.document)).toContain("#123456");
    expect(JSON.stringify(result.document)).not.toContain("13.5px");
    expect(
      result.report.warnings.some(
        (warning) =>
          warning.code === "unsupported-feature" && warning.detail.includes("font-size"),
      ),
    ).toBe(true);
  });

  it("preserves direct table-cell copy as editable rich text", () => {
    const result = importHtmlEmail({
      html: `<table><tr><td class="headline" style="color:#123456;font-size:32px;text-align:center">Build your desk setup</td></tr></table>`,
    });

    const textBlock = Object.values(result.document).find((block) => block.type === "text") as {
      properties: { text: unknown; textAlign?: string };
    };
    expect(JSON.stringify(textBlock.properties.text)).toContain("Build your desk setup");
    expect(JSON.stringify(textBlock.properties.text)).toContain("32px");
    expect(textBlock.properties.textAlign).toBe("center");
  });

  it("maps anchor padding to button internals and preserves standalone link typography", () => {
    const result = importHtmlEmail({
      html: `<html><head><style>
        .cta { padding: 8px 20px; background-color: #111111; color: #ffffff; }
        .footer-link { color: #123456; font-family: Georgia, serif; font-size: 13px; text-align: center; }
      </style></head><body><a class="cta" href="https://example.com/buy">Buy now</a><a class="footer-link" href="https://example.com/legal">Legal</a></body></html>`,
    });

    const button = Object.values(result.document).find((block) => block.type === "button") as {
      properties: Record<string, unknown>;
    };
    const link = Object.values(result.document).find((block) => block.type === "link") as {
      properties: Record<string, unknown>;
    };
    expect(button.properties).toMatchObject({ verticalPadding: 8, horizontalPadding: 20 });
    expect(button.properties.paddingTop).toBeUndefined();
    expect(link.properties).toMatchObject({
      textColor: "#123456",
      fontFamily: "Georgia, serif",
      fontSize: 13,
      align: "center",
    });
  });

  it("reports non-representable line height, transform, and margin instead of accepting them", () => {
    const result = importHtmlEmail({
      html: `<html><head><style>.copy { line-height: 1.5; text-transform: uppercase; margin: 12px; }</style></head><body><p class="copy">Copy</p></body></html>`,
    });

    expect(result.report.warnings.filter((warning) => warning.code === "unsupported-feature")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining("line-height") }),
        expect.objectContaining({ detail: expect.stringContaining("text-transform") }),
        expect.objectContaining({ detail: expect.stringContaining("margin") }),
      ]),
    );
  });
});
