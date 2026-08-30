import { describe, expect, it } from "vitest";
import type { EmailDocument } from "@flock/email-sdk";
import {
  computeWatchScopeHash,
  hashString,
  parsePersonaWatchScope,
  type PersonaWatchScope,
} from "./watch-scope";

const FIXTURE_DOC = {
  root: { id: "root", type: "root", parentId: null, childrenIds: ["sec_a"], properties: {} },
  sec_a: { id: "sec_a", type: "section", parentId: "root", childrenIds: ["txt_a", "btn_a"], properties: {} },
  txt_a: { id: "txt_a", type: "text", parentId: "sec_a", childrenIds: [], properties: { text: "hello" } },
  btn_a: { id: "btn_a", type: "button", parentId: "sec_a", childrenIds: [], properties: { text: "Go", href: "#" } },
} as unknown as EmailDocument;

describe("parsePersonaWatchScope", () => {
  const wrap = (line: string) => `---\nname: T\n${line}\n---\n\nBody text.`;

  it("defaults to whole-document without a watch line", () => {
    expect(parsePersonaWatchScope(wrap("color: \"#fff\""))).toEqual({ kind: "document" });
    expect(parsePersonaWatchScope("no frontmatter at all")).toEqual({ kind: "document" });
  });

  it("parses a block-type list", () => {
    expect(parsePersonaWatchScope(wrap("watch: text, button"))).toEqual({
      kind: "blockTypes",
      blockTypes: ["text", "button"],
    });
  });

  it("treats document/unknown-only lists as whole-document", () => {
    expect(parsePersonaWatchScope(wrap("watch: document"))).toEqual({ kind: "document" });
    expect(parsePersonaWatchScope(wrap("watch: nonsense, alsojunk"))).toEqual({ kind: "document" });
    /*
      Unknown tokens are dropped, valid ones survive.
    */
    expect(parsePersonaWatchScope(wrap("watch: junk, image"))).toEqual({
      kind: "blockTypes",
      blockTypes: ["image"],
    });
  });

  it("only reads watch from the frontmatter block, not the body", () => {
    expect(parsePersonaWatchScope("---\nname: T\n---\n\nwatch: text")).toEqual({
      kind: "document",
    });
  });
});

describe("computeWatchScopeHash", () => {
  it("document scope hashes the provided outline", () => {
    const hash = computeWatchScopeHash({
      doc: FIXTURE_DOC,
      scope: { kind: "document" },
      documentOutline: "outline-v1",
    });
    expect(hash).toBe(hashString("outline-v1"));
    expect(
      computeWatchScopeHash({
        doc: FIXTURE_DOC,
        scope: { kind: "document" },
        documentOutline: "outline-v2",
      }),
    ).not.toBe(hash);
  });

  it("block-type scope changes only when a watched block changes", () => {
    const scope: PersonaWatchScope = { kind: "blockTypes", blockTypes: ["text"] };
    const baseline = computeWatchScopeHash({ doc: FIXTURE_DOC, scope, documentOutline: "x" });

    /*
      A BUTTON change is invisible to a text watcher …
    */
    const buttonEdited = {
      ...FIXTURE_DOC,
      btn_a: { ...FIXTURE_DOC.btn_a, properties: { text: "Buy", href: "#" } },
    } as unknown as EmailDocument;
    expect(computeWatchScopeHash({ doc: buttonEdited, scope, documentOutline: "x" })).toBe(baseline);

    /*
      … but a TEXT change is not.
    */
    const textEdited = {
      ...FIXTURE_DOC,
      txt_a: { ...FIXTURE_DOC.txt_a, properties: { text: "changed" } },
    } as unknown as EmailDocument;
    expect(computeWatchScopeHash({ doc: textEdited, scope, documentOutline: "x" })).not.toBe(baseline);
  });

  it("hashString is deterministic and input-sensitive", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });
});
