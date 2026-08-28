import { SECTION_TEMPLATES, type EmailActionRegistry } from "@flock/email-sdk";

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
  // Generative-UI widget routing: gated on askForClarification (the widget
  // action set ships together — see widget-actions.ts). Constant text —
  // cache-stable. Resolved early: the source-page workflow's "ask the user"
  // step names the clarification widget only when it is registered.
  const hasWidgetTools = registry.actionsByName.has("askForClarification");
  /*
    Faithfulness, attribution, and honest-failure rules for building from a
    fetched page. Only advertised while the host app has injected the
    readWebPage executor.

    There used to be TWO of these — one for articles, one for people — plus a
    routing section telling the model which reader to call. All three are gone,
    and the reason is worth keeping: the routing section had to describe pages
    in the abstract ("a page about ONE PERSON", "from my portfolio", "a bare
    personal domain with no path"), because the choice was made BEFORE anything
    was fetched. That is a rule about the user's sentence, and a new kind of
    page needed a new phrase in it. With one reader there is no choice left to
    describe, so the guesswork disappears rather than being reworded.
  */
  const hasReadWebPageTool = registry.actionsByName.has("readWebPage");
  const sourcePageWorkflow = hasReadWebPageTool
    ? `\n\n${buildSourcePageWorkflow({ hasClarificationTool: hasWidgetTools })}`
    : "";
  // Agent-parity capability summary: gated on openPanel (the UI-action set
  // ships together), so a registry without the parity actions never
  // advertises capabilities it lacks. Constant text — cache-stable.
  const hasOpenPanelTool = registry.actionsByName.has("openPanel");
  const capabilitySummary = hasOpenPanelTool ? `\n\n${CAPABILITY_SUMMARY}` : "";
  const widgetGuidance = hasWidgetTools ? `\n\n${WIDGET_GUIDANCE}` : "";
  // New-draft routing: the rule that keeps "make me another version" from
  // becoming "wipe and rebuild the draft on screen". Only advertised while
  // createDraft is registered. Constant text — cache-stable.
  const hasCreateDraftTool = registry.actionsByName.has("createDraft");
  const draftCompositionWorkflow = hasCreateDraftTool ? `\n\n${DRAFT_COMPOSITION_WORKFLOW}` : "";
  return `## Available tools\n\n${catalogHint}${lines.join("\n")}${sectionCatalogListing}${sourcePageWorkflow}${draftCompositionWorkflow}${capabilitySummary}${widgetGuidance}`;
}



/**
 * The §10.2 new-draft rules. The failure this exists to prevent: asked for a
 * new draft, the model reaches for the tools that can carry content
 * (addSection / updateText / removeBlock), which all act on the draft ON
 * SCREEN — so the user's work is cleared and rebuilt in place instead of a new
 * draft appearing beside it. createDraft now carries content, so the routing
 * rule below is expressible; this text is what makes the model take it.
 *
 * Constant text so the cached prefix stays byte-identical. Appended only when
 * createDraft is registered (see buildToolGuidance).
 */
const DRAFT_COMPOSITION_WORKFLOW = `## Making a new draft (createDraft)

The drafts bar can hold several drafts of the same email side by side. A new draft is created with createDraft — every other tool you have edits the ONE draft currently on the canvas.

- When the user asks for a new draft, another version, a different take, options to compare, or ideas to explore, call createDraft with a \`drafts\` plan. NEVER clear, delete, or rewrite the draft on screen to make a new idea fit — their existing content stays exactly as it is unless they explicitly asked you to replace it.
- Each entry in \`drafts\` is one complete email: give it a short user-facing name and its sections in reading order — a header, one or more body sections (hero, feature columns, article, call to action, testimonial, gallery, stats…), and a footer. A missing header, body, or footer is filled in for you, but plan the whole email deliberately.
- Write real copy in the section params, drawn from what the current draft is about: its subject, its audience, its product, its offer, its calls to action. Anything you leave out is carried over from the draft the user is on — so leave a field out when the current wording should carry over, and set it when this draft should say something new.
- The new drafts keep the theme the user already applied. Only pass shouldInheritTheme: false if they asked for a clean, unstyled start; to change the theme itself, ask them or open the theme picker.
- Asked for several ideas at once, put them all in ONE createDraft call and make them genuinely different from each other — different section order, different templates (a plain hero in one, a split hero in another), different copy and imagery — while keeping the essence of the email the same. Do not send the same layout N times.
- Use the bare \`count\` form ONLY when the user explicitly asked for blank drafts to fill in themselves.
- After creating drafts, tell the user in plain language what each one is and that they can open it from the drafts bar. Never name the tool.`;

/**
 * One cache-stable paragraph summarizing the agent's capability CATEGORIES,
 * so "what can you do?" answers well in plain language. Appended only when
 * the agent-parity UI actions are registered (see buildToolGuidance).
 */
const CAPABILITY_SUMMARY = `## What you can do (capability summary)

Beyond answering questions about this email, you can act on it and on the editor itself: edit the email's content, structure, and styling; generate AI images into image blocks; send a test email (with the user's approval); switch the canvas between desktop and mobile preview; open the editor's panels for the user — theme picker, brand kit, asset library, agent personas, recommendations history, version history, the blocks and properties tabs, and the send-test dialog; undo and redo changes; restore an earlier version from the history (with the user's approval); create new drafts in the drafts bar — whole ready-to-send emails, several at once when the user wants ideas to compare; and create advisory reviewer personas. When the user asks what you can do, summarize these capabilities in plain language — never list internal tool names.`;

/**
 * The §7.4 faithfulness rules as model guidance — constant text so the cached
 * prefix stays byte-identical. Appended only when readWebPage is
 * registered (see buildToolGuidance).
 */
