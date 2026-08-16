import type { Block, BlockType } from "@flock/email-sdk";

/*
  The four nesting levels the canvas colour-codes. The schema caps depth at
  section › row › column › leaf, so these are ALL of them — every block on
  the canvas belongs to exactly one, and each gets its own hue so the
  selection outline and the breadcrumb chip both answer "which level am I
  looking at?" without reading the label.
*/
export type BlockLevel = "content" | "column" | "row" | "section";

/*
  The Tailwind palette family behind a level. Exposed for assertions and for
  reading the mapping at a glance ONLY — never to build a class name from.
  Tailwind cannot see dynamically-assembled names at build time, so every
  class string below is written out in full.
*/
export type BlockLevelHue = "sky" | "violet" | "orange" | "fuchsia";

export interface BlockLevelAccent {
  level: BlockLevel;
  hue: BlockLevelHue;
  /*
    Solid 2px outline: this block IS the selection. Drawn on the ::after
    overlay the shell owns (see BlockShell for why it is a pseudo-element).
  */
  selectedOutlineClassName: string;
  /*
    Dashed 2px outline: a preview of what clicking the hovered breadcrumb
    chip would select. Same hue as the solid one — clicking swaps dashed for
    solid, and nothing else about the outline changes.
  */
  hoverPreviewOutlineClassName: string;
  /*
    The faint hairline that appears while the pointer is over the block
    itself. Colour only — the shell adds the width on :hover.
  */
  pointerOutlineClassName: string;
  /*
    The selected block's own chip: a solid fill, the loudest thing in the stack.
  */
  selectedChipClassName: string;
  /*
    A clickable ancestor chip: tinted, subordinate to the selected chip, same hue.
  */
  ancestorChipClassName: string;
}

/*
  Shade choices, measured (WCAG contrast ratios, sRGB):

  OUTLINES stay at -500 with NO dark: variant. They are painted on email
  pixels, and EditorCanvas is explicit that those "come from document inline
  styles and never react to the app theme" — a theme-conditional stroke would
  lighten the outline against a still-white email. -500 is also exactly the
  sky-500 the selected block has always used, so content blocks keep the blue
  the owner asked to keep. Against white: violet 4.23:1, fuchsia 3.46:1,
  orange 2.80:1, sky 2.77:1 (the pre-existing baseline). Against a dark email
  background all four are 7:1 or better.

  CHIPS are app chrome sitting in the studio gutter, so they DO follow the
  theme. Light: a -700 fill with white text — sky 5.93:1, violet 7.10:1,
  fuchsia 6.32:1, orange 5.18:1. Dark: a -400 fill with -950 text — sky
  6.48:1, violet 5.60:1, fuchsia 6.02:1, orange 6.91:1. Every one clears AA
  for the chip's 10px type in both themes, where the old sky-500/white chip
  sat at 2.77:1. Ancestor chips invert that into a -50/-700 (light) and
  -950/-200 (dark) tint: 4.88:1 or better everywhere, visibly quieter than
  the selected chip while unmistakably the same hue.

  Hue separation: sky ~200°, orange ~50°, violet ~275°, fuchsia ~325°. The
  closest pair is violet/fuchsia at 50° apart, which is why columns use
  `violet` rather than Tailwind's literal `purple` (~295°) — purple would
  have sat only 30° from the section magenta.
*/
const BLOCK_LEVEL_ACCENTS: Record<BlockLevel, BlockLevelAccent> = {
  content: {
    level: "content",
    hue: "sky",
    selectedOutlineClassName: "after:border-2 after:border-solid after:border-sky-500",
    hoverPreviewOutlineClassName: "after:border-2 after:border-dashed after:border-sky-500",
    pointerOutlineClassName: "after:border-sky-300",
    selectedChipClassName:
      "border-sky-700 bg-sky-700 text-white dark:border-sky-400 dark:bg-sky-400 dark:text-sky-950",
    ancestorChipClassName:
      "border-sky-500/60 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-400/50 dark:bg-sky-950 dark:text-sky-200 dark:hover:bg-sky-900",
  },
  column: {
    level: "column",
    hue: "violet",
    selectedOutlineClassName: "after:border-2 after:border-solid after:border-violet-500",
    hoverPreviewOutlineClassName: "after:border-2 after:border-dashed after:border-violet-500",
    pointerOutlineClassName: "after:border-violet-300",
    selectedChipClassName:
      "border-violet-700 bg-violet-700 text-white dark:border-violet-400 dark:bg-violet-400 dark:text-violet-950",
    ancestorChipClassName:
      "border-violet-500/60 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-400/50 dark:bg-violet-950 dark:text-violet-200 dark:hover:bg-violet-900",
  },
  row: {
    level: "row",
    hue: "orange",
    selectedOutlineClassName: "after:border-2 after:border-solid after:border-orange-500",
    hoverPreviewOutlineClassName: "after:border-2 after:border-dashed after:border-orange-500",
    pointerOutlineClassName: "after:border-orange-300",
    selectedChipClassName:
      "border-orange-700 bg-orange-700 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-orange-950",
    ancestorChipClassName:
      "border-orange-500/60 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-400/50 dark:bg-orange-950 dark:text-orange-200 dark:hover:bg-orange-900",
  },
  section: {
    level: "section",
    hue: "fuchsia",
    selectedOutlineClassName: "after:border-2 after:border-solid after:border-fuchsia-500",
    hoverPreviewOutlineClassName: "after:border-2 after:border-dashed after:border-fuchsia-500",
    pointerOutlineClassName: "after:border-fuchsia-300",
    selectedChipClassName:
      "border-fuchsia-700 bg-fuchsia-700 text-white dark:border-fuchsia-400 dark:bg-fuchsia-400 dark:text-fuchsia-950",
    ancestorChipClassName:
      "border-fuchsia-500/60 bg-fuchsia-50 text-fuchsia-700 hover:bg-fuchsia-100 dark:border-fuchsia-400/50 dark:bg-fuchsia-950 dark:text-fuchsia-200 dark:hover:bg-fuchsia-900",
  },
};

/*
  Exhaustive by construction: adding a block type to the SDK breaks this
  record until someone decides which level it belongs to. `root` never gets a
  BlockShell (EditorCanvas renders the root's CHILDREN), so its entry is only
  here to satisfy that exhaustiveness; "section" is the honest answer for the
  outermost thing in the tree.
*/
const BLOCK_TYPE_LEVELS: Record<BlockType, BlockLevel> = {
  root: "section",
  section: "section",
  row: "row",
  column: "column",
  text: "content",
  button: "content",
  image: "content",
  divider: "content",
  link: "content",
  code: "content",
  spacer: "content",
};

/*
  Only the discriminant is read, so the argument is narrowed to it: a whole
  Block still satisfies this, and nothing here has to fabricate one.
*/
type BlockLike = Pick<Block, "type">;

/*
  Which of the four nesting levels a block sits at.
*/
export function getBlockLevel({ block }: { block: BlockLike }): BlockLevel {
  return BLOCK_TYPE_LEVELS[block.type];
}

/*
  The full accent set — outline and chip classes — for a block's level.
*/
export function getBlockLevelAccent({ block }: { block: BlockLike }): BlockLevelAccent {
  return BLOCK_LEVEL_ACCENTS[getBlockLevel({ block })];
}

/*
  Every level's accent, for tests and for any surface that legends the colours.
*/
export function listBlockLevelAccents(): BlockLevelAccent[] {
  return Object.values(BLOCK_LEVEL_ACCENTS);
}
