import { isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/studio/demo/DemoBootstrap", () => ({
  DemoBootstrap: function DemoBootstrapStub() {
    return null;
  },
}));

import DemoPage, { metadata } from "@/app/demo/page";
import { DemoBootstrap } from "./DemoBootstrap";

describe("the public demo route", () => {
  it("still mounts the guided DemoBootstrap experience", () => {
    const page = DemoPage();
    expect(isValidElement(page)).toBe(true);
    if (!isValidElement(page)) {
      return;
    }
    expect(page.type).toBe(DemoBootstrap);
  });

  it("keeps public-demo metadata instead of falling back to the login page", () => {
    expect(metadata.title).toBe("Demo — Flock");
    expect(metadata.description).toMatch(/two named agents reviewing an email/i);
  });
});
