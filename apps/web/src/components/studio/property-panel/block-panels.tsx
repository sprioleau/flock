"use client";

import type {
  ButtonBlock,
  ColumnBlock,
  DividerBlock,
  ImageBlock,
  RowBlock,
  SectionBlock,
  TextBlock,
} from "@tandem/email-sdk";
import {
  AlignField,
  ColorField,
  NumberField,
  PercentSliderField,
  SelectField,
  TextField,
} from "./fields";
import { GenerateImageField } from "./GenerateImageField";
import { ImageSourceField } from "./ImageSourceField";
import { PaddingFields } from "./PaddingFields";
import { getBlockPropertyHelp, type DescribableBlockType } from "./schema-help";
import { useCommitBlockProperties, useResolvedGlobals } from "./usePanelDispatch";

/**
 * Per-block property editors. Every control dispatches
 * `updateBlockProperties` on each input event (the canvas tracks live); the
 * store's undo-stack coalescing keeps undo at one entry per gesture. Optional
 * style fields are clearable overrides: clearing dispatches
 * `{ key: undefined }`, which the SDK's shallow merge removes so the
 * global/renderer default applies again.
 *
 * The text panel edits ONLY block-level fields (padding / color / alignment
 * overrides); rich-text content editing lives inline on the canvas.
 */

