import {
  ChartColumnIcon,
  Columns2Icon,
  Columns3Icon,
  CodeIcon,
  HeadingIcon,
  ImageIcon,
  ImagesIcon,
  LayoutGridIcon,
  LayoutTemplateIcon,
  LinkIcon,
  MinusIcon,
  NewspaperIcon,
  PanelBottomIcon,
  PanelTopIcon,
  QuoteIcon,
  SquareDashedIcon,
  SquareMousePointerIcon,
  TypeIcon,
  UnfoldVerticalIcon,
  type LucideIcon,
} from "lucide-react";
import { SECTION_TEMPLATES, type BlockType, type LeafBlockType } from "@tandem/email-sdk";
import type { LeafBlockVariant } from "../block-defaults";

/**
 * The Blocks-tab palette catalog: every block a user can add by hand, grouped
 * the way the pane renders them (Content / Layout / Sections). Items are pure
 * descriptors — insertion goes through the shared block-defaults factories
 * (drop path: dnd/drop-target buildPaletteDropInsertion; click path:
 * click-to-add-placement), so palette adds can never drift from what the
 * agent-facing tools and the rest of the studio produce.
 */

interface PaletteItemBase {
  /** Stable palette id — also the useDraggable id suffix and test hook. */
  id: string;
  /** User-facing tile label. */
  label: string;
  /** One-line user-facing description (tile tooltip). */
  description: string;
  Icon: LucideIcon;
}

export type PaletteItem =
  | (PaletteItemBase & {
      kind: "leaf";
      blockType: LeafBlockType;
      /** Optional content preset the block-defaults factory applies (e.g. the
       * Heading tile: a text block whose doc is a single heading node). */
      variant?: LeafBlockVariant;
    })
  | (PaletteItemBase & { kind: "columns"; columnCount: 2 | 3 })
  | (PaletteItemBase & { kind: "empty-section" })
  | (PaletteItemBase & { kind: "section-template"; templateId: string });

/**
 * The block type a palette item stands in for during ALLOWED_CHILD_TYPES
 * legality checks, or null when the item is click-to-add only (the eight
 * section templates in v1 — owner decision 2026-07-30 §8.2).
 */
export function getPaletteDragBlockType(item: PaletteItem): BlockType | null {
  switch (item.kind) {
    case "leaf":
      return item.blockType;
    case "columns":
      return "row";
    case "empty-section":
      return "section";
    case "section-template":
      return null;
  }
}

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  header: PanelTopIcon,
  hero: LayoutTemplateIcon,
  "feature-columns": LayoutGridIcon,
  article: NewspaperIcon,
  "image-gallery": ImagesIcon,
  testimonial: QuoteIcon,
  stats: ChartColumnIcon,
  footer: PanelBottomIcon,
};

export interface PaletteGroup {
  label: string;
  items: readonly PaletteItem[];
}

export const PALETTE_GROUPS: readonly PaletteGroup[] = [
  {
    label: "Content",
    items: [
      {
        kind: "leaf",
        id: "text",
        blockType: "text",
        label: "Text",
        description: "A paragraph of rich text.",
        Icon: TypeIcon,
      },
      {
        kind: "leaf",
        id: "heading",
        blockType: "text",
        variant: "heading",
        label: "Heading",
        description: "A text block starting as a heading.",
        Icon: HeadingIcon,
      },
      {
        kind: "leaf",
        id: "button",
        blockType: "button",
        label: "Button",
        description: "A call-to-action link button.",
        Icon: SquareMousePointerIcon,
      },
      {
        kind: "leaf",
        id: "image",
        blockType: "image",
        label: "Image",
        description: "A picture with alt text.",
        Icon: ImageIcon,
      },
      {
        kind: "leaf",
        id: "divider",
        blockType: "divider",
        label: "Divider",
        description: "A horizontal separator line.",
        Icon: MinusIcon,
      },
      {
        kind: "leaf",
        id: "link",
        blockType: "link",
        label: "Link",
        description: "A standalone hyperlink on its own line.",
        Icon: LinkIcon,
      },
      {
        kind: "leaf",
        id: "code",
        blockType: "code",
        label: "Code",
        description: "A syntax-highlighted code snippet.",
        Icon: CodeIcon,
      },
      {
        kind: "leaf",
        id: "spacer",
        blockType: "spacer",
        label: "Spacer",
        description: "Fixed vertical space between blocks.",
        Icon: UnfoldVerticalIcon,
      },
    ],
  },
  {
    label: "Layout",
    items: [
      {
        kind: "columns",
        id: "columns-2",
        columnCount: 2,
        label: "2 Columns",
        description: "A row of two equal columns.",
        Icon: Columns2Icon,
      },
      {
        kind: "columns",
        id: "columns-3",
        columnCount: 3,
        label: "3 Columns",
        description: "A row of three equal columns.",
        Icon: Columns3Icon,
      },
    ],
  },
  {
    label: "Sections",
    items: [
      {
        kind: "empty-section",
        id: "empty-section",
        label: "Empty",
        description: "A blank full-width section.",
        Icon: SquareDashedIcon,
      },
      ...SECTION_TEMPLATES.map(
        (template): PaletteItem => ({
          kind: "section-template",
          id: `template-${template.id}`,
          templateId: template.id,
          label: template.name,
          description: `A ready-made ${template.name.toLowerCase()} section. Click to add.`,
          Icon: TEMPLATE_ICONS[template.id] ?? LayoutTemplateIcon,
        }),
      ),
    ],
  },
];
