import { fetchTextResource } from "../brand-kit-extraction/fetch-page";

/**
 * robots.txt compliance for the Phase 7.4 ingestion pipeline.
 *
 * The plan's faithfulness rules name robots.txt alongside paywalls and blocks
 * as a reason a page CANNOT be read — and the required behavior is identical:
 * say so and stop, never invent content. So the check happens BEFORE the page
 * fetch, and a disallowed path never reaches the network.
 *
 * Scope (deliberately small, honest about it):
 * - Only `User-agent` / `Disallow` / `Allow` are interpreted. Crawl-delay,
 *   sitemaps, and wildcards-in-user-agent-names are ignored.
 * - Our own group (FLOCK_USER_AGENT_TOKEN) wins over the `*` group, matching
 *   the standard's "most specific group" rule.
 * - Longest-match-wins between Allow and Disallow (the widely-implemented
 *   Google/Bing precedence), with Allow winning ties.
 * - `*` and `$` in paths are supported; everything else is a literal prefix.
 *
 * Fail-open on fetch failure is the correct default here and is what every
 * mainstream crawler does: a missing or unreachable robots.txt means "no
 * stated restrictions". A robots.txt that we DID read and that disallows the
 * path is a hard stop.
 */

/** The product token this app identifies itself with in robots.txt groups. */
export const FLOCK_USER_AGENT_TOKEN = "flock";

/** robots.txt bodies bigger than this are ignored (fail-open). */
const MAX_ROBOTS_BYTES = 128 * 1024;

const ROBOTS_TIMEOUT_MS = 5_000;

/** How long a fetched robots.txt stays usable in this server process. */
const ROBOTS_CACHE_TTL_MS = 10 * 60 * 1000;

interface RobotsRule {
  /** True for Allow, false for Disallow. */
  isAllowRule: boolean;
  /** The raw path pattern, `*`/`$` included. */
  pattern: string;
}

interface RobotsGroups {
  /** Rules for our own product token, when the file names it. */
  flockRules: RobotsRule[] | null;
  /** Rules for the catch-all `*` group, when the file has one. */
  wildcardRules: RobotsRule[] | null;
}

interface CachedRobots {
  groups: RobotsGroups;
  fetchedAtMs: number;
}

const robotsCacheByOrigin = new Map<string, CachedRobots>();

/** Drop every cached robots.txt (tests; not used at runtime). */
export function clearRobotsCache(): void {
  robotsCacheByOrigin.clear();
}

/**
 * Parse a robots.txt body into the two groups we care about. Consecutive
 * `User-agent` lines share one rule block, per the standard.
 */
export function parseRobotsTxt(body: string): RobotsGroups {
  const groups: RobotsGroups = { flockRules: null, wildcardRules: null };
  /** Agents named by the User-agent lines immediately preceding current rules. */
  let activeAgents: string[] = [];
  let isCollectingAgents = false;

  const appendRule = (rule: RobotsRule): void => {
    for (const agent of activeAgents) {
      if (agent === "*") {
        groups.wildcardRules = [...(groups.wildcardRules ?? []), rule];
      } else if (agent === FLOCK_USER_AGENT_TOKEN) {
        groups.flockRules = [...(groups.flockRules ?? []), rule];
      }
    }
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (line.length === 0) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }
    const field = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (field === "user-agent") {
      const agent = value.toLowerCase();
      if (!isCollectingAgents) {
        activeAgents = [];
        isCollectingAgents = true;
      }
      activeAgents.push(agent);
      // An empty group (User-agent with no rules) still needs to exist so a
      // later "most specific group wins" lookup sees it.
      if (agent === "*") {
        groups.wildcardRules = groups.wildcardRules ?? [];
      } else if (agent === FLOCK_USER_AGENT_TOKEN) {
        groups.flockRules = groups.flockRules ?? [];
      }
      continue;
    }
    isCollectingAgents = false;
    if (activeAgents.length === 0) {
      continue; // rules before any User-agent line are not addressed to anyone
    }
    if (field === "disallow") {
      // "Disallow:" with an empty value means "nothing is disallowed" — it is
      // a rule that matches nothing, so it is simply not recorded.
      if (value.length > 0) {
        appendRule({ isAllowRule: false, pattern: value });
      }
    } else if (field === "allow" && value.length > 0) {
      appendRule({ isAllowRule: true, pattern: value });
    }
  }
  return groups;
}

/** Turn a robots path pattern (`*` wildcards, `$` end-anchor) into a regex. */
function toPatternRegExp(pattern: string): RegExp {
  const hasEndAnchor = pattern.endsWith("$");
  const body = hasEndAnchor ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${hasEndAnchor ? "$" : ""}`);
}

/** Length of the matched pattern, or -1 when the rule does not apply. */
function matchLength({ rule, path }: { rule: RobotsRule; path: string }): number {
  return toPatternRegExp(rule.pattern).test(path) ? rule.pattern.length : -1;
}

/**
 * Evaluate a parsed robots.txt against one path. Longest match wins; Allow
 * wins ties; no matching rule means allowed.
 */
export function isPathAllowedByRules({
  groups,
  path,
}: {
  groups: RobotsGroups;
  path: string;
}): boolean {
  const rules = groups.flockRules ?? groups.wildcardRules;
  if (rules === null || rules.length === 0) {
    return true;
  }
  let bestAllowLength = -1;
  let bestDisallowLength = -1;
  for (const rule of rules) {
    const length = matchLength({ rule, path });
    if (length < 0) {
      continue;
    }
    if (rule.isAllowRule) {
      bestAllowLength = Math.max(bestAllowLength, length);
    } else {
      bestDisallowLength = Math.max(bestDisallowLength, length);
    }
  }
  return bestAllowLength >= bestDisallowLength;
}

/**
 * Check whether robots.txt lets us fetch `rawUrl`. Fails OPEN — an
 * unreachable, oversized, or unparseable robots.txt is treated as "no stated
 * restrictions" — and fails CLOSED only on an explicit Disallow.
 */
export async function isFetchAllowedByRobots(rawUrl: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return true; // malformed URLs are the URL guard's business, not ours
  }
  const { origin } = target;
  const cached = robotsCacheByOrigin.get(origin);
  const isCacheFresh = cached !== undefined && Date.now() - cached.fetchedAtMs < ROBOTS_CACHE_TTL_MS;
  let groups: RobotsGroups;
  if (isCacheFresh) {
    groups = cached.groups;
  } else {
    const body = await fetchTextResource({
      url: `${origin}/robots.txt`,
      timeoutMs: ROBOTS_TIMEOUT_MS,
      maxBytes: MAX_ROBOTS_BYTES,
    });
    groups = body === null ? { flockRules: null, wildcardRules: null } : parseRobotsTxt(body);
    robotsCacheByOrigin.set(origin, { groups, fetchedAtMs: Date.now() });
  }
  return isPathAllowedByRules({ groups, path: `${target.pathname}${target.search}` });
}
