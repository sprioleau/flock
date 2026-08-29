import { describe, expect, it } from "vitest";
import { CHECKED_EMAIL_CLIENTS, findClientsWithIncompleteData } from "./supported-clients";

/*
  The whole reason this client list is a constant rather than "all of them".

  caniemail throws a RangeError the moment it evaluates a feature the dataset
  has no row for on a requested client, and that exception aborts the entire
  run — one missing data point costs every finding for every client. The list
  is chosen so it cannot happen. These tests are what keeps that true across a
  caniemail upgrade, which is exactly when it would otherwise stop being true
  and only say so in production.
*/
describe("CHECKED_EMAIL_CLIENTS", () => {
  it("has complete caniemail data for every client, so no document can make the checker throw", () => {
    expect(findClientsWithIncompleteData(CHECKED_EMAIL_CLIENTS)).toEqual([]);
  });

  /*
    The negative control. Without this, the assertion above passes just as
    happily if findClientsWithIncompleteData always returns [] — the exact
    shape of vacuous test this project has been bitten by. `gmail.ios` is a
    real client with a real, verified hole (`word-wrap`), and every Flock email
    contains `word-wrap`, so this is the concrete crash that forced the list.
  */
  it("detects the real data hole that ruled out gmail.ios", () => {
    const incomplete = findClientsWithIncompleteData(["gmail.ios"]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.client).toBe("gmail.ios");
    expect(incomplete[0]?.missingFeatureTitles).toContain("word-wrap");
  });

  it("reports a malformed client id rather than silently passing it as complete", () => {
    expect(findClientsWithIncompleteData(["not-a-client"])).toEqual([
      { client: "not-a-client", missingFeatureTitles: ["<malformed client id>"] },
    ]);
  });
});
