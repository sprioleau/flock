import type {
  AskForClarificationInput,
  ListAssetsInput,
  ProposeEditsInput,
  ProposeSectionVariationsInput,
} from "@flock/agent";
import type {
  BlockId,
  CreateDraftInput,
  CreatePersonaInput,
  GoToVersionInput,
  OpenPanelInput,
  RedoInput,
  ScaffoldSectionInput,
  SendTestEmailInput,
  ShowPreviewInput,
  UiPanel,
  UndoInput,
  UpdateBlockPropertiesOperation,
} from "@flock/email-sdk";
import type { ReadWebPageResult } from "@flock/agent";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  GENERATION_REQUEST_DATA_PART_TYPE,
  type FlockChatMessage,
} from "@/lib/chat-contract";
import {
  composeScrapedSection,
} from "@/lib/content-ingestion/compose-scraped-section";

/*
  Deterministic mock chat model (no API key needed — CI/tests use this via
  the x-flock-mock header; it is also the automatic fallback when
  GOOGLE_GENERATIVE_AI_API_KEY is absent).

  It emits the SAME provider-spec (LanguageModelV4) chunk sequence a real
  Gemini stream produces — text deltas, then tool-input-start, repeated
  tool-input-delta, tool-input-end, and a tool-call — so everything downstream
  (streamText input validation, UI-chunk
  conversion, SSE transport, editor-action execute, client gate) is the real
  pipeline. Chunk shapes copied from node_modules/ai/docs (v4 finishReason /
  usage shapes), per the Spike C finding: do not write these from memory.

  Scripted behavior, keyed off the last user message:
  - mentions "malformed tool calls" → the item-20 reliability probe: one
    tool call whose args arrive as a STRINGIFIED JSON envelope (the observed
    live Gemini mangle — must be silently recovered by the pre-validation
    unwrap) plus one with unparseable truncated args (must degrade to a
    single failure chip without killing the turn; the repair re-ask against
    this mock throws, exercising the repairer's never-throw path)
  - mentions "schema-invalid tool call" → one addSection call whose args
    PARSE but fail the Zod schema, in the exact shape of the live production
    failure (see SCHEMA_INVALID_PROBE_REGEX). Exercises the observability
    records that carry validation issue codes and paths.
  - mentions "reviewer comment(s)"  → updateBlockProperties acknowledging a
    comments-mode fix turn (the comment-dispatch prompts embed the phrase)
  - mentions preview/mobile/desktop → showPreview editor tool call
  - mentions "test email"           → sendTestEmail (exercises approval flow)
  - contains a URL                  → readWebPage with that URL (the
    server then performs the REAL fetch + extraction — Phase 7.4a seam)
  - contains a saved-section id ("saved:<rowId>") → scaffoldSection with
    that saved templateId (the owner-V2 saved-sections compose seam)
  - asks for a "full email" (or whole/entire/complete email) → the
    per-section streaming script: FOUR sequential scaffoldSection calls
    (header, hero, feature-columns, footer), each streamed as its own
    tool-input-start → deltas → tool-call sequence with real inter-chunk
    delays — the probe that pins "section 1 is applied before section N is
    even generated" (see pipeline-streaming.test.ts)
  - asks to add a section (e.g. "add a hero section") → scaffoldSection with
    the mentioned catalog templateId (exercises the Phase 7.2 scaffold seam)
  - widget scripts (generative UI, one per widget): "clarify"/"make it pop" →
    askForClarification; "variations"/"alternatives" →
    proposeSectionVariations; "improve"/"suggestions"/"feedback"/"review" →
    proposeEdits; "what images…"/"my library" → listAssets
  - otherwise → updateBlockProperties on the selected block (fallback
    btn_t9u0, the sample document's button), setting its label.

  The model is multi-step aware: the first doStream call emits the tool call;
  any later call (e.g. the step after an editor tool executed) emits a short
  closing text with finishReason "stop", so stopWhen loops terminate.
*/

export interface CreateMockChatModelInput {
  lastUserText: string;
  selectedBlockId?: BlockId;
  /*
    True when this request is an auto-continuation carrying tool results
    (the conversation already ends with an assistant message). The mock then
    emits ONLY the closing text — without this, every continuation round
    re-plans the same tool call and non-idempotent ops (scaffoldSection)
    would apply once per round.
  */
  isContinuationRequest?: boolean;
  /*
    How many sections the document already has — where a composed 7.4 section
    is appended. Absent means "append at the top" (an empty draft).
  */
  rootSectionCount?: number;
}

