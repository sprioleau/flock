"use client";

import { api } from "@convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { CompassIcon, GhostIcon, MonitorIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOwnerOverride } from "@/lib/auth/use-owner-override";
import {
  CHAT_PROVIDER_IDS,
  CHAT_PROVIDER_LABELS,
  chatProviderIdSchema,
  type ChatProviderId,
} from "@/lib/chat-provider";
import { useEditorStore } from "@/lib/editor-store";
import { restartTour } from "@/lib/tour/tour-progress";
import { getShortcutDisplay } from "../shortcuts/ShortcutKbd";
import { updateAppSettings, useAppSettings } from "./app-settings";

/*
  The app-wide settings entry point: a small floating action button in the
  bottom-right corner (fixed to the viewport, above the canvas chrome but
  below dialogs/sheets at z-50) opening a compact settings menu.

  Settings:
  - "Show me around": restarts the first-run walkthrough by resetting its
    localStorage progress (lib/tour/tour-progress.ts). An action, not a
    toggle — and the permanent way back to a tour that has been skipped.
  - "Demo mode" toggle, persisted per browser via app-settings.ts. Enabling
    it reveals the chat panel's "Queue demo messages" button
    (DemoQueueButton) and the ghost-collaborator control below.
  - "Time-travel replay" / "Op inspector" toggles (persisted the same way):
    reveal those power-user toolbar buttons — both hidden by default.
  - "Suggest related edits": whether proactive suggestion cards appear. ON by
    default (the feature shipped visible). Purely a visibility switch — the
    op log keeps recording either way, so switching it back on surfaces
    suggestions from edits already made rather than starting from scratch.
  - "Ghost collaborator" (demo mode only): starts/stops the server-driven
    simulated collaborator (convex/ghost.ts) that types into a text block —
    one-person multiplayer. The running state is reactive (getGhostStatus),
    so the label flips to Stop while the ghost is typing and back when the
    bounded run ends on its own.
  - "Chat service" (owner override only): which provider answers chat turns.
    See ChatProviderSetting below for why it is absent rather than disabled.
*/
export function SettingsFab() {
  const {
    isDemoModeEnabled,
    isTimeTravelReplayEnabled,
    isOpInspectorEnabled,
    isSuggestionsEnabled,
    chatProviderId,
  } = useAppSettings();
  /*
    UI convenience only — the server re-checks the cookie on every chat turn
    and ignores a provider request from a caller without one.
  */
  const { isUnlocked: hasOwnerOverride } = useOwnerOverride();
  const documentId = useEditorStore((state) => state.documentId);
  /*
    App-chrome theme (light / dark / system), persisted by next-themes. Safe
    to read here without a mounted guard: the menu content only renders after
    a click, which is always post-hydration.
  */
  const { theme, setTheme } = useTheme();

  const ghostStatus = useQuery(
    api.ghost.getGhostStatus,
    isDemoModeEnabled && documentId !== null ? { documentId } : "skip",
  );
  const startGhost = useMutation(api.ghost.startGhost);
  const stopGhost = useMutation(api.ghost.stopGhost);
  const isGhostTyping = ghostStatus?.isTyping === true;

  const toggleGhost = (): void => {
    if (documentId === null) {
      return;
    }
    const action = isGhostTyping ? stopGhost({ documentId }) : startGhost({ documentId });
    action.catch((error: unknown) => {
      console.error("[settings] ghost collaborator toggle failed:", error);
    });
  };

  return (
    /*
      bottom-16 keeps clear of the Next.js dev-tools badge, which owns the
      exact bottom-right corner during `next dev`.
    */
    <div className="fixed right-4 bottom-16 z-40">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon"
              aria-label="App settings"
              className="rounded-full bg-background shadow-lg"
            />
          }
          data-testid="settings-fab"
        >
          <SettingsIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-60">
          <DropdownMenuGroup>
            {/*
              The muted key hint (DropdownMenuShortcut pattern): ⇧⌘L cycles
              light → dark → system (bound in StudioShortcuts).
            */}
            <DropdownMenuLabel className="flex items-center">
              Appearance
              <DropdownMenuShortcut>{getShortcutDisplay("cycleTheme")}</DropdownMenuShortcut>
            </DropdownMenuLabel>
            {/*
              Theme applies to app chrome only — the email document keeps its
              own author-chosen colors in both modes.
            */}
            <DropdownMenuRadioGroup
              value={theme ?? "system"}
              onValueChange={(value) => setTheme(value)}
            >
              <DropdownMenuRadioItem value="light" closeOnClick={false} data-testid="settings-theme-light">
                <SunIcon className="size-4 shrink-0" />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark" closeOnClick={false} data-testid="settings-theme-dark">
                <MoonIcon className="size-4 shrink-0" />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system" closeOnClick={false} data-testid="settings-theme-system">
                <MonitorIcon className="size-4 shrink-0" />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Settings</DropdownMenuLabel>
            {/*
              The "Agents…" entry moved to the studio header next to the
              presence facepile (AgentCollaboratorsButton) — collaborators
              are first-class, not a debug setting.
            */}
            {/*
              An ACTION rather than a toggle, and the only one in this group:
              it resets the localStorage tour progress to the first stop, so
              the walkthrough starts over immediately. This is the owner's
              "there should be a way to trigger the onboarding flow from
              settings", and it doubles as the way QA re-runs the tour
              without clearing site data. Closes the menu on click (unlike
              the toggles below) because the thing it produces appears on the
              canvas behind it.
            */}
            <DropdownMenuItem onClick={restartTour} data-testid="settings-restart-tour">
              <CompassIcon className="size-4 shrink-0" />
              <span className="flex flex-col gap-0.5 py-0.5">
                <span>Show me around</span>
                <span className="text-xs text-muted-foreground">
                  Replays the five-step tour of the studio
                </span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem
              checked={isSuggestionsEnabled}
              onCheckedChange={(isChecked) =>
                updateAppSettings({ isSuggestionsEnabled: isChecked })
              }
              closeOnClick={false}
              data-testid="settings-suggestions-toggle"
            >
              <span className="flex flex-col gap-0.5 py-0.5">
                <span>Suggest related edits</span>
                <span className="text-xs text-muted-foreground">
                  Offers to apply a change you just made to similar blocks
                </span>
              </span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={isDemoModeEnabled}
              onCheckedChange={(isChecked) => updateAppSettings({ isDemoModeEnabled: isChecked })}
              closeOnClick={false}
              data-testid="settings-demo-mode-toggle"
            >
              <span className="flex flex-col gap-0.5 py-0.5">
                <span>Demo mode</span>
                <span className="text-xs text-muted-foreground">
                  Adds a demo-message button to the chat
                </span>
              </span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={isTimeTravelReplayEnabled}
              onCheckedChange={(isChecked) =>
                updateAppSettings({ isTimeTravelReplayEnabled: isChecked })
              }
              closeOnClick={false}
              data-testid="settings-replay-toggle"
            >
              <span className="flex flex-col gap-0.5 py-0.5">
                <span>Time-travel replay</span>
                <span className="text-xs text-muted-foreground">
                  Adds a toolbar button that replays the document&apos;s history
                </span>
              </span>
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={isOpInspectorEnabled}
              onCheckedChange={(isChecked) => updateAppSettings({ isOpInspectorEnabled: isChecked })}
              closeOnClick={false}
              data-testid="settings-inspector-toggle"
            >
              <span className="flex flex-col gap-0.5 py-0.5">
                <span>Op inspector</span>
                <span className="text-xs text-muted-foreground">
                  Adds a toolbar button that opens the live change log
                </span>
              </span>
            </DropdownMenuCheckboxItem>
            {isDemoModeEnabled && documentId !== null && (
              <DropdownMenuItem
                closeOnClick={false}
                onClick={toggleGhost}
                data-testid="settings-ghost-toggle"
              >
                <GhostIcon className="size-4 shrink-0" />
                <span className="flex flex-col gap-0.5 py-0.5">
                  <span>{isGhostTyping ? "Stop ghost collaborator" : "Ghost collaborator"}</span>
                  <span className="text-xs text-muted-foreground">
                    {isGhostTyping
                      ? "Riley is typing — click to stop"
                      : "A simulated teammate types for ~25s"}
                  </span>
                </span>
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <ChatProviderSetting
            isUnlocked={hasOwnerOverride}
            chatProviderId={chatProviderId}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/*
  The value standing for `chatProviderId: null`. A radio group needs a value
  per option and `null` is not one — it is the ABSENCE of a choice, which is
  exactly the third state this control has to offer. The sentinel lives only
  between the group and its handler; what gets persisted is still `null`.
*/
const DEPLOYMENT_DEFAULT_VALUE = "deployment-default";

/*
  Which service answers chat messages — the owner's provider switch.

  ABSENT, NOT DISABLED, for everyone without the override. A greyed-out row
  announces that a hidden capability exists and invites people to go looking
  for the way in; there is nothing here for them to enable, so there is
  nothing here to show. Returning `null` takes the separator with it, so the
  menu below "Op inspector" simply ends where it always did.

  This is presentation, not enforcement. Anyone can set the underlying value
  (it is localStorage), and it changes nothing: the server honours a provider
  request only from a caller holding a valid override, and quietly uses the
  deployment's own provider otherwise. Hiding the control keeps a
  non-functional choice out of the way — it is not what makes it safe.

  Three options because `null` is meaningful. "Automatic" is not a synonym for
  Gemini: it means "don't pin anything", so if the deployment's provider
  changes, a browser on Automatic follows it and a browser pinned to Gemini
  does not.
*/
export function ChatProviderSetting(props: {
  isUnlocked: boolean;
  chatProviderId: ChatProviderId | null;
}) {
  if (!props.isUnlocked) {
    return null;
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        {/*
          "Yours only" rather than "owner override" / "admin": it says why
          this row is here and nobody else's menu has it, without naming a
          mechanism the reader has no use for.
        */}
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span>Chat service (yours only)</span>
          <span className="font-normal">
            Which service answers your chat messages
          </span>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={props.chatProviderId ?? DEPLOYMENT_DEFAULT_VALUE}
          onValueChange={(value) => {
            const parsed = chatProviderIdSchema.safeParse(value);
            updateAppSettings({ chatProviderId: parsed.success ? parsed.data : null });
          }}
        >
          <DropdownMenuRadioItem
            value={DEPLOYMENT_DEFAULT_VALUE}
            closeOnClick={false}
            data-testid="settings-chat-provider-default"
          >
            Automatic
          </DropdownMenuRadioItem>
          {CHAT_PROVIDER_IDS.map((providerId) => (
            <DropdownMenuRadioItem
              key={providerId}
              value={providerId}
              closeOnClick={false}
              data-testid={`settings-chat-provider-${providerId}`}
            >
              {CHAT_PROVIDER_LABELS[providerId]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    </>
  );
}