const help = (blockType: DescribableBlockType) => (propertyKey: string) =>
  getBlockPropertyHelp({ blockType, propertyKey });

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export function ButtonPanel({ block }: { block: ButtonBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const globals = useResolvedGlobals();
  const { properties } = block;
  const helpFor = help("button");

  return (
    <div className="space-y-4 p-4">
      <TextField
        label="Label"
        value={properties.label}
        helpText={helpFor("label")}
        onCommit={(value) => commit({ label: value })}
      />
      <TextField
        label="Link (href)"
        value={properties.href}
        helpText={helpFor("href")}
        onCommit={(value) => commit({ href: value })}
      />
      <AlignField
        label="Alignment"
        value={properties.align}
        isClearable
        helpText={helpFor("align")}
        onCommit={(value) => commit({ align: value })}
      />
      <ColorField
        label="Background"
        value={properties.backgroundColor}
        fallbackColor={globals.buttonBackgroundColor}
        isClearable
        helpText={helpFor("backgroundColor")}
        onCommit={(value) => commit({ backgroundColor: value })}
      />
      <ColorField
        label="Text color"
        value={properties.textColor}
        fallbackColor={globals.buttonTextColor}
        isClearable
        helpText={helpFor("textColor")}
        onCommit={(value) => commit({ textColor: value })}
      />
      <ColorField
        label="Border color"
        value={properties.borderColor}
        fallbackColor={globals.buttonBorderColor}
        isClearable
        helpText={helpFor("borderColor")}
        onCommit={(value) => commit({ borderColor: value })}
      />
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Border radius"
          value={properties.borderRadius}
          isClearable
          min={0}
          placeholder={String(globals.buttonBorderRadius)}
          helpText={helpFor("borderRadius")}
          onCommit={(value) => commit({ borderRadius: value })}
        />
        <NumberField
          label="Border size"
          value={properties.borderSize}
          isClearable
          min={0}
          placeholder={String(globals.buttonBorderSize)}
          helpText={helpFor("borderSize")}
          onCommit={(value) => commit({ borderSize: value })}
        />
        <NumberField
          label="Inner horiz."
          value={properties.horizontalPadding}
          isClearable
          min={0}
          placeholder={String(globals.buttonHorizontalPadding)}
          helpText={helpFor("horizontalPadding")}
          onCommit={(value) => commit({ horizontalPadding: value })}
        />
        <NumberField
          label="Inner vert."
          value={properties.verticalPadding}
          isClearable
          min={0}
          placeholder={String(globals.buttonVerticalPadding)}
          helpText={helpFor("verticalPadding")}
          onCommit={(value) => commit({ verticalPadding: value })}
        />
      </div>
      <PaddingFields blockType="button" properties={properties} onCommitPadding={commit} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

export function ImagePanel({ block }: { block: ImageBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const globals = useResolvedGlobals();
  const { properties } = block;
  const helpFor = help("image");

  return (
    <div className="space-y-4 p-4">
      <ImageSourceField
        src={properties.src}
        helpText={helpFor("src")}
        onCommitSrc={(src) => commit({ src })}
      />
      <GenerateImageField blockId={block.id} />
      <TextField
        label="Alt text"
        value={properties.alt}
        emptyBehavior="commit"
        placeholder="Describe the image"
        helpText={helpFor("alt")}
        onCommit={(value) => commit({ alt: value ?? "" })}
      />
      {/* Width as a SCALE slider: the stored property stays pixels (the
          schema's `width`), but the control reads/writes it as a percent of
          the RESOLVED contentWidth — the same mapping new images use (85% at
          creation). Every movement commits instantly (never debounced); the
          exact px value stays visible in the readout, and clearing restores
          "natural" via the replaceBlockProperties clear path. */}
      <PercentSliderField
        label="Width"
        valuePercent={
          properties.width !== undefined
            ? Math.round(
                (Math.min(properties.width, globals.contentWidth) / globals.contentWidth) * 100,
              )
            : undefined
        }
        min={10}
        max={100}
        step={1}
        detailText={
          properties.width !== undefined
            ? `${Math.min(properties.width, globals.contentWidth)}px`
            : undefined
        }
        clearedLabel="natural"
        helpText={helpFor("width")}
        onCommit={(percent) => commit({ width: Math.round((percent / 100) * globals.contentWidth) })}
        onClear={() => commit({ width: undefined })}
      />
      <AlignField
        label="Alignment"
        value={properties.align}
        isClearable
        helpText={helpFor("align")}
        onCommit={(value) => commit({ align: value })}
      />
      <ColorField
        label="Background"
        value={properties.backgroundColor}
        // Unset image backgrounds are transparent — the content background
        // shows through, so it is the value the user actually sees.
        fallbackColor={globals.contentBackgroundColor}
        isClearable
        helpText={helpFor("backgroundColor")}
        onCommit={(value) => commit({ backgroundColor: value })}
      />
      <TextField
        label="Link (href)"
        value={properties.href}
        emptyBehavior="clear"
        placeholder="none"
        helpText={helpFor("href")}
        onCommit={(value) => commit({ href: value })}
      />
      <PaddingFields blockType="image" properties={properties} onCommitPadding={commit} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function SectionPanel({ block }: { block: SectionBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const globals = useResolvedGlobals();
  const { properties } = block;
  const helpFor = help("section");

  return (
    <div className="space-y-4 p-4">
      <ColorField
        label="Inner background"
        value={properties.innerBackgroundColor}
        fallbackColor={globals.contentBackgroundColor}
        isClearable
        helpText={helpFor("innerBackgroundColor")}
        onCommit={(value) => commit({ innerBackgroundColor: value })}
      />
      <ColorField
        label="Outer background"
        value={properties.outerBackgroundColor}
        fallbackColor={globals.emailBackgroundColor}
        isClearable
        helpText={helpFor("outerBackgroundColor")}
        onCommit={(value) => commit({ outerBackgroundColor: value })}
      />
      <PaddingFields blockType="section" properties={properties} onCommitPadding={commit} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

export function RowPanel({ block }: { block: RowBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const { properties } = block;
  const helpFor = help("row");

  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Padding top"
          value={properties.paddingTop}
          isClearable
          min={0}
          placeholder="auto"
          helpText={helpFor("paddingTop")}
          onCommit={(value) => commit({ paddingTop: value })}
        />
        <NumberField
          label="Padding bottom"
          value={properties.paddingBottom}
          isClearable
          min={0}
          placeholder="auto"
          helpText={helpFor("paddingBottom")}
          onCommit={(value) => commit({ paddingBottom: value })}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------

type ColumnVerticalAlign = NonNullable<ColumnBlock["properties"]["verticalAlign"]>;

const VERTICAL_ALIGN_OPTIONS: ReadonlyArray<{ value: ColumnVerticalAlign; label: string }> = [
  { value: "top", label: "Top" },
  { value: "middle", label: "Middle" },
  { value: "bottom", label: "Bottom" },
];

export function ColumnPanel({ block }: { block: ColumnBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const globals = useResolvedGlobals();
  const { properties } = block;
  const helpFor = help("column");

  return (
    <div className="space-y-4 p-4">
      <NumberField
        label="Width (%)"
        value={properties.widthPercent}
        isClearable
        min={1}
        max={100}
        placeholder="auto"
        helpText={helpFor("widthPercent")}
        onCommit={(value) => commit({ widthPercent: value })}
      />
      <SelectField
        label="Vertical align"
        value={properties.verticalAlign}
        options={VERTICAL_ALIGN_OPTIONS}
        isClearable
        helpText={helpFor("verticalAlign")}
        onCommit={(value) => commit({ verticalAlign: value })}
      />
      <ColorField
        label="Background"
        value={properties.backgroundColor}
        // Unset column backgrounds are transparent — the content background
        // shows through, so it is the value the user actually sees.
        fallbackColor={globals.contentBackgroundColor}
        isClearable
        helpText={helpFor("backgroundColor")}
        onCommit={(value) => commit({ backgroundColor: value })}
      />
      <PaddingFields blockType="column" properties={properties} onCommitPadding={commit} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

export function DividerPanel({ block }: { block: DividerBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const globals = useResolvedGlobals();
  const { properties } = block;
  const helpFor = help("divider");

  return (
    <div className="space-y-4 p-4">
      <ColorField
        label="Color"
        value={properties.color}
        fallbackColor={globals.dividerColor}
        isClearable
        helpText={helpFor("color")}
        onCommit={(value) => commit({ color: value })}
      />
      <NumberField
        label="Thickness (px)"
        value={properties.thickness}
        isClearable
        min={1}
        placeholder="1"
        helpText={helpFor("thickness")}
        onCommit={(value) => commit({ thickness: value })}
      />
      <PaddingFields blockType="divider" properties={properties} onCommitPadding={commit} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text (block-level fields only — content editing is inline on the canvas)
// ---------------------------------------------------------------------------

export function TextPanel({ block }: { block: TextBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const globals = useResolvedGlobals();
  const { properties } = block;
  const helpFor = help("text");

  return (
    <div className="space-y-4 p-4">
      <ColorField
        label="Text color"
        value={properties.textColor}
        // No single resolved value exists (headings and paragraphs differ);
        // body text color is the honest representative so the field always
        // shows the doc's current effective value instead of a blank input.
        fallbackColor={globals.paragraphTextColor}
        isClearable
        helpText={helpFor("textColor")}
        onCommit={(value) => commit({ textColor: value })}
      />
      <AlignField
        label="Alignment"
        value={properties.textAlign}
        isClearable
        helpText={helpFor("textAlign")}
        onCommit={(value) => commit({ textAlign: value })}
      />
      <PaddingFields blockType="text" properties={properties} onCommitPadding={commit} />
      <p className="text-xs text-muted-foreground">
        Edit the text content directly on the canvas.
      </p>
    </div>
  );
}