interface MockToolCallPlan {
  toolName: string;
  input:
    | ShowPreviewInput
    | SendTestEmailInput
    | ScaffoldSectionInput
    | UpdateBlockPropertiesOperation
    | OpenPanelInput
    | UndoInput
    | RedoInput
    | GoToVersionInput
    | CreateDraftInput
    | CreatePersonaInput
    | AskForClarificationInput
    | ProposeSectionVariationsInput
    | ProposeEditsInput
    | ListAssetsInput
    | { url: string };
  acknowledgementText: string;
}

/*
  openPanel keyword table for the scripted mock: first phrase found in the
  user message wins (order matters — "recommendations history" must match
  before "history"). Names mirror the human words for each surface.
*/
const MOCK_PANEL_KEYWORDS: readonly { pattern: RegExp; panel: UiPanel; label: string }[] = [
  { pattern: /\btheme\b/i, panel: "theme", label: "theme picker" },
  { pattern: /\bbrand\b/i, panel: "brand-kit", label: "brand kit" },
  /*
    "content studio" stays as a MATCHED alias (the feature's old name) but
    the spoken label is the user-facing one: Asset Library.
  */
  { pattern: /\blibrary|content studio\b/i, panel: "library", label: "asset library" },
  { pattern: /\bpersonas?\b|\bagents?\b/i, panel: "agents", label: "agent personas" },
  { pattern: /\brecommendations?\b/i, panel: "recommendations", label: "recommendations history" },
  { pattern: /\bhistory\b|\bversions?\b/i, panel: "history", label: "version history" },
  { pattern: /\bblocks?\b/i, panel: "blocks", label: "blocks tab" },
  { pattern: /\bpropert/i, panel: "properties", label: "properties tab" },
  { pattern: /\bsend[ -]?test\b|\btest email\b/i, panel: "send-test", label: "send-test dialog" },
];

/*
  English count words the createDraft script understands, beyond digits.
*/
const MOCK_COUNT_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  a: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

/*
  The createDraft composition script: section shapes the mock cycles through
  so several drafts in one call differ the way the live model is told to make
  them differ (a plain hero in one, a split hero in another).
*/
const MOCK_DRAFT_SHAPES: readonly string[][] = [
  ["header", "hero", "feature-columns", "cta", "footer"],
  ["header-centered", "hero-split", "article", "footer-social"],
  ["header", "testimonial", "hero", "stats", "footer"],
  ["header-centered", "article", "image-gallery", "cta", "footer-social"],
  ["header", "hero", "testimonial-columns", "footer"],
];

/*
  Draft names the mock gives its plans — the angle, not "Draft N".
*/
const MOCK_DRAFT_ANGLES = [
  "Bold and direct",
  "Story first",
  "Social proof",
  "Visual showcase",
  "Short and warm",
] as const;

/*
  Turn the user's own words into a subject line the composed drafts can talk
  about ("Create a new draft about our spring sale" → "our spring sale"), so
  the mock exercises the same copy-carrying path a live model would.
*/
function extractMockDraftSubject(lastUserText: string): string | null {
  const match = lastUserText.match(/\b(?:about|for|on)\s+([^.?!]{3,60})/i);
  return match?.[1]?.trim() ?? null;
}

function buildMockDraftPlans({
  count,
  lastUserText,
}: {
  count: number;
  lastUserText: string;
}): CreateDraftInput["drafts"] {
  const subject = extractMockDraftSubject(lastUserText);
  return Array.from({ length: count }, (_unused, index) => {
    const shape = MOCK_DRAFT_SHAPES[index % MOCK_DRAFT_SHAPES.length]!;
    return {
      name: MOCK_DRAFT_ANGLES[index % MOCK_DRAFT_ANGLES.length]!,
      sections: shape.map((templateId) => ({
        templateId,
        ...(subject !== null && (templateId === "hero" || templateId === "hero-split")
          ? { params: { headline: `A fresh take on ${subject}` } }
          : {}),
      })),
    };
  });
}



/*
  Catalog templateIds the mock recognizes by keyword in the user message.
*/
const MOCK_SCAFFOLD_TEMPLATE_IDS = [
  "header",
  "hero",
  "feature-columns",
  "article",
  "image-gallery",
  "testimonial",
  "stats",
  "footer",
] as const;

