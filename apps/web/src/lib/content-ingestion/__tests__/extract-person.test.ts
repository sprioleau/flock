import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPerson } from "../extract-person";

/**
 * Person extraction is held to a stricter bar than article extraction: the
 * subject is a human being, so nothing may be inferred. Every field here is
 * either something the page literally said, or absent.
 */

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf-8");
}

const PROFILE_URL = "https://riverside.example.edu/people/amara-osei?ref=directory";

describe("extractPerson — a real profile page", () => {
  const result = extractPerson({ html: loadFixture("profile-page.html"), finalUrl: PROFILE_URL });

  it("reads the person's own structured identity", () => {
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const { person } = result;
    expect(person.name).toBe("Amara Osei");
    expect(person.role).toBe("Professor of Environmental Engineering");
    expect(person.organization).toBe("Riverside University");
    expect(person.sourceName).toBe("Riverside University");
  });

  it("uses the canonical URL for attribution, not the tracking URL we fetched", () => {
    if (!result.isOk) throw new Error("expected success");
    expect(result.person.profileUrl).toBe("https://riverside.example.edu/people/amara-osei");
  });

  it("prefers the page's own description as the bio", () => {
    if (!result.isOk) throw new Error("expected success");
    expect(result.person.bio).toContain("urban heat islands");
  });

  it("absolutizes the portrait against the fetched URL", () => {
    if (!result.isOk) throw new Error("expected success");
    expect(result.person.photoSourceUrl).toBe(
      "https://riverside.example.edu/media/portraits/osei.jpg",
    );
  });

  it("attributes every extracted fact to the profile URL", () => {
    if (!result.isOk) throw new Error("expected success");
    expect(result.person.facts.length).toBeGreaterThan(0);
    for (const fact of result.person.facts) {
      expect(fact.sourceUrl).toBe("https://riverside.example.edu/people/amara-osei");
      expect(fact.text.length).toBeGreaterThan(0);
    }
  });

  it("keeps navigation, related-people links, and the footer out of the facts", () => {
    if (!result.isOk) throw new Error("expected success");
    const allFactText = result.person.facts.map((fact) => fact.text).join(" ");
    expect(allFactText).not.toContain("Juno Park");
    expect(allFactText).not.toContain("All rights reserved");
    expect(allFactText).not.toContain("Give");
  });
});

describe("extractPerson — falling back through the sources", () => {
  const bareProfile = `
    <html><head><title>Jordan Vale — Northwind Co</title></head><body><main>
      <h1>Jordan Vale</h1>
      <p class="role">Head of Partnerships</p>
      <p>Jordan Vale has led partnerships at Northwind since 2021, working with retail
         and logistics companies across the region on long-term supply agreements.</p>
    </main></body></html>`;

  it("reads the h1 and a class-marked role line when there is no JSON-LD", () => {
    const result = extractPerson({
      html: bareProfile,
      finalUrl: "https://northwind.example.com/team/jordan-vale",
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.person.name).toBe("Jordan Vale");
    expect(result.person.role).toBe("Head of Partnerships");
    // No org was stated anywhere structured — so none is claimed.
    expect(result.person.organization).toBeUndefined();
    expect(result.person.sourceName).toBe("northwind.example.com");
  });

  it("claims no photo when the page has none", () => {
    const result = extractPerson({
      html: bareProfile,
      finalUrl: "https://northwind.example.com/team/jordan-vale",
    });
    if (!result.isOk) throw new Error("expected success");
    expect(result.person.photoSourceUrl).toBeUndefined();
  });
});

describe("extractPerson — honest refusals", () => {
  it("refuses a page that names no one", () => {
    const result = extractPerson({
      html: "<html><body><main><p>Directory of staff members.</p></main></body></html>",
      finalUrl: "https://example.com/people",
    });
    expect(result).toMatchObject({ isOk: false, reason: "no_person_found" });
  });

  it("refuses a page that names someone but says nothing about them", () => {
    const result = extractPerson({
      html: "<html><head><title>Sam Rivera</title></head><body><main><h1>Sam Rivera</h1></main></body></html>",
      finalUrl: "https://example.com/people/sam-rivera",
    });
    expect(result).toMatchObject({ isOk: false, reason: "no_profile_content" });
    if (result.isOk) return;
    expect(result.message).toContain("Sam Rivera");
    expect(result.message).toContain("no readable description");
  });
});
