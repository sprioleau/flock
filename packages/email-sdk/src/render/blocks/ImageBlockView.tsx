import type { CSSProperties } from "react";
import { Column, Img, Link, Row } from "react-email";
import type { ImageBlock } from "../../schema/blocks";
import type { ResolvedImageStyles } from "../styles";
import { blockPaddingStyle } from "./shared";

export interface ImageBlockViewProps {
  block: ImageBlock;
  resolvedStyles: ResolvedImageStyles;
}

/** React Email's <Img> is display:block, so alignment is margin-based. */
const ALIGN_MARGINS: Record<ResolvedImageStyles["align"], CSSProperties> = {
  left: { marginLeft: 0, marginRight: "auto" },
  center: { marginLeft: "auto", marginRight: "auto" },
  right: { marginLeft: "auto", marginRight: 0 },
};

/**
 * image → React Email <Img>, wrapped in <Link> when href is set. Width caps
 * at the available width; height always tracks the aspect ratio.
 */
export function ImageBlockView({ block, resolvedStyles }: ImageBlockViewProps) {
  const { src, alt, width, href } = block.properties;
  const image = (
    <Img
      src={src}
      alt={alt}
      {...(width !== undefined ? { width } : {})}
      style={{
        maxWidth: "100%",
        height: "auto",
        ...ALIGN_MARGINS[resolvedStyles.align],
      }}
    />
  );
  return (
    <Row>
      <Column style={blockPaddingStyle(resolvedStyles)}>
        {href !== undefined ? <Link href={href}>{image}</Link> : image}
      </Column>
    </Row>
  );
}