/*
  What a comment-fix turn actually WRITES, keyed off what the reviewer asked
  for.

  The branch below used to answer every comment with one fixed label, which is
  fine for a test asserting that the seam runs and useless in front of a
  person: a surface whose whole claim is "the agent answered what you said"
  cannot answer three different things identically. These are the same
  keyword-scripted rules the rest of this mock is built from (see the header),
  one level deeper — the reviewer's own words reach the model verbatim inside
  the dispatch prompt (comment-dispatch.ts quotes the thread), so matching on
  them is matching on the real input.

  The fallback is the previous behaviour, untouched: a comment this table has
  no opinion about is still acknowledged and still marks the turn.
*/
const MOCK_COMMENT_FIX_EDITS: readonly {
  pattern: RegExp;
  label: string;
  acknowledgementText: string;
}[] = [
  {
    pattern: /\b(?:shorter|shorten|too long|tighten|trim)\b/i,
    label: "Reserve yours",
    acknowledgementText: "Tightening that label so it fits on a phone.",
  },
  {
    pattern: /\b(?:pushy|pressure|urgent|softer|soften|warmer|friendlier|gentler)\b/i,
    label: "Reserve when you're ready",
    acknowledgementText: "Softening that label to match the tone of the rest of the letter.",
  },
  {
    pattern: /\b(?:specific|clearer|spell out|say what)\b/i,
    label: "Reserve a bag of the spring lot",
    acknowledgementText: "Making that label say exactly what is being reserved.",
  },
];

/*
  The label + acknowledgement a comment-fix turn resolves to.
*/
export function planCommentFixEdit(lastUserText: string): {
  label: string;
  acknowledgementText: string;
} {
  const match = MOCK_COMMENT_FIX_EDITS.find(({ pattern }) => pattern.test(lastUserText));
  if (match === undefined) {
    return {
      label: "Addressed reviewer feedback",
      acknowledgementText: "Addressing the reviewer feedback on the canvas now.",
    };
  }
  return { label: match.label, acknowledgementText: match.acknowledgementText };
}

