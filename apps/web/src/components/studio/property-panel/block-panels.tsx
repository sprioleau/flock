"use client";

import {
  BORDER_STYLES,
  CODE_BLOCK_LANGUAGES,
  resolveBlockStyles,
  type BorderStyle,
  type ButtonBlock,
  type CodeBlock,
  type CodeBlockLanguage,
  type CodeBlockTheme,
  type ColumnBlock,
  type DividerBlock,
  type ImageBlock,
  type LinkBlock,
  type RowBlock,
  type SectionBlock,
  type SpacerBlock,
  type TextBlock,
} from "@flock/email-sdk";
import {
  AlignField,
  ColorField,
  DropdownField,
  NumberField,
  PercentSliderField,
  SelectField,
  TextField,
} from "./fields";
import { EMAIL_SAFE_FONT_OPTIONS } from "../text-editor/email-safe-fonts";
import { BrandSocialFillRow } from "./BrandSocialFillRow";
import { GenerateImageField } from "./GenerateImageField";
import { ImageSourceField } from "./ImageSourceField";
import { PaddingFields } from "./PaddingFields";
import { TextareaField } from "./TextareaField";
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

/** Sentence-case labels for the SDK's border-style vocabulary. */
const BORDER_STYLE_OPTIONS: ReadonlyArray<{ value: BorderStyle; label: string }> = BORDER_STYLES.map(
  (style) => ({ value: style, label: `${style[0]!.toUpperCase()}${style.slice(1)}` }),
);


// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export function ButtonPanel({ block }: { block: ButtonBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const globals = useResolvedGlobals();
  const { properties } = block;
  const helpFor = help("button");
  const resolved = resolveBlockStyles(globals, block);

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
      <DropdownField
        label="Border style"
        value={resolved.borderStyle}
        options={BORDER_STYLE_OPTIONS}
        helpText={helpFor("borderStyle")}
        onCommit={(value) => commit({ borderStyle: value as BorderStyle })}
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
      <DropdownField
        label="Font"
        value={resolved.fontFamily}
        options={EMAIL_SAFE_FONT_OPTIONS}
        helpText={helpFor("fontFamily")}
        onCommit={(value) => commit({ fontFamily: value })}
      />
      <PaddingFields blockType="button" properties={properties} resolvedPadding={resolved} onCommitPadding={commit} />
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
  const resolved = resolveBlockStyles(globals, block);

  return (
    <div className="space-y-4 p-4">
      <ImageSourceField helpText={helpFor("src")} onCommitSrc={(src) => commit({ src })} />
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
          the RESOLVED contentWidth — the same mapping new images use (60% at
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
      {/* Border group. Corner radius is a theme-able property (it falls back
          to globals.imageBorderRadius, the image counterpart of the button's
          radius global), so its placeholder shows the inherited value; width,
          style, and color are per-image only. */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Border</p>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Corner radius"
            value={properties.borderRadius}
            isClearable
            min={0}
            placeholder={String(globals.imageBorderRadius)}
            helpText={helpFor("borderRadius")}
            onCommit={(value) => commit({ borderRadius: value })}
          />
          <NumberField
            label="Width"
            value={properties.borderWidth}
            isClearable
            min={0}
            placeholder={String(resolved.borderWidth)}
            helpText={helpFor("borderWidth")}
            onCommit={(value) => commit({ borderWidth: value })}
          />
        </div>
        <DropdownField
          label="Style"
          value={resolved.borderStyle}
          options={BORDER_STYLE_OPTIONS}
          helpText={helpFor("borderStyle")}
          onCommit={(value) => commit({ borderStyle: value as BorderStyle })}
        />
        <ColorField
          label="Color"
          value={properties.borderColor}
          fallbackColor={resolved.borderColor}
          isClearable
          helpText={helpFor("borderColor")}
          onCommit={(value) => commit({ borderColor: value })}
        />
      </div>
      <PaddingFields blockType="image" properties={properties} resolvedPadding={resolved} onCommitPadding={commit} />
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
  const resolved = resolveBlockStyles(globals, block);

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
      <PaddingFields blockType="section" properties={properties} resolvedPadding={resolved} onCommitPadding={commit} />
      {/* Item 26: fill this section's social row from the brand kit (renders
          only when the section has social links and the kit carries some). */}
      <BrandSocialFillRow sectionId={block.id} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

export function RowPanel({ block }: { block: RowBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const globals = useResolvedGlobals();
  const { properties } = block;
  const helpFor = help("row");
  const resolved = resolveBlockStyles(globals, block);

  return (
    <div className="space-y-4 p-4">
      <ColorField
        label="Background"
        value={properties.backgroundColor}
        // Unset row backgrounds are transparent — the section background shows
        // through, so it is the value the user actually sees.
        fallbackColor={globals.contentBackgroundColor}
        isClearable
        helpText={helpFor("backgroundColor")}
        onCommit={(value) => commit({ backgroundColor: value })}
      />
      <PaddingFields blockType="row" properties={properties} resolvedPadding={resolved} onCommitPadding={commit} />
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
  const resolved = resolveBlockStyles(globals, block);

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
      <PaddingFields blockType="column" properties={properties} resolvedPadding={resolved} onCommitPadding={commit} />
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
  const resolved = resolveBlockStyles(globals, block);

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
      <PaddingFields blockType="divider" properties={properties} resolvedPadding={resolved} onCommitPadding={commit} />
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
  const resolved = resolveBlockStyles(globals, block);

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
      <ColorField
        label="Background"
        value={properties.backgroundColor}
        // Unset text backgrounds are transparent — the content background
        // shows through, so it is the value the user actually sees.
        fallbackColor={globals.contentBackgroundColor}
        isClearable
        helpText={helpFor("backgroundColor")}
        onCommit={(value) => commit({ backgroundColor: value })}
      />
      <AlignField
        label="Alignment"
        value={properties.textAlign}
        isClearable
        helpText={helpFor("textAlign")}
        onCommit={(value) => commit({ textAlign: value })}
      />
      <PaddingFields blockType="text" properties={properties} resolvedPadding={resolved} onCommitPadding={commit} />
      <p className="text-xs text-muted-foreground">
        Edit the text content directly on the canvas.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

const LINK_UNDERLINE_OPTIONS: ReadonlyArray<{ value: "underlined" | "plain"; label: string }> = [
  { value: "underlined", label: "Underlined" },
  { value: "plain", label: "Plain" },
];

export function LinkPanel({ block }: { block: LinkBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const globals = useResolvedGlobals();
  const { properties } = block;
  const helpFor = help("link");
  const isUnderlined = properties.isUnderlined ?? true;
  const resolved = resolveBlockStyles(globals, block);

  return (
    <div className="space-y-4 p-4">
      <TextField
        label="Text"
        value={properties.text}
        helpText={helpFor("text")}
        onCommit={(value) => commit({ text: value })}
      />
      <TextField
        label="Link (href)"
        value={properties.href}
        helpText={helpFor("href")}
        onCommit={(value) => commit({ href: value })}
      />
      <ColorField
        label="Text color"
        value={properties.textColor}
        fallbackColor={globals.linkTextColor}
        isClearable
        helpText={helpFor("textColor")}
        onCommit={(value) => commit({ textColor: value })}
      />
      <SelectField
        label="Underline"
        value={isUnderlined ? "underlined" : "plain"}
        options={LINK_UNDERLINE_OPTIONS}
        helpText={helpFor("isUnderlined")}
        onCommit={(value) => {
          if (value !== undefined) {
            commit({ isUnderlined: value === "underlined" });
          }
        }}
      />
      <DropdownField
        label="Font"
        value={resolved.fontFamily}
        options={EMAIL_SAFE_FONT_OPTIONS}
        helpText={helpFor("fontFamily")}
        onCommit={(value) => commit({ fontFamily: value })}
      />
      <NumberField
        label="Font size (px)"
        value={properties.fontSize}
        isClearable
        min={1}
        placeholder="14"
        helpText={helpFor("fontSize")}
        onCommit={(value) => commit({ fontSize: value })}
      />
      <AlignField
        label="Alignment"
        value={properties.align}
        isClearable
        helpText={helpFor("align")}
        onCommit={(value) => commit({ align: value })}
      />
      <PaddingFields blockType="link" properties={properties} resolvedPadding={resolved} onCommitPadding={commit} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

const CODE_LANGUAGE_OPTIONS: ReadonlyArray<{ value: CodeBlockLanguage; label: string }> =
  CODE_BLOCK_LANGUAGES.map((language) => ({ value: language, label: language }));

const CODE_THEME_OPTIONS: ReadonlyArray<{ value: CodeBlockTheme; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const LINE_NUMBER_OPTIONS: ReadonlyArray<{ value: "shown" | "hidden"; label: string }> = [
  { value: "shown", label: "Shown" },
  { value: "hidden", label: "Hidden" },
];

export function CodePanel({ block }: { block: CodeBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const globals = useResolvedGlobals();
  const { properties } = block;
  const helpFor = help("code");
  const shouldShowLineNumbers = properties.shouldShowLineNumbers ?? false;
  const resolved = resolveBlockStyles(globals, block);

  return (
    <div className="space-y-4 p-4">
      <TextareaField
        label="Code"
        value={properties.code}
        textareaClassName="font-mono text-xs"
        helpText={helpFor("code")}
        onCommit={(value) => commit({ code: value })}
      />
      <DropdownField
        label="Language"
        value={properties.language}
        options={CODE_LANGUAGE_OPTIONS}
        helpText={helpFor("language")}
        onCommit={(value) => commit({ language: value as CodeBlockLanguage })}
      />
      <SelectField
        label="Theme"
        value={properties.theme ?? "dark"}
        options={CODE_THEME_OPTIONS}
        helpText={helpFor("theme")}
        onCommit={(value) => {
          if (value !== undefined) {
            commit({ theme: value });
          }
        }}
      />
      <SelectField
        label="Line numbers"
        value={shouldShowLineNumbers ? "shown" : "hidden"}
        options={LINE_NUMBER_OPTIONS}
        helpText={helpFor("shouldShowLineNumbers")}
        onCommit={(value) => {
          if (value !== undefined) {
            commit({ shouldShowLineNumbers: value === "shown" });
          }
        }}
      />
      <PaddingFields blockType="code" properties={properties} resolvedPadding={resolved} onCommitPadding={commit} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spacer
// ---------------------------------------------------------------------------

export function SpacerPanel({ block }: { block: SpacerBlock }) {
  const commit = useCommitBlockProperties(block.id);
  const { properties } = block;
  const helpFor = help("spacer");

  return (
    <div className="space-y-4 p-4">
      <NumberField
        label="Height (px)"
        value={properties.height}
        min={1}
        placeholder="24"
        helpText={helpFor("height")}
        onCommit={(value) => {
          if (value !== undefined) {
            commit({ height: value });
          }
        }}
      />
    </div>
  );
}
