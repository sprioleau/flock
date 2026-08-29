import { caniemail } from "caniemail";
import { renderToHTML } from "../render/render-to-html";
import type { EmailDocument } from "../store/document";
import { findBlockIdAt, indexBlockRanges, toIndexRange } from "./block-ranges";
import {
  CHECKED_EMAIL_CLIENTS,
  CHECKED_EMAIL_CLIENT_LABELS,
  type CheckedEmailClient,
} from "./supported-clients";

/**
 * `checkEmailCompatibility` — the pre-send client-support check.
 *
 * WHAT IT IS, AND WHERE THE RULES COME FROM. Not one rule in this file was
 * written here. The judgements — "Outlook's Word engine ignores
 * `border-radius`", "Yahoo's web client drops `height`" — come from Can I
 * Email's dataset (307 features, community-tested against real clients), read
 * through the `caniemail` package's own HTML/CSS analysis. Flock's part is
 * choosing which clients to ask about, rendering the email, deciding which
 * answers are worth a user's attention, and saying which BLOCK each one is
 * about. The alternative — hand-writing an email linter — would be a worse
 * copy of a dataset that is already maintained and already right.
 *
 * ZERO MODEL CALLS. This is the point as much as the findings are. The QA
 * Reviewer persona currently spends Gemini quota to guess at renderability
 * ("fonts email clients cannot render"), and that quota is 15 requests a
 * minute shared with production. A deterministic check answers a strictly
 * larger version of that question for nothing, every time, identically.
 *
 * ADVISORY, NEVER BLOCKING. Nothing here can refuse a send, and the result
 * type has no "fail" state for a caller to branch on: a document that cannot
 * even be rendered comes back as `isChecked: false` with a reason, on the
 * same success channel as a clean bill of health. An email QA tool that
 * stands between a user and their own send is a worse product than one that
 * is occasionally ignored.
 */

/**
 * Features whose presence is decided by the RENDERER, not by anything a user
 * can set — so reporting them tells someone about a decision they did not
 * make and have no control to unmake.
 *
 * This is the one piece of curation in the feature, and it is the piece most
 * able to quietly turn into censorship, so the rule is narrow and each entry
 * has to earn its place against it: a feature belongs here only if NO
 * combination of Flock block properties removes it from the rendered email.
 * "Noisy" is not a qualification; "the user cannot act on it" is.
 *
 *   word-wrap, word-break     TextBlockView sets both as literals so an
 *                             unbroken run (a long URL, a pasted token) wraps
 *                             inside its block instead of overflowing. Outlook
 *                             and Yahoo ignore them, which is precisely the
 *                             degradation they were chosen for.
 *   target attribute          React Email's own Link and Button hardcode
 *                             `target="_blank"`; no Flock property exposes it.
 *                             caniemail's own note says these clients force
 *                             `target="_blank"` on every link anyway, so the
 *                             behaviour they "do not support" is the behaviour
 *                             they produce.
 *   text-decoration-line      Every link emits a `text-decoration` declaration
 *                             on BOTH branches of the underline toggle
 *                             (`underline` or `none`), so switching it off
 *                             does not remove the declaration.
 *   height property           ImageBlockView's `height: auto` (what keeps an
 *                             image on its aspect ratio) and SpacerBlockView's
 *                             explicit height (the entire point of a spacer).
 *                             Neither is optional if the block is to work.
 *   outline                   React Email's Img carries `outline: none` in its
 *                             own base style, beneath any Flock property.
 *
 * KNOWN COST, stated rather than hidden: suppression is by feature name, and
 * caniemail issues do not carry the declaration's value, so a user-set image
 * height is suppressed along with the renderer's `height: auto`. Reporting
 * `height` on every image of every email to keep that one case is the worse
 * trade.
 *
 * The list is PINNED, NOT TRUSTED: check-compatibility.test.ts renders a
 * document that exercises each of these paths with entirely default
 * properties and asserts it produces NO findings — an email nobody has styled
 * says nothing — while also asserting every entry here is genuinely produced
 * by that render, so a dead entry cannot sit here hiding a real finding.
 */
export const RENDERER_EMITTED_FEATURES: readonly string[] = [
  "word-wrap",
  "word-break",
  "target attribute",
  "text-decoration-line",
  "height property",
  "outline",
];

/** One aggregated problem: a feature, the block it affects, and where it breaks. */
export interface CompatibilityFinding {
  /** caniemail's name for the feature, e.g. "border-radius", "<video> element". */
  featureTitle: string;
  /**
   * The block whose markup carries it, or undefined when the markup belongs
   * to the document itself (`<html>`, `<head>`, `<body>`) rather than to any
   * block. Undefined is an honest answer and is surfaced as such — it is
   * never rounded to a nearby block.
   */
  blockId: string | undefined;
  /** The checked clients where the feature does not work at all. */
  affectedClients: CheckedEmailClient[];
  /** Those clients as human labels, for display. */
  affectedClientLabels: string[];
  /** caniemail's caveats for this feature on these clients, deduplicated. */
  notes: string[];
}

/** A check that ran. `findings` may be empty, which is the good outcome. */
export interface EmailCompatibilityReport {
  isChecked: true;
  findings: CompatibilityFinding[];
  /** Which clients were asked — the honest scope of a clean result. */
  checkedClients: readonly CheckedEmailClient[];
}