/*
  Exported so the routing it performs is directly testable. What is worth
  testing here is not that a particular phrase maps to a particular tool, but
  that PHRASING NO LONGER DECIDES ANYTHING — /demo forces this mock
  server-side, so a mock that routed on wording would keep reproducing the
  original defect long after the real path stopped having it.
*/
export function planMockToolCall({
  lastUserText,
  selectedBlockId,
}: CreateMockChatModelInput): MockToolCallPlan {
  /*
    Comments-mode fix dispatch (checked FIRST: the prompt embeds the
    reviewer's own words, which could otherwise trip any keyword below):
    both dispatch shapes contain "reviewer comment(s)" by construction
    (comment-dispatch.ts). One deterministic content op marks the turn.
  */
  if (/\breviewer comments?\b/i.test(lastUserText)) {
    const commentFix = planCommentFixEdit(lastUserText);
    return {
      toolName: "updateBlockProperties",
      input: {
        name: "updateBlockProperties",
        blockId: selectedBlockId ?? ("btn_t9u0" as BlockId),
        properties: { label: commentFix.label },
      },
      acknowledgementText: commentFix.acknowledgementText,
    };
  }
  /*
    Agent-parity scripts (checked before the preview/test-email intents so
    "open the test email dialog" opens the dialog rather than sending):
  */
  const hasOpenIntent = /\bopen\b|\bshow me\b/i.test(lastUserText);
  if (hasOpenIntent) {
    const panelMatch = MOCK_PANEL_KEYWORDS.find(({ pattern }) => pattern.test(lastUserText));
    if (panelMatch !== undefined) {
      return {
        toolName: "openPanel",
        input: { panel: panelMatch.panel },
        acknowledgementText: `Opening the ${panelMatch.label} for you.`,
      };
    }
  }
  if (/\bundo\b/i.test(lastUserText)) {
    return {
      toolName: "undo",
      input: {},
      acknowledgementText: "Undoing the last change.",
    };
  }
  if (/\bredo\b/i.test(lastUserText)) {
    return {
      toolName: "redo",
      input: {},
      acknowledgementText: "Redoing the change.",
    };
  }
  const versionMatch = lastUserText.match(
    /\b(?:go (?:back )?to|restore|roll ?back(?: to)?)\b[\s\S]*\bversion\s*#?(\d+)/i,
  );
  if (versionMatch !== null) {
    const version = Number(versionMatch[1]);
    return {
      toolName: "goToVersion",
      input: { version },
      acknowledgementText: `Restoring version ${version} — approve to continue.`,
    };
  }
  /*
    The qualifier run repeats: "3 drafts", "3 new drafts" and "3 new blank
    drafts" all have to resolve the same count. A single optional qualifier
    stops at the first word and silently falls through to count 1.
  */
  const draftMatch = lastUserText.match(
    /\b(?:create|make|start|new)\b[\s\S]*?\b(?:(\d+)|(\w+))?\s*(?:(?:new|blank|empty|starter)\s+)*drafts?\b/i,
  );
  if (draftMatch !== null) {
    const count =
      draftMatch[1] !== undefined
        ? Number(draftMatch[1])
        : (MOCK_COUNT_WORDS[draftMatch[2]?.toLowerCase() ?? ""] ?? 1);
    /*
      "blank"/"empty" keeps the bare count form (starter drafts to fill in).
      Anything else is a request for a real email, so the mock plans one the
      way the live model is instructed to: a complete header/body/footer
      email per draft, and genuinely different plans when asked for several.
    */
    if (/\bblank\b|\bempty\b|\bstarter\b/i.test(lastUserText)) {
      return {
        toolName: "createDraft",
        input: count === 1 ? {} : { count },
        acknowledgementText:
          count === 1 ? "Creating a new blank draft." : `Creating ${count} new blank drafts.`,
      };
    }
    return {
      toolName: "createDraft",
      input: { drafts: buildMockDraftPlans({ count, lastUserText }) },
      acknowledgementText:
        count === 1
          ? "Putting a new draft together for you."
          : `Putting ${count} new drafts together for you.`,
    };
  }
  if (/\b(?:create|make|add)\b[\s\S]*\bpersona\b/i.test(lastUserText)) {
    const name =
      lastUserText.match(/persona\s+(?:named|called)\s+["“']?([^"”'.,]+)["”']?/i)?.[1]?.trim() ??
      "Accessibility Advocate";
    return {
      toolName: "createPersona",
      input: {
        name,
        description: `Reviews the email as a ${name.toLowerCase()}.`,
        behavior: `You are the ${name}. Review each change to the email and leave short, specific recommendations from your specialty's point of view.`,
      },
      acknowledgementText: `Creating the "${name}" persona.`,
    };
  }
  /*
    --- Generative-UI widget scripts (one per widget — quota-free QA) --------
    askForClarification: "clarify"-family words or the canonical vague ask.
  */
  if (/\bclarif\w*\b|\bmake it pop\b/i.test(lastUserText)) {
    return {
      toolName: "askForClarification",
      input: {
        question: "What kind of “pop” are you going for?",
        options: [
          "Bolder colors",
          "Bigger headline",
          "More breathing room",
          "Add an eye-catching image",
        ],
      },
      acknowledgementText: "Happy to — quick question first.",
    };
  }
  /*
    proposeSectionVariations: variations/alternatives asks.
  */
  if (/\bvariations?\b|\balternatives?\b|\bdifferent takes\b/i.test(lastUserText)) {
    return {
      toolName: "proposeSectionVariations",
      input: {
        intent: "A few different directions for this section",
        variations: [
          {
            title: "Bold announcement",
            templateId: "hero",
            params: { headline: "Big news is on the way" },
          },
          {
            title: "Story first",
            templateId: "article",
            params: { headline: "The story behind the launch" },
          },
          { title: "Social proof", templateId: "testimonial" },
        ],
      },
      acknowledgementText: "Here are a few directions — pick the one you like.",
    };
  }
  /*
    proposeEdits: improvement/feedback asks (no direct-change verb needed —
    the scripted mock keys off the review vocabulary alone).
  */
  if (/\bimprove\b|\bsuggestions?\b|\bfeedback\b|\breview\b/i.test(lastUserText)) {
    const suggestionBlockId = selectedBlockId ?? ("btn_t9u0" as BlockId);
    return {
      toolName: "proposeEdits",
      input: {
        suggestions: [
          {
            title: "Stronger call to action",
            description: "Tell readers exactly what they get when they click.",
            edits: [
              { blockId: suggestionBlockId, property: "label", value: "Start your free trial" },
            ],
          },
          {
            title: "Send clicks somewhere useful",
            description: "Point the button at your signup page.",
            edits: [
              { blockId: suggestionBlockId, property: "href", value: "https://example.com/signup" },
            ],
          },
        ],
      },
      acknowledgementText: "A couple of ways to strengthen this email.",
    };
  }
  /*
    listAssets: questions about the session's image library.
  */
  if (
    /\b(?:what|which|list|show)\b[\s\S]*\b(?:images?|assets?|photos?)\b/i.test(lastUserText) ||
    /\bmy library\b/i.test(lastUserText)
  ) {
    return {
      toolName: "listAssets",
      input: {},
      acknowledgementText: "Checking your library.",
    };
  }
  const hasPreviewIntent = /\b(preview|mobile|desktop|viewport)\b/i.test(lastUserText);
  if (hasPreviewIntent) {
    const mode = /\bdesktop\b/i.test(lastUserText) ? ("desktop" as const) : ("mobile" as const);
    return {
      toolName: "showPreview",
      input: { mode },
      acknowledgementText: `Switching the canvas to the ${mode} preview.`,
    };
  }
  if (/\btest email\b/i.test(lastUserText)) {
    /*
      Sends are REAL since Phase 8.1 — never invent a third-party address.
      Use the address in the message, else Resend's safe test inbox.
    */
    const to =
      lastUserText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] ?? "delivered@resend.dev";
    return {
      toolName: "sendTestEmail",
      input: { to },
      acknowledgementText: `Requesting a test send to ${to}.`,
    };
  }
  /*
    A URL in the message → the ingestion tool. Checked BEFORE the scaffold
    intent: "make a section from this <url>" must fetch, not scaffold
    placeholder content. The server executes the REAL fetch + extraction, so
    tests exercise the whole read-only tool seam.

    There used to be a fifteen-keyword regex here deciding WHICH reader to
    call, because there were two. It was the only keyword matcher on user
    phrasing anywhere in the system, and it existed solely so the mock would
    agree with a routing rule that was itself a rule about phrasings. With one
    reader there is nothing to route, and it goes away as a consequence of the
    architecture rather than as a cleanup somebody had to remember.
  */
  const urlMatch = lastUserText.match(/https?:\/\/[^\s"'<>)]+/i);
  if (urlMatch !== null) {
    return {
      toolName: "readWebPage",
      input: { url: urlMatch[0] },
      acknowledgementText: "Reading that page now.",
    };
  }
  /*
    A saved-section id in the message → scaffoldSection with the saved
    templateId (owner V2 item 3): exercises the widened schema through the
    server validation gate and the client's saved-scaffold intercept.
  */
  const savedSectionIdMatch = lastUserText.match(/\bsaved:[a-z0-9]+\b/i);
  if (savedSectionIdMatch !== null) {
    return {
      toolName: "scaffoldSection",
      input: {
        name: "scaffoldSection",
        templateId: savedSectionIdMatch[0],
        position: "bottom",
        params: {},
      },
      acknowledgementText: "Adding your saved section.",
    };
  }
  const hasScaffoldIntent = /\b(add|insert|scaffold)\b[\s\S]*\bsection\b/i.test(lastUserText);
  if (hasScaffoldIntent) {
    const templateId =
      MOCK_SCAFFOLD_TEMPLATE_IDS.find((candidate) =>
        new RegExp(`\\b${candidate.replace("-", "[ -]?")}`, "i").test(lastUserText),
      ) ?? "hero";
    const position = /\btop\b/i.test(lastUserText) ? ("top" as const) : ("bottom" as const);
    return {
      toolName: "scaffoldSection",
      input: { name: "scaffoldSection", templateId, position, params: {} },
      acknowledgementText: `Adding a ${templateId} section from the catalog.`,
    };
  }
  const blockId = selectedBlockId ?? ("btn_t9u0" as BlockId);
  return {
    toolName: "updateBlockProperties",
    input: {
      name: "updateBlockProperties",
      blockId,
      properties: { label: lastUserText.slice(0, 40) || "Updated" },
    },
    /*
      Block ids are never user-facing — keep the prose generic.
    */
    acknowledgementText: "Updating the selected block.",
  };
}

/*
  Item-20 reliability probe (see the header): the EXACT malformed shapes from
  the live failure, scripted. Call 1's raw argument text is a JSON-ENCODED
  STRING of the whole envelope (name embedded) — the pre-validation unwrap
  must recover it into a normally-applied op. Call 2's raw text is truncated
  garbage — unrepairable by construction (this mock has no doGenerate, so the
  repair re-ask throws), and must cost exactly one failure chip while the
  turn survives.
*/
const MALFORMED_PROBE_REGEX = /\bmalformed tool calls\b/i;

/*
  Schema-invalid probe: args that PARSE as JSON and then fail the tool's Zod
  schema — the other half of the malformed space, and the one the malformed
  probe above cannot reach (its two calls fail at JSON parse time, so they
  produce no Zod issue list at all).

  The scripted payload is the real production failure, verbatim in shape: an
  `addSection` call where the model wrapped `children[0].text` in a
  `type: "text"` envelope instead of using `properties`, omitted `childrenIds`
  and `properties`, and got the `name` discriminator wrong. It exists so the
  observability records that carry Zod issue codes and paths
  (flock.chat.toolInputRejected) can be exercised without a provider call.
*/
const SCHEMA_INVALID_PROBE_REGEX = /\bschema-invalid tool call\b/i;

/*
  Full-email compose script: intent regex + the sections it streams, in
  reading order. Checked BEFORE the single-section scaffold intent ("build
  the whole email" must not degrade to one hero section).
*/
const COMPOSE_EMAIL_REGEX = /\b(?:full|whole|entire|complete)\s+email\b/i;

/**
 * The phrase a drafts-menu generation request contributes to the mock's intent
 * text (see {@link readMockIntentText}). Worded to match
 * {@link COMPOSE_EMAIL_REGEX}, which is the whole point of it.
 */
const GENERATION_REQUEST_INTENT_TEXT = "Design a complete email.";

/**
 * What the mock reads as the user's intent, from the last user message.
 *
 * Two sources, joined. The message's own TEXT parts are what the person typed.
 * A `data-generation-request` part contributes
 * {@link GENERATION_REQUEST_INTENT_TEXT}, because an "Ideate with AI" / "Add
 * design variation" send now reaches the thread as a short sentence and the
 * brief the LIVE model reads is assembled server-side (generation-brief.ts) —
 * the mock has no such assembly step. Without this, the compose script above
 * would stop firing for those actions and the mock would scaffold ONE section
 * where the real pipeline streams a whole email.
 *
 * It lives here rather than in the route, and never in the user-facing copy,
 * so that UI wording is never shaped by what a test double greps for.
 */
export function readMockIntentText(messages: FlockChatMessage[]): string {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  if (lastUserMessage === undefined) {
    return "";
  }
  const typedText = lastUserMessage.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
  const hasGenerationRequest = lastUserMessage.parts.some(
    (part) => part.type === GENERATION_REQUEST_DATA_PART_TYPE,
  );
  return hasGenerationRequest
    ? `${typedText} ${GENERATION_REQUEST_INTENT_TEXT}`.trim()
    : typedText;
}

export const MOCK_COMPOSE_EMAIL_TEMPLATE_IDS = [
  "header",
  "hero",
  "feature-columns",
  "footer",
] as const;

/*
  The per-section streaming chunk sequence: one scaffoldSection call per
  template, each with its own tool-input-start → 16-char deltas →
  tool-input-end → tool-call. With simulateReadableStream's per-chunk delay
  this reproduces the shape (and pacing) of a real model composing a full
  email section by section — downstream, section 1's validated call reaches
  the client while section N's input is still being generated.
*/
function buildComposeEmailChunks() {
  const perSectionChunks = MOCK_COMPOSE_EMAIL_TEMPLATE_IDS.flatMap((templateId, index) => {
    const toolCallId = `call_${crypto.randomUUID()}`;
    const inputJson = JSON.stringify({
      name: "scaffoldSection",
      templateId,
      position: "bottom" as const,
      params: {},
    });
    const inputDeltas: string[] = [];
    for (let sliceStart = 0; sliceStart < inputJson.length; sliceStart += 16) {
      inputDeltas.push(inputJson.slice(sliceStart, sliceStart + 16));
    }
    return [
      ...(index === 0
        ? [
            { type: "text-start" as const, id: "text-1" },
            {
              type: "text-delta" as const,
              id: "text-1",
              delta: "Building the email one section at a time.",
            },
            { type: "text-end" as const, id: "text-1" },
          ]
        : []),
      { type: "tool-input-start" as const, id: toolCallId, toolName: "scaffoldSection" },
      ...inputDeltas.map((delta) => ({
        type: "tool-input-delta" as const,
        id: toolCallId,
        delta,
      })),
      { type: "tool-input-end" as const, id: toolCallId },
      {
        type: "tool-call" as const,
        toolCallId,
        toolName: "scaffoldSection",
        input: inputJson,
      },
    ];
  });
  return [
    ...perSectionChunks,
    {
      type: "finish" as const,
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 25, text: 10, reasoning: undefined },
      },
    },
  ];
}

