"use client";

import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useOptionalPresenceRoster,
  useSetNickname,
  type PresenceRosterEntry,
} from "@/lib/presence";
import { cn } from "@/lib/utils";

/**
 * Phase 6.2a topbar facepile: one colored initial-circle per ONLINE room
 * member (self first — the presence component orders it that way), the agent
 * rendered with a spark glyph instead of an initial. Hovering shows the full
 * name; clicking YOUR OWN avatar opens a small popover to edit the nickname
 * (persisted to localStorage and broadcast immediately by useSetNickname).
 *
 * Renders nothing when no document/presence room is open.
 */
export function PresenceFacepile() {
  const roster = useOptionalPresenceRoster();
  if (roster === null) {
    return null;
  }
  const onlineMembers = roster.filter((entry) => entry.isOnline);
  if (onlineMembers.length === 0) {
    return null;
  }
  return (
    <TooltipProvider>
      <div className="flex items-center -space-x-1.5" data-testid="presence-facepile">
        {onlineMembers.map((entry) =>
          entry.isSelf ? (
            <SelfAvatar key={entry.userId} entry={entry} />
          ) : (
            <MemberAvatar key={entry.userId} entry={entry} />
          ),
        )}
      </div>
      <div className="mx-1 h-5 w-px bg-border" aria-hidden />
    </TooltipProvider>
  );
}

const AVATAR_CLASSES =
  "flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-background select-none";

/** Persona roster members (multi-agent canvas v0) carry this userId prefix. */
const isPersonaEntry = (entry: PresenceRosterEntry): boolean =>
  entry.userId.startsWith("persona:");

function AvatarGlyph({ entry }: { entry: PresenceRosterEntry }) {
  if (isPersonaEntry(entry)) {
    // Personas show their initial like humans — their identity is a NAME, not
    // "the agent" — with the status dot below marking them as non-human.
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

/** A remote member (human, agent, or persona): colored circle + name tooltip. */
function MemberAvatar({ entry }: { entry: PresenceRosterEntry }) {
  return (
    <Tooltip>
      <TooltipTrigger
        className={cn(AVATAR_CLASSES, "relative")}
        style={{ backgroundColor: entry.data.color }}
        aria-label={memberLabel(entry)}
        data-testid="presence-avatar"
        data-presence-user={entry.userId}
      >
        <AvatarGlyph entry={entry} />
        {isPersonaEntry(entry) && <PersonaStatusDot status={entry.data.status} />}
      </TooltipTrigger>
      <TooltipContent side="bottom">{memberLabel(entry)}</TooltipContent>
    </Tooltip>
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
        className={cn(AVATAR_CLASSES, "cursor-pointer hover:brightness-110")}
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
