import { expect, test, type Page } from "@playwright/test";
import {
  getBlock,
  getCanvasRoot,
  leaveDemoNarration,
  openDemoDocument,
  suppressOnboardingTour,
} from "./support/studio";

/*
  The canvas: selection and comment mode.

  Every test here runs on a /demo document with the scripted narration dropped
  (see leaveDemoNarration). That buys an ordinary studio whose document still
  cannot spend inference — nothing on this page calls a model, but a stray
  ambient persona sweep would, and on a demo row even that one is mocked.
*/

async function openStudioOnDemoDocument(page: Page): Promise<string> {
  await suppressOnboardingTour(page);
  const documentId = await openDemoDocument(page);
  await leaveDemoNarration(page);
  await expect(getCanvasRoot(page, documentId)).toBeVisible();
  return documentId;
}

test.describe("studio canvas", () => {
  test("moves selection between blocks and clears it on the background", async ({ page }) => {
    const documentId = await openStudioOnDemoDocument(page);
    const primaryButton = getBlock(page, { documentId, blockId: "btn_prim" });
    const secondaryButton = getBlock(page, { documentId, blockId: "btn_scnd" });

    await primaryButton.scrollIntoViewIfNeeded();
    await primaryButton.click();
    await expect(primaryButton).toHaveAttribute("data-selected", "true");

    /*
      Selection is single: picking a second block must release the first.
      Worth pinning because the selected block is what the chat turn is ABOUT —
      two blocks reading as selected at once would make the composer's "describe
      a change to this button" prompt a lie about which button.
    */
    await secondaryButton.scrollIntoViewIfNeeded();
    await secondaryButton.click();
    await expect(secondaryButton).toHaveAttribute("data-selected", "true");
    await expect(primaryButton).not.toHaveAttribute("data-selected", "true");

    /* Clicking the canvas surround deselects — the escape hatch that gets a
       user out of the selection chrome without a keyboard. */
    await page.getByTestId("editor-canvas").click({ position: { x: 8, y: 8 } });
    await expect(secondaryButton).not.toHaveAttribute("data-selected", "true");
  });

  test("scopes every block to the canvas of the document being edited", async ({ page }) => {
    /*
      Block ids are per document, not globally unique: two drafts forked from
      the same parent carry the SAME `btn_prim`. So the canvas root advertises
      which document it renders, and every lookup is expected to go through it.
      This test pins that advertisement — the thing drop-target.ts, the presence
      overlays and this suite all depend on.
    */
    const documentId = await openStudioOnDemoDocument(page);

    await expect(getBlock(page, { documentId, blockId: "btn_prim" })).toHaveCount(1);
    await expect(getBlock(page, { documentId, blockId: "no_such_block" })).toHaveCount(0);
    await expect(getCanvasRoot(page, "not-this-document")).toHaveCount(0);
  });

  test("arms and disarms comment mode from the header control", async ({ page }) => {
    await openStudioOnDemoDocument(page);

    /*
      Comment mode SUSPENDS ordinary canvas editing — while it is armed every
      click drops a pin instead of selecting a block. A toggle that got stuck on
      would look like an editor that had stopped responding, so both directions
      matter, and both are asserted through the label a screen reader would
      read rather than through the store.
    */
    const armButton = page.getByRole("button", { name: "Turn on comment mode" });
    await expect(armButton).toBeVisible();
    await armButton.click();

    const disarmButton = page.getByRole("button", { name: "Turn off comment mode" });
    await expect(disarmButton).toBeVisible();
    await expect(disarmButton).toHaveAttribute("aria-pressed", "true");

    /* Escape is the documented way out (the tooltip promises it). */
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Turn on comment mode" })).toBeVisible();
  });
});
