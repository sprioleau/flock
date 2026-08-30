/*
  Starter prompts for the EMPTY chat thread.

  The empty state told the user what to do ("Describe a change and watch it
  land on the canvas") without giving them a way to do it. These are that way:
  a small set of chips, each carrying one concrete, ready-to-send prompt that
  the chip hands to the composer — focused and editable, NEVER auto-sent. That
  is the same discipline the persona finding card's "Ask in chat" already
  follows (SuggestionCard.tsx), and it is what makes a starter trustworthy: the
  user reads what they are about to ask for before they ask for it.

  Pure and dependency-free on purpose. vitest.config.ts pins `environment:
  "node"` for all of src/**, so everything decided here — which starters exist,
  what they say, which ones are shown, and in what order — is unit-testable,
  and the component that renders them stays a thin map over selectPromptStarters().

  THREE RULES the content follows, and the reasons they matter:

  1. Every prompt names something the copilot can actually DO today. Each one
     below lands on a verified shipping surface: `updateText` /
     `updateBlockProperties` for the rewrite, `openPanel("brand-kit")` for the
     brand scrape, `applyTheme` (a wholesale replace of the root globals) for
     the theme, `scaffoldSection` over the section catalog's `feature-columns`
     template for the section, and the approval-gated `sendTestEmail` for the
     test send. A starter that produces "I can't do that" is worse than no
     starter — it is the user's first impression of the copilot's ceiling.

  2. Specific, not a category label. "Rewrite the headline and opening
     paragraph for a product launch" teaches what the copilot will take;
     "Create an email" teaches nothing and produces a worse first result. The
     specifics are also the part the user is meant to EDIT — the handoff drops
     the caret at the end of the inserted text for exactly that.

  3. They tell the SAME story the new draft already tells. A fresh draft opens
     on a starter document whose "Three moves to make it yours" section reads
     set the theme → drop in a section → send yourself a test
     (createStarterDocument, packages/email-sdk). The starters below follow
     that spine rather than inventing a competing one, so the canvas and the
     chat panel are teaching one lesson between them.

  Vocabulary: an EMAIL is the container, a DRAFT is a child of it. The copilot
  edits the current draft, so that is what these prompts say.
*/

/*
  Stable ids — the union rather than `string` so the selection tests and any
  future per-starter treatment in the component are checked by the compiler.
*/
export type PromptStarterId =
  | "rewrite-opening"
  | "brand-from-website"
  | "restyle-theme"
  | "add-section"
  | "send-test";

export interface PromptStarter {
  id: PromptStarterId;
  /*
    The chip's visible text, and therefore its accessible name. Verb-first
    and short enough to sit three or four across a narrow chat panel.
  */
  label: string;
  /*
    What lands in the composer, verbatim. Written as the user's own sentence,
    because that is whose message it becomes.
  */
  prompt: string;
}

/*
  Never more than four on screen. A starter list long enough to need reading
  is a menu, and a menu is a worse version of the text box it sits above.
*/
export const MAX_VISIBLE_PROMPT_STARTERS = 4;

/*
  Declared in the order they should read: the core loop first (it is what the
  panel is FOR), then the starter document's own three moves. The list is one
  longer than the cap, which is what makes the brand gate below a swap rather
  than a hole — see selectPromptStarters.
*/
export const PROMPT_STARTERS: readonly PromptStarter[] = [
  {
    /*
      The core loop, and deliberately the first chip: describe a change, watch
      it land. Phrased structurally ("the headline and opening paragraph")
      rather than by block id, so it resolves against the starter document's
      hero AND against whatever the user has already built.
    */
    id: "rewrite-opening",
    label: "Rewrite the opening",
    prompt:
      "Rewrite the headline and opening paragraph of this draft for a product launch, and give the button a label that matches.",
  },
  {
    /*
      The demo moment. The copilot cannot scrape a site itself, but it CAN open
      the surface that does — openPanel("brand-kit") — and the brand kit panel
      leads with its "Create from website URL" field, so the chip lands the user
      one paste away from a whole theme built from their own colors and fonts.
    */
    id: "brand-from-website",
    label: "Use my brand",
    prompt:
      "Open the brand kit so I can paste my website address and build a theme from my own colors and fonts.",
  },
  {
    /*
      Move one of the starter document's three. Every property named here is a
      real root global (contentBackgroundColor, buttonBackgroundColor,
      buttonBorderRadius), and applyTheme replaces the globals wholesale while
      stripping per-section background overrides — which is why "every section"
      is an honest promise rather than a hopeful one.
    */
    id: "restyle-theme",
    label: "Restyle the theme",
    prompt:
      "Give this draft a warmer theme — a soft off-white background, a deeper accent color on the buttons, and rounder button corners — and apply it across every section.",
  },
  {
    /*
      Move two. `feature-columns` is a real catalog template taking 2–4
      features, and scaffoldSection accepts an "above this section" anchor, so
      both halves of this sentence are things the tool actually takes.
    */
    id: "add-section",
    label: "Add a section",
    prompt:
      "Add a three-column features section above the footer, each column with a short title and one sentence under it.",
  },
  {
    /*
      Move three. sendTestEmail requires a real recipient address and is gated
      behind human approval, so the prompt asks for the address the user must
      supply — which is precisely what INSERT mode is good at: the chip fills
      the composer, the caret sits at the end, and the user types the address
      before sending. A chip that auto-sent this would be asking the copilot to
      guess an email address.
    */
    id: "send-test",
    label: "Send myself a test",
    prompt: "Send a test of this draft to my inbox at ",
  },
];

export interface SelectPromptStartersInput {
  /*
    Whether a saved brand kit already resolved for this canvas (the studio's
    useActiveBrandKit hasSavedKit). Not "is the panel reachable" — the panel is
    always reachable — but "has this user already done the thing the chip is
    for".
  */
  hasSavedBrandKit: boolean;
}

/*
  The starters to show right now, in reading order, capped at
  MAX_VISIBLE_PROMPT_STARTERS.

  One gate, and it is a swap rather than a subtraction: a canvas that already
  has a saved brand kit has had its demo moment, so "Use my brand" drops out —
  and because the declared list is one longer than the cap, "Send myself a
  test" moves up into the vacated slot. That reads as a progression rather than
  an accident: once your brand is in, the next thing worth doing is seeing the
  draft in a real inbox. Either way the user gets four chips.
*/
export function selectPromptStarters({
  hasSavedBrandKit,
}: SelectPromptStartersInput): PromptStarter[] {
  return PROMPT_STARTERS.filter(
    (starter) => !(starter.id === "brand-from-website" && hasSavedBrandKit),
  ).slice(0, MAX_VISIBLE_PROMPT_STARTERS);
}
