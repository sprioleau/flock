import { expect, type Locator, type Page } from "@playwright/test";

/*
  Shared vocabulary for driving the Flock studio from a browser.

  Everything here is either (a) a determinism primitive the app deliberately
  exposes, or (b) a piece of setup that is the same in every spec. Assertions
  live in the specs; this file only gets a page into a known state and answers
  questions about it.
*/

/*
  The dev-only store handle the studio publishes on `window`
  (apps/web/src/lib/editor-store.ts — guarded by NODE_ENV !== "production", so
  it is there under `next dev` and absent in a real deployment).

  Re-declared rather than imported: the callbacks below are serialised and run
  INSIDE the page, where this project's module graph does not exist. Only the
  fields the suite actually reads are named, so this stays a description of
  what is being relied on rather than a copy of EditorState.
*/
declare global {
  interface Window {
    __flockEditorStore?: {
      getState: () => {
        documentId: string | null;
        selectedBlockId: string | null;
        pendingOps: readonly unknown[];
        doc: Record<string, { id: string; type: string; properties: Record<string, unknown> }>;
      };
    };
  }
}

/* localStorage keys the studio reads at mount. Mirrors of the app's own
   constants (lib/tour/tour-progress.ts, lib/demo/demo-preset.ts) — deliberate
   duplication, because a test that imported them could not tell the difference
   between "the key was renamed" and "the key still works". */
const TOUR_PROGRESS_STORAGE_KEY = "flock:tour-progress";
const DEMO_SESSION_STORAGE_KEY = "flock:demo-session";
const ENABLED_PERSONAS_STORAGE_KEY = "flock_enabled_agents";

/* The model id api/chat reports when the deterministic mock served the turn
   (apps/web/src/app/api/chat/constants.ts). */
export const MOCK_MODEL_ID = "flock-mock-chat-model";

/* The response header naming the model that actually ran
   (apps/web/src/lib/chat-contract.ts). */
export const MODEL_RESPONSE_HEADER = "x-flock-model";

/*
  Stop the first-run walkthrough before the page has a chance to start it.

  The tour AUTO-STARTS for a browser that has never seen it, which is every
  Playwright context, and its scrim is `pointer-events-auto` everywhere
  outside the current spotlight — so it silently eats canvas clicks for about
  half a minute without any of its copy containing the word "tour". Left
  alone it is the single biggest source of unexplained flake in this suite.

  Call this BEFORE the first navigation. /demo suppresses the tour on its own
  (demo-preset.ts), so demo.spec.ts deliberately does not call it — proving
  that suppression is a real test, not a thing this helper faked.
*/
export async function suppressOnboardingTour(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key }: { key: string }) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ status: "dismissed", resumeStopId: null }),
      );
    },
    { key: TOUR_PROGRESS_STORAGE_KEY },
  );
}

/*
  Open a fresh /demo document and return its id, with the studio mounted.

  /demo is the ONE entrance a browser test can drive at zero cost: the row it
  provisions carries `isDemo`, and both inference routes force the
  deterministic mock off that row server-side (lib/demo/mock-authority.ts). No
  header, no client setting, and nothing a spec can get wrong is involved.
*/
export async function openDemoDocument(page: Page): Promise<string> {
  await page.goto("/demo");
  await page.waitForURL(/\/studio\?doc=/);
  const documentId = new URL(page.url()).searchParams.get("doc");
  if (documentId === null) {
    throw new Error("/demo redirected to the studio without a ?doc= parameter.");
  }
  await expect(getCanvasRoot(page, documentId)).toBeVisible();
  return documentId;
}

/*
  Leave the scripted demo NARRATION while staying on the demo DOCUMENT.

  The two are different things, and the difference is what makes this useful:
  the guided card, the canvas dim and the two agents come from three
  localStorage keys, while the mock-forcing comes from the Convex row. Dropping
  the keys gives a spec the ordinary studio — no card overlapping the canvas,
  no ambient persona sweeps writing findings mid-assertion — on a document that
  still cannot spend a penny of inference.

  NOT the "Exit the demo" button, deliberately: that one navigates to a bare
  /studio, which provisions a brand-new NON-demo document, and every turn on it
  would reach for a real model.
*/
export async function leaveDemoNarration(page: Page): Promise<void> {
  await page.evaluate(
    ({ sessionKey, personasKey }: { sessionKey: string; personasKey: string }) => {
      window.localStorage.removeItem(sessionKey);
      window.localStorage.setItem(personasKey, "[]");
    },
    { sessionKey: DEMO_SESSION_STORAGE_KEY, personasKey: ENABLED_PERSONAS_STORAGE_KEY },
  );
  await page.reload();
}

/*
  The canvas of ONE document.

  Always scoped by document id: block ids repeat across forked sibling drafts,
  so a bare `[data-block-id="btn_prim"]` can resolve into a neighbouring frame
  the spec was not talking about (the same reason drop-target.ts scopes its own
  lookups this way).
*/
export function getCanvasRoot(page: Page, documentId: string): Locator {
  return page.locator(`[data-dnd-canvas-root][data-canvas-document-id="${documentId}"]`);
}

export function getBlock(page: Page, input: { documentId: string; blockId: string }): Locator {
  return getCanvasRoot(page, input.documentId).locator(`[data-block-id="${input.blockId}"]`);
}

/*
  Wait until the editor has nothing left in flight.

  `pendingOps` is the outbound overlay: operations applied locally that the
  server has not acknowledged yet. Empty means every edit this page made has
  round-tripped through Convex — which is the real "the app has settled"
  signal, and strictly better than any sleep, because it is the same fact the
  app itself uses to decide when to rebase.
*/
export async function expectEditorSettled(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const state = window.__flockEditorStore?.getState();
          return state === undefined ? "no-store" : state.pendingOps.length;
        }),
      { message: "the editor never drained its pending operations" },
    )
    .toBe(0);
}

/* A block's live properties, straight off the store — for the cases where the
   rendered pixels are an email-HTML detail but the property is the behaviour
   under test. */
export async function readBlockProperties(
  page: Page,
  input: { blockId: string },
): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(
    ({ blockId }: { blockId: string }) =>
      window.__flockEditorStore?.getState().doc[blockId]?.properties,
    { blockId: input.blockId },
  );
}

/* The composer's textarea. Queried by its accessible label, which — unlike the
   placeholder and unlike the send button's label — is the same string in every
   state of a turn. */
export function getChatComposer(page: Page): Locator {
  return page.getByLabel("Chat message");
}

/*
  The composer's send button.

  The one control in the panel with no stable accessible handle: its
  `aria-label` flips between "Send message" and "Queue message" the instant a
  turn goes in flight, so a role+name query would pass or fail on timing. Hence
  the testid, added for exactly this.
*/
export function getChatSendButton(page: Page): Locator {
  return page.getByTestId("chat-composer-send");
}
