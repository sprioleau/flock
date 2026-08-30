/*
  Shared Tiptap/ProseMirror schema module.

  Imported by BOTH the client editor and the Convex backend
  (convex/prosemirror.ts, via a relative import). The server-side sync and
  transform APIs need the EXACT same schema the client editor uses, so this
  module re-exports the inline text editor's extension set (the Resend
  editor's reduced StarterKit, text-block-extensions.ts) as the single source
  of truth: doc > (paragraph | heading 1-3) > (text | hardBreak), with
  bold / italic / underline / strike / link marks.

  It also solves a monorepo resolution problem: the root-level convex/ dir
  cannot resolve @tiptap/* or @react-email/editor (pnpm isolated
  node_modules; they are only installed in apps/web), but esbuild (the Convex
  bundler) and tsc both resolve node_modules by walking up from THIS file's
  location.
*/
import { getSchema } from "@tiptap/core";
import { createTextBlockExtensions } from "../components/studio/text-editor/text-block-extensions";

/*
  Schema-affecting extensions. The client adds the sync extension on top.
*/
export const editorExtensions = createTextBlockExtensions();

/*
  Build the ProseMirror schema matching the client editor.
*/
export function buildEditorSchema() {
  return getSchema(editorExtensions);
}

/*
  Re-exported so convex/ code can use ProseMirror transforms without needing
  @tiptap/pm resolvable from the repo root.
*/
export { Transform } from "@tiptap/pm/transform";
