"use client";

import type {
  ButtonBlock,
  DividerBlock,
  ImageBlock,
  SectionBlock,
  TextBlock,
} from "@tandem/email-sdk";
import { AlignField, ColorField, NumberField, TextField } from "./fields";
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
      <TextField
        label="Alt text"
        value={properties.alt}
        emptyBehavior="commit"
        placeholder="Describe the image"
        helpText={helpFor("alt")}
        onCommit={(value) => commit({ alt: value ?? "" })}
      />
      <NumberField
        label="Width (px)"
        value={properties.width}
        isClearable
        min={1}
        // Beyond the content width the renderer clamps anyway, so larger
        // numbers are meaningless — cap at the RESOLVED contentWidth
        // (document value, or the SDK default). Clamped both by the HTML max
        // attribute and in the commit path (typed/pasted values).
        max={globals.contentWidth}
        placeholder="natural"
        helpText={helpFor("width")}
        onCommit={(value) => commit({ width: value })}
      />
      <AlignField
        label="Alignment"
        value={properties.align}
        isClearable
        helpText={helpFor("align")}
        onCommit={(value) => commit({ align: value })}
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
  const { properties } = block;
  const helpFor = help("text");

  return (
    <div className="space-y-4 p-4">
      <ColorField
        label="Text color"
        value={properties.textColor}
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
