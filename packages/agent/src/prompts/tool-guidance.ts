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
  // cache-stable. Resolved early: the web-content workflow's "ask the user"
  // step names the clarification widget only when it is registered.
  const hasWidgetTools = registry.actionsByName.has("askForClarification");
  // Phase 7.4(a) web-content workflow: faithfulness, attribution, and honest
  // failure rules for building from a fetched URL. Only advertised while the
  // host app has injected the fetchWebContent executor.
  const hasFetchWebContentTool = registry.actionsByName.has("fetchWebContent");
  const webContentWorkflow = hasFetchWebContentTool
    ? `\n\n${buildWebContentWorkflow({ hasClarificationTool: hasWidgetTools })}`
    : "";
  // Phase 7.4(b) person-spotlight workflow: same faithfulness law, sharpened
  // because the subject is a person. Only advertised while the host app has
  // injected the fetchPersonHighlight executor.
  const hasPersonHighlightTool = registry.actionsByName.has("fetchPersonHighlight");
  const personHighlightWorkflow = hasPersonHighlightTool ? `\n\n${PERSON_HIGHLIGHT_WORKFLOW}` : "";
  /*
    Slice 1 routing rule: which of the two page readers to call. It can only
    be stated when BOTH are registered — naming a tool the registry does not
    have is how a model gets told to call something that does not exist.
    Placed BEFORE the two workflows so the choice is read before either
    workflow's "call this FIRST" line. Constant text — cache-stable.
  */
  const hasBothPageReaders = hasFetchWebContentTool && hasPersonHighlightTool;
  const sourcePageRouting = hasBothPageReaders ? `\n\n${SOURCE_PAGE_ROUTING}` : "";
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
  return `## Available tools\n\n${catalogHint}${lines.join("\n")}${sectionCatalogListing}${sourcePageRouting}${webContentWorkflow}${personHighlightWorkflow}${draftCompositionWorkflow}${capabilitySummary}${widgetGuidance}`;
}

/*
  Which page reader to call. The defect this exists to prevent, in the owner's
  own words: "create a new draft based on my portfolio website: sprioleau.dev.
  Pull in the images and details about me." That ran through fetchWebContent —
  an article extractor — and produced the stock starter email, because nothing
  in the prompt divided the space the request lands in and both descriptions
  split on what the USER CALLED the page rather than what the page is about.

  Two rules do the work here: subject decides, and when a page is both a
  person and their work, the person wins. A portfolio is nearly always both,
  so a rule that merely "prefers" one would leave the ambiguous case exactly
  where it was.

  Constant text so the cached prefix stays byte-identical. Appended only when
  BOTH page readers are registered (see buildToolGuidance).
*/
const SOURCE_PAGE_ROUTING = `## Which page reader to call (fetchWebContent or fetchPersonHighlight)

Both tools read ONE public URL. Choose by WHAT THE PAGE IS ABOUT, never by the word the user used for it.

- A page about ONE PERSON — a personal site or portfolio, an about page, a profile, a bio, a staff or faculty page — is fetchPersonHighlight.
- A page about A TOPIC OR AN EVENT — a news article, a blog post, release notes, docs, an announcement — is fetchWebContent.
- "Make an email from my site", "from my portfolio", "based on my personal website", "about me", "details about me", "who I am", or a bare personal domain with no path (janedoe.com, jane.dev) is the FIRST case. Call fetchPersonHighlight. These are ordinary phrasings, not article requests, and reading them as article requests is the specific mistake this rule exists to stop.
- A personal site is usually BOTH: a bio AND write-ups of the person's work. When both descriptions fit, THE PERSON WINS — call fetchPersonHighlight. fetchWebContent is for a page that would still be the same page if someone else had written it: one specific post or article, linked directly, that the user asked you to turn into an email about ITS subject.
- The user's words break the tie in one direction only. An ask about the person ("about me", "introduce them", "who they are") makes it a person page whatever the URL looks like. An ask about a subject the page happens to cover does NOT turn a personal homepage into an article.
- If the payload that comes back is plainly not what the user asked about — prose with no name in it when they asked for an email about themselves — say so and call the other tool once. Never build the email from a payload that is not about what they asked for.
- fetchPersonHighlight returns one portrait, a name, a role, an organization, a bio, and attributed facts. It does not return a skills list, project cards, or company logos. Build from what it returned and tell the user plainly what their page did not give you — do not invent the rest.`;

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
 * prefix stays byte-identical. Appended only when fetchWebContent is
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

