"use client";

import type { Block } from "@tandem/email-sdk";
import {
  ButtonPanel,
  CodePanel,
  ColumnPanel,
  DividerPanel,
  ImagePanel,
  LinkPanel,
  RowPanel,
  SectionPanel,
  SpacerPanel,
  TextPanel,
} from "./block-panels";
import { DocumentSettingsPanel } from "./DocumentSettingsPanel";

/**
 * Schema-driven property editor body: document settings when nothing is
 * selected, otherwise the editor for the selected block's type. Keyed by
 * block id upstream so field drafts reset when the selection changes.
 */

export function PropertyPanel({ block }: { block: Block | undefined }) {
  if (block === undefined) {
    return <DocumentSettingsPanel />;
  }
  switch (block.type) {
    case "button":
      return <ButtonPanel block={block} />;
    case "image":
      return <ImagePanel block={block} />;
    case "section":
      return <SectionPanel block={block} />;
    case "divider":
      return <DividerPanel block={block} />;
    case "text":
      return <TextPanel block={block} />;
    case "link":
      return <LinkPanel block={block} />;
    case "code":
      return <CodePanel block={block} />;
    case "spacer":
      return <SpacerPanel block={block} />;
    case "root":
      return <DocumentSettingsPanel />;
    case "row":
      return <RowPanel block={block} />;
    case "column":
      return <ColumnPanel block={block} />;
  }
}
