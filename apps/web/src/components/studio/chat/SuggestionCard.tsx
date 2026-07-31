"use client";

import { useState } from "react";
import { CheckIcon, SparklesIcon, Undo2Icon, XIcon } from "lucide-react";
import { usePersonaAdvisors, type PersonaCard } from "@/lib/personas/use-persona-advisors";
import { useSuggestions } from "@/lib/suggestions/use-suggestions";
import type { Suggestion, SuggestionRungId } from "@/lib/suggestions/types";
import { cn } from "@/lib/utils";

/**
 * The Phase 7.3 suggestion surface: one slim, dismissible card directly above
 * the composer. Deliberately quiet — muted colors, small type, no motion, and
 * it renders nothing at all when no suggestion is live (passive v1: it
 * appears after a settled user gesture and never interrupts).
 *
 * - Rung buttons apply that scope's pre-validated ops instantly.
 * - The confirm-gated rung (whole-email re-theme) swaps the card body to an
 *   inline confirm before anything is dispatched.
 * - After Apply the card shows a brief "Applied — Revert" state wired to the
 *   same history.revertBatch path as chat-turn revert chips (suggestions
 *   apply outside a chat turn, so the affordance lives here — see
 *   use-suggestions.ts), then clears on its own.
 *
 * Multi-agent canvas v0: persona ADVISORY findings (source:"analysis") render
 * here too — up to 3 quiet cards, each chipped with its persona's name and
 * color, stacked above the rule card. A finding with pre-validated ops gets
 * one-click Apply (same instant dispatch + revert path, `persona:<slug>`
 * provenance); a finding without ops is informational with dismiss only.
 * This component always mounts while the studio is open, so it is also the
 * host of {@link usePersonaAdvisors} — the hook that keeps enabled personas
 * on the facepile and fires the batched runner after settled user gestures.
 */
export interface SuggestionCardProps {
  /** Keeps the card's controls out of the tab order while the panel is collapsed. */
  isPanelExpanded: boolean;
}

const quietButtonClassName = cn(
  "inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11px]",
  "text-muted-foreground hover:bg-muted hover:text-foreground",
);

export function SuggestionCard({ isPanelExpanded }: SuggestionCardProps) {
  const { visibleSuggestion, appliedState, applyRung, dismiss, revertApplied } = useSuggestions();
  const personaAdvisors = usePersonaAdvisors();

  if (visibleSuggestion === null && appliedState === null && personaAdvisors.cards.length === 0) {
    return null;
  }
  const tabIndex = isPanelExpanded ? 0 : -1;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t px-3 py-2" data-testid="suggestion-card">
      {personaAdvisors.cards.map((card) => (
        <PersonaFindingCard
          key={card.suggestion.id}
          card={card}
          tabIndex={tabIndex}
          onApply={() => personaAdvisors.applySuggestion(card.suggestion.id)}
          onDismiss={() => personaAdvisors.dismissSuggestion(card.suggestion.id)}
          onRevert={() => personaAdvisors.revertApplied(card.suggestion.id)}
        />
      ))}
      {(visibleSuggestion !== null || appliedState !== null) && (
      <div className="rounded-lg border bg-muted/30 px-2.5 py-2">
        {appliedState !== null ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <p
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                data-testid="suggestion-applied"
              >
                Applied — {appliedState.rungLabel}
              </p>
              <button
                type="button"
                tabIndex={tabIndex}
                onClick={revertApplied}
                className={quietButtonClassName}
                data-testid="suggestion-revert"
              >
                <Undo2Icon className="size-3" />
                Revert
              </button>
            </div>
            {appliedState.revertErrorMessage !== null && (
              <p className="text-[11px] text-destructive">{appliedState.revertErrorMessage}</p>
            )}
          </div>
        ) : visibleSuggestion !== null ? (
          // Keyed by suggestion id so the inline confirm state resets whenever
          // a fresh suggestion replaces the current one.
          <SuggestionBody
            key={visibleSuggestion.id}
            suggestion={visibleSuggestion}
            tabIndex={tabIndex}
            applyRung={applyRung}
            dismiss={dismiss}
          />
        ) : null}
      </div>
      )}
    </div>
  );
}

/**
 * One persona finding: identity chip (persona color dot + name), title,
 * description, target hints, and either Apply+Dismiss (ops pre-validated by
 * the runner + re-dry-run at click time) or Dismiss only (informational).
 */
