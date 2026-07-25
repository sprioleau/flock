---
name: convex-dev-prosemirror-sync
description: Add a collaborative editor sync engine for the popular ProseMirror-based Tiptap and BlockNote rich text editors. Use this skill whenever working with Collaborative Text Editor Sync or related Convex component functionality.
version: 0.2.5
---

> Agents: read this skill fully before writing code that uses Collaborative Text Editor Sync. Follow the installation and configuration steps exactly.

# Collaborative Text Editor Sync

## Instructions

This component adds collaborative document editing to your Convex app using ProseMirror's operational transformation engine. It provides React hooks for Tiptap and BlockNote editors that automatically sync document changes between clients through your Convex database. The component handles conflict resolution, debounced snapshots for performance, and server-side document transformations for AI integration.

### Installation

```bash
npm install @convex-dev/prosemirror-sync
```

Current npm version: `@convex-dev/prosemirror-sync@0.2.5`

## Use cases

- **Building a collaborative document editor** where multiple users need to edit the same document simultaneously across different devices or browser tabs
- **Adding rich text editing to multi-user apps** like project management tools, note-taking apps, or content management systems that require real-time collaboration
- **Integrating AI-powered document features** where you need to programmatically modify documents server-side while users are actively editing
- **Creating offline-capable editors** that allow users to start editing new documents before connecting to the server and sync changes when back online
- **Building document-centric workflows** where you need the document data stored alongside other app data in your Convex database for queries and relationships

## How it works

You install the component in your `convex.config.ts` file, then expose the sync API through a Convex function that calls methods like `getSnapshot`, `submitSteps`, and `latestVersion` from the `ProsemirrorSync` class. The component uses operational transformations to safely merge concurrent edits between clients.

On the frontend, you use either `useBlockNoteSync` or `useTiptapSync` React hooks that handle document fetching, real-time syncing via a Tiptap extension, and local state management. The hooks provide a `create()` method for new documents and return either a ready-to-use editor instance or loading states.

The component automatically creates debounced snapshots (configurable via `snapshotDebounceMs`) to optimize performance for new clients joining a document. It includes built-in warnings for unsynced changes when closing tabs and supports server-side document transformations through the `transform()` method, which accepts ProseMirror Transform objects for programmatic document modifications.

## When NOT to use

- When a simpler built-in solution exists for your specific use case
- If you are not using Convex as your backend
- When the functionality provided by Collaborative Text Editor Sync is not needed

## Resources

- [npm package](https://www.npmjs.com/package/%40convex-dev%2Fprosemirror-sync)
- [GitHub repository](https://github.com/get-convex/prosemirror-sync)
- [Convex Components Directory](https://www.convex.dev/components/prosemirror-sync)
- [Convex documentation](https://docs.convex.dev)