function buildMalformedProbeChunks(selectedBlockId: BlockId | undefined) {
  const blockId = selectedBlockId ?? ("btn_t9u0" as BlockId);
  const recoverableEnvelope = JSON.stringify(
    JSON.stringify({
      name: "updateBlockProperties",
      blockId,
      properties: { label: "Unwrapped OK" },
    }),
  );
  const unparseableArgs = '{"name":"updateBlockProperties","blockId":';
  return [
    { type: "text-start" as const, id: "text-1" },
    {
      type: "text-delta" as const,
      id: "text-1",
      delta: "Sending one recoverable and one broken tool call.",
    },
    { type: "text-end" as const, id: "text-1" },
    {
      type: "tool-call" as const,
      toolCallId: `call_${crypto.randomUUID()}`,
      toolName: "updateBlockProperties",
      input: recoverableEnvelope,
    },
    {
      type: "tool-call" as const,
      toolCallId: `call_${crypto.randomUUID()}`,
      toolName: "updateBlockProperties",
      input: unparseableArgs,
    },
    {
      type: "finish" as const,
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 25, text: 10, reasoning: undefined },
      },
    },
  ];
}

function buildSchemaInvalidProbeChunks() {
  /*
    Parseable JSON, wrong SHAPE — see SCHEMA_INVALID_PROBE_REGEX.
  */
  const schemaInvalidArgs = JSON.stringify({
    name: "section",
    section: { id: "sec_probe", type: "section", parentId: "root" },
    index: 0,
    children: [{ id: "txt_probe", type: "text", parentId: "sec_probe", text: { type: "text", text: "Hello" } }],
  });
  return [
    { type: "text-start" as const, id: "text-1" },
    {
      type: "text-delta" as const,
      id: "text-1",
      delta: "Sending one tool call whose arguments parse but fail the schema.",
    },
    { type: "text-end" as const, id: "text-1" },
    {
      type: "tool-call" as const,
      toolCallId: `call_${crypto.randomUUID()}`,
      toolName: "addSection",
      input: schemaInvalidArgs,
    },
    {
      type: "finish" as const,
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 25, text: 10, reasoning: undefined },
      },
    },
  ];
}

