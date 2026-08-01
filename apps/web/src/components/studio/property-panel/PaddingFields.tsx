"use client";

import type { ResolvedPadding } from "@flock/email-sdk";
import { NumberField } from "./fields";
import { getBlockPropertyHelp, type DescribableBlockType } from "./schema-help";

/**
 * The four outer-padding overrides shared by every editable block type.
 * Clearable: an emptied input removes the override so the renderer falls back
 * to globals.baseSpacing-derived defaults.
 *
 * Unset fields show the RESOLVED effective pixel value as their placeholder —
 * the exact number the canvas renders through the styles chain — never a
 * literal "auto" (owner ask 2026-07-31: "I don't know what auto translates
 * to"). The property itself stays unset, so "empty = follows the theme"
 * semantics are preserved: a theme/baseSpacing change still flows through.
 */

const PADDING_KEYS = ["paddingTop", "paddingBottom", "paddingLeft", "paddingRight"] as const;
type PaddingKey = (typeof PADDING_KEYS)[number];

const PADDING_LABELS: Record<PaddingKey, string> = {
  paddingTop: "Top",
  paddingBottom: "Bottom",
  paddingLeft: "Left",
  paddingRight: "Right",
};

export interface PaddingProperties {
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
}

export interface PaddingFieldsProps {
  blockType: DescribableBlockType;
  properties: PaddingProperties;
  /** The block's fully-resolved padding (resolveBlockStyles output) — the
   * effective values shown as placeholders on unset fields. */
  resolvedPadding: ResolvedPadding;
  onCommitPadding: (patch: Partial<Record<PaddingKey, number | undefined>>) => void;
}

export function PaddingFields({
  blockType,
  properties,
  resolvedPadding,
  onCommitPadding,
}: PaddingFieldsProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Padding (px)</p>
      <div className="grid grid-cols-2 gap-2">
        {PADDING_KEYS.map((key) => (
          <NumberField
            key={key}
            label={PADDING_LABELS[key]}
            value={properties[key]}
            isClearable
            min={0}
            placeholder={String(resolvedPadding[key])}
            helpText={getBlockPropertyHelp({ blockType, propertyKey: key })}
            onCommit={(value) => onCommitPadding({ [key]: value })}
          />
        ))}
      </div>
    </div>
  );
}