function buildWebContentWorkflow({
  hasClarificationTool,
}: {
  hasClarificationTool: boolean;
}): string {
  // The user picks the shape (plan §7.4: "the user chooses"). With the
  // clarification widget registered the question is a widget call; without it,
  // one plain-language question and a stop.
  const askForShapeStep = hasClarificationTool
    ? `call askForClarification with the question "Should this become a whole email, or one new section?" and the options "A whole email" and "One new section", then stop and wait for their answer`
    : `ask them in one short question whether they want a whole email or one new section, then stop and wait for their answer`;
  return `## Building from a web page (fetchWebContent)

When the user shares a URL and asks you to build content from it, call fetchWebContent FIRST — never write about a page you have not fetched in this conversation.

- Compose ONLY from the returned payload. Condense the real mainText faithfully; never add facts, quotes, names, or numbers that are not in it. If mainText was truncated, work with what you have — do not guess at the rest.
- THE USER CHOOSES the shape: a whole email, or one section added to the draft they are working on. When they already said which ("add a section from this", "turn this into an email"), do that. When they only shared a link, ${askForShapeStep}. Never guess between the two.
- Hand-compose with addSection (not scaffoldSection — templates cannot carry a real image URL or link): a heading with the real title, one or two short paragraphs condensed from mainText, the returned heroImageUrl as an image (with meaningful alt text) when there is one, and ALWAYS a button labeled like "Read the full story" whose href is the returned canonicalUrl. Naming the source (sourceName) in the copy is good practice.
- For a whole email, that is several addSection calls telling the story in order — headline section, body sections, a closing section with the read-the-full-story link — still built only from the payload.
- Use heroImageUrl exactly as returned and only when it is present; it is already stored on our servers. A missing image means the page had none we could use — leave the image out rather than substituting a placeholder or an address you assembled yourself.
- If the result has isOk: false, the page could not be read (blocked by the site's robots rules, paywalled, not an article, unreachable). Relay the returned message to the user in your own short words, make NO edits, and STOP — inventing plausible content for an unread page is the one unforgivable failure here.
- If confidence is "low", tell the user the page was hard to read and the section may need their review.`;
}

/**
 * The §7.4(b) person-spotlight rules. Constant text so the cached prefix stays
 * byte-identical. Appended only when fetchPersonHighlight is registered.
 */
const PERSON_HIGHLIGHT_WORKFLOW = `## Spotlighting a person (fetchPersonHighlight)

When the user links someone's profile and asks for an intro, spotlight, or highlight of them, call fetchPersonHighlight FIRST — never write about a person from memory or inference.

- Write ONLY what the payload supports: the name, role, and organization as given, the bio as returned, and the listed facts. Every fact carries the page it came from; a claim with no fact behind it does not go in the email.
- Attribute: the section ALWAYS links back to profileUrl (a button or link like "See their full profile"). When a fact came from a different page than the profile, name that source in the copy.
- searchStatus tells you how wide the evidence is. "unavailable" means nothing beyond the profile page was consulted — write a spotlight from that page alone and do not imply wider research.
- Use photoUrl exactly as returned, with alt text naming the person. When it is absent there is no usable photo: compose without an image and never describe how they look.
- Never guess at pronouns, titles, achievements, or dates. If the user wants something the payload does not support, say what is missing and ask them for it.
- If the result has isOk: false, the profile could not be read. Relay the returned message, make NO edits, and STOP.`;