/*
  ---------------------------------------------------------------------------
  Phase 7.4 compose step (the mock standing in for the model)
  ---------------------------------------------------------------------------
*/

/*
  The ingestion tool result this mock composes from.
*/
interface IngestionToolResult {
  result: ReadWebPageResult;
}

/*
  Find the newest ingestion tool result in the prompt the SDK just handed us.
  Analysis tools execute server-side and their JSON output comes back as a
  tool-result part on the NEXT step of the same request — so on step 2 the
  mock is looking at the page the server really fetched.
*/
function findIngestionToolResult(prompt: unknown): IngestionToolResult | null {
  if (!Array.isArray(prompt)) {
    return null;
  }
  for (let messageIndex = prompt.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = (prompt[messageIndex] as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex] as {
        type?: string;
        toolName?: string;
        output?: { type?: string; value?: unknown };
      };
      if (part.type !== "tool-result" || part.output?.type !== "json") {
        continue;
      }
      const data = (part.output.value as { isFound?: boolean; data?: unknown } | undefined)?.data;
      if (data === undefined) {
        continue;
      }
      if (part.toolName === "readWebPage") {
        return { result: data as ReadWebPageResult };
      }
    }
  }
  return null;
}

/*
  The 7.4 compose step, scripted: turn the REAL fetched payload into one
  addSection call — or, when the page could not be read, into a plain-language
  relay of the refusal and NOTHING ELSE.

  That second branch is the deterministic proof of the plan's hardest rule:
  a blocked, paywalled, or robots-disallowed URL costs the document zero
  edits. The mock has the same information the model would have, and makes
  the same choice the guidance demands of it.
*/
function buildIngestionComposeChunks({
  ingestion,
  rootSectionCount,
}: {
  ingestion: IngestionToolResult;
  rootSectionCount: number;
}) {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 25, text: 10, reasoning: undefined },
  };
  const refusalMessage = ingestion.result.isOk ? null : ingestion.result.message;
  if (refusalMessage !== null) {
    return [
      { type: "text-start" as const, id: "text-refusal" },
      { type: "text-delta" as const, id: "text-refusal", delta: refusalMessage },
      { type: "text-end" as const, id: "text-refusal" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
    ];
  }
  /*
    Narrowed by refusalMessage === null above.
  */
  const operation = composeScrapedSection({
    page: (ingestion.result as { isOk: true; page: never }).page,
    index: rootSectionCount,
  });
  const acknowledgement = "Adding a section built from that page.";
  const toolCallId = `call_${crypto.randomUUID()}`;
  const inputJson = JSON.stringify(operation);
  return [
    { type: "text-start" as const, id: "text-compose" },
    { type: "text-delta" as const, id: "text-compose", delta: acknowledgement },
    { type: "text-end" as const, id: "text-compose" },
    { type: "tool-input-start" as const, id: toolCallId, toolName: "addSection" },
    { type: "tool-input-end" as const, id: toolCallId },
    {
      type: "tool-call" as const,
      toolCallId,
      toolName: "addSection",
      input: inputJson,
    },
    {
      type: "finish" as const,
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage,
    },
  ];
}

