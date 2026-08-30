"use client";

import { Button } from "@/components/ui/button";
import { requestPersonaSweep, useIsPersonaSweepInFlight } from "@/lib/personas/persona-sweep";

/*
  "Check now" — the human's explicit trigger for a persona review of the
  document AS IS (persona-sweep.ts owns the semantics: bypasses cooldowns
  and the settled-edit trigger, works while paused, single batched call).
  One shared button for both placements: the facepile popover (that one
  persona) and the recommendations modal (all enabled personas).
*/
export function PersonaCheckNowButton({
  documentId,
  personaSlugs,
}: {
  documentId: string | null;
  personaSlugs: readonly string[];
}) {
  const isSweepInFlight = useIsPersonaSweepInFlight();
  const isDisabled = isSweepInFlight || documentId === null || personaSlugs.length === 0;
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="shrink-0"
      disabled={isDisabled}
      onClick={() => {
        if (documentId !== null) {
          void requestPersonaSweep({ documentId, personaSlugs });
        }
      }}
      data-testid="persona-check-now"
    >
      {isSweepInFlight ? "Checking…" : "Check now"}
    </Button>
  );
}
