"use client";

import { useState } from "react";
import { BotIcon, BotOffIcon, HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useArePersonasPaused } from "@/lib/personas/enabled-personas";
import { PersonaPickerDialog } from "./PersonaPickerDialog";
import { PersonaRecommendationsDialog } from "./PersonaRecommendationsDialog";

/**
 * First-class entry point for the AI collaborators (owner decision: personas
 * are collaborators, not a debug setting — this moved OUT of the settings
 * FAB). Renders next to the presence facepile in the studio header, so
 * "who's here" and "add an AI teammate" read as one cluster; opens the
 * agent collaborators modal (PersonaPickerDialog). The history button beside
 * it opens the recommendations-history modal on its "All" tab (the same
 * modal a persona avatar click opens pre-filtered).
 */
export function AgentCollaboratorsButton() {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isRecommendationsOpen, setIsRecommendationsOpen] = useState(false);
  // Paused recommendations (credit conservation) read at the entry point:
  // a slashed, dimmed bot with an explanatory tooltip — the pause/resume
  // control itself lives in the modal's header.
  const arePersonasPaused = useArePersonasPaused();

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  arePersonasPaused ? "AI collaborators (recommendations paused)" : "AI collaborators"
                }
                onClick={() => setIsPickerOpen(true)}
                className={arePersonasPaused ? "text-muted-foreground opacity-60" : undefined}
                data-testid="agent-collaborators-button"
                data-paused={arePersonasPaused || undefined}
              />
            }
          >
            {arePersonasPaused ? <BotOffIcon /> : <BotIcon />}
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {arePersonasPaused ? "Recommendations paused" : "AI collaborators"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Recommendation history"
                onClick={() => setIsRecommendationsOpen(true)}
                data-testid="recommendations-history-button"
              />
            }
          >
            <HistoryIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">Recommendation history</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PersonaPickerDialog isOpen={isPickerOpen} onOpenChange={setIsPickerOpen} />
      <PersonaRecommendationsDialog
        isOpen={isRecommendationsOpen}
        onOpenChange={setIsRecommendationsOpen}
        initialPersonaSlug={null}
      />
    </>
  );
}
