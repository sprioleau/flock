"use client";

import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { useQuery } from "convex/react";
import { SparklesIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import { PersonaCheckNowButton } from "@/components/studio/personas/PersonaCheckNowButton";
import { PersonaRecommendationsDialog } from "@/components/studio/personas/PersonaRecommendationsDialog";
import { getRecommendationOutcome } from "@/components/studio/personas/recommendation-outcome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditorStore } from "@/lib/editor-store";
import { useArePersonasPaused } from "@/lib/personas/enabled-personas";
import { buildNextCheckLabel, usePersonaLastRunAtMs } from "@/lib/personas/persona-run-clock";
import {
  useOptionalPresenceRoster,
  useSetNickname,
  type PresenceData,
  type PresenceRosterEntry,
} from "@/lib/presence";
import { cn } from "@/lib/utils";
import { AgentAvatarPentagon } from "./AgentAvatarPentagon";
import { extractPersonaSlugFromPresenceUserId } from "./persona-cursor-helpers";

/**
 * Phase 6.2a topbar facepile, persona-presence UX overhaul (2026-07-31):
 * one avatar per ONLINE room member (self first — the presence component
 * orders it that way). SHAPE ENCODES KIND: humans are circles; non-human
 * collaborators — advisory personas and the chat agent — are rounded
 * point-up PENTAGONS (AgentAvatarPentagon), so concurrent agent vs human
 * collaborators are instantly distinguishable.
 *
 * Interactions: hovering a PERSONA avatar opens a hover card with its
 * user-facing next-check line ("Checks again in about 30 seconds",
 * "Checking now…", "Paused", "Waiting for changes") and its recent
 * recommendations; CLICKING it opens the recommendations-history modal
 * pre-filtered to that persona. Humans keep the name tooltip; clicking YOUR
 * OWN avatar still opens the nickname editor.
 *
 * Renders nothing when no document/presence room is open.
 */
export function PresenceFacepile() {
  const roster = useOptionalPresenceRoster();
  // The recommendations modal opened from a persona avatar (pre-filtered).
  const [recommendationsSlug, setRecommendationsSlug] = useState<string | null>(null);
  const [isRecommendationsOpen, setIsRecommendationsOpen] = useState(false);
  if (roster === null) {
    return null;
  }
  const onlineMembers = roster.filter((entry) => entry.isOnline);
  if (onlineMembers.length === 0) {
    return null;
  }
  const openRecommendationsForSlug = (slug: string): void => {
    setRecommendationsSlug(slug);
    setIsRecommendationsOpen(true);
  };
  return (
    <TooltipProvider>
      {/* ONE flex root (avatar stack + divider side by side) so the facepile
          behaves in any parent — the toolbar wraps it in a plain
          overflow-hidden slot, where two sibling divs would stack vertically
          and break the row's centering. */}
      <div className="flex items-center">
        <div className="flex items-center -space-x-1.5" data-testid="presence-facepile">
          {onlineMembers.map((entry) =>
            entry.isSelf ? (
              <SelfAvatar key={entry.userId} entry={entry} />
            ) : isPersonaEntry(entry) ? (
              <PersonaAvatar
                key={entry.userId}
                entry={entry}
                onOpenRecommendations={openRecommendationsForSlug}
              />
            ) : (
              <MemberAvatar key={entry.userId} entry={entry} />
            ),
          )}
        </div>
        <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
      </div>
      <PersonaRecommendationsDialog
        isOpen={isRecommendationsOpen}
        onOpenChange={setIsRecommendationsOpen}
        initialPersonaSlug={recommendationsSlug}
      />
    </TooltipProvider>
  );
}

/** Shared avatar box: 24px, glyph typography; shape classes layer on top. */
const AVATAR_BASE_CLASSES =
  "relative flex size-6 shrink-0 items-center justify-center text-[10px] font-semibold text-white select-none";

/** Humans: the classic colored circle with a background ring. */
const HUMAN_AVATAR_CLASSES = cn(AVATAR_BASE_CLASSES, "rounded-full ring-2 ring-background");

/**
 * Agents/personas: no CSS shape — the AgentAvatarPentagon SVG (first child)
 * draws both the background-ring pentagon and the colored one.
 */
const AGENT_AVATAR_CLASSES = AVATAR_BASE_CLASSES;

/** Persona roster members (multi-agent canvas v0) carry this userId prefix. */
const isPersonaEntry = (entry: PresenceRosterEntry): boolean =>
  entry.userId.startsWith("persona:");

function AvatarGlyph({ entry }: { entry: PresenceRosterEntry }) {
  if (isPersonaEntry(entry)) {
    // Personas show their initial like humans — their identity is a NAME, not
    // "the agent" — the pentagon shape and status dot mark them as non-human.
    return <>{entry.data.name.charAt(0).toUpperCase()}</>;
  }
  if (entry.data.isAgent === true) {
    return <SparklesIcon className="size-3" aria-hidden />;
  }
  return <>{entry.data.name.charAt(0).toUpperCase()}</>;
}

function memberLabel(entry: PresenceRosterEntry): string {
  if (isPersonaEntry(entry)) {
    const status = entry.data.status;
    return `${entry.data.name} (AI persona)${status !== undefined ? ` — ${status}` : ""}`;
  }
  if (entry.data.isAgent === true) {
    return `${entry.data.name} (AI agent)`;
  }
  return entry.isSelf ? `${entry.data.name} (you)` : entry.data.name;
}

/**
 * The persona's live lifecycle dot (bottom-right of the avatar): gray when
 * idle, amber while reading (context assembly), pulsing violet while its
 * analysis call is in flight. Statuses are written server-side on real state
 * transitions (convex/personas.ts setPersonaStatus).
 */
function PersonaStatusDot({ status }: { status: "idle" | "reading" | "thinking" | undefined }) {
  return (
    <span
      className={cn(
        "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-background",
        status === "thinking" && "animate-pulse bg-violet-500",
        status === "reading" && "animate-pulse bg-amber-500",
        (status === "idle" || status === undefined) && "bg-muted-foreground/50",
      )}
      data-testid="persona-status-dot"
      data-status={status ?? "idle"}
      aria-hidden
    />
  );
}

/** A remote HUMAN or the chat agent: shape-coded avatar + name tooltip. */
function MemberAvatar({ entry }: { entry: PresenceRosterEntry }) {
  const isAgentShaped = entry.data.isAgent === true;
  return (
    <Tooltip>
      <TooltipTrigger
        className={isAgentShaped ? AGENT_AVATAR_CLASSES : HUMAN_AVATAR_CLASSES}
        style={isAgentShaped ? undefined : { backgroundColor: entry.data.color }}
        aria-label={memberLabel(entry)}
        data-testid="presence-avatar"
        data-presence-user={entry.userId}
      >
        {isAgentShaped && <AgentAvatarPentagon color={entry.data.color} />}
        <span className="relative">
          <AvatarGlyph entry={entry} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{memberLabel(entry)}</TooltipContent>
    </Tooltip>
  );
}

/**
 * An advisory persona: pentagon avatar; HOVER opens the status hover card
 * (next check + recent recommendations), CLICK opens the recommendations
 * modal pre-filtered to this persona.
 */
function PersonaAvatar({
  entry,
  onOpenRecommendations,
}: {
  entry: PresenceRosterEntry;
  onOpenRecommendations: (slug: string) => void;
}) {
  const [isHoverCardOpen, setIsHoverCardOpen] = useState(false);
  const slug = extractPersonaSlugFromPresenceUserId(entry.userId);
  if (slug === null) {
    return null; // malformed persona userId — nothing sensible to render
  }
  return (
    <Popover.Root open={isHoverCardOpen} onOpenChange={setIsHoverCardOpen}>
      <Popover.Trigger
        openOnHover
        delay={200}
        className={cn(AGENT_AVATAR_CLASSES, "cursor-pointer")}
        onClick={() => {
          setIsHoverCardOpen(false);
          onOpenRecommendations(slug);
        }}
        aria-label={`${memberLabel(entry)} — view recommendations`}
        data-testid="presence-avatar"
        data-presence-user={entry.userId}
      >
        <AgentAvatarPentagon color={entry.data.color} />
        <span className="relative">
          <AvatarGlyph entry={entry} />
        </span>
        <PersonaStatusDot status={entry.data.status} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="center" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            className="z-50 w-64 rounded-md border bg-popover p-3 text-popover-foreground shadow-md outline-none"
            data-testid="persona-hover-card"
          >
            <PersonaHoverCard
              slug={slug}
              name={entry.data.name}
              color={entry.data.color}
              status={entry.data.status}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** How many recent recommendations the hover card lists. */
const HOVER_CARD_RECENT_LIMIT = 3;

/**
 * Hover-card body — mounts only while the card is open, so its queries and
 * the 1s countdown tick cost nothing the rest of the time. The next-check
 * line derives from the local run clock (persona-run-clock.ts) + the
 * registry cooldown — user-facing words only, zero presence writes.
 */
function PersonaHoverCard({
  slug,
  name,
  color,
  status,
}: {
  slug: string;
  name: string;
  color: string;
  status: PresenceData["status"];
}) {
  const documentId = useEditorStore((state) => state.documentId);
  const arePersonasPaused = useArePersonasPaused();
  const lastRunAtMs = usePersonaLastRunAtMs({ documentId, slug });
  const personaRows = useQuery(api.personas.getPersonasBySlugs, { slugs: [slug] });
  const findingRows = useQuery(
    api.personaFindings.listFindingsForDocument,
    documentId !== null ? { documentId } : "skip",
  );

  // Local 1s tick so "Checks again in about Ns" counts down while visible.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const nextCheckLabel = buildNextCheckLabel({
    isPaused: arePersonasPaused,
    personaStatus: status,
    lastRunAtMs,
    cooldownSeconds: personaRows?.[0]?.cooldownSeconds ?? null,
    nowMs,
  });
  const recentRows = (findingRows ?? [])
    .filter((row) => row.personaSlug === slug)
    .slice(0, HOVER_CARD_RECENT_LIMIT);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <p className="min-w-0 truncate text-sm font-medium">{name}</p>
        <span className="ml-auto shrink-0 rounded-full border px-1.5 py-px text-[10px] text-muted-foreground">
          AI agent
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" data-testid="persona-next-check">
          {nextCheckLabel}
        </p>
        <PersonaCheckNowButton documentId={documentId} personaSlugs={[slug]} />
      </div>
      <div>
        <p className="text-[11px] font-medium text-foreground/80">Recent recommendations</p>
        {findingRows === undefined ? (
          <p className="mt-1 text-[11px] text-muted-foreground">Loading…</p>
        ) : recentRows.length === 0 ? (
          <p className="mt-1 text-[11px] text-muted-foreground">Nothing suggested yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {recentRows.map((row) => {
              const outcome = getRecommendationOutcome(row);
              return (
                <li
                  key={row.findingId}
                  className="flex items-center gap-1.5"
                  data-testid="persona-hover-recommendation"
                >
                  <span className="min-w-0 flex-1 truncate text-[11px]">{row.title}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full border px-1.5 py-px text-[10px]",
                      outcome.className,
                    )}
                  >
                    {outcome.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground/70">Click the avatar for full history.</p>
    </div>
  );
}

/** Your own avatar: click opens the nickname editor popover. */
function SelfAvatar({ entry }: { entry: PresenceRosterEntry }) {
  const setNickname = useSetNickname();
  const [isOpen, setIsOpen] = useState(false);
  const [draftName, setDraftName] = useState(entry.data.name);

  const saveNickname = (): void => {
    setNickname(draftName);
    setIsOpen(false);
  };

  return (
    <Popover.Root
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setDraftName(entry.data.name);
        }
        setIsOpen(nextOpen);
      }}
    >
      <Popover.Trigger
        className={cn(HUMAN_AVATAR_CLASSES, "cursor-pointer hover:brightness-110")}
        style={{ backgroundColor: entry.data.color }}
        title="Edit your display name"
        aria-label={`${memberLabel(entry)} — edit your display name`}
        data-testid="presence-avatar-self"
      >
        <AvatarGlyph entry={entry} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="isolate z-50">
          <Popover.Popup className="z-50 w-56 rounded-md border bg-popover p-3 text-popover-foreground shadow-md outline-none">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveNickname();
              }}
              className="flex flex-col gap-2"
            >
              <label htmlFor="presence-nickname" className="text-xs font-medium">
                Display name
              </label>
              <Input
                id="presence-nickname"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                maxLength={40}
                autoFocus
                className="h-8 text-sm"
                data-testid="presence-nickname-input"
              />
              <div className="flex justify-end">
                <Button type="submit" size="sm" data-testid="presence-nickname-save">
                  Save
                </Button>
              </div>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
