import {
  AlignCenterIcon,
  ChartColumnIcon,
  Columns2Icon,
  Columns3Icon,
  Columns4Icon,
  CodeIcon,
  HeadingIcon,
  HexagonIcon,
  ImageIcon,
  ImagesIcon,
  LayoutGridIcon,
  LayoutTemplateIcon,
  LinkIcon,
  ListChecksIcon,
  MegaphoneIcon,
  MessagesSquareIcon,
  MinusIcon,
  NewspaperIcon,
  PanelBottomDashedIcon,
  PanelBottomIcon,
  PanelTopIcon,
  QuoteIcon,
  Share2Icon,
  ShoppingBagIcon,
  SquareDashedIcon,
  SquareMousePointerIcon,
  SquareSplitHorizontalIcon,
  TagIcon,
  TerminalIcon,
  TypeIcon,
  UnfoldVerticalIcon,
  type LucideIcon,
} from "lucide-react";
import {
  SECTION_CATEGORIES,
  SECTION_TEMPLATES,
  type BlockType,
  type LeafBlockType,
  type SectionCategory,
} from "@tandem/email-sdk";
import type { LeafBlockVariant } from "../block-defaults";

/**
 * The Blocks-tab palette catalog: every block a user can add by hand, grouped
 * the way the pane renders them (Content / Layout, then the categorized
 * Sections gallery). Items are pure descriptors — insertion goes through the
 * shared block-defaults factories (drop path: dnd/drop-target
 * buildPaletteDropInsertion; click path: click-to-add-placement), so palette
 * adds can never drift from what the agent-facing tools and the rest of the
 * studio produce.
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
  | (PaletteItemBase & { kind: "columns"; columnCount: 2 | 3 | 4 })
  | (PaletteItemBase & { kind: "empty-section" })
  | (PaletteItemBase & { kind: "section-template"; templateId: string });

/**
 * The block type a palette item stands in for during ALLOWED_CHILD_TYPES
 * legality checks. EVERY palette item is draggable (owner decision 2026-07-31,
 * reversing the v1 click-only rule for section templates): template tiles
 * stand in for a section, so they resolve to root-level gaps exactly like the
 * Empty Section tile. Null remains the "cannot drag" contract for any future
 * click-only item.
 */
export function getPaletteDragBlockType(item: PaletteItem): BlockType | null {
  switch (item.kind) {
    case "leaf":
      return item.blockType;
    case "columns":
      return "row";
    case "empty-section":
    case "section-template":
      return "section";
  }
}

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  header: PanelTopIcon,
  "header-centered": AlignCenterIcon,
  hero: LayoutTemplateIcon,
  "hero-split": SquareSplitHorizontalIcon,
  "feature-columns": LayoutGridIcon,
  "feature-list": ListChecksIcon,
  article: NewspaperIcon,
  "image-gallery": ImagesIcon,
  cta: MegaphoneIcon,
  product: ShoppingBagIcon,
  pricing: TagIcon,
  "code-sample": TerminalIcon,
  testimonial: QuoteIcon,
  "testimonial-columns": MessagesSquareIcon,
  stats: ChartColumnIcon,
  footer: PanelBottomIcon,
  "footer-social": Share2Icon,
  "footer-detailed": PanelBottomDashedIcon,
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
        // Stage M (brand-kit §7.2): feels like a block type, is a PRESET —
        // an image block with role:"logo", sourced from the canvas brand's
        // CONFIRMED logo (placeholder + Brand kit hint when none). Brand
        // propagation re-sources role-marked images on update.
        kind: "leaf",
        id: "logo",
        blockType: "image",
        variant: "logo",
        label: "Logo",
        description: "Your brand's logo — updates when the brand changes.",
        Icon: HexagonIcon,
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
      {
        kind: "columns",
        id: "columns-4",
        columnCount: 4,
        label: "4 Columns",
        description: "A row of four equal columns.",
        Icon: Columns4Icon,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// The Sections gallery — the palette's third area, categorized (§10)
// ---------------------------------------------------------------------------

/** The blank starting point, shown beside the Section gallery entry tile. */
export const EMPTY_SECTION_ITEM: PaletteItem = {
  kind: "empty-section",
  id: "empty-section",
  label: "Empty section",
  description: "A blank full-width section.",
  Icon: SquareDashedIcon,
};

/** User-facing labels for the SDK's section-category axis. */
const SECTION_CATEGORY_LABELS: Record<SectionCategory, string> = {
  header: "Headers",
  hero: "Heroes",
  content: "Body",
  "social-proof": "Social proof",
  footer: "Footers",
};

export interface SectionGalleryCategory {
  id: SectionCategory;
  /** User-facing category sub-heading ("Headers", "Footers", …). */
  label: string;
  items: readonly PaletteItem[];
}

/**
 * The section-template gallery, grouped by the SDK catalog's category axis in
 * catalog (composition) order. Tile labels and tooltips are single-sourced
 * from each template's name and useWhen sentence, so the gallery can never
 * drift from what scaffoldSection actually builds.
 */
export const SECTION_GALLERY: readonly SectionGalleryCategory[] = SECTION_CATEGORIES.map(
  (category) => ({
    id: category,
    label: SECTION_CATEGORY_LABELS[category],
    items: SECTION_TEMPLATES.filter((template) => template.category === category).map(
      (template): PaletteItem => ({
        kind: "section-template",
        id: `template-${template.id}`,
        templateId: template.id,
        label: template.name,
        description: template.useWhen,
        Icon: TEMPLATE_ICONS[template.id] ?? LayoutTemplateIcon,
      }),
    ),
  }),
).filter((categoryGroup) => categoryGroup.items.length > 0);
