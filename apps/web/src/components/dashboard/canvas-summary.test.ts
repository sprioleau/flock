import { describe, expect, it } from "vitest";
import {
  buildCanvasHref,
  formatDraftCount,
  formatHiddenDraftCount,
  formatRelativeTime,
} from "./canvas-summary";

const NOW_MS = Date.UTC(2026, 7, 3, 12, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("reads anything inside the last minute as current", () => {
    expect(formatRelativeTime({ timestampMs: NOW_MS, nowMs: NOW_MS })).toBe("Just now");
    expect(formatRelativeTime({ timestampMs: NOW_MS - 59 * 1000, nowMs: NOW_MS })).toBe(
      "Just now",
    );
  });

  it("never renders a negative age when the timestamp is ahead of the clock", () => {
    expect(formatRelativeTime({ timestampMs: NOW_MS + 5 * MINUTE, nowMs: NOW_MS })).toBe(
      "Just now",
    );
  });

  it("singularizes the boundary units", () => {
    expect(formatRelativeTime({ timestampMs: NOW_MS - MINUTE, nowMs: NOW_MS })).toBe(
      "1 minute ago",
    );
    expect(formatRelativeTime({ timestampMs: NOW_MS - HOUR, nowMs: NOW_MS })).toBe("1 hour ago");
    expect(formatRelativeTime({ timestampMs: NOW_MS - DAY, nowMs: NOW_MS })).toBe("Yesterday");
  });

  it("counts minutes, hours and days", () => {
    expect(formatRelativeTime({ timestampMs: NOW_MS - 5 * MINUTE, nowMs: NOW_MS })).toBe(
      "5 minutes ago",
    );
    expect(formatRelativeTime({ timestampMs: NOW_MS - 3 * HOUR, nowMs: NOW_MS })).toBe(
      "3 hours ago",
    );
    expect(formatRelativeTime({ timestampMs: NOW_MS - 3 * DAY, nowMs: NOW_MS })).toBe(
      "3 days ago",
    );
  });

  it("switches to an absolute date past a week, so the reader does no arithmetic", () => {
    const formatted = formatRelativeTime({ timestampMs: NOW_MS - 30 * DAY, nowMs: NOW_MS });
    expect(formatted).not.toMatch(/ago/);
    /*
      Same calendar year as NOW_MS, so the year is left off.
    */
    expect(formatted).not.toMatch(/2026/);
  });

  it("includes the year once the date is in a different one", () => {
    expect(formatRelativeTime({ timestampMs: NOW_MS - 400 * DAY, nowMs: NOW_MS })).toMatch(
      /2025/,
    );
  });
});

describe("formatDraftCount", () => {
  it("always carries the unit, singularized at one", () => {
    expect(formatDraftCount(0)).toBe("0 drafts");
    expect(formatDraftCount(1)).toBe("1 draft");
    expect(formatDraftCount(4)).toBe("4 drafts");
  });
});

describe("buildCanvasHref", () => {
  it("opens the most recently touched draft when there is one", () => {
    expect(buildCanvasHref({ canvasId: "cnv_1", entryDocumentId: "doc_9" })).toBe(
      "/studio?doc=doc_9",
    );
  });

  it("falls back to the canvas link the studio resolves server-side", () => {
    expect(buildCanvasHref({ canvasId: "cnv_1", entryDocumentId: null })).toBe(
      "/studio?canvas=cnv_1",
    );
  });

  it("encodes ids rather than trusting them to be URL-safe", () => {
    expect(buildCanvasHref({ canvasId: "a b&c", entryDocumentId: null })).toBe(
      "/studio?canvas=a%20b%26c",
    );
  });
});

describe("formatHiddenDraftCount", () => {
  it("returns null when every draft is already on the card", () => {
    expect(formatHiddenDraftCount({ draftCount: 3, shownCount: 3 })).toBeNull();
    expect(formatHiddenDraftCount({ draftCount: 2, shownCount: 4 })).toBeNull();
  });

  it("counts the remainder when the card truncates", () => {
    expect(formatHiddenDraftCount({ draftCount: 6, shownCount: 4 })).toBe("+2 more");
  });
});
