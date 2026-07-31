"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronDownIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { setPersonaEnabled, useEnabledPersonaSlugs } from "@/lib/personas/enabled-personas";
import { parsePersonaMarkdown } from "@/lib/personas/parse-persona-markdown";
import { cn } from "@/lib/utils";

/**
 * Multi-agent canvas v0 — the persona picker: a dialog (opened from the
 * settings FAB's "Agents" entry) listing every registry persona with an
 * enable toggle. Enablement is browser-session-scoped localStorage
 * (enabled-personas.ts); enabled personas join the open document's facepile
 * and review settled edits (use-persona-advisors.ts).
 *
 * The persona's markdown renders READ-ONLY behind a disclosure — in-app
 * markdown editing (reshaping a persona's behavior, or copying a built-in
 * into a custom persona) is the v1 step (proposal §6 item 9).
 */

export interface PersonaPickerDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

export function PersonaPickerDialog({ isOpen, onOpenChange }: PersonaPickerDialogProps) {
  const personas = useQuery(api.personas.listPersonas, isOpen ? {} : "skip");
  const seedBuiltInPersonas = useMutation(api.personas.seedBuiltInPersonas);
  const enabledSlugs = useEnabledPersonaSlugs();

  // Idempotent built-in seed on first open (insert-if-missing; never overwrites).
  useEffect(() => {
    if (isOpen) {
      seedBuiltInPersonas({}).catch((error: unknown) => {
        console.error("[personas] built-in seed failed:", error);
      });
    }
  }, [isOpen, seedBuiltInPersonas]);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="persona-picker">
        <DialogHeader>
          <DialogTitle>Agents</DialogTitle>
          <DialogDescription>
            Advisory teammates that review your edits and leave suggestions. Enabled agents join
            the document&apos;s facepile while you work.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {personas === undefined ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Loading agents…</p>
          ) : personas.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No agents yet.</p>
          ) : (
            personas.map((persona) => (
              <PersonaRow
                key={persona.slug}
                persona={persona}
                isEnabled={enabledSlugs.includes(persona.slug)}
              />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface PersonaRowProps {
  persona: {
    slug: string;
    name: string;
    color: string;
    capabilityMode: "advisory";
    personaMarkdown: string;
    cooldownSeconds: number;
  };
  isEnabled: boolean;
}

function PersonaRow({ persona, isEnabled }: PersonaRowProps) {
  const [isMarkdownExpanded, setIsMarkdownExpanded] = useState(false);
  const parsed = parsePersonaMarkdown(persona.personaMarkdown);

  return (
    <div className="rounded-lg border px-3 py-2.5" data-testid={`persona-row-${persona.slug}`}>
      <div className="flex items-start gap-2.5">
        <span
          className="mt-1 size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: persona.color }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{persona.name}</p>
            <span className="rounded-full border px-1.5 py-px text-[10px] text-muted-foreground">
              {persona.capabilityMode}
            </span>
          </div>
          {parsed.description !== null && (
            <p className="mt-0.5 text-xs text-muted-foreground">{parsed.description}</p>
          )}
        </div>
        <PersonaToggle slug={persona.slug} name={persona.name} isEnabled={isEnabled} />
      </div>
      <button
        type="button"
        onClick={() => setIsMarkdownExpanded((current) => !current)}
        className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        aria-expanded={isMarkdownExpanded}
        data-testid={`persona-markdown-toggle-${persona.slug}`}
      >
        <ChevronDownIcon
          className={cn("size-3 transition-transform", isMarkdownExpanded && "rotate-180")}
        />
        {isMarkdownExpanded ? "Hide definition" : "View definition"}
      </button>
      {isMarkdownExpanded && (
        <pre className="mt-1.5 max-h-48 overflow-y-auto rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {persona.personaMarkdown}
        </pre>
      )}
    </div>
  );
}

/** A small switch (no shadcn switch in this repo — a minimal, accessible one). */
function PersonaToggle({
  slug,
  name,
  isEnabled,
}: {
  slug: string;
  name: string;
  isEnabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isEnabled}
      aria-label={`${isEnabled ? "Disable" : "Enable"} ${name}`}
      onClick={() => setPersonaEnabled({ slug, isEnabled: !isEnabled })}
      className={cn(
        "relative mt-0.5 h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
        isEnabled ? "bg-primary" : "bg-muted-foreground/25",
      )}
      data-testid={`persona-toggle-${slug}`}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform",
          isEnabled && "translate-x-4",
        )}
        aria-hidden
      />
    </button>
  );
}
