import { expect, test } from "@playwright/test";
import { getBlock, getCanvasRoot, openDemoDocument } from "./support/studio";

/*
  /demo — the front door for a stranger.

  These tests deliberately do NOT suppress the onboarding tour. /demo suppresses
  it itself, and that suppression is one of the things under test: a helper that
  pre-dismissed the tour would make the assertion below prove nothing.
*/

test.describe("/demo", () => {
  test("hands a stranger a working studio on a seeded email", async ({ page }) => {
    const documentId = await openDemoDocument(page);

    /* The address bar is the studio's, not /demo's — the bootstrap replaces
       the route once it has a document (DemoBootstrap: "a preset over the real
       studio, not a second application"). */
    expect(page.url()).toContain(`/studio?doc=${documentId}`);

    /* The canvas belongs to the document that was just provisioned. */
    await expect(getCanvasRoot(page, documentId)).toHaveAttribute(
      "data-canvas-document-id",
      documentId,
    );

    /* The seeded email is really there — its lead heading and both of its
       calls to action, which are what the scripted agents later review. */
    await expect(page.getByText("Your spring lot has landed")).toBeVisible();
    await expect(getBlock(page, { documentId, blockId: "btn_prim" })).toBeVisible();
    await expect(getBlock(page, { documentId, blockId: "btn_scnd" })).toBeVisible();
  });

  test("suppresses the first-run tour that would otherwise photobomb it", async ({ page }) => {
    /*
      A first-time browser is exactly who /demo is for, and the walkthrough
      auto-starts for a first-time browser. If both ran, they would narrate over
      each other — and worse, the tour's presence suppresses every advisory
      persona run, silencing the two agents the whole route exists to show.

      The preset is written BEFORE the navigation for this reason, so the
      correct assertion is that the tour never appears at all, not that it
      disappears quickly.
    */
    await openDemoDocument(page);

    await expect(page.getByTestId("studio-tour-card")).toHaveCount(0);
    await expect(page.getByTestId("studio-tour-scrim")).toHaveCount(0);
    await expect(page.getByTestId("demo-run-panel")).toBeVisible();
  });

  test("provisions a fresh document per visit, so two visitors never collide", async ({ page }) => {
    /*
      Isolation between strangers is a property of the DOCUMENT here: presence
      rooms, persona rows and findings are all keyed per document, so "one
      document per visit" IS the isolation story. A single shared demo document
      would make every visitor an editor of the next visitor's demo.

      Two visits from one browser is the strongest form of this a single-context
      test can make: same cookies, same session id, same everything the server
      could have keyed a cache on.
    */
    const firstDocumentId = await openDemoDocument(page);
    const secondDocumentId = await openDemoDocument(page);

    expect(secondDocumentId).not.toBe(firstDocumentId);
    await expect(getCanvasRoot(page, secondDocumentId)).toBeVisible();
    await expect(getCanvasRoot(page, firstDocumentId)).toHaveCount(0);
  });
});
