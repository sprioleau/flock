import { buildDocumentContext, buildToolGuidance, SYSTEM_STATIC } from "@flock/agent";
import type { BlockId, EmailDocument } from "@flock/email-sdk";
import { chatActionRegistry } from "./registry";

/*
  System context for the chat pipeline — composed from the packages/agent
  prompt layers (the Phase 3 integration; this module was the marked seam).

  Caching contract (see packages/agent/src/prompts/index.ts):

  - `staticInstructions` — layers (a) SYSTEM_STATIC + (b) buildToolGuidance,
    both byte-identical for EVERY request (the guidance is a pure function of
    the module-level registry). Sent as the `system` message, i.e. the FIRST
    tokens, so Gemini's implicit context caching gets a stable prefix.
  - `documentContext` — layer (c) buildDocumentContext: per-request fresh
    tokens (compressed outline + selection). Appended as the LAST user message
    so it never breaks the cached prefix (static system + conversation).
*/

export interface BuildSystemContextInput {
  doc: EmailDocument;
  selectedBlockId?: BlockId;
  /*
    Optional extra FRESH-layer line(s), e.g. the brand social-links context
    (brand-context.ts). Fresh data only — never part of the static prefix.
  */
  brandContextLine?: string | null;
  /*
    Optional fresh-layer saved-sections block (saved-sections-context.ts):
    the user's own reusable sections, advertised as scaffoldSection
    `saved:<id>` templateIds. Fresh data only — never the static prefix.
  */
  savedSectionsContext?: string | null;
}

export interface SystemContext {
  /*
    Static agent identity + document model + tool guidance. Cache-stable, sent first.
  */
  staticInstructions: string;
  /*
    Per-request document outline + selection. Fresh tokens, sent last.
  */
  documentContext: string;
}

/*
  Route-level static tail: HOW this transport attaches the per-request
  document view. Constant — safe inside the cached prefix.
*/
const DOCUMENT_CONTEXT_NOTE = `## Document context

The current document state is attached as the final user message, marked [DOCUMENT CONTEXT]. It is authoritative — trust it over anything earlier in the conversation. It is a compressed outline: text is truncated and most properties are omitted, so call getBlockDetails when an edit depends on a block's exact current contents. When the user says "this" or "the selected" block, use the id under "## Selection".`;

/*
  Route-level static tail: how the agent SPEAKS to the user, and what it
  refuses. Constant — safe inside the cached prefix.

  WHY THE HONESTY RULE LIVES HERE, AND ONLY HERE.

  createDraft's tool result is composed by the browser that built the drafts
  and is now truthful to the character: it names the drafts that landed and
  states, imperatively, which planned sections were rebuilt as something else
  or left out. Measured against a real portfolio URL, the model received
  exactly that and opened its reply "I've created three new drafts … complete
  with your headshot and details from your background, story, and selected
  projects". On another page it described a hero, an article section and
  testimonials that were not in the draft at all.

  The result was true and the prose was not, so the gap is precedence, not
  reporting. Three things in the prompt produced it:

  1. NOTHING GRANTED A TOOL RESULT AUTHORITY. DOCUMENT_CONTEXT_NOTE below says
     of the outline "It is authoritative — trust it over anything earlier in
     the conversation". Tool results had no such clause, so a standing rule
     beat a per-turn one, which is the ordering a model should be expected to
     apply.
  2. THE STANDING RULES POINTED AT THE PLAN. "tell the user in plain language
     what each one is" asks a question only the plan the model just sent can
     answer, and the source-page workflow's "name what you read in your reply"
     invited the source sentence that opened both bad replies. Fixed at the
     source in tool-guidance.ts; the plan-is-not-the-result law is stated once,
     below.
  3. THE ONLY FAITHFULNESS LAW WAS ABOUT THE EMAIL. "Compose ONLY from the
     returned payload … never add a fact" governs what goes INTO the draft.
     Neither bad reply added a fact to a draft — both added facts to the
     PROSE, which no rule covered.

  Written in the shape of the instructions this codebase does get obeyed:
  capitalised prohibitions, concrete forbidden examples, and a positive
  replacement, in the standing prompt rather than a tool result. Placed after
  all per-tool guidance so no bullet gets the last word on it, and kept out of
  SYSTEM_STATIC (shared with the personas route, which reports on no tools)
  and out of buildToolGuidance (every section there is gated on one action
  being registered).
*/
const USER_FACING_CONDUCT_NOTE = `## Talking to the user

Your visible replies must read like a helpful design partner, never an engineer's log:
- NEVER include block ids (sec_a1b2, btn_x9k3, "root", …), tool names, operation names, schema or validation details, batch ids, or any other internal identifiers in your prose. Ids are for tool calls only. Refer to blocks by what the user sees: "the button", "the headline", "the second section".
- Keep replies short and plain-language: say what you changed or found, not how the machinery did it.

## Only describe what the tools reported

A tool call is a REQUEST. Its result is the account of what actually happened, and that result is authoritative: it outranks the plan you sent, what you meant to build, and anything a source you read led you to expect. Read every result to the end before you write a word about it.

- NEVER describe a section, a draft, an image, a heading, or a line of copy the result did not confirm is there. Your own plan is not evidence that it landed. "I've built you a hero, an article section and testimonials" is a false sentence when the result says two of those three were left out — and the user sees the canvas, so it is a sentence you get caught in.
- When a result says something was left out, replaced with something else, filled from the user's existing work, or only partly done, SAY SO PLAINLY IN THAT SAME REPLY — in your opening sentences, not after a paragraph of what went well, and never dropped because the news is disappointing. Then offer to put it right.
- Naming a source you read ("from your portfolio at example.com") says where you looked. It is never a claim about what is in the result, and it never licenses describing content the result did not confirm.
- When you are unsure whether something is really there, leave it out of your reply. A short true sentence is worth more than a warm one the user stops believing the moment they look at their email.

## Scope

You ONLY help with this email — its content, structure, styling, previews, and test sends. If the user asks for anything else (general questions, code, other documents, unrelated tasks), reply with one short sentence explaining you can only help with editing this email, and do not call any tools for that request.`;

/*
  Layers (a) + (b) + the route notes, assembled ONCE at module load: all are
  constants for a given build, and pre-joining guarantees the byte-identical
  prefix Gemini's implicit caching keys on.
*/
const STATIC_INSTRUCTIONS = [
  SYSTEM_STATIC,
  buildToolGuidance(chatActionRegistry),
  USER_FACING_CONDUCT_NOTE,
  DOCUMENT_CONTEXT_NOTE,
].join("\n\n");

/*
  Build the two-layer system context for one request.
*/
export function buildSystemContext({
  doc,
  selectedBlockId,
  brandContextLine,
  savedSectionsContext,
}: BuildSystemContextInput): SystemContext {
  const documentContext = [
    "[DOCUMENT CONTEXT — auto-attached, not written by the user]",
    buildDocumentContext({ doc, options: { selectedBlockId } }),
    /*
      Fresh-layer brand context (item 26): appended after the outline so the
      cached static prefix stays byte-identical.
    */
    ...(brandContextLine === undefined || brandContextLine === null ? [] : [brandContextLine]),
    /*
      Fresh-layer saved sections (owner V2): same byte-identity contract.
    */
    ...(savedSectionsContext === undefined || savedSectionsContext === null
      ? []
      : [savedSectionsContext]),
  ].join("\n");

  return { staticInstructions: STATIC_INSTRUCTIONS, documentContext };
}
