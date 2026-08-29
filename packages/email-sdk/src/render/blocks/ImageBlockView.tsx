import type { CSSProperties } from "react";
import { Column, Img, Link, Row } from "react-email";
import type { ImageBlock } from "../../schema/blocks";
import type { ResolvedImageStyles } from "../styles";
import { blockPaddingStyle, type BlockAnnotation } from "./shared";

export interface ImageBlockViewProps {
  block: ImageBlock;
  resolvedStyles: ResolvedImageStyles;
  /**
   * Analysis-only stamp carrying this block's id onto the outermost element.
   * Empty (and therefore absent from the HTML) on every ordinary render —
   * see BLOCK_ANNOTATION_ATTRIBUTE in ./shared.
   */
  annotation?: BlockAnnotation;
}

/** React Email's <Img> is display:block, so alignment is margin-based. */
const ALIGN_MARGINS: Record<ResolvedImageStyles["align"], CSSProperties> = {
  left: { marginLeft: 0, marginRight: "auto" },
  center: { marginLeft: "auto", marginRight: "auto" },
  right: { marginLeft: "auto", marginRight: 0 },
};

/**
 * image → React Email <Img>, wrapped in <Link> when href is set. Width caps
 * at the available width; height always tracks the aspect ratio. The block
 * background goes on the wrapping <Column> (a td, email-safe like the column
 * block's background) so it fills the block's bounds — through the padding
 * and around an image narrower than the block.
 *
 * Border and corner radius sit on the <img> itself (not the wrapping cell),
 * so they frame the picture rather than the padded block. `border-radius` is
 * emitted plainly, the same graceful-degradation contract ButtonBlockView
 * already keeps for the button's corners: Word-engine Outlook ignores the
 * declaration and shows square corners — no VML fallback, no editor warning.
 * Both are skipped entirely at their zero/none defaults so an unstyled image
 * renders exactly the markup it always has.
 */
export function ImageBlockView({ block, resolvedStyles, annotation = {} }: ImageBlockViewProps) {
  const { src, alt, width, href } = block.properties;
  const hasBorder = resolvedStyles.borderWidth > 0 && resolvedStyles.borderStyle !== "none";
  const image = (
    <Img
      src={src}
      alt={alt}
      {...(width !== undefined ? { width } : {})}
      style={{
        maxWidth: "100%",
        height: "auto",
        ...ALIGN_MARGINS[resolvedStyles.align],
        ...(resolvedStyles.borderRadius > 0
          ? { borderRadius: `${resolvedStyles.borderRadius}px` }
          : {}),
        // React Email's Img sets `border: none` in its own base style, so the
        // shorthand (not the longhands) is what reliably overrides it.
        ...(hasBorder
          ? {
              border: `${resolvedStyles.borderWidth}px ${resolvedStyles.borderStyle} ${resolvedStyles.borderColor}`,
            }
          : {}),
      }}
    />
  );
  return (
    <Row {...annotation}>
      <Column
        style={{
          ...(resolvedStyles.backgroundColor !== undefined
            ? { backgroundColor: resolvedStyles.backgroundColor }
            : {}),
          ...blockPaddingStyle(resolvedStyles),
        }}
      >
        {href !== undefined ? <Link href={href}>{image}</Link> : image}
      </Column>
    </Row>
  );
}
