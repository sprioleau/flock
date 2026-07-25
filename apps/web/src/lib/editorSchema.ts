/**
 * Shared Tiptap/ProseMirror schema module.
 *
 * Imported by BOTH the client editor (apps/web/src/app/spike/sync) and the
 * Convex backend (convex/prosemirror.ts, via a relative import). The server-side
 * transform API needs the exact same schema the client editor uses, so this is
 * the single source of truth for schema-affecting extensions.
 *
 * It also solves a monorepo resolution problem: the root-level convex/ dir
 * cannot resolve @tiptap/* (they are only installed in apps/web), but esbuild
 * and tsc both resolve node_modules by walking up from THIS file's location.
 */
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

/** Schema-affecting extensions. The client adds the sync extension on top. */
export const editorExtensions = [StarterKit];

/** Build the ProseMirror schema matching the client editor. */
export function buildEditorSchema() {
  return getSchema(editorExtensions);
}

// Re-exported so convex/ code can use ProseMirror transforms without needing
// @tiptap/pm resolvable from the repo root.
export { Transform } from "@tiptap/pm/transform";
