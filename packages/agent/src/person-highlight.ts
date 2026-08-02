import { defineEmailAction, type AnalysisEmailAction } from "@flock/email-sdk";
import { z } from "zod";

/**
 * `fetchPersonHighlight` — the Phase 7.4(b) read-only person-profile tool
 * CONTRACT (case (b): a person profile link → a person-highlight section).
 *
 * Same split as fetchWebContent: this package owns the model-facing surface
 * (name, description, input schema, result payload) so the prompt layers and
 * the contract can never drift; the host app owns the network side — profile
 * fetch, extraction, the public-web search fan-out, and photo rehosting — and
 * INJECTS it via {@link definePersonHighlightAction}.
 *
 * Faithfulness contract (plan §7.4 — LAW), sharpened for people because the
 * subject is a human being:
 * - Every claim the model may write about the person arrives as a `fact` with
 *   its own `sourceUrl`. There is no unattributed prose in this payload.
 * - `searchStatus` tells the model exactly how wide the evidence is. When it
 *   is "unavailable" the ONLY evidence is the profile page itself, and the
 *   spotlight must not imply broader research happened.
 * - `photoUrl` is present only when the host could store a usable image; its
 *   absence means "no photo", never "invent one".
 * - `isOk: false` means the profile could not be read. Relay `message` and
 *   stop — a fabricated bio is the worst possible failure of this feature.
 */

// ---------------------------------------------------------------------------
// Input (what the model sends)
// ---------------------------------------------------------------------------

export const personHighlightInputSchema = z
  .strictObject({
    url: z
      .string()
      .min(1)
      .max(2048)
      .describe(
        "The full http(s) URL of the person's profile page (staff/faculty page, personal site, team bio), exactly as the user gave it.",
      ),
    personName: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "The person's name, if the user said it. Helps confirm the right profile was read and sharpens the public-info search.",
      ),
  })
  .describe("Input for fetchPersonHighlight: one public profile page for one person.");

export type PersonHighlightInput = z.infer<typeof personHighlightInputSchema>;

// ---------------------------------------------------------------------------
// Result payload (what the model gets back)
// ---------------------------------------------------------------------------

/** One attributable claim about the person. Never write one without its source. */
export interface PersonFact {
  /** The claim, in the source's own terms. */
  text: string;
  /** The page this claim came from — link here when you use it. */
  sourceUrl: string;
}

/** One page that was consulted. */
export interface PersonSource {
  title: string;
  url: string;
}

/** How much public information beyond the profile page was gathered. */
export type PersonSearchStatus = "searched" | "no_results" | "unavailable";

/** The bounded, fully-attributed person payload returned on a successful read. */
export interface PersonHighlightPayload {
  /** The person's name as the profile page gives it. */
  name: string;
  /** Their role/title line, when the page states one. */
  role?: string;
  /** The organization the profile belongs to, when identifiable. */
  organization?: string;
  /** Human-readable name of the profile's site. */
  sourceName: string;
  /** The profile's canonical URL — USE THIS for the attribution link. */
  profileUrl: string;
  /**
   * A usable photo of the person, already stored on our own servers. Absent
   * means no usable photo was found — say nothing about their appearance and
   * compose the section without an image.
   */
  photoUrl?: string;
  /** The page's own summary of the person, condensed. Absent when it has none. */
  bio?: string;
  /** Attributable claims — the ONLY facts you may state. */
  facts: PersonFact[];
  /** Every page consulted, profile first. */
  sources: PersonSource[];
  /**
   * "searched" — public web results were gathered and are in `facts`.
   * "no_results" — a search ran and found nothing usable.
   * "unavailable" — no search ran; the profile page is the only evidence.
   */
  searchStatus: PersonSearchStatus;
}

/**
 * Success carries the real profile; refusal carries a machine `reason` plus a
 * user-relayable `message` — the same two-state shape as fetchWebContent.
 */
export type PersonHighlightResult =
  | { isOk: true; person: PersonHighlightPayload }
  | { isOk: false; reason: string; message: string };

/** The injected implementation: guarded profile fetch + extraction + search. */
export type FetchPersonHighlightFn = (input: {
  url: string;
  personName?: string;
}) => Promise<PersonHighlightResult>;

// ---------------------------------------------------------------------------
// Action definition (executor injected by the host app)
// ---------------------------------------------------------------------------

/**
 * Define the `fetchPersonHighlight` analysis action around a host-provided
 * profile-research implementation. Read-only by construction: it never
 * touches the document (the `doc` argument is ignored).
 */
export function definePersonHighlightAction({
  fetchPersonHighlight,
}: {
  fetchPersonHighlight: FetchPersonHighlightFn;
}): AnalysisEmailAction<typeof personHighlightInputSchema, Promise<PersonHighlightResult>> {
  return defineEmailAction({
    name: "fetchPersonHighlight",
    description:
      "Research ONE person from the profile page the user linked: fetch the page server-side, extract who they are (name, role, organization, bio, photo), and gather public information about them. Returns attributable facts — every one carrying the source it came from — plus the list of pages consulted. Read-only; the document is unchanged. Call it BEFORE writing anything about a person the user linked. If the result has isOk: false the profile could not be read: tell the user why, make no edits, and never guess at who they are.",
    kind: "analysis",
    schema: personHighlightInputSchema,
    readOnly: true,
    parallelSafe: true,
    needsApproval: false,
    run: (_doc, input): Promise<PersonHighlightResult> =>
      fetchPersonHighlight({
        url: input.url,
        ...(input.personName === undefined ? {} : { personName: input.personName }),
      }),
  });
}
