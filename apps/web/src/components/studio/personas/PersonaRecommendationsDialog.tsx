"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEditorStore } from "@/lib/editor-store";
import { useEnabledPersonaSlugs } from "@/lib/personas/enabled-personas";
import { getOrCreateSessionId } from "@/lib/session";
import { cn } from "@/lib/utils";
import { PersonaCheckNowButton } from "./PersonaCheckNowButton";
import { getRecommendationOutcome } from "./recommendation-outcome";

/**
 * Persona presence UX — the recommendations-history modal: EVERY
 * recommendation the enabled agents have made for this document, newest
 * first, each labeled with what happened to it (Pending / Applied /
 * Dismissed for actionable ones; Informational for advice that carries no
 * ops). Tabs are one per REGISTRY persona plus "All" — derived from
 * personas.listPersonas, never hardcoded slugs (personas are pure data; the
 * marketplace invariant).
 *
 * Reached two ways: clicking a persona's avatar in the facepile opens it
 * PRE-FILTERED to that persona (initialPersonaSlug), and the history button
 * beside the AI-collaborators button opens it on "All".
 *
 * Data is the reactive personaFindings.listFindingsForDocument feed, so a
 * dismissal or apply in any tab (cards, another collaborator, this modal)
 * updates every open modal live. The per-row Dismiss action reuses the SAME
 * dismissFinding mutation the suggestion cards call — no new write path.
 */

type FindingHistoryRow = FunctionReturnType<
  typeof api.personaFindings.listFindingsForDocument
>[number];

export interface PersonaRecommendationsDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Pre-filter to one persona (facepile avatar click); null opens on "All". */
  initialPersonaSlug: string | null;
}

export function PersonaRecommendationsDialog({
  isOpen,
  onOpenChange,
  initialPersonaSlug,
}: PersonaRecommendationsDialogProps) {
  const documentId = useEditorStore((state) => state.documentId);
  const enabledSlugs = useEnabledPersonaSlugs();
  // Session id read only while open (a user gesture opened us — never SSR).
  const sessionId = isOpen ? getOrCreateSessionId() : null;

  const personas = useQuery(
    api.personas.listPersonas,
    isOpen && sessionId !== null ? { sessionId } : "skip",
  );
  const findingRows = useQuery(
    api.personaFindings.listFindingsForDocument,
    isOpen && documentId !== null ? { documentId } : "skip",
  );

  // The selected tab (null = All), re-seeded from the entry point each time
  // the dialog OPENS (render-time adjustment on the isOpen edge).
  const [selectedSlug, setSelectedSlug] = useState<string | null>(initialPersonaSlug);
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setSelectedSlug(initialPersonaSlug);
    }
  }

  const visibleRows = (findingRows ?? []).filter(
    (row) => selectedSlug === null || row.personaSlug === selectedSlug,
  );

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="persona-recommendations">
        <DialogHeader>
          <DialogTitle>Recommendations</DialogTitle>
          <DialogDescription>
            Everything your agents have suggested for this email, newest first, with what
            happened to each suggestion.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start justify-between gap-2">
          <div
            className="flex min-w-0 flex-wrap items-center gap-1.5"
            role="tablist"
            aria-label="Filter by agent"
          >
            <RecommendationsTab
              label="All"
              isSelected={selectedSlug === null}
              onSelect={() => setSelectedSlug(null)}
              testId="recommendations-tab-all"
            />
            {(personas ?? []).map((persona) => (
              <RecommendationsTab
                key={persona.slug}
                label={persona.name}
                color={persona.color}
                isSelected={selectedSlug === persona.slug}
                isInactive={!enabledSlugs.includes(persona.slug)}
                onSelect={() => setSelectedSlug(persona.slug)}
                testId={`recommendations-tab-${persona.slug.replaceAll("/", "-")}`}
              />
            ))}
          </div>
          {/* Sweep-all "Check now" (owner ask): every ENABLED agent reviews
              the document as it is, right now — hidden when nothing is
              enabled (history stays readable regardless). */}
          {enabledSlugs.length > 0 && (
            <PersonaCheckNowButton documentId={documentId} personaSlugs={enabledSlugs} />
          )}
        </div>
        {/* FIXED height (owner ask): tab switches change the list contents,
            never the modal dimensions — the list is the scrollable region. */}
        <div className="flex h-[55vh] max-h-[560px] flex-col gap-2 overflow-y-auto">
          {findingRows === undefined ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Loading recommendations…
            </p>
          ) : visibleRows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No recommendations here yet — they appear as agents review your edits.
            </p>
          ) : (
            visibleRows.map((row) => <RecommendationRow key={row.findingId} row={row} />)
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RecommendationsTab({
  label,
  color,
  isSelected,
  isInactive = false,
  onSelect,
  testId,
}: {
  label: string;
  color?: string;
  isSelected: boolean;
  /** Registry persona that isn't currently enabled — history stays browsable. */
  isInactive?: boolean;
  onSelect: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isSelected}
      onClick={onSelect}
      title={isInactive ? `${label} isn't currently enabled — its history is still here.` : undefined}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        isSelected
          ? "border-foreground/20 bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground",
        isInactive && !isSelected && "opacity-60",
      )}
      data-testid={testId}
      data-inactive={isInactive || undefined}
    >
      {color !== undefined && (
        <span
          className={cn("size-2 shrink-0 rounded-full", isInactive && "opacity-60")}
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}
      {label}
    </button>
  );
}

/** Coarse, user-facing recency ("just now", "5 minutes ago", "2 hours ago"). */
export function formatRelativeTime({ atMs, nowMs }: { atMs: number; nowMs: number }): string {
  const elapsedMs = Math.max(0, nowMs - atMs);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) {
    return "just now";
  }
  if (elapsedMinutes < 60) {
    return elapsedMinutes === 1 ? "1 minute ago" : `${elapsedMinutes} minutes ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return elapsedHours === 1 ? "1 hour ago" : `${elapsedHours} hours ago`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  return elapsedDays === 1 ? "1 day ago" : `${elapsedDays} days ago`;
}

function RecommendationRow({ row }: { row: FindingHistoryRow }) {
  const dismissFinding = useMutation(api.personaFindings.dismissFinding);
  // Recency is captured at row mount (dialog open) — purity over ticking.
  const [mountedAtMs] = useState(() => Date.now());
  const outcome = getRecommendationOutcome(row);
  return (
    <div
      className="rounded-lg border px-3 py-2.5"
      data-testid="recommendation-row"
      data-finding-status={row.status}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="mt-1 size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: row.personaColor }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <p className="text-sm font-medium">{row.title}</p>
            <span
              className={cn("rounded-full border px-1.5 py-px text-[10px]", outcome.className)}
              data-testid="recommendation-status"
            >
              {outcome.label}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{row.description}</p>
          <p className="mt-1 text-[11px] text-muted-foreground/80">
            {row.personaName}
            {row.targetBlockNames.length > 0 && <> · {row.targetBlockNames.join(", ")}</>}
            {" · "}
            {formatRelativeTime({ atMs: row.createdAtMs, nowMs: mountedAtMs })}
          </p>
        </div>
        {row.status === "open" && row.isActionable && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 text-muted-foreground"
            onClick={() => {
              // The cards' exact dismissal write path — every tab converges.
              dismissFinding({ findingId: row.findingId }).catch((error: unknown) => {
                console.warn("[personas] dismissFinding from history failed", error);
              });
            }}
            data-testid="recommendation-dismiss"
          >
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}