/** The email could not be rendered, so there was nothing to check. */
export interface EmailCompatibilityFailure {
  isChecked: false;
  /** Why. Written to be relayed to a person. */
  message: string;
}

export type EmailCompatibilityResult = EmailCompatibilityReport | EmailCompatibilityFailure;

export interface CheckEmailCompatibilityOptions {
  /** The document to check. Only read — checking never mutates it. */
  doc: EmailDocument;
  /**
   * Cap on how many findings come back, highest impact first. A user reading
   * a pre-send panel acts on the first few or none of them; an uncapped list
   * is a wall, and a wall is dismissed as a unit.
   */
  maxFindings?: number;
}

/** Default cap — see {@link CheckEmailCompatibilityOptions.maxFindings}. */
export const COMPATIBILITY_MAX_FINDINGS = 8;

/** Is this one of the clients {@link CHECKED_EMAIL_CLIENTS} asked about? */
function isCheckedEmailClient(client: string): client is CheckedEmailClient {
  return CHECKED_EMAIL_CLIENTS.some((checked) => checked === client);
}

interface FindingAccumulator {
  featureTitle: string;
  blockId: string | undefined;
  affectedClients: Set<CheckedEmailClient>;
  notes: Set<string>;
  /** Earliest position seen, so output order follows the email's own order. */
  startIndex: number;
}

/**
 * Run the check.
 *
 * TWO RENDERS, ONE DOCUMENT. The email is rendered here with block
 * annotation ON, which is not the render that gets sent — see
 * BLOCK_ANNOTATION_ATTRIBUTE. The annotated copy exists only inside this
 * function and is what every position in the result is relative to. The
 * attribute is inert to caniemail (its element and attribute checks are keyed
 * off the dataset, which has no `data-*` entry), so annotating changes which
 * BLOCK a finding names and never changes WHETHER there is a finding — a
 * property asserted in the tests rather than assumed here.
 *
 * ERRORS ONLY, NOT WARNINGS. caniemail separates "no support" from "partial
 * support", and partial is the ordinary condition of email CSS — the same
 * document that yields a couple of dozen errors yields several hundred
 * partial-support warnings, nearly all of them describing behaviour the user
 * already expects and cannot change. Reporting them would bury the handful of
 * declarations that genuinely do nothing in the client they are sent to.
 */
export async function checkEmailCompatibility({
  doc,
  maxFindings = COMPATIBILITY_MAX_FINDINGS,
}: CheckEmailCompatibilityOptions): Promise<EmailCompatibilityResult> {
  let html: string;
  try {
    html = await renderToHTML(doc, { isBlockAnnotated: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      isChecked: false,
      message: `The email could not be rendered, so it could not be checked: ${reason}`,
    };
  }

  const result = caniemail({ clients: [...CHECKED_EMAIL_CLIENTS], html });
  const ranges = indexBlockRanges(html);
  const accumulators = new Map<string, FindingAccumulator>();

  for (const [client, issues] of result.issues.errors) {
    /*
      caniemail keys its result map by its OWN full client union, not by the
      subset that was asked for. Narrowing through a guard rather than a cast
      keeps the impossible case (a client we never requested) explicitly
      dropped instead of silently relabelled.
    */
    if (!isCheckedEmailClient(client)) {
      continue;
    }
    for (const issue of issues) {
      if (RENDERER_EMITTED_FEATURES.includes(issue.title)) {
        continue;
      }
      const { startIndex, endIndex } =
        issue.position === undefined
          ? { startIndex: 0, endIndex: html.length }
          : toIndexRange({ html, start: issue.position.start, end: issue.position.end });
      const blockId = findBlockIdAt({ ranges, startIndex, endIndex });
      /*
        Grouped by FEATURE AND BLOCK, not by feature and position. caniemail
        reports the same feature once per client and once per element, so a
        button with a rounded corner arrives as several rows; a user sees one
        problem with one button. Two different buttons stay two findings,
        because the block is the thing they would act on.
      */
      const key = `${issue.title} ${blockId ?? ""}`;
      const existing = accumulators.get(key);
      const accumulator: FindingAccumulator = existing ?? {
        featureTitle: issue.title,
        blockId,
        affectedClients: new Set(),
        notes: new Set(),
        startIndex,
      };
      accumulator.affectedClients.add(client);
      for (const note of issue.notes) {
        accumulator.notes.add(note);
      }
      accumulator.startIndex = Math.min(accumulator.startIndex, startIndex);
      accumulators.set(key, accumulator);
    }
  }

  /*
    Ordered by breadth first — a feature broken in six clients matters more
    than one broken in a single mobile app — and by position within the email
    second, so equally-broad findings read top to bottom like the email does.
  */
  const findings = [...accumulators.values()]
    .sort(
      (left, right) =>
        right.affectedClients.size - left.affectedClients.size ||
        left.startIndex - right.startIndex ||
        left.featureTitle.localeCompare(right.featureTitle),
    )
    .slice(0, maxFindings)
    .map((accumulator) => {
      const affectedClients = [...accumulator.affectedClients].sort();
      return {
        featureTitle: accumulator.featureTitle,
        blockId: accumulator.blockId,
        affectedClients,
        affectedClientLabels: affectedClients.map((client) => CHECKED_EMAIL_CLIENT_LABELS[client]),
        notes: [...accumulator.notes],
      };
    });

  return { isChecked: true, findings, checkedClients: CHECKED_EMAIL_CLIENTS };
}
