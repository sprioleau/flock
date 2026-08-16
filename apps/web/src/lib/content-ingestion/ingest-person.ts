import type {
  PersonFact,
  PersonHighlightPayload,
  PersonHighlightResult,
  PersonSource,
} from "@flock/agent";
import { fetchPage, type FetchFailureReason } from "../brand-kit-extraction/fetch-page";
import { extractPerson } from "./extract-person";
import { rehostImageToStorage } from "./rehost-image";
import { isFetchAllowedByRobots } from "./robots";
import { searchPublicWeb } from "./search-web";

/**
 * The Phase 7.4(b) person pipeline: ONE public profile URL in, an attributed
 * person payload out — or an honest refusal.
 *
 * Stages mirror the article pipeline, plus the search fan-out the plan calls
 * for:
 *   1. robots.txt   — the site's own rules decide whether we may read it.
 *   2. fetchPage    — the shared SSRF-guarded fetch primitive.
 *   3. extractPerson — pure extraction: name, role, organization, bio, photo,
 *                     and the page's own paragraphs as attributed facts.
 *   4. searchPublicWeb — public-web claims, each bound to the page that says
 *                     it. Off unless explicitly enabled (see search-web.ts);
 *                     when off, `searchStatus: "unavailable"` tells the model
 *                     the profile page is the only evidence it has.
 *   5. photo rehost — the portrait is copied into Convex storage. Fail-soft:
 *                     no photo beats a broken one, and beats a made-up one.
 *
 * The payload has no unattributed prose in it: `facts` each carry a
 * `sourceUrl`, and `sources` lists every page consulted. That is what makes
 * "never paraphrase into fabrication" checkable rather than aspirational.
 */

/** Profile-mode overrides for fetch failures whose stock copy is brand-kit-flavored. */
const PROFILE_FAILURE_MESSAGES: Partial<Record<FetchFailureReason, string>> = {
  blocked_by_site:
    "That site wouldn't let the profile be read (it blocks automated access — many professional networks do). Nothing was invented in its place; try a public bio page, or tell us what to say about them.",
  /*
    Same split as article mode: blocked_by_site can still be escaped by
    another page on that host, an origin-wide bot check cannot — so this one
    must not send the user back to the same site for a different bio page.
  */
  blocked_by_bot_challenge:
    "That site blocks automated readers, so no page on it can be read — another page there won't get through either. Nothing was invented in its place; tell us what you'd like the spotlight to say.",
  not_html:
    "That address isn't a readable web page. Try a direct link to the person's profile or bio page.",
};

/** The refusal returned when the site's robots.txt disallows the profile path. */
export const PERSON_ROBOTS_REFUSAL: PersonHighlightResult = {
  isOk: false,
  reason: "blocked_by_robots",
  message:
    "That site's robots.txt asks automated readers to stay off that profile, so it wasn't fetched. Nothing was made up in its place — try a page the site allows, or tell us what you'd like the spotlight to say.",
};

/** Cap on total facts handed to the model (page + search). */
const MAX_FACTS = 10;

export interface IngestPersonInput {
  /** The profile page to read. */
  url: string;
  /** The person's name, when the user said it. */
  personName?: string;
  /** Session that should own a rehosted portrait. */
  sessionId?: string | null;
  /** False skips the photo rehost and drops the image (unit tests). */
  shouldRehostPhoto?: boolean;
  /** True when running against the deterministic mock tier — never searches. */
  isMockRun?: boolean;
}

/**
 * Research one person from their profile page — or refuse honestly. This is
 * the fetchPersonHighlight tool's executor and the POST /api/ingest person
 * path; both share this exact behavior.
 */
export async function ingestPerson({
  url,
  personName,
  sessionId = null,
  shouldRehostPhoto = true,
  isMockRun = false,
}: IngestPersonInput): Promise<PersonHighlightResult> {
  if (!(await isFetchAllowedByRobots(url))) {
    return PERSON_ROBOTS_REFUSAL;
  }
  const page = await fetchPage(url);
  if (!page.isOk) {
    return {
      isOk: false,
      reason: page.reason,
      message: PROFILE_FAILURE_MESSAGES[page.reason] ?? page.message,
    };
  }
  const extracted = extractPerson({
    html: page.html,
    finalUrl: page.finalUrl,
    ...(personName === undefined ? {} : { personName }),
  });
  if (!extracted.isOk) {
    return extracted;
  }
  const { person } = extracted;

  const sources: PersonSource[] = [{ title: person.sourceName, url: person.profileUrl }];
  const facts: PersonFact[] = person.facts.map(({ text, sourceUrl }) => ({ text, sourceUrl }));

  // Search fan-out: attributed public claims, or an honest "we didn't look".
  const searchSubject = [person.name, person.role, person.organization ?? person.sourceName]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(", ");
  const search = await searchPublicWeb({ query: searchSubject, isMockRun });
  if (search.status === "searched") {
    for (const claim of search.claims) {
      facts.push({ text: claim.text, sourceUrl: claim.sourceUrl });
    }
    for (const source of search.sources) {
      if (!sources.some((existing) => existing.url === source.url)) {
        sources.push(source);
      }
    }
  }

  const photoUrl =
    person.photoSourceUrl === undefined || !shouldRehostPhoto
      ? null
      : await rehostImageToStorage({
          imageUrl: person.photoSourceUrl,
          sessionId,
          name: person.name,
          sourceUrl: person.profileUrl,
        });

  const payload: PersonHighlightPayload = {
    name: person.name,
    ...(person.role === undefined ? {} : { role: person.role }),
    ...(person.organization === undefined ? {} : { organization: person.organization }),
    sourceName: person.sourceName,
    profileUrl: person.profileUrl,
    ...(photoUrl === null ? {} : { photoUrl }),
    ...(person.bio === undefined ? {} : { bio: person.bio }),
    facts: facts.slice(0, MAX_FACTS),
    sources,
    searchStatus: search.status,
  };
  return { isOk: true, person: payload };
}

/**
 * The session-less adapter injected into the agent action registry (a
 * module-level singleton, so it cannot close over a request's session). The
 * chat route fulfills the tool host-side with the caller's session — see
 * app/api/chat/tools.ts.
 */
export async function fetchPersonHighlight(input: {
  url: string;
  personName?: string;
}): Promise<PersonHighlightResult> {
  return ingestPerson(input);
}
