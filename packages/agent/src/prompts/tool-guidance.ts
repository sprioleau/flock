import { SECTION_TEMPLATES, type EmailActionRegistry } from "@tandem/email-sdk";

/**
 * Prompt layer (b) — tool guidance, generated from the SDK's action registry.
 * Plan §3.2 / §9.3: descriptions come from the registry, never hand-written
 * here, so this layer can't drift from the actual tool surface.
 *
 * CACHEABLE: pure function of the registry — for a given build of the SDK the
 * output is byte-identical on every request. Assemble it immediately after
 * SYSTEM_STATIC so Gemini's implicit caching covers both static layers as one
 * stable prefix. Registry registration order is preserved (deterministic).
 */
export function buildToolGuidance(registry: EmailActionRegistry): string {
  const lines = registry.actions.map((action) => {
    const flags: string[] = [action.kind];
    flags.push(action.readOnly ? "read-only" : action.kind === "editor" ? "ui-only" : "edits doc");
    flags.push(action.parallelSafe ? "parallel-safe" : "sequential");
    if (action.needsApproval !== false) {
      flags.push(
        typeof action.needsApproval === "function"
          ? "may need approval"
          : "needs approval",
      );
    }
    return `- ${action.name} (${flags.join(", ")}) — ${action.description}`;
  });
  // §9.4 catalog-lookup: advertise the read-back path only when it is registered.
  const hasBlockDetailsTool = registry.actionsByName.has("getBlockDetails");
  const catalogHint = hasBlockDetailsTool
    ? "Tool inputs are compact; call getBlockDetails for a block's full shape before complex edits.\n\n"
    : "";
  // Phase 7.2 section catalog: one compact line per template (id + useWhen),
  // single-sourced from the SDK catalog so this listing can't drift. Only
  // advertised while scaffoldSection is registered.
  const hasScaffoldSectionTool = registry.actionsByName.has("scaffoldSection");
  const sectionCatalogListing = hasScaffoldSectionTool
    ? `\n\n## Section catalog (scaffoldSection templateId values)\n\n${SECTION_TEMPLATES.map(
        (template) => `- ${template.id} — ${template.useWhen}`,
      ).join("\n")}`
    : "";
  // Phase 7.4(a) web-content workflow: faithfulness, attribution, and honest
  // failure rules for building from a fetched URL. Only advertised while the
  // host app has injected the fetchWebContent executor.
  const hasFetchWebContentTool = registry.actionsByName.has("fetchWebContent");
  const webContentWorkflow = hasFetchWebContentTool ? `\n\n${WEB_CONTENT_WORKFLOW}` : "";
  return `## Available tools\n\n${catalogHint}${lines.join("\n")}${sectionCatalogListing}${webContentWorkflow}`;
}

/**
 * The §7.4 faithfulness rules as model guidance — constant text so the cached
 * prefix stays byte-identical. Appended only when fetchWebContent is
 * registered (see buildToolGuidance).
 */
const WEB_CONTENT_WORKFLOW = `## Building from a web page (fetchWebContent)

When the user shares a URL and asks you to build content from it, call fetchWebContent FIRST — never write about a page you have not fetched in this conversation.

- Compose ONLY from the returned payload. Condense the real mainText faithfully; never add facts, quotes, names, or numbers that are not in it. If mainText was truncated, work with what you have — do not guess at the rest.
- Default to ONE new section for the story; build out a whole email from it only when the user explicitly asks for one.
- Hand-compose that section with addSection (not scaffoldSection — templates cannot carry a real image URL or link): a heading with the real title, one or two short paragraphs condensed from mainText, the returned heroImageUrl as an image (with meaningful alt text) when there is one, and ALWAYS a button labeled like "Read the full story" whose href is the returned canonicalUrl. Naming the source (sourceName) in the copy is good practice.
- If the result has isOk: false, the page could not be read (blocked, paywalled, not an article, unreachable). Relay the returned message to the user in your own short words, make NO edits, and STOP — inventing plausible content for an unread page is the one unforgivable failure here.
- If confidence is "low", tell the user the page was hard to read and the section may need their review.`;
