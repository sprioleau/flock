"use client";

import { SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { updateAppSettings, useAppSettings } from "./app-settings";

/**
 * The app-wide settings entry point: a small floating action button in the
 * bottom-right corner (fixed to the viewport, above the canvas chrome but
 * below dialogs/sheets at z-50) opening a compact settings menu.
 *
 * First setting: the "Demo mode" toggle, persisted per browser via
 * app-settings.ts. Enabling it reveals the chat panel's "Queue demo
 * messages" button (DemoQueueButton).
 */
export function SettingsFab() {
  const { isDemoModeEnabled } = useAppSettings();

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
            <DropdownMenuLabel>Settings</DropdownMenuLabel>
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
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