function PersonaFindingCard({
  card,
  tabIndex,
  onApply,
  onDismiss,
  onRevert,
}: {
  card: PersonaCard;
  tabIndex: number;
  onApply: () => void;
  onDismiss: () => void;
  onRevert: () => void;
}) {
  const { suggestion, appliedState } = card;
  return (
    <div
      className="rounded-lg border bg-muted/30 px-2.5 py-2"
      data-testid="persona-finding-card"
      data-persona-slug={suggestion.personaSlug}
    >
      {appliedState !== null ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <p
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              data-testid="persona-finding-applied"
            >
              Applied — {suggestion.personaName}&apos;s suggestion
            </p>
            <button
              type="button"
              tabIndex={tabIndex}
              onClick={onRevert}
              className={quietButtonClassName}
              data-testid="persona-finding-revert"
            >
              <Undo2Icon className="size-3" />
              Revert
            </button>
          </div>
          {appliedState.revertErrorMessage !== null && (
            <p className="text-[11px] text-destructive">{appliedState.revertErrorMessage}</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-start gap-2">
            <PersonaChip name={suggestion.personaName} color={suggestion.personaColor} />
            <button
              type="button"
              aria-label={`Dismiss ${suggestion.personaName} suggestion`}
              tabIndex={tabIndex}
              onClick={onDismiss}
              className="ml-auto cursor-pointer rounded-sm text-muted-foreground hover:text-foreground"
              data-testid="persona-finding-dismiss"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
          <p className="text-xs font-medium" data-testid="persona-finding-title">
            {suggestion.title}
          </p>
          <p className="text-[11px] text-muted-foreground" data-testid="persona-finding-description">
            {suggestion.description}
          </p>
          {suggestion.ops.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                type="button"
                tabIndex={tabIndex}
                onClick={onApply}
                className={quietButtonClassName}
                data-testid="persona-finding-apply"
              >
                <CheckIcon className="size-3" />
                Apply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The persona identity chip: color dot + name, quiet by design. */
function PersonaChip({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
      style={{ borderColor: color, color }}
      data-testid="persona-finding-chip"
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {name}
    </span>
  );
}

function SuggestionBody({
  suggestion,
  tabIndex,
  applyRung,
  dismiss,
}: {
  suggestion: Suggestion;
  tabIndex: number;
  applyRung: (rungId: SuggestionRungId) => void;
  dismiss: () => void;
}) {
  const [confirmingRungId, setConfirmingRungId] = useState<SuggestionRungId | null>(null);
  const confirmingRung =
    confirmingRungId !== null
      ? suggestion.rungs.find((rung) => rung.id === confirmingRungId)
      : undefined;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-xs font-medium" data-testid="suggestion-title">
          {suggestion.title}
        </p>
        <button
          type="button"
          aria-label="Dismiss suggestion"
          tabIndex={tabIndex}
          onClick={dismiss}
          className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground"
          data-testid="suggestion-dismiss"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      {confirmingRung !== undefined ? (
        <>
          <p className="pl-5.5 text-[11px] text-muted-foreground">
            {confirmingRung.confirmDescription}
          </p>
          <div className="flex flex-wrap gap-1.5 pl-5.5 pt-1">
            <button
              type="button"
              tabIndex={tabIndex}
              onClick={() => applyRung(confirmingRung.id)}
              className={cn(
                "inline-flex cursor-pointer items-center rounded-md bg-primary px-2 py-1",
                "text-[11px] text-primary-foreground hover:bg-primary/90",
              )}
              data-testid="suggestion-confirm-apply"
            >
              Re-theme the email
            </button>
            <button
              type="button"
              tabIndex={tabIndex}
              onClick={() => setConfirmingRungId(null)}
              className={quietButtonClassName}
              data-testid="suggestion-confirm-cancel"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="pl-5.5 text-[11px] text-muted-foreground" data-testid="suggestion-description">
            {suggestion.description}
          </p>
          <div className="flex flex-wrap gap-1.5 pl-5.5 pt-1">
            {suggestion.rungs.map((rung) => (
              <button
                key={rung.id}
                type="button"
                tabIndex={tabIndex}
                onClick={() =>
                  rung.needsConfirm === true ? setConfirmingRungId(rung.id) : applyRung(rung.id)
                }
                className={quietButtonClassName}
                data-testid={`suggestion-rung-${rung.id}`}
              >
                {rung.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
