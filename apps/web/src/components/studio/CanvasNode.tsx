"use client";

import {
  CodeBlockView,
  ColumnBlockView,
  DividerBlockView,
  LinkBlockView,
  resolveBlockStyles,
  RowBlockView,
  SectionBlockView,
  SpacerBlockView,
  type EmailTreeNode,
  type GlobalStyles,
} from "@tandem/email-sdk";
import { BlockShell } from "./BlockShell";
import { ButtonBlockCanvasSlot } from "./button-editor/ButtonBlockCanvasSlot";
import { ImageBlockCanvasSlot } from "./ImageBlockCanvasSlot";
import { TextBlockCanvasSlot } from "./text-editor/TextBlockCanvasSlot";

export interface CanvasNodeProps {
  node: EmailTreeNode;
  globals: GlobalStyles | undefined;
}

/**
 * Recursive canvas traversal — the same SDK block views the HTML renderer
 * uses (visual parity), each wrapped in an interactive BlockShell.
 *
 * Column is the one exception: its view renders a <td>, which cannot be
 * wrapped in a div without breaking the table row, so its shell goes INSIDE
 * the cell around the column's content.
 */
export function CanvasNode({ node, globals }: CanvasNodeProps) {
  const { block } = node;
  const children = node.children.map((child) => (
    <CanvasNode key={child.block.id} node={child} globals={globals} />
  ));

  switch (block.type) {
    case "section":
      return (
        <BlockShell block={block}>
          {/* Adding blocks happens through the right rail's Blocks tab
              (drag in or click-to-add) — the old per-section ghost
              "+ Add block" menu is gone (owner decision 2026-07-30). */}
          <SectionBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)}>
            {children}
          </SectionBlockView>
        </BlockShell>
      );
    case "row":
      return (
        <BlockShell block={block}>
          <RowBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)}>
            {children}
          </RowBlockView>
        </BlockShell>
      );
    case "column":
      return (
        <ColumnBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)}>
          <BlockShell block={block} className="min-h-6">
            {children}
          </BlockShell>
        </ColumnBlockView>
      );
    case "text":
      return (
        <BlockShell block={block}>
          <TextBlockCanvasSlot
            block={block}
            resolvedStyles={resolveBlockStyles(globals, block)}
          />
        </BlockShell>
      );
    case "button":
      // The canvas slot swaps in the single-line label editor while this
      // button's inline editing session is open.
      return (
        <BlockShell block={block}>
          <ButtonBlockCanvasSlot block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
        </BlockShell>
      );
    case "image":
      // The canvas slot layers the ephemeral AI-generation preview (data-URI
      // instant paint + status overlay) over the shared SDK view.
      return (
        <BlockShell block={block}>
          <ImageBlockCanvasSlot block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
        </BlockShell>
      );
    case "divider":
      return (
        <BlockShell block={block}>
          <DividerBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
        </BlockShell>
      );
    case "link":
      return (
        <BlockShell block={block}>
          <LinkBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
        </BlockShell>
      );
    case "code":
      return (
        <BlockShell block={block}>
          <CodeBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
        </BlockShell>
      );
    case "spacer":
      return (
        <BlockShell block={block}>
          <SpacerBlockView block={block} resolvedStyles={resolveBlockStyles(globals, block)} />
        </BlockShell>
      );
    case "root":
      // The root is rendered by EditorCanvas itself; it never recurses here.
      return null;
  }
}
