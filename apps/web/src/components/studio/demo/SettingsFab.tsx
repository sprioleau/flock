"use client";

import { api } from "@convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { GhostIcon, MonitorIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEditorStore } from "@/lib/editor-store";
import { updateAppSettings, useAppSettings } from "./app-settings";

/**
 * The app-wide settings entry point: a small floating action button in the
 * bottom-right corner (fixed to the viewport, above the canvas chrome but
 * below dialogs/sheets at z-50) opening a compact settings menu.
 *
 * Settings:
 * - "Demo mode" toggle, persisted per browser via app-settings.ts. Enabling
 *   it reveals the chat panel's "Queue demo messages" button
 *   (DemoQueueButton) and the ghost-collaborator control below.
 * - "Time-travel replay" / "Op inspector" toggles (persisted the same way):
 *   reveal those power-user toolbar buttons — both hidden by default.
 * - "Ghost collaborator" (demo mode only): starts/stops the server-driven
 *   simulated collaborator (convex/ghost.ts) that types into a text block —
 *   one-person multiplayer. The running state is reactive (getGhostStatus),
 *   so the label flips to Stop while the ghost is typing and back when the
 *   bounded run ends on its own.
 */
export function SettingsFab() {
  const { isDemoModeEnabled, isTimeTravelReplayEnabled, isOpInspectorEnabled } = useAppSettings();
  const documentId = useEditorStore((state) => state.documentId);
  // App-chrome theme (light / dark / system), persisted by next-themes. Safe
  // to read here without a mounted guard: the menu content only renders after
  // a click, which is always post-hydration.
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
    // bottom-16 keeps clear of the Next.js dev-tools badge, which owns the
    // exact bottom-right corner during `next dev`.
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
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            {/* Theme applies to app chrome only — the email document keeps its
                own author-chosen colors in both modes. */}
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
            {/* The "Agents…" entry moved to the studio header next to the
                presence facepile (AgentCollaboratorsButton) — collaborators
                are first-class, not a debug setting. */}
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
