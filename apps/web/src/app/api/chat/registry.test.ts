import { getAction, toAISDKToolDefinitions } from "@flock/email-sdk";
import { describe, expect, it } from "vitest";
import { chatActionRegistry } from "./registry";

/**
 * The registry the in-app chat agent both advertises AND dispatches from. A
 * capability that exists in the sdk but never reaches this object is a
 * capability no agent has — which is precisely what inspectRenderedEmail was
 * before it was registered, so it is worth a test that says so out loud.
 */

describe("chatActionRegistry", () => {
  it("gives the agent a read-only way to look at the email it just built", () => {
    const action = getAction(chatActionRegistry, "inspectRenderedEmail");

    expect(action?.kind).toBe("analysis");
    expect(action?.readOnly).toBe(true);
    expect(action?.needsApproval).toBe(false);
  });

  it("advertises it to the model as a tool, description and all", () => {
    const definition = toAISDKToolDefinitions(chatActionRegistry).find(
      (candidate) => candidate.name === "inspectRenderedEmail",
    );

    expect(definition).toBeDefined();
    // Empty input is valid: the tool reads the current email with no arguments.
    expect(definition?.inputSchema.safeParse({}).success).toBe(true);
    expect(definition?.description).toContain("Read-only");
  });
});
