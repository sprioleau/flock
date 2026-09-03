import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SendTestEmailControl } from "./use-send-test-email";

vi.mock("@/lib/editor-store", () => ({
  useEditorStore: {
    getState: () => ({ doc: {} }),
  },
}));

import { TestSendEmailDialogContent } from "./SendTestEmailDialog";

const CONTROL: SendTestEmailControl = {
  recipients: ["owner@example.com"],
  updateRecipientAt: vi.fn(),
  addRecipient: vi.fn(),
  removeRecipientAt: vi.fn(),
  canAddRecipient: true,
  subject: "A subject for the selected draft",
  updateSubject: vi.fn(),
  persistSubject: vi.fn(),
  previewText: "A preview for the selected draft",
  updatePreviewText: vi.fn(),
  persistPreviewText: vi.fn(),
  sendState: { status: "idle" },
  isSending: false,
  prepareToSend: vi.fn(),
  discardInFlightSend: vi.fn(),
  submitSend: vi.fn(),
};

describe("test send dialog content", () => {
  it("puts editable send controls beside the active draft's rendered email", () => {
    const markup = renderToStaticMarkup(
      <TestSendEmailDialogContent
        control={CONTROL}
        activeDocumentId="draft_selected"
        renderState={{
          status: "ok",
          documentId: "draft_selected",
          html: "<html><body>Selected draft preview</body></html>",
        }}
      />,
    );

    expect(markup).toContain("Subject");
    expect(markup).toContain("Preview text");
    expect(markup).toContain('aria-label="Recipient 1"');
    expect(markup).toContain('title="Rendered test email preview"');
    expect(markup).toContain("Selected draft preview");
    expect(markup).toContain("md:grid-cols-2");
  });

  it("withholds stale rendered markup from a different draft", () => {
    const markup = renderToStaticMarkup(
      <TestSendEmailDialogContent
        control={CONTROL}
        activeDocumentId="draft_selected"
        renderState={{
          status: "ok",
          documentId: "draft_other",
          html: "<html><body>Other draft preview</body></html>",
        }}
      />,
    );

    expect(markup).not.toContain("Other draft preview");
    expect(markup).toContain("Refreshing rendered preview");
  });
});
