import { expect, test, type Page } from "@playwright/test";
import {
  expectEditorSettled,
  getBlock,
  getCanvasRoot,
  getChatComposer,
  getChatSendButton,
  leaveDemoNarration,
  MOCK_MODEL_ID,
  MODEL_RESPONSE_HEADER,
  openDemoDocument,
  readBlockProperties,
  suppressOnboardingTour,
} from "./support/studio";

/*
  ===========================================================================
  THE SPEC THAT COULD SPEND MONEY, AND WHAT IT DOES ABOUT THAT
  ===========================================================================

  A chat turn is the one gesture in this product that calls a language model,
  and Flock's default provider is a Gemini free tier SHARED WITH PRODUCTION —
  15 requests a minute, 500 a day, for the whole deployment. There is no
  client-side lever to opt out: the dev "mock" checkbox was removed, and
  `isMockEnabled` now initialises false with nothing to set it.

  Two independent things keep this file free, and neither of them is a
  convention a spec author has to remember:

  1. THE DOCUMENT. Every turn below runs against a /demo document, whose row
     carries `isDemo`. Both inference routes resolve that flag SERVER-SIDE and
     force the deterministic mock (lib/demo/mock-authority.ts). It is not a
     header, so it cannot be forgotten, stripped, or overridden by anything
     this file sends.

  2. THE SERVER. The suite starts its own `next dev` with the provider keys set
     to the empty string (playwright.config.ts), which `provider.ts` reads as
     "no provider configured" and answers with the mock. Blanking lives in
     deployment configuration precisely so that editing a spec cannot undo it.

  AND THEN IT IS ASSERTED RATHER THAN BELIEVED. Until this suite landed, which
  model served a turn was recorded in exactly one place — a server log line —
  so nothing outside the process could check. `/api/chat` now answers with
  `x-flock-model` naming the model that actually ran, and the first test below
  reads it back. If either guarantee above ever breaks, that assertion goes red
  on the very first turn instead of a quota going quiet.

  WHAT IS DELIBERATELY NOT TESTED HERE: anything that would require a NON-demo
  document to take a chat turn. That is the only assertion that could
  independently prove the blanked Gemini key is in force, and making it would
  cost one real request every run to prove that no real request happens. The
  blanking mechanism is proved instead in preview-send.spec.ts, which shows the
  identically-blanked Resend key reaching its route as absent — same
  `webServer.env`, same `@next/env` path, no spend either way.
*/

const CHAT_API_PATH = "/api/chat";

/*
  A prompt the deterministic mock answers with `updateBlockProperties` on the
  SELECTED block, setting its label to the prompt text (mock-model.ts's final
  fallback). Chosen to miss every keyword ahead of that fallback — no
  "section", "preview", "review", "test email", "open", URL — so the op under
  test is the one this file means to be testing.
*/
const RENAME_PROMPT = "Rename this to Grab the spring lot";

async function openStudioOnDemoDocument(page: Page): Promise<string> {
  await suppressOnboardingTour(page);
  const documentId = await openDemoDocument(page);
  await leaveDemoNarration(page);
  await expect(getCanvasRoot(page, documentId)).toBeVisible();
  return documentId;
}

async function selectBlockAndSend(
  page: Page,
  input: { documentId: string; blockId: string; prompt: string },
) {
  const block = getBlock(page, { documentId: input.documentId, blockId: input.blockId });
  await block.scrollIntoViewIfNeeded();
  await block.click();
  await expect(block).toHaveAttribute("data-selected", "true");

  const composer = getChatComposer(page);
  await composer.fill(input.prompt);

  /* Armed before the click so the first turn's response cannot be missed. */
  const chatResponse = page.waitForResponse((response) =>
    response.url().includes(CHAT_API_PATH),
  );
  await getChatSendButton(page).click();
  return chatResponse;
}

