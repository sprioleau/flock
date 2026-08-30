"use client";

import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BrandColor } from "@/lib/brand-kit";
import {
  findHexTokens,
  resolveHexAgainstKit,
  type ResolvedHex,
} from "@/lib/email-design-hex";
import { cn } from "@/lib/utils";

/*
  The RENDERER for email-design.md (the CEILING over the structured brand
  kit's FLOOR). It shows the doc as styled markdown, and — the whole point of
  this view — turns ANY hex color written in the prose into an inline swatch
  chip. A hex that matches a kit color is chipped WITH that color's name and a
  "from kit" marker; a hex that matches nothing is still chipped but marked
  "unmanaged". The structured kit remains the source of truth for color; this
  view only annotates what the author already wrote, never restates the
  palette as authoritative.

  How the chips get injected: a tiny rehype plugin walks the parsed tree and
  splits every text node on its hex tokens, wrapping each one in a marker
  <span> (outside code/pre). react-markdown then renders those spans through
  the {@link HexChip} component below, which resolves the hex against the kit.
  Doing it on the tree — rather than on rendered strings — means a hex is
  chipped no matter where it sits: a heading, a list item, a table cell.
*/

/*
  The property key the plugin stamps a normalized hex onto, and the component
  reads back. Kept in one place so the two ends never drift.
*/
const HEX_PROPERTY = "dataEmailHex";

/*
  A mutable view of the hast nodes this plugin rewrites. Deliberately minimal
  (not the full hast union) so the transform reads plainly and stays free of
  the Root/Element content-type friction that adds nothing here.
*/
interface MutableNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MutableNode[];
}

/*
  One text node's value, split into a run of plain-text nodes and marker
  spans — one span per hex token, carrying the normalized hex. Text with no
  hex comes back as a single unchanged text node.
*/
function splitTextIntoNodes(value: string): MutableNode[] {
  const tokens = findHexTokens(value);
  if (tokens.length === 0) {
    return [{ type: "text", value }];
  }
  const nodes: MutableNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.index > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, token.index) });
    }
    const original = value.slice(token.index, token.index + token.length);
    nodes.push({
      type: "element",
      tagName: "span",
      properties: { [HEX_PROPERTY]: token.hex },
      children: [{ type: "text", value: original }],
    });
    cursor = token.index + token.length;
  }
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

/*
  Recursively rewrite a parent's children. Text inside code/pre is left
  literal — a hex in a code sample is code, not a swatch.
*/
function transformNode(node: MutableNode, parentTagName: string | null): void {
  if (node.children === undefined) {
    return;
  }
  const isCodeContext = parentTagName === "code" || parentTagName === "pre";
  const nextChildren: MutableNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && !isCodeContext) {
      nextChildren.push(...splitTextIntoNodes(child.value ?? ""));
    } else {
      transformNode(child, child.tagName ?? null);
      nextChildren.push(child);
    }
  }
  node.children = nextChildren;
}

/*
  The rehype plugin. Typed on the local {@link MutableNode} rather than hast's
  Root — the `hast` types aren't resolvable from this package, and the tree we
  touch (elements and text) is exactly this minimal shape.
*/
function rehypeHexTokens() {
  return (tree: MutableNode): void => {
    transformNode(tree, null);
  };
}

/*
  One hex swatch chip: the color square (inline style, because the color IS
  the data), the hex, and either the kit color's name + a "from kit" marker
  or an "unmanaged" marker. Everything but the square uses semantic tokens,
  so the chip reads correctly in dark mode.
*/
function HexChip({ resolved }: { resolved: ResolvedHex }) {
  const { hex, kitColorName, isFromKit } = resolved;
  const title = isFromKit
    ? `${hex} — ${kitColorName} (from brand kit)`
    : `${hex} — unmanaged (not in the brand kit)`;
  return (
    <span
      className="mx-px inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-1 py-px align-middle text-[0.85em] leading-none"
      title={title}
      data-testid="email-design-hex-chip"
    >
      <span
        aria-hidden
        className="inline-block size-3 shrink-0 rounded-[3px] border border-border"
        style={{ backgroundColor: hex }}
      />
      <span className="font-mono">{hex}</span>
      {isFromKit ? (
        <span className="text-muted-foreground">
          {kitColorName}
          <span className="ml-1 opacity-70">· from kit</span>
        </span>
      ) : (
        <span className="text-muted-foreground italic opacity-80">unmanaged</span>
      )}
    </span>
  );
}

/*
  Pull the plugin-stamped hex off a rendered span's hast node, or null when
  this is an ordinary span (there aren't any — markdown emits none — but the
  guard keeps the renderer honest).
*/
function readHexProperty(node: unknown): string | null {
  const properties = (node as MutableNode | undefined)?.properties;
  const value = properties?.[HEX_PROPERTY];
  return typeof value === "string" ? value : null;
}

function buildComponents(colors: BrandColor[] | undefined): Components {
  return {
    span({ node, children, ...rest }) {
      const hex = readHexProperty(node);
      if (hex === null) {
        return <span {...rest}>{children}</span>;
      }
      return <HexChip resolved={resolveHexAgainstKit({ hex, colors })} />;
    },
  };
}

/*
  Element styling for the rendered doc, as arbitrary-variant classes on the
  container: there is no typography plugin in this app, and preflight strips
  heading/list defaults, so spacing and sizing are set here explicitly. All
  semantic tokens — legible in both themes.
*/
const PROSE_CLASSNAME = cn(
  "text-sm text-foreground",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold",
  "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_p]:my-2 [&_p]:leading-relaxed",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5",
  "[&_a]:text-primary [&_a]:underline",
  "[&_strong]:font-semibold [&_em]:italic",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-4 [&_hr]:border-border",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left",
  "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:font-medium",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
);

/*
  The rendered email-design.md. `colors` is the kit's authored palette — the
  only thing a hex is resolved against. Blank markdown shows a muted note
  rather than an empty box.
*/
export function EmailDesignDocView({
  markdown,
  colors,
  className,
}: {
  markdown: string;
  colors: BrandColor[] | undefined;
  className?: string;
}) {
  const components = useMemo(() => buildComponents(colors), [colors]);
  if (markdown.trim().length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground italic", className)}>
        No email design guidance yet.
      </p>
    );
  }
  return (
    <div className={cn(PROSE_CLASSNAME, className)} data-testid="email-design-doc-view">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHexTokens]}
        components={components}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
