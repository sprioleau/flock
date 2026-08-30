import type { Block } from "../schema/blocks";
import type { EmailDocument } from "../store/document";
import { checkDocumentIntegrity } from "../store/integrity";
import { inflate, type EmailTreeNode } from "../store/tree";
import { DocumentIntegrityError } from "./errors";
import { resolveBlockStyles, type ResolvedBlockStyles } from "./styles";

/*
  A node of the render-ready JSON tree: the block, its fully-resolved styles
  (globals + overrides already merged), and its children in order. This is
  the wire format for non-JS renderers/callers.
*/
export interface RenderedEmailNode {
  block: Block;
  resolvedStyles: ResolvedBlockStyles;
  children: RenderedEmailNode[];
}

/*
  Inflate the document and attach resolved styles to every node.
  Throws DocumentIntegrityError when the document fails the integrity check.
*/
export function renderToJSON(document: EmailDocument): RenderedEmailNode {
  const integrity = checkDocumentIntegrity(document);
  if (!integrity.isValid) {
    throw new DocumentIntegrityError(integrity.errors);
  }

  const tree = inflate(document);
  const globals = tree.block.properties.globals;

  const attachStyles = (node: EmailTreeNode): RenderedEmailNode => ({
    block: node.block,
    resolvedStyles: resolveBlockStyles(globals, node.block),
    children: node.children.map(attachStyles),
  });

  return attachStyles(tree);
}
