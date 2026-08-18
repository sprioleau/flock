import { describe, expect, it } from "vitest";
import { DEMO_PERSONA_SLUGS } from "./demo-turns";
import {
  buildDemoAppSettingsRaw,
  buildDemoEnabledPersonasRaw,
  buildDemoRestoreSnapshot,
  buildDemoTourProgressRaw,
  parseDemoSession,
  selectIsDemoDocument,
  type DemoRestoreSnapshot,
  type DemoSession,
} from "./demo-preset";

/**
 * What entering the demo does to a visitor's browser — and, more importantly,
 * what leaving it has to be able to undo.
 *
 * The failure these tests exist to prevent is silent and permanent: /demo
 * writes browser-global settings, so a bug in the snapshot rule does not break
 * the demo at all — it quietly leaves a stranger's own drafts with demo mode
 * on and two agents enabled forever.
 */

const EMPTY_SNAPSHOT: DemoRestoreSnapshot = {
  appSettingsRaw: null,
  enabledPersonasRaw: null,
  tourProgressRaw: null,
};

describe("the preset", () => {
  it("reveals the lenses the narration points at", () => {
    const settings: unknown = JSON.parse(buildDemoAppSettingsRaw(null));
    expect(settings).toMatchObject({
      isDemoModeEnabled: true,
      isTimeTravelReplayEnabled: true,
      isOpInspectorEnabled: true,
    });
  });

  it("keeps settings it has no business changing", () => {
    const prior = JSON.stringify({ chatProviderId: "gemini", isSuggestionsEnabled: false });
    const settings = JSON.parse(buildDemoAppSettingsRaw(prior)) as Record<string, unknown>;
    // The demo runs in the visitor's own browser, not a sandbox — an unrelated
    // preference must survive it and be there when they exit.
    expect(settings.chatProviderId).toBe("gemini");
    expect(settings.isSuggestionsEnabled).toBe(false);
  });

  it("survives corrupt stored settings rather than refusing to start", () => {
    const settings = JSON.parse(buildDemoAppSettingsRaw("{not json")) as Record<string, unknown>;
    expect(settings.isDemoModeEnabled).toBe(true);
  });

  it("enables exactly the two agents the demo narrates", () => {
    expect(JSON.parse(buildDemoEnabledPersonasRaw())).toEqual([...DEMO_PERSONA_SLUGS]);
  });

  it("suppresses the first-run tour, which would otherwise auto-start over the demo", () => {
    // Terminal status, so selectActiveTourStopId resolves to null: no card, and
    // — the part that would actually break the demo — advisory runs are no
    // longer gated off by getIsTourRunning().
    expect(JSON.parse(buildDemoTourProgressRaw())).toEqual({
      status: "dismissed",
      resumeStopId: null,
    });
  });
});

describe("the restore snapshot", () => {
  it("captures what the visitor had when there is no demo running", () => {
    const current: DemoRestoreSnapshot = {
      appSettingsRaw: '{"isDemoModeEnabled":false}',
      enabledPersonasRaw: "[]",
      tourProgressRaw: null,
    };
    expect(buildDemoRestoreSnapshot({ current, activeSession: null })).toEqual(current);
  });

  it("re-entering /demo keeps the ORIGINAL snapshot, never the demo's own settings", () => {
    const original: DemoRestoreSnapshot = {
      appSettingsRaw: '{"isDemoModeEnabled":false}',
      enabledPersonasRaw: "[]",
      tourProgressRaw: null,
    };
    const activeSession: DemoSession = {
      documentId: "doc_demo_one",
      startedAtMs: 1,
      restore: original,
    };
    // "Start over" routes back through /demo. Without this rule the second
    // entry would record the PRESET as the visitor's prior settings and the
    // exit path would then "restore" them to demo mode permanently.
    const current: DemoRestoreSnapshot = {
      appSettingsRaw: buildDemoAppSettingsRaw(original.appSettingsRaw),
      enabledPersonasRaw: buildDemoEnabledPersonasRaw(),
      tourProgressRaw: buildDemoTourProgressRaw(),
    };
    expect(buildDemoRestoreSnapshot({ current, activeSession })).toEqual(original);
  });
});

describe("reading the session back", () => {
  it("round-trips a written session", () => {
    const session: DemoSession = {
      documentId: "doc_demo",
      startedAtMs: 1_700_000_000_000,
      restore: EMPTY_SNAPSHOT,
    };
    expect(parseDemoSession(JSON.stringify(session))).toEqual(session);
  });

  it("treats anything unrecognizable as no demo at all", () => {
    expect(parseDemoSession(null)).toBeNull();
    expect(parseDemoSession("{not json")).toBeNull();
    expect(parseDemoSession('{"documentId":""}')).toBeNull();
    // A record with no restore snapshot cannot be exited from cleanly, so it
    // is not a session worth honouring.
    expect(parseDemoSession('{"documentId":"doc_demo"}')).toBeNull();
  });
});

describe("which document the demo owns", () => {
  const session: DemoSession = {
    documentId: "doc_demo",
    startedAtMs: 0,
    restore: EMPTY_SNAPSHOT,
  };

  it("is the demo's scratch document and nothing else", () => {
    expect(selectIsDemoDocument({ session, documentId: "doc_demo" })).toBe(true);
    // The whole zero-leak property: a stale session record must never put the
    // demo bar — or the advisors' demo run gate — over a real draft.
    expect(selectIsDemoDocument({ session, documentId: "doc_real" })).toBe(false);
    expect(selectIsDemoDocument({ session: null, documentId: "doc_demo" })).toBe(false);
    expect(selectIsDemoDocument({ session, documentId: null })).toBe(false);
  });
});
