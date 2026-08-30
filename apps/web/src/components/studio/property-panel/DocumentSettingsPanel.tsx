"use client";

import type { GlobalStyles, TextAlign } from "@flock/email-sdk";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { EMAIL_SAFE_FONT_OPTIONS } from "../text-editor/email-safe-fonts";
import { AlignField, ColorField, DropdownField, NumberField } from "./fields";
import { getGlobalStyleHelp } from "./schema-help";
import { useCommitGlobalStyles, useResolvedGlobals } from "./usePanelDispatch";

/*
  Document settings — shown when nothing is selected. Edits the root block's
  global styles via `updateDocumentSettings` (shallow merge), dispatched on
  every input event with store-side undo coalescing. Values shown are the
  resolved globals (document values with renderer defaults filled in), so
  committing a field pins it explicitly.
*/

type GlobalColorKey = {
  [K in keyof GlobalStyles]-?: Required<GlobalStyles>[K] extends string ? K : never;
}[keyof GlobalStyles];

type GlobalNumberKey = {
  [K in keyof GlobalStyles]-?: Required<GlobalStyles>[K] extends number ? K : never;
}[keyof GlobalStyles];

type GlobalAlignKey = "heading1TextAlign" | "heading2TextAlign" | "heading3TextAlign" | "paragraphTextAlign";

interface TypographyGroup {
  heading: string;
  fontFamilyKey: GlobalColorKey;
  textColorKey: GlobalColorKey;
  textAlignKey: GlobalAlignKey;
}

const TYPOGRAPHY_GROUPS: readonly TypographyGroup[] = [
  {
    heading: "Heading 1",
    fontFamilyKey: "heading1FontFamily",
    textColorKey: "heading1TextColor",
    textAlignKey: "heading1TextAlign",
  },
  {
    heading: "Heading 2",
    fontFamilyKey: "heading2FontFamily",
    textColorKey: "heading2TextColor",
    textAlignKey: "heading2TextAlign",
  },
  {
    heading: "Heading 3",
    fontFamilyKey: "heading3FontFamily",
    textColorKey: "heading3TextColor",
    textAlignKey: "heading3TextAlign",
  },
  {
    heading: "Paragraph",
    fontFamilyKey: "paragraphFontFamily",
    textColorKey: "paragraphTextColor",
    textAlignKey: "paragraphTextAlign",
  },
];

export function DocumentSettingsPanel() {
  const resolvedGlobals = useResolvedGlobals();
  const commitGlobals = useCommitGlobalStyles();

  const colorField = (label: string, key: GlobalColorKey) => (
    <ColorField
      label={label}
      value={resolvedGlobals[key]}
      helpText={getGlobalStyleHelp(key)}
      onCommit={(value) => {
        if (value !== undefined) {
          commitGlobals({ [key]: value } as GlobalStyles);
        }
      }}
    />
  );

  const numberField = (
    label: string,
    input: { key: GlobalNumberKey; min?: number; max?: number },
  ) => (
    <NumberField
      label={label}
      value={resolvedGlobals[input.key]}
      min={input.min}
      max={input.max}
      helpText={getGlobalStyleHelp(input.key)}
      onCommit={(value) => {
        if (value !== undefined) {
          commitGlobals({ [input.key]: value } as GlobalStyles);
        }
      }}
    />
  );

  const fontFamilyField = (label: string, key: GlobalColorKey) => (
    <DropdownField
      label={label}
      value={resolvedGlobals[key]}
      options={EMAIL_SAFE_FONT_OPTIONS}
      helpText={getGlobalStyleHelp(key)}
      onCommit={(value) => commitGlobals({ [key]: value } as GlobalStyles)}
    />
  );

  const alignField = (label: string, key: GlobalAlignKey) => (
    <AlignField
      label={label}
      value={resolvedGlobals[key]}
      helpText={getGlobalStyleHelp(key)}
      onCommit={(value: TextAlign | undefined) => {
        if (value !== undefined) {
          commitGlobals({ [key]: value } as GlobalStyles);
        }
      }}
    />
  );

  return (
    <Accordion defaultValue={["colors"]} className="px-4" data-slot="document-settings">
      <AccordionItem value="colors">
        <AccordionTrigger>Colors</AccordionTrigger>
        <AccordionContent className="space-y-3">
          {colorField("Email background", "emailBackgroundColor")}
          {colorField("Content background", "contentBackgroundColor")}
          {colorField("Link text", "linkTextColor")}
          {colorField("Divider", "dividerColor")}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="typography">
        <AccordionTrigger>Typography</AccordionTrigger>
        <AccordionContent className="space-y-4">
          {TYPOGRAPHY_GROUPS.map((group) => (
            <div key={group.heading} className="space-y-3">
              <p className="text-xs font-semibold">{group.heading}</p>
              {fontFamilyField("Font family", group.fontFamilyKey)}
              {colorField("Text color", group.textColorKey)}
              {alignField("Alignment", group.textAlignKey)}
            </div>
          ))}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="buttons">
        <AccordionTrigger>Buttons</AccordionTrigger>
        <AccordionContent className="space-y-3">
          {colorField("Background", "buttonBackgroundColor")}
          {colorField("Text color", "buttonTextColor")}
          {colorField("Border color", "buttonBorderColor")}
          {numberField("Border radius (px)", { key: "buttonBorderRadius", min: 0 })}
          {numberField("Border size (px)", { key: "buttonBorderSize", min: 0 })}
          {numberField("Horizontal padding (px)", { key: "buttonHorizontalPadding", min: 0 })}
          {numberField("Vertical padding (px)", { key: "buttonVerticalPadding", min: 0 })}
          {fontFamilyField("Font family", "buttonFontFamily")}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="images">
        <AccordionTrigger>Images</AccordionTrigger>
        <AccordionContent className="space-y-3">
          {numberField("Corner radius (px)", { key: "imageBorderRadius", min: 0 })}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="layout">
        <AccordionTrigger>Layout</AccordionTrigger>
        <AccordionContent className="space-y-3">
          {numberField("Content width (px)", { key: "contentWidth", min: 280, max: 900 })}
          {numberField("Base spacing (px)", { key: "baseSpacing", min: 0 })}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