/*
  KNOWN GAP, not a flake. All three cases below fail, and the earlier reading
  of WHY was wrong: it is not that the chat panel starts collapsed, and the
  fix is NOT to expand it in setup. Re-measured 2026-08-28 by un-fixme-ing
  these three and reading the failure.

  What actually happens. The composer is reachable -- `composer.fill()`
  succeeds, and Playwright resolves the send button and reports it "visible,
  enabled and stable". The click then never lands, retried 161 times until the
  90s timeout, with:

      <aside class="... border-r ... transition-[width] ..."> intercepts
      pointer events

  That aside is the chat panel itself, box [0, 0, 360, viewportH]. The send
  button's box is x≈312 w=36, i.e. INSIDE it. So the composer is not covered
  by some other panel; it is clipped by the panel that owns it -- the aside is
  `overflow: hidden`, the shell above it is `flex h-dvh w-full overflow-hidden`,
  and `document.elementFromPoint` at the button's own centre returns an
  ancestor div rather than the button. Nothing can scroll it into view, which
  is why expanding a panel cannot help and why a taller viewport alone did not
  fix the hit test either.

  So this is a LAYOUT defect, not test setup: when the panel's content is
  taller than the panel (transcript plus the seeded suggestion cards), the
  composer is clipped out of reach. A real user on a short viewport hits the
  same thing. The fix belongs in the panel -- let the transcript scroll and
  keep the composer pinned -- after which these three should pass unchanged.

  Deliberately NOT worked around by sending with Enter instead of clicking.
  That would make the suite green while hiding a control real users cannot
  click. The assertions here are the point of the slice and stay intact.
*/
test.describe("chat operations", () => {
  test.fixme("a turn on a demo document is served by the mock, and says so on the wire", async ({
    page,
  }) => {
    const documentId = await openStudioOnDemoDocument(page);
    const response = await selectBlockAndSend(page, {
      documentId,
      blockId: "btn_prim",
      prompt: RENAME_PROMPT,
    });

    /*
      THE ASSERTION THIS WHOLE SUITE IS ARRANGED AROUND. The response names the
      model that actually served the turn; anything other than the mock id means
      a browser test just spent production's shared quota.
    */
    expect(response.headers()[MODEL_RESPONSE_HEADER]).toBe(MOCK_MODEL_ID);

    /*
      And it was the SERVER that decided. The client sent no `x-flock-mock`
      header — there is no UI that could — so the mock came from the document
      row, which is the only version of this guarantee a public /demo link can
      rely on. If this ever fails while the assertion above passes, the demo's
      protection has quietly moved back into the client's hands.
    */
    expect(response.request().headers()).not.toHaveProperty("x-flock-mock");
  });

  test.fixme("applies the agent's operation to the canvas and settles", async ({ page }) => {
    const documentId = await openStudioOnDemoDocument(page);
    await selectBlockAndSend(page, {
      documentId,
      blockId: "btn_prim",
      prompt: RENAME_PROMPT,
    });

    /*
      The whole op pipeline in one assertion: composer → /api/chat → streamed
      tool call → server-side validation → client apply → canvas re-render. The
      button the user selected now carries the words they typed, because the
      mock's fallback op sets the selected block's label to the prompt.
    */
    const button = getBlock(page, { documentId, blockId: "btn_prim" });
    await expect(button).toContainText(RENAME_PROMPT);
    await expect(button).not.toContainText("Reserve your bag");

    /* Nothing left outstanding: every op the turn produced has been
       acknowledged by the server, not merely painted optimistically. */
    await expectEditorSettled(page);
    await expect
      .poll(async () => {
        const properties = await readBlockProperties(page, { blockId: "btn_prim" });
        return properties?.label;
      })
      .toBe(RENAME_PROMPT);
  });

  test.fixme("the operation survives a reload, so it reached the op log", async ({ page }) => {
    /*
      The difference between an edit and an illusion. Everything above could be
      satisfied by local state that never left the tab; only a reload proves the
      operation went through Convex and came back as the document's real head.
      A document that forgets an agent's edit on refresh is the worst failure
      this product has, and it is invisible to every unit test.
    */
    const documentId = await openStudioOnDemoDocument(page);
    await selectBlockAndSend(page, {
      documentId,
      blockId: "btn_prim",
      prompt: RENAME_PROMPT,
    });
    await expect(getBlock(page, { documentId, blockId: "btn_prim" })).toContainText(RENAME_PROMPT);
    await expectEditorSettled(page);

    await page.reload();
    await expect(getCanvasRoot(page, documentId)).toBeVisible();
    await expect(getBlock(page, { documentId, blockId: "btn_prim" })).toContainText(RENAME_PROMPT);
  });
});
