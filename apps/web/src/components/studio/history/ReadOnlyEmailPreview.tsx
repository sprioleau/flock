"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ButtonBlockView,
  CodeBlockView,
  ColumnBlockView,
  DividerBlockView,
  ImageBlockView,
  inflate,
  LinkBlockView,
  resolveBlockStyles,
  resolveRootBlockStyles,
  RowBlockView,
  SectionBlockView,
  SpacerBlockView,
  TextBlockView,
  type EmailDocument,
  type EmailTreeNode,
  type GlobalStyles,
} from "@flock/email-sdk";

/**
 * A historical document rendered through the SAME SDK block views the canvas
 * uses (visual parity), but with NO interactive shells: no selection, no
 * drag, no inline editing, no add-block affordances. `pointer-events-none`
 * on the surface guarantees nothing inside is clickable. The whole email is
 * laid out at its natural width and scaled down via CSS `zoom` (which,
 * unlike `transform: scale`, keeps layout height in sync — no corrected
 * height wrapper, so scroll height, the pinned footer, and the pane's
 * visible scrollbar all just work).
 *
 * The zoom factor is MEASURED, not hardcoded: a ResizeObserver on the
 * wrapper computes containerWidth / PREVIEW_LAYOUT_WIDTH_PX (the
 * pointer-presence overlay's measuring pattern), so the scaled email fits
 * its container exactly at any drawer width — symmetric by construction, no
 * outer-background sliver on one edge, no clipped edge on the other.
 */

/** Natural layout width the preview is composed at before scaling. */
const PREVIEW_LAYOUT_WIDTH_PX = 640;

/** Pre-measure fallback (one frame at most), ≈ the historical drawer fit. */
const PREVIEW_FALLBACK_ZOOM = 0.62;

/** Measured zoom that makes the 640px layout fill `element` exactly. */
function useFitZoom(): { containerRef: React.RefObject<HTMLDivElement | null>; zoom: number } {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) {
      return;
    }
    const measure = (): void => {
      // clientWidth excludes the wrapper's border, so the zoomed content
      // fits the border box exactly (no remainder to clip or show through).
      if (element.clientWidth > 0) {
        setZoom(element.clientWidth / PREVIEW_LAYOUT_WIDTH_PX);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { containerRef, zoom: zoom ?? PREVIEW_FALLBACK_ZOOM };
}

function ReadOnlyNode({ node, globals }: { node: EmailTreeNode; globals: GlobalStyles | undefined }) {
  const { block } = node;
  const children = node.children.map((child) => (
    <ReadOnlyNode key={child.block.id} node={child} globals={globals} />
  ));

  switch (block.type) {
    case "section":
      return (
        <SectionBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)}>
          {children}
        </SectionBlockView>
      );
    case "row":
      return (
        <RowBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)}>
          {children}
        </RowBlockView>
      );
    case "column":
      return (
        <ColumnBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)}>
          {children}
        </ColumnBlockView>
      );
    case "text":
      return <TextBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "button":
      return <ButtonBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "image":
      return <ImageBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "divider":
      return <DividerBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "link":
      return <LinkBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "code":
      return <CodeBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "spacer":
      return <SpacerBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />;
    case "root":
      // The root surface is rendered by ReadOnlyEmailPreview itself.
      return null;
  }
}

export function ReadOnlyEmailPreview({ doc }: { doc: EmailDocument }) {
  const tree = useMemo(() => inflate(doc), [doc]);
  const rootStyles = resolveRootBlockStyles(tree.block);
  const globals = tree.block.properties.globals;
  const { containerRef, zoom } = useFitZoom();

  return (
    <div
      ref={containerRef}
      className="overflow-x-hidden rounded-md border"
      data-testid="history-version-preview"
    >
      {/* mx-auto is the robustness backstop (owner ask): if any measurement
          is ever stale (e.g. a platform scrollbar reflow), the residual
          remainder splits evenly instead of piling on one edge. */}
      <div
        className="pointer-events-none mx-auto select-none"
        style={{
          width: PREVIEW_LAYOUT_WIDTH_PX,
          zoom,
          backgroundColor: rootStyles.emailBackgroundColor,
        }}
      >
        {tree.children.map((child) => (
          <ReadOnlyNode key={child.block.id} node={child} globals={globals} />
        ))}
      </div>
    </div>
  );
}
