/*
  `@flock/email-sdk/qa` — the deterministic, zero-model pre-send checks.

  A SUBPATH AND NOT THE MAIN BARREL, deliberately. `@flock/email-sdk` is
  imported by well over a hundred CLIENT modules in apps/web, and this entry
  pulls in the caniemail dataset (~1.5MB of feature-support data plus an HTML
  and a CSS parser). Exporting it from `src/index.ts` would put all of that
  into the studio's browser bundle to support a check that only ever runs on
  a server. The subpath keeps the cost where the capability is.
*/
export {
  checkEmailCompatibility,
  COMPATIBILITY_MAX_FINDINGS,
  RENDERER_EMITTED_FEATURES,
} from "./check-compatibility";
export type {
  CheckEmailCompatibilityOptions,
  CompatibilityFinding,
  EmailCompatibilityFailure,
  EmailCompatibilityReport,
  EmailCompatibilityResult,
} from "./check-compatibility";
export {
  CHECKED_EMAIL_CLIENTS,
  CHECKED_EMAIL_CLIENT_LABELS,
  findClientsWithIncompleteData,
} from "./supported-clients";
export type { CheckedEmailClient } from "./supported-clients";
export { findBlockIdAt, indexBlockRanges, toIndexRange } from "./block-ranges";
export type { BlockRange } from "./block-ranges";
