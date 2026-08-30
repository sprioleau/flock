import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { getCollabVersion, getCollabVersionAfter } from "./collab-sync-state";

/*
  Phase 6.2b — remote cursors/selection highlights inside the per-block
  synced editor, rendered purely as VIEW-LAYER ProseMirror decorations (no
  schema or content changes, honoring the Phase 5 no-custom-content-plugins
  spirit).

  Data flow: the React layer filters the presence roster down to OTHER
  members whose `selection.blockId` is this block and pushes them in via
  `updateRemoteCursors` (a meta-only transaction — no steps, so the sync
  pipeline ignores it). The plugin keeps a DecorationSet plus a per-user
  fingerprint:

   - every transaction maps the existing decorations through `tr.mapping`,
     so carets stay anchored to the right characters between roster updates
     (local typing cannot make remote carets jitter);
   - a roster update rebuilds ONLY the users whose payload actually changed
     (fingerprint mismatch); unchanged users keep their mapped decorations —
     stale payloads can never yank a caret backwards;
   - a payload whose sync `version` is AHEAD of this editor's confirmed
     collab version is HELD (the previous decorations keep mapping) until
     the corresponding steps land, then applied at exact coordinates.
     Without the gate the decoration would be placed against the older doc
     and then double-shifted when the steps arrive (verified drift);
   - remote positions are clamped to the current doc size on rebuild
     (version-less or lagging payloads may momentarily disagree with the
     synced doc; the sibling hook's throttled rebroadcast self-corrects
     within a beat).

  Visuals: a `Decoration.inline` low-alpha highlight for anchor≠head ranges
  and a `Decoration.widget` caret (2px bar + name flag; the flag fades ~2s
  after that user's last selection change via a CSS animation that restarts
  only when the user's decoration DOM is rebuilt). See presence-cursors.css.
*/

export interface RemoteCursor {
  userId: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
  /*
    The sync (collab) version the positions were computed against.
  */
  version?: number;
  isAgent?: boolean;
}

interface RemoteCursorsState {
  decorations: DecorationSet;
  /*
    userId → payload fingerprint of the decorations currently in the set.
  */
  fingerprints: Map<string, string>;
  /*
    Payloads ahead of the local collab version, waiting for their steps.
  */
  heldAhead: Map<string, RemoteCursor>;
}

const remoteCursorsPluginKey = new PluginKey<RemoteCursorsState>("flockRemoteCursors");

/*
  Push the latest roster-derived cursor list into the editor's plugin.
*/
export function updateRemoteCursors({
  editor,
  cursors,
}: {
  editor: Editor;
  cursors: RemoteCursor[];
}): void {
  if (editor.isDestroyed) {
    return;
  }
  editor.view.dispatch(editor.state.tr.setMeta(remoteCursorsPluginKey, cursors));
}

export function createRemoteCursorsExtension(): Extension {
  return Extension.create({
    name: "flockRemoteCursors",
    addProseMirrorPlugins() {
      return [createRemoteCursorsPlugin()];
    },
  });
}

function createRemoteCursorsPlugin(): Plugin<RemoteCursorsState> {
  return new Plugin<RemoteCursorsState>({
    key: remoteCursorsPluginKey,
    state: {
      init: () => ({
        decorations: DecorationSet.empty,
        fingerprints: new Map(),
        heldAhead: new Map(),
      }),
      // eslint-disable-next-line max-params -- ProseMirror's StateField.apply signature
      apply: (transaction, value, oldState) => {
        /*
          Keep existing carets anchored through every transaction (local
          keystrokes, applied remote steps, rebases alike).
        */
        let decorations = value.decorations.map(transaction.mapping, transaction.doc);
        /*
          NOT read from newState: plugin fields fill in plugin order and the
          collab field may not be populated yet (see getCollabVersionAfter).
        */
        const localVersion = getCollabVersionAfter({ transaction, oldState });

        const cursors = transaction.getMeta(remoteCursorsPluginKey) as
          | RemoteCursor[]
          | undefined;

        if (cursors === undefined) {
          /*
            No roster update — but held-ahead payloads may have become
            applicable if this transaction confirmed their steps.
          */
          if (value.heldAhead.size === 0) {
            return { decorations, fingerprints: value.fingerprints, heldAhead: value.heldAhead };
          }
          const fingerprints = new Map(value.fingerprints);
          const heldAhead = new Map(value.heldAhead);
          const oldVersion = getCollabVersion(oldState);
          for (const [userId, cursor] of value.heldAhead) {
            if (isAheadOfLocalDoc({ cursor, localVersion })) {
              continue;
            }
            heldAhead.delete(userId);
            fingerprints.set(userId, buildFingerprint(cursor));
            decorations = removeUserDecorations({ decorations, userId });
            /*
              The releasing transaction may confirm steps BEYOND the
              payload's version in one batch (steps sync in batches); map
              the positions through exactly the tail of the transaction the
              payload has not seen, or they land stale by the overshoot.
            */
            const released = mapReleasedCursor({ cursor, transaction, oldVersion });
            decorations = decorations.add(
              transaction.doc,
              buildCursorDecorations({ cursor: released, doc: transaction.doc }),
            );
          }
          return { decorations, fingerprints, heldAhead };
        }

        const fingerprints = new Map<string, string>();
        const heldAhead = new Map<string, RemoteCursor>();
        const liveUserIds = new Set(cursors.map((cursor) => cursor.userId));
        for (const userId of value.fingerprints.keys()) {
          if (!liveUserIds.has(userId)) {
            decorations = removeUserDecorations({ decorations, userId });
          }
        }
        for (const cursor of cursors) {
          const fingerprint = buildFingerprint(cursor);
          const previousFingerprint = value.fingerprints.get(cursor.userId);
          if (previousFingerprint === fingerprint) {
            /*
              Unchanged payload: keep the mapped decorations (no rebuild →
              no jitter, and the flag's fade timeline is not restarted).
            */
            fingerprints.set(cursor.userId, fingerprint);
            continue;
          }
          if (isAheadOfLocalDoc({ cursor, localVersion })) {
            /*
              The payload references steps this editor hasn't confirmed yet:
              hold it (the user's previous decorations keep mapping) and
              apply at exact coordinates once the steps land.
            */
            heldAhead.set(cursor.userId, cursor);
            if (previousFingerprint !== undefined) {
              fingerprints.set(cursor.userId, previousFingerprint);
            }
            continue;
          }
          fingerprints.set(cursor.userId, fingerprint);
          decorations = removeUserDecorations({ decorations, userId: cursor.userId });
          decorations = decorations.add(
            transaction.doc,
            buildCursorDecorations({ cursor, doc: transaction.doc }),
          );
        }
        return { decorations, fingerprints, heldAhead };
      },
    },
    props: {
      decorations(state) {
        return remoteCursorsPluginKey.getState(state)?.decorations;
      },
    },
  });
}

