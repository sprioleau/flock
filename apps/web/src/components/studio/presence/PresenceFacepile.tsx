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

function AvatarGlyph({ entry }: { entry: PresenceRosterEntry }) {
  if (entry.data.isAgent === true) {
    return <SparklesIcon className="size-3" aria-hidden />;
  }
  return <>{entry.data.name.charAt(0).toUpperCase()}</>;
}

function memberLabel(entry: PresenceRosterEntry): string {
  if (entry.data.isAgent === true) {
    return `${entry.data.name} (AI agent)`;
  }
  return entry.isSelf ? `${entry.data.name} (you)` : entry.data.name;
}

/** A remote member (human or agent): colored circle + name tooltip. */
function MemberAvatar({ entry }: { entry: PresenceRosterEntry }) {
  return (
    <Tooltip>
      <TooltipTrigger
        className={AVATAR_CLASSES}
        style={{ backgroundColor: entry.data.color }}
        aria-label={memberLabel(entry)}
        data-testid="presence-avatar"
        data-presence-user={entry.userId}
      >
        <AvatarGlyph entry={entry} />
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
