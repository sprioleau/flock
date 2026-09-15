// @vitest-environment edge-runtime
import { register as registerProsemirrorSync } from "@convex-dev/prosemirror-sync/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "@convex/_generated/api";
import schema from "@convex/schema";
import { parseHtmlEmailImport } from "./html-email-import";

const modules = import.meta.glob([
  "../../../../convex/**/*.{ts,js}",
  "!**/*.d.ts",
  "!**/*.test.ts",
]);

function createBackend() {
  const backend = convexTest(schema, modules);
  registerProsemirrorSync(backend);
  return backend;
}

describe("HTML import persistence", () => {
  it("creates a reloadable sibling draft with server-authored provenance and normal history", async () => {
    const backend = createBackend();
    const source = await backend.mutation(api.documents.createDocument, {
      sessionId: "import-owner",
    });
    const preview = parseHtmlEmailImport({
      html: '<body><h1>Imported launch</h1><p>Safe copy</p><script>alert("x")</script></body>',
    });

    const created = await backend.mutation(api.documents.createImportedDocument, {
      sessionId: "import-owner",
      canvasId: source.canvasId,
      sourceDocumentId: source.documentId,
      doc: preview.document,
      sanitizedHtml: preview.sanitizedHtml,
      warnings: preview.report.warnings,
      unsupportedFeatures: preview.report.unsupportedFeatures,
    });
    const imported = await backend.query(api.documents.getDocument, {
      documentId: created.documentId,
    });

    expect(imported?.name).toBe("Imported HTML");
    expect(imported?.doc).toEqual(preview.document);
    expect(imported?.htmlImport?.sanitizedHtml).not.toContain("script");
    expect(imported?.htmlImport?.sourceChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(imported?.htmlImport?.warnings).toEqual(preview.report.warnings);

    const edit = await backend.mutation(api.documents.applyOperations, {
      documentId: created.documentId,
      ops: [{ name: "updateDocumentSettings", globals: { contentWidth: 640 } }],
      context: { authorId: "import-owner", author: "user", caller: "frontend" },
    });
    expect(edit.isOk).toBe(true);
    expect(
      await backend.mutation(api.history.undo, {
        documentId: created.documentId,
        authorId: "import-owner",
      }),
    ).toMatchObject({ isOk: true });
  });

  it("rejects a source draft from another canvas", async () => {
    const backend = createBackend();
    const first = await backend.mutation(api.documents.createDocument, { sessionId: "owner" });
    const second = await backend.mutation(api.documents.createDocument, { sessionId: "owner" });
    const preview = parseHtmlEmailImport({ html: "<body><p>Safe</p></body>" });

    await expect(
      backend.mutation(api.documents.createImportedDocument, {
        sessionId: "owner",
        canvasId: first.canvasId,
        sourceDocumentId: second.documentId,
        doc: preview.document,
        sanitizedHtml: preview.sanitizedHtml,
        warnings: [],
        unsupportedFeatures: [],
      }),
    ).rejects.toThrow("does not belong");
  });

  it("keeps the persistence boundary within the import resource caps", async () => {
    const backend = createBackend();
    const source = await backend.mutation(api.documents.createDocument, { sessionId: "owner" });
    const preview = parseHtmlEmailImport({ html: "<body><p>Safe</p></body>" });

    await expect(
      backend.mutation(api.documents.createImportedDocument, {
        sessionId: "owner",
        canvasId: source.canvasId,
        sourceDocumentId: source.documentId,
        doc: preview.document,
        sanitizedHtml: "é".repeat(300_000),
        warnings: [],
        unsupportedFeatures: [],
      }),
    ).rejects.toThrow("larger than 512 KB");
  });
});