export function createMockChatModel(input: CreateMockChatModelInput) {
  const isContinuationRequest = input.isContinuationRequest ?? false;
  const isMalformedProbe = MALFORMED_PROBE_REGEX.test(input.lastUserText);
  const isSchemaInvalidProbe = SCHEMA_INVALID_PROBE_REGEX.test(input.lastUserText);
  const isComposeEmailProbe = COMPOSE_EMAIL_REGEX.test(input.lastUserText);
  const plan = planMockToolCall(input);
  const inputJson = JSON.stringify(plan.input);
  /*
    Unique per request — clients dedupe applied ops by toolCallId (Spike C).
  */
  const toolCallId = `call_${crypto.randomUUID()}`;
  const inputDeltas: string[] = [];
  for (let index = 0; index < inputJson.length; index += 16) {
    inputDeltas.push(inputJson.slice(index, index + 16));
  }

  let doStreamCallCount = 0;

  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 25, text: 10, reasoning: undefined },
  };

  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      doStreamCallCount += 1;
      const isFirstStep = doStreamCallCount === 1 && !isContinuationRequest;
      /*
        Step 2 of a 7.4 turn: the server has really fetched the page and the
        payload is in the prompt. Compose from it, or relay the refusal.
        Continuation ROUNDS are excluded — the section was already composed in
        the round that fetched, and addSection is not idempotent.
      */
      const ingestion = isContinuationRequest ? null : findIngestionToolResult(prompt);
      if (ingestion !== null) {
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: 20,
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "response-metadata" as const,
                id: `mock-response-${doStreamCallCount}`,
                modelId: "flock-mock-chat-model",
                timestamp: new Date(0),
              },
              ...buildIngestionComposeChunks({
                ingestion,
                rootSectionCount: input.rootSectionCount ?? 0,
              }),
            ],
          }),
        };
      }
      if (isMalformedProbe && isFirstStep) {
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: 20,
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "response-metadata" as const,
                id: `mock-response-${doStreamCallCount}`,
                modelId: "flock-mock-chat-model",
                timestamp: new Date(0),
              },
              ...buildMalformedProbeChunks(input.selectedBlockId),
            ],
          }),
        };
      }
      if (isSchemaInvalidProbe && isFirstStep) {
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: 20,
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "response-metadata" as const,
                id: `mock-response-${doStreamCallCount}`,
                modelId: "flock-mock-chat-model",
                timestamp: new Date(0),
              },
              ...buildSchemaInvalidProbeChunks(),
            ],
          }),
        };
      }
      if (isComposeEmailProbe && isFirstStep) {
        return {
          stream: simulateReadableStream({
            chunkDelayInMs: 20,
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "response-metadata" as const,
                id: `mock-response-${doStreamCallCount}`,
                modelId: "flock-mock-chat-model",
                timestamp: new Date(0),
              },
              ...buildComposeEmailChunks(),
            ],
          }),
        };
      }
      /*
        One array literal (conditional spreads) so TS infers a single chunk
        union for simulateReadableStream's generic across both step shapes.
      */
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: 20,
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            {
              type: "response-metadata" as const,
              id: `mock-response-${doStreamCallCount}`,
              modelId: "flock-mock-chat-model",
              timestamp: new Date(0),
            },
            ...(isFirstStep
              ? [
                  { type: "text-start" as const, id: "text-1" },
                  { type: "text-delta" as const, id: "text-1", delta: plan.acknowledgementText },
                  { type: "text-end" as const, id: "text-1" },
                  { type: "tool-input-start" as const, id: toolCallId, toolName: plan.toolName },
                  ...inputDeltas.map((delta) => ({
                    type: "tool-input-delta" as const,
                    id: toolCallId,
                    delta,
                  })),
                  { type: "tool-input-end" as const, id: toolCallId },
                  {
                    type: "tool-call" as const,
                    toolCallId,
                    toolName: plan.toolName,
                    input: inputJson,
                  },
                  {
                    type: "finish" as const,
                    finishReason: { unified: "tool-calls" as const, raw: undefined },
                    usage,
                  },
                ]
              : [
                  { type: "text-start" as const, id: "text-2" },
                  { type: "text-delta" as const, id: "text-2", delta: "Done." },
                  { type: "text-end" as const, id: "text-2" },
                  {
                    type: "finish" as const,
                    finishReason: { unified: "stop" as const, raw: undefined },
                    usage,
                  },
                ]),
          ],
        }),
      };
    },
  });
}
