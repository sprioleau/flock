"use client";

import { NumberField } from "./fields";
import { getBlockPropertyHelp, type DescribableBlockType } from "./schema-help";

/**
 * The four outer-padding overrides shared by every editable block type.
 * Clearable: an emptied input removes the override so the renderer falls back
 * to globals.baseSpacing-derived defaults.
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
  onCommitPadding: (patch: Partial<Record<PaddingKey, number | undefined>>) => void;
}

export function PaddingFields({ blockType, properties, onCommitPadding }: PaddingFieldsProps) {
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
            placeholder="auto"
            helpText={getBlockPropertyHelp({ blockType, propertyKey: key })}
            onCommit={(value) => onCommitPadding({ [key]: value })}
          />
        ))}
      </div>
    </div>
  );
}
