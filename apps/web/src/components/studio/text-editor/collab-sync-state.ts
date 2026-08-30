import type { EditorState, Plugin, Transaction } from "@tiptap/pm/state";

/*
  Read-only access to the prosemirror-collab plugin that
  `@convex-dev/prosemirror-sync`'s Tiptap extension installs (Phase 6.2b).

  Why not import `prosemirror-collab`: it is a transitive dependency of the
  sync component only (`@tiptap/pm` ships no `collab` entry point), and a
  second copy would create a second PluginKey that cannot see the sync
  extension's plugin state. Why not the literal key string `"collab$"`:
  PluginKey name registration is first-come-first-served PER PAGE — with
  parallel chunk loading another `new PluginKey("collab")` can claim
  `"collab$"` first, pushing the sync extension's key to `"collab$1"` (this
  genuinely differed between two tabs of the same build during
  verification). Instead, the collab plugin is located by its unmistakable
  STATE SHAPE — `{ version: number, unconfirmed: array }` — and its actual
  key string is read off the found plugin for transaction-meta lookups.
  Everything degrades to `null` if the shape is ever not found.
*/

interface CollabPluginState {
  version: number;
  unconfirmed: unknown[];
}

function isCollabPluginState(value: unknown): value is CollabPluginState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { version?: unknown }).version === "number" &&
    Array.isArray((value as { unconfirmed?: unknown }).unconfirmed)
  );
}

interface FoundCollabPlugin {
  pluginState: CollabPluginState;
  /*
    The plugin's registered key string (e.g. "collab$", "collab$1").
  */
  metaKey: string;
}

function findCollabPlugin(state: EditorState): FoundCollabPlugin | null {
  for (const plugin of state.plugins) {
    const pluginState: unknown = plugin.getState(state);
    if (isCollabPluginState(pluginState)) {
      /*
        Plugin.key is the registered key string (internal but stable across
        prosemirror-state versions; used only for getMeta lookups).
      */
      const metaKey = (plugin as Plugin & { key?: unknown }).key;
      return { pluginState, metaKey: typeof metaKey === "string" ? metaKey : "collab$" };
    }
  }
  return null;
}

/*
  The confirmed sync version of the editor's collab plugin state — the same
  number `collab.getVersion(state)` returns inside the sync extension. Null
  when the collab plugin is absent (e.g. an editor mounted without the sync
  extension).
*/
export function getCollabVersion(state: EditorState): number | null {
  return findCollabPlugin(state)?.pluginState.version ?? null;
}

/*
  The version at which the CURRENT doc's coordinates (and therefore the
  local selection) will be exact for other clients: confirmed version plus
  the editor's not-yet-confirmed local steps. Selection positions are
  computed against the local doc, which already contains those steps —
  broadcasting the bare confirmed version made receivers apply positions
  too early and then double-shift them when the steps arrived (verified
  drift under concurrent typing). If unconfirmed steps get rebased over
  concurrent remote steps this undercounts by design; the mapped selection
  change triggers a fresh broadcast, so the drift self-heals within a beat.
*/
export function getCollabSelectionVersion(state: EditorState): number | null {
  const found = findCollabPlugin(state);
  if (found === null) {
    return null;
  }
  return found.pluginState.version + found.pluginState.unconfirmed.length;
}

/*
  The confirmed collab version AFTER a transaction, computed from within a
  plugin's `StateField.apply`. `newState` cannot be used there: plugin state
  fields are filled in plugin order, and the collab field may not be
  populated yet when another plugin's apply runs (observed as null reads).
  Instead: a `receiveTransaction` stamps `{ version }` meta under the collab
  plugin's key — use it when present, else the version is unchanged from
  `oldState`.
*/
export function getCollabVersionAfter({
  transaction,
  oldState,
}: {
  transaction: Transaction;
  oldState: EditorState;
}): number | null {
  const found = findCollabPlugin(oldState);
  if (found === null) {
    return null;
  }
  const meta: unknown = transaction.getMeta(found.metaKey);
  const metaVersion = (meta as { version?: unknown } | null | undefined)?.version;
  return typeof metaVersion === "number" ? metaVersion : found.pluginState.version;
}

export interface RemoteStepRange {
  from: number;
  to: number;
}

export interface ReceivedRemoteSteps {
  /*
    Confirmed collab version BEFORE this transaction (steps window start).
  */
  fromVersion: number;
  /*
    Number of server steps this transaction confirmed (window length).
  */
  stepCount: number;
  /*
    Changed ranges in the transaction's FINAL doc coordinates.
  */
  ranges: RemoteStepRange[];
}

/*
  Detect a transaction produced by `collab.receiveTransaction` that applied
  doc-changing REMOTE steps, and extract (a) the server version window they
  confirmed — for clientId attribution via the `getSteps` query — and (b)
  the changed ranges in final-doc coordinates — for the agent-edit pulse.

  Rebase shape: when local unconfirmed steps exist, the transaction is
  [n inverted local, R remote, ≤n re-applied local] with `getMeta("rebased")
  === n`. We read ranges only from the remote span (a re-apply that failed
  shrinks the span estimate, so a slice of the remote steps may be missed —
  the pulse then under-covers, and the whole-block fallback still fires when
  nothing usable remains). Locally-echoed own steps never reach here: collab
  slices them off before building the transaction, leaving docChanged false.
*/
export function getReceivedRemoteSteps({
  transaction,
  oldState,
}: {
  transaction: Transaction;
  oldState: EditorState;
}): ReceivedRemoteSteps | null {
  const found = findCollabPlugin(oldState);
  if (found === null || !transaction.docChanged) {
    return null;
  }
  const collabMeta: unknown = transaction.getMeta(found.metaKey);
  const newVersion =
    typeof (collabMeta as { version?: unknown } | null | undefined)?.version === "number"
      ? (collabMeta as { version: number }).version
      : null;
  if (newVersion === null) {
    return null;
  }
  const fromVersion = found.pluginState.version;
  const stepCount = newVersion - fromVersion;
  if (stepCount <= 0) {
    return null;
  }

  const rebasedMeta: unknown = transaction.getMeta("rebased");
  const rebasedCount = typeof rebasedMeta === "number" ? rebasedMeta : 0;
  const remoteStart = rebasedCount;
  const remoteEnd = Math.max(remoteStart, transaction.steps.length - rebasedCount);

  const ranges: RemoteStepRange[] = [];
  for (let index = remoteStart; index < remoteEnd; index++) {
    const stepMap = transaction.mapping.maps[index];
    if (stepMap === undefined) {
      continue;
    }
    /*
      Map each step's touched range through the REMAINDER of the
      transaction's mapping so the range lands in final-doc coordinates.
    */
    const remainder = transaction.mapping.slice(index + 1);
    // eslint-disable-next-line max-params -- ProseMirror's StepMap.forEach callback signature
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push({
        from: remainder.map(newStart, -1),
        to: remainder.map(newEnd, 1),
      });
    });
  }
  return { fromVersion, stepCount, ranges };
}
