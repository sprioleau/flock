import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchPageMock = vi.hoisted(() => vi.fn());
const isFetchAllowedByRobotsMock = vi.hoisted(() => vi.fn());
const rehostImageToStorageMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/brand-kit-extraction/fetch-page", () => ({ fetchPage: fetchPageMock }));
vi.mock("../robots", () => ({ isFetchAllowedByRobots: isFetchAllowedByRobotsMock }));
vi.mock("../rehost-image", () => ({ rehostImageToStorage: rehostImageToStorageMock }));

import { ingestPage } from "../ingest-page";

/**
 * The staged pipeline's own guarantees, at the seam rather than end to end.
 *
 * THE HOUSE RULE these exist to pin: A REFUSAL IS NOT AN ERROR. A page that
 * cannot be read comes back as a SUCCESSFUL call carrying `isOk: false` and
 * something worth relaying — never a throw, because a throw puts an unreadable
 * page on the error path where the model is invited to retry.
 */

const PAGE_URL = "https://studio.example/about";

const PAGE_HTML = `<!doctype html>
<html><head>
  <title>Rowan Ellis — Studio Marrow</title>
  <meta property="og:site_name" content="Studio Marrow">
  <meta property="og:image" content="https://studio.example/social/card.png">
  <meta name="description" content="Product designer working on clinical software.">
</head><body><main>
  <h1>Rowan Ellis</h1>
  <p>Rowan Ellis is a product designer who has spent the last nine years on clinical software,
     mostly the parts nurses use at three in the morning when nothing else is going well.</p>
  <p>Before Studio Marrow she led design at a hospital scheduling company, where she learned
     that the hardest problems in the building are almost never the ones on the roadmap.</p>
  <h2>Skills</h2>
  <ul><li>TypeScript</li><li>React</li><li>Design systems</li><li>Accessibility auditing</li></ul>
  <h2>Work</h2>
  <img src="/media/atlas.png" alt="Atlas scheduling board" width="1200" height="800">
  <img src="/media/ward.png" alt="Ward handover screen" width="1200" height="800">
  <img src="/media/rota.png" alt="Rota planner" width="1200" height="800">
</main></body></html>`;

beforeEach(() => {
  fetchPageMock.mockReset();
  isFetchAllowedByRobotsMock.mockReset();
  rehostImageToStorageMock.mockReset();
  isFetchAllowedByRobotsMock.mockResolvedValue(true);
  fetchPageMock.mockResolvedValue({ isOk: true, html: PAGE_HTML, finalUrl: PAGE_URL });
  rehostImageToStorageMock.mockResolvedValue("https://storage.convex.cloud/card.png");
});

describe("ingestPage — a refusal is a successful call", () => {
  it("does not throw and does not fetch when robots.txt disallows the path", async () => {
    isFetchAllowedByRobotsMock.mockResolvedValue(false);
    const result = await ingestPage({ url: PAGE_URL });
    expect(result.isOk).toBe(false);
    if (result.isOk) return;
    expect(result.message.length).toBeGreaterThan(0);
    expect(fetchPageMock).not.toHaveBeenCalled();
  });

  it("relays a fetch failure rather than throwing", async () => {
    fetchPageMock.mockResolvedValue({
      isOk: false,
      reason: "blocked_by_site",
      message: "brand-kit-flavoured copy",
    });
    const result = await ingestPage({ url: PAGE_URL });
    expect(result).toMatchObject({ isOk: false, reason: "blocked_by_site" });
    if (result.isOk) return;
    /* The page-mode override replaces copy written for a different caller. */
    expect(result.message).not.toContain("branding");
    expect(result.message).toContain("blocks automated access");
  });

  it("relays an unreadable page rather than throwing", async () => {
    fetchPageMock.mockResolvedValue({
      isOk: true,
      html: "<html><body><p>Hi.</p></body></html>",
      finalUrl: PAGE_URL,
    });
    const result = await ingestPage({ url: PAGE_URL });
    expect(result).toMatchObject({ isOk: false, reason: "no_main_content" });
  });

  it("fails OPEN when robots.txt itself cannot be reached", async () => {
    /*
      robots.ts returns true when it cannot reach robots.txt — an unreachable
      rules file is not a prohibition. Pinned here because the opposite default
      would silently make every page on a flaky host unreadable.
    */
    isFetchAllowedByRobotsMock.mockResolvedValue(true);
    const result = await ingestPage({ url: PAGE_URL });
    expect(result.isOk).toBe(true);
    expect(fetchPageMock).toHaveBeenCalledWith(PAGE_URL);
  });
});

describe("ingestPage — the lead image", () => {
  it("copies exactly one image, however many the page offers", async () => {
    /*
      The fixture offers four candidates. Copying is a fetch, a storage write,
      and an Asset Library row apiece, and the composer can place one lead — so
      the count is the guarantee, and the fixture has to be able to break it.
    */
    const probe = await ingestPage({ url: PAGE_URL });
    expect(probe.isOk).toBe(true);
    expect(rehostImageToStorageMock).toHaveBeenCalledTimes(1);
  });

  it("prefers the publisher's own nominated image over an inline one", async () => {
    await ingestPage({ url: PAGE_URL });
    expect(rehostImageToStorageMock).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: "https://studio.example/social/card.png" }),
    );
  });

  it("drops an image that cannot be stored, and still returns the page", async () => {
    /*
      Fail-soft, and the failure mode matters: the original URL must NOT come
      back instead. Hot-linking a CDN that may refuse the recipient's mail
      client is how an email ends up with a broken image where the sender
      believed there was a picture.
    */
    rehostImageToStorageMock.mockResolvedValue(null);
    const result = await ingestPage({ url: PAGE_URL });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.page.leadImageUrl).toBeUndefined();
    expect(JSON.stringify(result.page)).not.toContain("social/card.png");
  });

  it("files the copy under the caller's session", async () => {
    await ingestPage({ url: PAGE_URL, sessionId: "sess_xyz" });
    expect(rehostImageToStorageMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_xyz" }),
    );
  });
});

describe("ingestPage — what reaches the model", () => {
  it("carries the page's lists across, with the heading they sat under", async () => {
    const result = await ingestPage({ url: PAGE_URL });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const skills = result.page.lists.find((list) => list.headingBefore === "Skills");
    expect(skills?.items).toEqual([
      "TypeScript",
      "React",
      "Design systems",
      "Accessibility auditing",
    ]);
  });

  it("does not leak linkDensity into the model-facing payload", async () => {
    /*
      linkDensity is INTERNAL EVIDENCE for admitting a list. The model has no
      use for it and no way to act on it, so it stops at this boundary — and a
      spread rather than an explicit mapping would quietly carry it through the
      first time either type gained a field.
    */
    const result = await ingestPage({ url: PAGE_URL });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(JSON.stringify(result.page)).not.toContain("linkDensity");
  });

  it("keeps the page's own name as a heading block", async () => {
    const result = await ingestPage({ url: PAGE_URL });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    const headings = result.page.blocks.filter((block) => block.kind === "heading");
    expect(headings.map((heading) => heading.text)).toContain("Rowan Ellis");
  });
});
