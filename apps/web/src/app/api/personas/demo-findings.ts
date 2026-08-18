import { createDemoDocument, type Block, type EmailDocument, type Operation } from "@flock/email-sdk";
import { stableStringify } from "@/lib/suggestions/serialize-block";
import type { RunnerOutputFinding } from "./finding-schema";

/*
  The two recommendations that pair with the /demo seed email.

  READ THIS FIRST, because the honesty question is the interesting one.

  /demo does not call a model (demo-mode.md §H: the routes share a 15 RPM /
  500-per-day free-tier quota with production, so a public link cannot spend
  it). The generic mock that covers CI and keyless clones produces one
  placeholder note per persona pointed at an arbitrary leaf block, which
  proves the MECHANISM perfectly and the JUDGEMENT not at all — and judgement
  is the single most valuable thing the product does. A demo that shows the
  plumbing and hides the intelligence is a demo of the wrong half.

  So this file buys that half back, once: two findings written to pair with
  the two problems planted in the seed email (packages/email-sdk demo-document
  — the files are a matched pair and must be changed together). They are
  FIXTURE COPY, not a recording of a model run, and nothing here claims
  otherwise. What keeps that honest is where the disclosure lives: /demo tells
  the visitor the run is scripted at the point it hands them into a real,
  unmocked session, and every server-side log line for these runs carries
  `isMock: true` and `findingSource: "demo-seed"`. What is NOT done is
  stamping "mock" on the recommendations themselves — a card labelled as fake
  teaches a stranger nothing about what the product says, and the label was
  doing the disclosure work that belongs at the exit.

  EVERY FINDING CARRIES AN APPLYABLE OP. A recommendation a visitor can accept
  in one press is the product; a recommendation that hands them off to the
  chat composer to go ask for the edit is a demo of a to-do list. The ops here
  are ordinary `updateBlockProperties` operations and they go through the
  route's ordinary dry-run before they are offered, so Apply does the real
  thing: real validation, a real op-log batch with `persona:<slug>`
  provenance, real undo.

  ONE HONEST ASYMMETRY, worth naming rather than hiding. The Styling
  Recommender's op is one a REAL run of that persona could also have produced:
  its fix is three scalar property values, which is exactly what
  `proposedEditSchema` can express. The Tone Police's op is not — its fix is a
  rewritten rich-text document, and `proposedEditSchema.value` is a `string`,
  so today a real Tone Police run can only ever describe a rewrite in prose
  and hand it to the composer. That is a genuine product gap (a persona whose
  entire job is copy cannot propose an applyable copy change), not a demo
  problem, and closing it means widening the model-facing edit schema to carry
  a text document. Until then this fixture shows the product one change ahead
  of where the live runner is.

  FRESHNESS. A fixture finding is only served while every block it is about
  still matches the seed byte for byte (`stableStringify`, the same snapshot
  function `personaFindings` already uses for staleness). The moment a visitor
  edits one of those blocks the fixture stops applying and the generic mock
  takes over — so the fixture can never describe an email that no longer says
  what it describes.
*/

/*
  A finding on its way into the route's post-processing, which is either
  model-shaped (`proposedEdits`: scalar property values the route translates to
  ops) or seed-shaped (`seedOps`: ops written directly, because a rich-text
  rewrite cannot be expressed as a scalar).

  Both paths are dry-run against the live document before anything is offered —
  `seedOps` buys the fixture no trust, only expressiveness.
*/
export interface RunnerFindingCandidate extends RunnerOutputFinding {
  seedOps?: Operation[];
}

/* The seed, materialised once: it is deterministic, and this module compares
   against it on every mocked run. */
const SEED_DOCUMENT = createDemoDocument();

function seedSnapshotFor(blockId: string): string {
  const seedBlock: Block | undefined = SEED_DOCUMENT[blockId];
  return stableStringify(seedBlock);
}

/*
  The rewritten hard-sell paragraph, in the voice the rest of the letter is
  already written in: the deadline survives (it is true — the roast is on
  Tuesday), the pressure and the shouting do not.
*/
const REWRITTEN_URGENCY_PARAGRAPH = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "We only roast what the harvest gives us, so this lot is a small one — about four hundred bags. Yours is set aside until Sunday night, and if you'd rather wait for the next arrival, that's completely fine by us.",
        },
      ],
    },
  ],
};

interface SeededFinding {
  finding: RunnerFindingCandidate;
  /* Blocks that must still match the seed for this finding to be served. */
  requiredSeedBlockIds: readonly string[];
}

const SEEDED_FINDINGS_BY_SLUG: Readonly<Record<string, SeededFinding>> = {
  "builtin/tone-police": {
    requiredSeedBlockIds: ["txt_push", "txt_lead"],
    finding: {
      personaSlug: "builtin/tone-police",
      title: "One paragraph shouts, and the rest of the email doesn't",
      description:
        'The letter opens like a note to a regular — "we set one aside for you" — and then switches to pressure and capitals: "everyone else has already claimed theirs", "RESERVE NOW", "LAST CHANCE". Applying this rewrites that paragraph in the opening\'s voice and keeps the real Sunday deadline, which is the only urgency the email has actually earned.',
      targetBlockNames: ['the paragraph beginning "Let\'s be honest…"'],
      targetBlockIds: ["txt_push"],
      seedOps: [
        {
          name: "updateBlockProperties",
          blockId: "txt_push",
          properties: { text: REWRITTEN_URGENCY_PARAGRAPH },
        },
      ],
    },
  },
  "builtin/styling-recommender": {
    requiredSeedBlockIds: ["btn_scnd", "btn_prim"],
    finding: {
      personaSlug: "builtin/styling-recommender",
      title: "The two buttons have drifted apart",
      description:
        '"Reserve your bag" is the brand green, centred, with a 6px corner. "Shop the spring lineup" is orange, left-aligned, with a 24px corner — the same kind of ask wearing a different outfit, and that orange appears nowhere else in the email. Applying this matches the second button to the first on all three.',
      targetBlockNames: [
        'the button labeled "Shop the spring lineup"',
        'the button labeled "Reserve your bag"',
      ],
      /* The block being CHANGED comes first: the route points each persona's
         block-presence chrome at `targetBlockIds[0]`, so this is what the
         avatar parks on. */
      targetBlockIds: ["btn_scnd", "btn_prim"],
      seedOps: [
        {
          name: "updateBlockProperties",
          blockId: "btn_scnd",
          properties: { backgroundColor: "#1f6f5c", borderRadius: 6, align: "center" },
        },
      ],
    },
  },
};

/*
  The seeded finding for one persona, or null when this document is not the
  seed email any more (or never was).

  Called only from the mocked path — a real model run is never displaced by
  this fixture.
*/
export function selectSeededFinding({
  doc,
  personaSlug,
}: {
  doc: EmailDocument;
  personaSlug: string;
}): RunnerFindingCandidate | null {
  const seeded = SEEDED_FINDINGS_BY_SLUG[personaSlug];
  if (seeded === undefined) {
    return null;
  }
  const isStillTheSeedEmail = seeded.requiredSeedBlockIds.every((blockId) => {
    const block: Block | undefined = doc[blockId];
    return block !== undefined && stableStringify(block) === seedSnapshotFor(blockId);
  });
  return isStillTheSeedEmail ? seeded.finding : null;
}
