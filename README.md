# Tandem

**What email creation looks like when humans and agents are the same kind of collaborator.**

Tandem is a collaborative email studio where you don't just get an AI assistant bolted onto an editor — you get a room. You edit on a live canvas; a copilot builds alongside you from plain language; a crew of advisory agents reads your drafts on a cadence and leaves reviewable recommendations; and other humans (and their agents) can be in the document at the same time, cursors and all. Every change — human click, copilot edit, agent suggestion — flows through the same validated, invertible operations, so you can see who did what, apply anything with one click, and revert anything just as fast.

This is a working preview of a future-facing idea: software where agents are first-class collaborators with visible presence and editable expertise, and the human is always in control.

## The feature set

| Category | Feature | What it does |
|---|---|---|
| **The Canvas** | Multi-draft canvas | Work on several drafts side by side as frames on one canvas — the active draft is a full live editor, siblings render as live previews. Duplicate a draft to explore a variation, promote one to its own canvas, delete the dead ends, and copy a link that drops a collaborator straight onto any draft or canvas. |
| | Direct manipulation | Drag-and-drop blocks — within the canvas or straight from the palette, where every tile drags — plus floating block toolbars (move, duplicate, delete) and property panels with instant feedback: sliders, color pickers, font dropdowns. |
| | Rich text, block by block | Full rich text inside every text block: per-paragraph alignment, span-level styling — font family, size, color, highlight, links — and a one-click heading preset. Button labels edit right on the canvas. |
| | A full block set | Text, image, button, columns, divider — plus link, code, and spacer blocks. New drafts open on a polished starter email. |
| | Section gallery | Eighteen categorized section templates — headers, heroes, feature layouts, product, pricing, testimonials, stats, footers, and more — rendered as live previews in your current theme. Drag one in or click to add; the copilot composes from the same catalog. |
| | Saved sections | Save any section you like and reuse it anywhere. A manager lists your library with usage counts, each saved section carries an AI-written note on when it fits, and the copilot reaches for your sections when composing. |
| | Keyboard-first | ⌘B and ⌘\ toggle the panels, ⌘K jumps to chat, `/` summons a quick prompt from anywhere, and holding `A` turns your cursor into a block stamp. |
| | Dark mode | Light, Dark, or System — the whole studio follows. |
| | Viewport toggle | Flip any frame between desktop and mobile widths. |
| **The AI Copilot** | Chat that edits the document | Describe what you want; the copilot streams validated edit operations onto the canvas in real time. Invalid tool calls are repaired automatically before they ever touch the document. |
| | Whole emails, streamed in sections | Ask for a full email and it assembles section by section, streaming onto the canvas as each part lands — you watch the email build instead of waiting for it. |
| | AI image generation | Generate images for image blocks from a prompt, with an instant in-canvas preview. Every generation lands in a session asset library in the header, ready to browse and reuse. |
| | Article ingestion | Point the copilot at a public article or web page; it pulls the content in cleanly — title, byline, source — with attribution and a link back to the original built into the workflow. |
| | Canvas-to-chat handoff | Send a selected block or text span straight into the chat composer, queue multiple requests, and recall your prompt history. |
| **The Agent Crew** | Proactive advisory personas | Four built-in reviewers — **Tone Police**, **Styling Recommender**, **QA Reviewer**, and **Date Checker** — read your drafts on a cadence and surface findings as recommendations, not silent edits. |
| | Visible agent presence | Agents aren't invisible processes. They appear in the header alongside humans, wear pentagon avatars (humans stay circles), and move live cursors across the canvas showing what they're reading, thinking about, and presenting. |
| | Editable expertise | Every persona's behavior is data, not code — open the structured editor and change what an agent cares about. Editing a built-in forks your own copy; the original stays intact. |
| | You set the pace | An eagerness slider controls how often agents sweep, a pause switch stops them entirely, and a **Check now** button triggers a full review on demand. |
| | Reviewable recommendations | Findings arrive in a tray with a badge — apply any suggestion with one click, revert it just as easily, dismiss all at once, and browse each agent's full history in a per-agent modal. Findings persist and converge across tabs. |
| | Ask in chat | When a finding calls for judgment rather than a one-click fix, hand it to the copilot as a ready-made prompt and work it out in conversation. |
| | Affordable to leave on | Each persona watches only the parts of the document it cares about, and lightweight heartbeat checks decide when a change actually warrants a full review — so the crew stays cheap while it stays vigilant. |
| **Multiplayer** | Humans together | Live named cursors, a presence facepile, and per-block collaborative rich text — two people can type in the same paragraph. |
| | Agents in the same room | AI edits merge through the same server-side transform as human keystrokes, so the copilot can restyle a paragraph *while you're typing in it* without clobbering your cursor. |
| | Ghost collaborator | A simulated teammate for solo demos — real presence, real cursor, so you can see multiplayer without a second person. |
| **History & Trust** | One append-only history | Every mutation from every collaborator lands in a single operation log with authorship — you can always answer "who changed this, and was it a human or an agent?" |
| | Undo, redo, revert | Undo/redo that never rewrites history, plus per-batch revert: unwind any past change — yours, the copilot's, or an agent's — without touching everything after it. |
| | Time travel | Restore the document to any point in time, or scrub through its entire history and watch it replay like a movie. Before/after chips show each change at a glance, in human language. |
| | Op inspector | For the curious: a live console showing every raw operation and its inverse as they happen. |
| **Brand & Theme** | Brand kit from a URL | Type your website address — with or without the `https://` — and Tandem extracts your palette (including signature accents), logo, brand name, social card, and social links, and builds a theme from it. |
| | Assets you approve | Extracted logos and images arrive as proposals — nothing joins your kit until you confirm it. Your social links can fill the email footer in one click. |
| | Brand colors everywhere | Your brand palette shows up as swatches inside every color picker in the studio, so on-brand is always one click away. |
| | Live theming | Pick a theme and every draft follows it live; override any global and snap back cleanly. |
| **Output & Sending** | Email-safe HTML | One click exports battle-tested, email-client-safe HTML, previewable in a sandboxed pane. |
| | Real sending, human-approved | Send yourself a test in one click from the header, delivered via Resend. The agent can prepare a send too — but only a human releases it, after an explicit approval step. |