function buildFingerprint(cursor: RemoteCursor): string {
  return `${cursor.anchor}|${cursor.head}|${cursor.version ?? "-"}|${cursor.name}|${cursor.color}`;
}

/*
  Map a held payload's positions into the releasing transaction's final doc.

  A held payload's coordinates are exact at server version `cursor.version`
  WITHOUT this editor's own unconfirmed steps. A collab receive-transaction
  is laid out as [n inverted local, remote steps for oldVersion+1.., ≤n
  re-applied local] — so the doc after (n inversions + `version − oldVersion`
  remote steps) is exactly the doc the payload describes. Mapping through
  the REMAINDER of the transaction (later remote steps + re-applied local
  steps) lands the positions in final coordinates. Falls back to raw
  positions (clamped downstream) when the window can't be established.
*/
function mapReleasedCursor({
  cursor,
  transaction,
  oldVersion,
}: {
  cursor: RemoteCursor;
  transaction: Transaction;
  oldVersion: number | null;
}): RemoteCursor {
  if (
    cursor.version === undefined ||
    oldVersion === null ||
    cursor.version < oldVersion ||
    !transaction.docChanged
  ) {
    return cursor;
  }
  const rebasedMeta: unknown = transaction.getMeta("rebased");
  const rebasedCount = typeof rebasedMeta === "number" ? rebasedMeta : 0;
  const alreadySeenSteps = rebasedCount + (cursor.version - oldVersion);
  if (alreadySeenSteps >= transaction.mapping.maps.length) {
    return cursor;
  }
  const remainder = transaction.mapping.slice(alreadySeenSteps);
  return {
    ...cursor,
    anchor: remainder.map(cursor.anchor, -1),
    head: remainder.map(cursor.head, -1),
  };
}

/*
  True when the payload's sync version is newer than what this editor has
  confirmed — rendering it now would double-shift once the steps arrive.
*/
function isAheadOfLocalDoc({
  cursor,
  localVersion,
}: {
  cursor: RemoteCursor;
  localVersion: number | null;
}): boolean {
  return cursor.version !== undefined && localVersion !== null && cursor.version > localVersion;
}

function removeUserDecorations({
  decorations,
  userId,
}: {
  decorations: DecorationSet;
  userId: string;
}): DecorationSet {
  return decorations.remove(
    decorations.find(undefined, undefined, (spec) => spec.userId === userId),
  );
}

function buildCursorDecorations({
  cursor,
  doc,
}: {
  cursor: RemoteCursor;
  doc: PmNode;
}): Decoration[] {
  /*
    Clamp: presence payloads can momentarily reference an older doc.
  */
  const maxPos = doc.content.size;
  const anchor = clampPosition(cursor.anchor, maxPos);
  const head = clampPosition(cursor.head, maxPos);

  const built: Decoration[] = [
    Decoration.widget(head, () => buildCaretElement(cursor), {
      key: `caret|${cursor.userId}|${buildFingerprint(cursor)}`,
      userId: cursor.userId,
      side: -1,
      ignoreSelection: true,
    }),
  ];
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  if (from < to) {
    built.push(
      Decoration.inline(
        from,
        to,
        {
          class: "flock-remote-selection",
          style: `--flock-presence-color: ${cursor.color}`,
        },
        { userId: cursor.userId },
      ),
    );
  }
  return built;
}

function buildCaretElement(cursor: RemoteCursor): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "flock-remote-caret";
  caret.style.setProperty("--flock-presence-color", cursor.color);
  const flag = document.createElement("span");
  flag.className = "flock-remote-caret__flag";
  flag.textContent = cursor.isAgent === true ? `✦ ${cursor.name}` : cursor.name;
  caret.appendChild(flag);
  return caret;
}

/*
  Clamp a (possibly stale) remote position into the current doc: [0, maxPos].
*/
function clampPosition(position: number, maxPos: number): number {
  return Math.max(0, Math.min(position, maxPos));
}
