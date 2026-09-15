import { describe, expect, it } from "vitest";
import { MAX_HTML_IMPORT_BYTES } from "@/lib/html-email-import";
import { POST } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/html-import/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/html-import/preview", () => {
  it("returns a converted document, sanitized source, and fidelity report without persistence", async () => {
    const response = await POST(
      request({
        html: `<body><h1>Welcome</h1><script>alert('xss')</script><a href="https://example.com">Read</a></body>`,
      }),
    );
    const payload = (await response.json()) as {
      document: Record<string, { type: string }>;
      sanitizedHtml: string;
      report: { warnings: Array<{ code: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.document.root.type).toBe("root");
    expect(payload.sanitizedHtml).not.toMatch(/script|alert/i);
    expect(payload.report.warnings.some((warning) => warning.code === "active-content-removed")).toBe(true);
  });

  it("rejects malformed input and preserves the parser's 512 KB limit", async () => {
    const invalid = await POST(request({ html: 12 }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_input" });

    const oversized = await POST(request({ html: "x".repeat(MAX_HTML_IMPORT_BYTES + 1) }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "too-large" });
  });
});