## The primitives (why this works)

Most editors bolt AI on and hope. Tandem's core was designed so that humans and agents are the same kind of collaborator — the primitives are not hostile to agents, and everything above falls out of five of them:

- **One append-only operation log with provenance.** Every change from every actor is an operation with an author. There is no second history for AI edits; undo, revert, audit, and time travel all read from the same spine.
- **Pure operations with exact inverses.** Applying an operation never mutates state and always returns its inverse — even cascading deletes invert cleanly. Undo, per-batch revert, and point-in-time restore aren't features that were built; they're consequences.
- **Intent-level actions, validated before anything lands.** Agents don't write raw document JSON. They express intent through a small set of typed actions that are schema-validated, integrity-checked, and translated deterministically — a malformed agent call is repaired or rejected before the document ever sees it.
- **Presence that treats agents as first-class.** Cursors, rooms, and facepiles don't distinguish "user" from "bot" at the infrastructure level — an agent joins a document the way a person does. That's why agent activity is *visible* instead of ambient and spooky.
- **Personas as pure data.** An agent's expertise is a markdown document with a structured shape — readable, editable, forkable, and shareable. Built-ins are just the ones that ship in the box.

The through-line: the human is always in control. Every agent action is a proposal or a logged, attributed, one-click-revertible operation. Nothing is irreversible, and nothing is anonymous.

## Stack

- **Next.js** (App Router, canary) + **React 19**
- **TypeScript 7** (native compiler); the `typescript` package intentionally aliases the TS6 API shim (`@typescript/typescript6`) so API-dependent tooling (ESLint, Vitest, editors) keeps working while `tsc` itself is TS7-native
- **Tailwind 4** + **shadcn/ui**
- **Convex** — data, presence, file storage, and `@convex-dev/prosemirror-sync` for collaborative text
- **AI SDK v7** + **Gemini** (`@ai-sdk/google`)
- **React Email 6** — email-safe HTML rendering
- **Resend** — real email delivery
- **Zod 4**, **pnpm workspaces**

## Repo layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js app — studio canvas, chat panel, personas, presence, API routes |
| `packages/email-sdk` | The core: schemas, flat block store + integrity checks, pure operations with inverses, action envelope/registry, section catalog, renderers |
| `packages/agent` | Agent-side machinery: compressed document views, prompts, intent-level tools (web content fetch, span styling, section scaffolding) |
| `convex/` | Convex functions — documents, op-log history, personas and findings, presence, prosemirror-sync, brand kits, cleanup crons |

## Getting started

```bash
corepack enable            # pnpm is pinned via package.json's packageManager field
pnpm install               # registry pinned to public npm in .npmrc

cp apps/web/.env.example apps/web/.env.local   # fill in values
npx convex dev --once      # provisions dev deployment, writes Convex vars to .env.local

pnpm dev                   # root script (runs apps/web); or run from apps/web
# open http://localhost:3000/studio
```

Useful commands:

- `pnpm demo` (in `packages/email-sdk`) — builds an email from ops and emits valid HTML
- `pnpm test` (in `packages/email-sdk`) — Vitest; needs Node >= 20.19
- `pnpm typecheck` / `pnpm lint` / `pnpm build` — run across the workspace from the root (same steps as CI)

**`/api/render` contract:** `POST /api/render` with `{ document }` (a flat block map) returns `{ html }` — email-safe HTML rendered through React Email — or a structured 400 on schema/integrity failures.

## Deployment

- **Vercel** — deployed via CLI with `rootDirectory` set to `apps/web`: https://tandem-one-neon.vercel.app
- **Convex** — separate prod deployment; its URL/deploy key are wired into Vercel env vars

Deployed builds sit behind a lightweight password gate; capability links pass straight through.
