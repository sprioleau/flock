import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  getReceivedRemoteSteps,
  type RemoteStepRange,
} from "./collab-sync-state";

/*
  Phase 6.2b — the agent-edit pulse (merge-notify part 2): when steps
  authored by the AI agent land in the local synced editor, flash a brief
  (~1s, background-only, zero layout shift) highlight over the changed
  range so the user SEES the agent edit merge mid-typing.

  Attribution: prosemirror-collab does not surface step clientIds on the
  transactions it builds, so the plugin records each received remote-step
  window ({fromVersion, stepCount}, extracted in collab-sync-state.ts) as a
  PENDING pulse, and the plugin view asks the React layer's
  `resolveClientIds` (a one-shot `api.prosemirror.getSteps` query — the
  server pairs every stored step with its clientId) whether the window
  contains AI_AGENT_CLIENT_ID steps. Pending ranges are mapped through
  every intervening transaction, so the pulse lands on the right characters
  even if the user keeps typing during the ~1 roundtrip of attribution.
  Nothing here touches the keystroke path: detection is a pure read on
  already-dispatched transactions, and the query fires only when remote
  steps arrive.

  Fallback: if the agent's ranges collapse to nothing renderable (pure
  deletions in a shrunken doc), the whole block's inline content shimmers
  instead (`flock-agent-pulse--block`).
*/

/*
  Mirrors AI_AGENT_CLIENT_ID in convex/model/textBlockSync.ts (the convex
  model file cannot be imported into the client bundle).
*/
const AGENT_CLIENT_ID = "flock-agent";

const PULSE_DURATION_MS = 1000;

export type ResolveClientIds = (window: {
  fromVersion: number;
  stepCount: number;
}) => Promise<Array<string | number>>;

interface PendingPulse {
  id: number;
  fromVersion: number;
  stepCount: number;
  ranges: RemoteStepRange[];
}

interface AgentPulseState {
  pending: PendingPulse[];
  decorations: DecorationSet;
}

type AgentPulseAction =
  | { type: "activate"; id: number }
  | { type: "drop"; id: number }
  | { type: "clear"; id: number };

const agentPulsePluginKey = new PluginKey<AgentPulseState>("flockAgentPulse");

let nextPulseId = 1;

export function createAgentPulseExtension({
  resolveClientIds,
}: {
  resolveClientIds: ResolveClientIds;
}): Extension {
  return Extension.create({
    name: "flockAgentPulse",
    addProseMirrorPlugins() {
      return [createAgentPulsePlugin({ resolveClientIds })];
    },
  });
}

function createAgentPulsePlugin({
  resolveClientIds,
}: {
  resolveClientIds: ResolveClientIds;
}): Plugin<AgentPulseState> {
  return new Plugin<AgentPulseState>({
    key: agentPulsePluginKey,
    state: {
      init: () => ({ pending: [], decorations: DecorationSet.empty }),
      // eslint-disable-next-line max-params -- ProseMirror's StateField.apply signature
      apply: (transaction, value, oldState) => {
        let decorations = value.decorations.map(transaction.mapping, transaction.doc);
        let pending = value.pending;

        /*
          Keep not-yet-attributed ranges anchored through concurrent edits.
        */
        if (transaction.docChanged && pending.length > 0) {
          pending = pending.map((pulse) => ({
            ...pulse,
            ranges: pulse.ranges.map((range) => ({
              from: transaction.mapping.map(range.from, -1),
              to: transaction.mapping.map(range.to, 1),
            })),
          }));
        }

        const received = getReceivedRemoteSteps({ transaction, oldState });
        if (received !== null) {
          pending = [...pending, { id: nextPulseId++, ...received }];
        }

        const action = transaction.getMeta(agentPulsePluginKey) as
          | AgentPulseAction
          | undefined;
        if (action !== undefined) {
          if (action.type === "activate") {
            const pulse = pending.find((candidate) => candidate.id === action.id);
            pending = pending.filter((candidate) => candidate.id !== action.id);
            if (pulse !== undefined) {
              decorations = decorations.add(
                transaction.doc,
                buildPulseDecorations({ pulse, doc: transaction.doc }),
              );
            }
          } else if (action.type === "drop") {
            pending = pending.filter((candidate) => candidate.id !== action.id);
          } else {
            decorations = decorations.remove(
              decorations.find(undefined, undefined, (spec) => spec.pulseId === action.id),
            );
          }
        }

        return { pending, decorations };
      },
    },
    props: {
      decorations(state) {
        return agentPulsePluginKey.getState(state)?.decorations;
      },
    },
    view: (editorView) => {
      const requestedPulseIds = new Set<number>();
      const clearTimers = new Set<ReturnType<typeof setTimeout>>();

      const dispatchAction = (action: AgentPulseAction): void => {
        if (editorView.isDestroyed) {
          return;
        }
        editorView.dispatch(editorView.state.tr.setMeta(agentPulsePluginKey, action));
      };

      const attributePulse = (pulse: PendingPulse): void => {
        resolveClientIds({ fromVersion: pulse.fromVersion, stepCount: pulse.stepCount })
          .then((clientIds) => {
            const hasAgentSteps = clientIds
              .slice(0, pulse.stepCount)
              .includes(AGENT_CLIENT_ID);
            if (!hasAgentSteps) {
              dispatchAction({ type: "drop", id: pulse.id });
              return;
            }
            dispatchAction({ type: "activate", id: pulse.id });
            const timer = setTimeout(() => {
              clearTimers.delete(timer);
              dispatchAction({ type: "clear", id: pulse.id });
            }, PULSE_DURATION_MS);
            clearTimers.add(timer);
          })
          .catch(() => {
            /*
              Attribution is best-effort cosmetics; never surface an error.
            */
            dispatchAction({ type: "drop", id: pulse.id });
          });
      };

      return {
        update: (view) => {
          const pluginState = agentPulsePluginKey.getState(view.state);
          if (pluginState === undefined) {
            return;
          }
          for (const pulse of pluginState.pending) {
            if (requestedPulseIds.has(pulse.id)) {
              continue;
            }
            requestedPulseIds.add(pulse.id);
            attributePulse(pulse);
          }
        },
        destroy: () => {
          for (const timer of clearTimers) {
            clearTimeout(timer);
          }
          clearTimers.clear();
        },
      };
    },
  });
}

function buildPulseDecorations({
  pulse,
  doc,
}: {
  pulse: PendingPulse;
  doc: PmNode;
}): Decoration[] {
  const maxPos = doc.content.size;
  const built: Decoration[] = [];
  for (const range of pulse.ranges) {
    const from = Math.max(0, Math.min(range.from, maxPos));
    const to = Math.max(0, Math.min(range.to, maxPos));
    if (from < to) {
      built.push(
        Decoration.inline(from, to, { class: "flock-agent-pulse" }, { pulseId: pulse.id }),
      );
    }
  }
  if (built.length === 0 && maxPos > 0) {
    /*
      Pure deletion (or fully stale ranges): block-level shimmer fallback.
    */
    built.push(
      Decoration.inline(
        0,
        maxPos,
        { class: "flock-agent-pulse flock-agent-pulse--block" },
        { pulseId: pulse.id },
      ),
    );
  }
  return built;
}
