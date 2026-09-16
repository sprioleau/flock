"use client";

import type { BackgroundPosition, BackgroundRepeat, BackgroundSize } from "@flock/email-sdk";
import { DropdownField, TextField } from "./fields";

/*
  The importer preserves a background image as typed block properties. Keep
  the presentation shared across section, row, and column panels so every
  container offers the same safe, editable controls.
*/

export interface BackgroundImageProperties {
  backgroundImageUrl?: string;
  backgroundSize?: BackgroundSize;
  backgroundPosition?: BackgroundPosition;
  backgroundRepeat?: BackgroundRepeat;
}

export interface BackgroundImageFieldsProps {
  properties: BackgroundImageProperties;
  helpFor: (propertyKey: string) => string | undefined;
  onCommit: (properties: Record<string, unknown>) => void;
}

export const BACKGROUND_IMAGE_SIZE_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "cover", label: "Cover" },
  { value: "contain", label: "Contain" },
] as const;

export const BACKGROUND_IMAGE_POSITION_OPTIONS = [
  { value: "center", label: "Center" },
  { value: "center center", label: "Center center" },
  { value: "top center", label: "Top center" },
  { value: "top left", label: "Top left" },
  { value: "top right", label: "Top right" },
  { value: "bottom center", label: "Bottom center" },
  { value: "bottom left", label: "Bottom left" },
  { value: "bottom right", label: "Bottom right" },
  { value: "center left", label: "Center left" },
  { value: "center right", label: "Center right" },
] as const;

export const BACKGROUND_IMAGE_REPEAT_OPTIONS = [
  { value: "no-repeat", label: "No repeat" },
  { value: "repeat", label: "Repeat" },
  { value: "repeat-x", label: "Repeat horizontally" },
  { value: "repeat-y", label: "Repeat vertically" },
] as const;

export function BackgroundImageFields({ properties, helpFor, onCommit }: BackgroundImageFieldsProps) {
  return (
    <div className="space-y-4">
      <TextField
        label="Background image URL"
        value={properties.backgroundImageUrl}
        emptyBehavior="clear"
        placeholder="https://…"
        helpText={helpFor("backgroundImageUrl")}
        onCommit={(value) => onCommit({ backgroundImageUrl: value })}
      />
      <DropdownField
        label="Background size"
        value={properties.backgroundSize}
        options={BACKGROUND_IMAGE_SIZE_OPTIONS}
        helpText={helpFor("backgroundSize")}
        onCommit={(value) => onCommit({ backgroundSize: value })}
      />
      <DropdownField
        label="Background position"
        value={properties.backgroundPosition}
        options={BACKGROUND_IMAGE_POSITION_OPTIONS}
        helpText={helpFor("backgroundPosition")}
        onCommit={(value) => onCommit({ backgroundPosition: value })}
      />
      <DropdownField
        label="Background repeat"
        value={properties.backgroundRepeat}
        options={BACKGROUND_IMAGE_REPEAT_OPTIONS}
        helpText={helpFor("backgroundRepeat")}
        onCommit={(value) => onCommit({ backgroundRepeat: value })}
      />
    </div>
  );
}
