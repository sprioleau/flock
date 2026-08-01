import type { Block, BlockId, EmailDocument, Operation } from "@flock/email-sdk";

/**
 * Proactive recommendations (Phase 7.3 v1) — shared types.
 *
 * The agent watches what the user does — the op log's settled `author:
 * "user"` entries, no new telemetry — and volunteers one quiet, dismissible
 * suggestion at a time in the chat area. Every suggestion carries its
 * operations PRE-COMPOSED and PRE-VALIDATED (dry-run via the SDK's pure
 * `applyOperations` against the current doc), so clicking Apply dispatches
 * the ready batch instantly with agent provenance — no model call on the
 * apply path, and the standard per-batch revert works.
 *
 * THE LLM-UPGRADE SEAM: v1 generation is fully deterministic — the
 * {@link SuggestionRule} registry detects patterns AND composes ops +
 * templated copy mechanically (`source: "rule"`). A later `kind: "analysis"`
 * agent call (plan §7.3) can produce this SAME {@link Suggestion} shape —
 * model-written copy + ops, tagged `source: "analysis"` — and flow through
 * the identical dry-run validation, staleness invalidation, card rendering,
 * dismissal bookkeeping, and apply/revert path. Nothing downstream of the
 * `Suggestion` type knows or cares how a suggestion was made.
 */

/** How a suggestion was produced. v1 only ever emits "rule" (see seam note above). */
export type SuggestionSource = "rule" | "analysis";

/** Ids of the v1 deterministic rules (the extensible registry in rules.ts). */
export type SuggestionRuleId = "repeated-property-edit" | "sibling-asymmetry";

/**
 * The escalation-ladder scopes, smallest to largest. "retheme" is the
 * whole-email rung and always gates behind an explicit confirm.
 */
export type SuggestionRungId = "section" | "email" | "retheme";

/** One rung of the escalation ladder: a label and its ready-to-dispatch ops. */
export interface SuggestionRung {
  id: SuggestionRungId;
  /** Button label. Names things ("the other 2 buttons"), never block ids. */
  label: string;
  /** Pre-composed ops, dispatched verbatim (and instantly) on Apply. */
  ops: Operation[];
  /** Largest-scope rungs require an explicit inline confirm before applying. */
  needsConfirm?: boolean;
  /** What the confirm step explains (required when needsConfirm is true). */
  confirmDescription?: string;
}

/** One suggestion: quiet card copy plus its pre-validated op ladder. */
export interface Suggestion {
  /** Unique per instance (a fresh id per generation). */
  id: string;
  ruleId: SuggestionRuleId;
  source: SuggestionSource;
  /**
   * Dismissal identity for this document: `${blockType}|${propertyKey}`.
   * Deliberately excludes the rule id — dismissing "match the buttons'
   * background color" quiets BOTH rules for that pattern on this doc.
   */
  patternKey: string;
  title: string;
  description: string;
  /** At least one non-gated rung is guaranteed (see rules.ts). */
  rungs: SuggestionRung[];
  /**
   * Every block this suggestion depends on: all rung target blocks, the
   * anchor block the pattern hangs off, and the root block when a re-theme
   * rung reads the current globals. Any change to one of these (including
   * deletion) invalidates the suggestion immediately.
   */
  targetBlockIds: BlockId[];
}

/**
 * Multi-agent canvas v0: one advisory persona FINDING, flowing through the
 * `source: "analysis"` seam this module reserved (see the header note —
 * nothing downstream cares how a suggestion was made). Structurally a
 * sibling of {@link Suggestion} rather than an extension of it: persona
 * findings carry an identity chip and a single pre-validated op batch
 * instead of the rules' escalation ladder, and an EMPTY `ops` array is legal
 * (a purely informational card with dismiss only). Everything else — dry-run
 * validation, target-snapshot staleness, patternKey dismissal bookkeeping,
 * apply-with-provenance + per-batch revert — is the exact same machinery
 * (use-persona-advisors.ts reuses it piece by piece).
 */
export interface PersonaSuggestion {
  /** Unique per instance (fresh id per runner response). */
  id: string;
  source: Extract<SuggestionSource, "analysis">;
  /** Persona identity for the card chip + apply provenance. */
  personaSlug: string;
  personaName: string;
  personaColor: string;
  /**
   * Dismissal identity: `persona:${personaSlug}|${sorted targetBlockIds}`.
   * Dismissing quiets THIS persona for THOSE blocks on this document
   * (shared localStorage bookkeeping with rule suggestions — the `persona:`
   * prefix keeps the key spaces disjoint).
   */
  patternKey: string;
  title: string;
  description: string;
  /** Visible content references ("the button labeled 'Buy now'") — never ids. */
  targetBlockNames: string[];
  /** Blocks the finding depends on; any change invalidates it (staleness). */
  targetBlockIds: BlockId[];
  /** Pre-composed, dry-run-validated ops. Empty = informational card. */
  ops: Operation[];
  /**
   * Main-agent handoff for op-less findings: a ready-to-send chat prompt in
   * the user's voice. The card's "Ask in chat" inserts it into the composer
   * (focused, editable — never auto-sent). Absent on findings with ops and
   * on rows recorded before the field existed (no CTA then).
   */
  suggestedPrompt?: string;
}

/** One settled user property edit, extracted from an op-log entry. */
export interface RecentPropertyEdit {
  blockId: BlockId;
  blockType: Block["type"];
  propertyKey: string;
  value: unknown;
  /** The op-log version of the entry this edit came from. */
  version: number;
  createdAtMs: number;
}

/** Everything a rule sees. `doc` is the CURRENT rendered document (overlay included). */
export interface SuggestionRuleContext {
  doc: EmailDocument;
  /** Suggestible user edits within the recency window, oldest → newest. */
  recentEdits: RecentPropertyEdit[];
  /** The edit whose settling triggered this evaluation (last of recentEdits). */
  anchorEdit: RecentPropertyEdit;
  isPatternDismissed: (patternKey: string) => boolean;
}

/** One registry entry: a cheap pattern detector that composes a full suggestion. */
export interface SuggestionRule {
  id: SuggestionRuleId;
  detect: (context: SuggestionRuleContext) => Suggestion | null;
}