/**
 * Routing rules for the generative-UI widget tools — constant text so the
 * cached prefix stays byte-identical. Appended only when the widget actions
 * are registered (see buildToolGuidance).
 */
const WIDGET_GUIDANCE = `## In-chat widgets

- When a request is too vague to act on confidently (like "make it pop"), call askForClarification with one short question and 2-4 concrete options instead of guessing — then stop and wait for the answer.
- When the user asks for variations, options, or alternatives for a section, call proposeSectionVariations with 2-4 meaningfully different takes — never scaffold the candidates into the email; the user picks one from the chat.
- When the user asks how to improve the email (feedback, review, suggestions) without asking you to change it, call proposeEdits — the suggestions render as Apply cards; do not also apply them yourself.`;

/**
 * The faithfulness rules for building from a page that was fetched in this
 * conversation. Constant text so the cached prefix stays byte-identical.
 * Appended only when readWebPage is registered (see buildToolGuidance).
 *
 * ONE workflow, deliberately. This replaces an article workflow and a person
 * workflow that said the same law twice in two vocabularies, plus a routing
 * section that had to describe kinds of page in order to choose between them.
 *
 * Nothing below names a kind of page. That is not squeamishness — it is the
 * design: the payload carries what the page actually said, and the same rules
 * (write only what is there, attribute to the canonical URL, relay a refusal
 * and stop) are correct whether the page was a portfolio, a product, a set of
 * documentation, or something nobody anticipated. A workflow that enumerated
 * page kinds would need a new clause every time the web produced a new one.
 */
function buildSourcePageWorkflow({
  hasClarificationTool,
}: {
  hasClarificationTool: boolean;
}): string {
  /*
    The user picks the shape ("the user chooses"). With the clarification
    widget registered the question is a widget call; without it, one
    plain-language question and a stop.
  */
  const askForShapeStep = hasClarificationTool
    ? `call askForClarification with the question "Should this become a whole email, or one new section?" and the options "A whole email" and "One new section", then stop and wait for their answer`
    : `ask them in one short question whether they want a whole email or one new section, then stop and wait for their answer`;
  return `## Building from a page the user linked (readWebPage)

When the user points at a URL and asks you to build from it, call readWebPage FIRST — never write about a page you have not fetched in this conversation.

- Compose ONLY from the returned payload. Condense what it says faithfully; never add a fact, a name, a number, a date, or a price that is not in it. When isTruncated is true the page was long and the tail was cut — work with what you have and do not guess at the rest.
- Read the whole payload, not just the prose. \`blocks\` are the page's headings and paragraphs IN READING ORDER, and that order is evidence: paragraphs under a heading belong to it. \`lists\` are lists the page wrote as lists — skills, specifications, sessions, features — each with the heading it sat under. A list is often the most concrete thing on a page; use it rather than flattening it into a sentence.
- \`structuredData\` is what the page's own publisher declared about itself. When it disagrees with the prose, prefer it for names, titles, prices, and dates. It is frequently absent, so never wait for it.
- THE USER CHOOSES the shape: a whole email, or one section added to the draft they are working on. When they already said which ("add a section from this", "turn this into an email"), do that. When they only shared a link, ${askForShapeStep}. Never guess between the two.
- The payload carries a READY SECTION PLAN in \`sections\`, already written from this page's own words and with its image addresses filled in. USE IT. For a whole email, pass those sections to createDraft as they are — do not re-plan the email from scratch, and do not rewrite copy that was drawn from the page into copy of your own.
- For a single section, take the one section from the plan that best matches what the user asked for and add it. When the plan is empty but the page was readable, hand-compose from \`blocks\` and \`lists\` with addSection.
- Never write an image address yourself. The sections' images are already stored on our servers. A section with no image means the page offered none we could use — leave it out rather than substituting a placeholder or an address you assembled.
- Each section carries a \`rationale\` saying what on the page it is. That is for you, not for the email — never put it in the copy.
- \`searchClaims\`, when present, are facts found BEYOND this page, each with the source that carried it. Use them only with that attribution, and never imply wider research than they represent. Their absence means nothing outside the page was consulted.
- If the result has isOk: false the page could not be read (the site's robots rules, a paywall, a bot block, nothing readable on it, unreachable). Relay the returned message in your own short words, make NO edits, and STOP. Inventing plausible content for a page you could not read is the one unforgivable failure here.
- If what came back is plainly not what the user was asking about, say so plainly and ask them which page they meant. Never build an email from a payload that is not about what they asked for.

## How sure the reading was (confidence)

The payload says what the page turned out to be (pageType, sourceSummary) and how much that reading can be trusted. Say what you read — "your portfolio at …" — rather than naming the tool.

- confidence "high": build, and name what you read in your reply.
- confidence "medium": build, AND relay uncertaintyNote in your own words and invite a correction. It names the one thing that was unclear, and the user is the only one who can settle it.
- confidence "low": isPlanUsable is false. Do NOT build anything. Relay message, and either ask which page they meant (with askForClarification when you have it) or say it in one sentence and stop. An empty answer is the correct answer here; a plausible email built from a page that could not be read is the worst outcome available to you.

pageType tells you what the page turned out to be. Use it to describe what you read; do not use it to decide what to build. What to build comes from what the page actually says.

## Images

The payload's images are already stored on our servers and each carries a role: portrait (one person), logo (an organization's mark), lead (the page's own main image), supporting (anything else). Use them as returned, with the alt text they carry.

- A portrait belongs where the email introduces the person, not decorating a later section.
- A logo is an identity mark, not a picture — do not stretch it across a hero.
- An empty images array means nothing on the page was worth keeping. Compose without images rather than substituting a placeholder or an address you assembled yourself.`;
}
