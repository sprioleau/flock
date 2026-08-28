import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchPageMock = vi.hoisted(() => vi.fn());
const isFetchAllowedByRobotsMock = vi.hoisted(() => vi.fn());
const rehostImageToStorageMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/brand-kit-extraction/fetch-page", () => ({ fetchPage: fetchPageMock }));
vi.mock("../robots", () => ({ isFetchAllowedByRobots: isFetchAllowedByRobotsMock }));
vi.mock("../rehost-image", () => ({ rehostImageToStorage: rehostImageToStorageMock }));

import { ingestPage } from "../ingest-page";
import type { ClassifyFn } from "../classify-page";

/**
 * A reader that returns exactly what a test wants, spending no quota.
 *
 * Supplies a minimal valid plan unless the test provides one, because a
 * reading with no sections is deliberately treated as unusable — these tests
 * are about images and payload plumbing, not about that rule.
 */
function cannedReader(reading: Record<string, unknown>): ClassifyFn {
  return async () => ({
    sections: [
      {
        templateId: "hero",
        copy: { headline: "Rowan Ellis", body: "Nine years of clinical software.", imageAlt: "Rowan Ellis" },
        sourceBlockIndices: [0],
        rationale: "The page's own opening.",
      },
    ],
    ...reading,
  });
}

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
  <img src="/media/rowan.jpg" alt="Rowan Ellis" width="400" height="400">
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

describe("ingestPage — the images", () => {
  it("copies only one when nothing read the page", async () => {
    /*
      With no reader, the deterministic floor nominates the publisher's own
      image and nothing else. The fixture offers four candidates, so this can
      genuinely break.
    */
    const probe = await ingestPage({ url: PAGE_URL });
    expect(probe.isOk).toBe(true);
    expect(rehostImageToStorageMock).toHaveBeenCalledTimes(1);
    expect(rehostImageToStorageMock).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: "https://studio.example/social/card.png" }),
    );
  });

  it("copies at most four, however many roles the reader assigns", async () => {
    /*
      Each copy is a fetch, a storage write, and an Asset Library row. The cap
      is a real cost bound, so the fixture assigns more than it.
    */
    const result = await ingestPage({
      url: PAGE_URL,
      classify: cannedReader({
        pageType: "portfolio",
        confidence: "high",
        sourceSummary: "A studio page.",
        isPlanUsable: true,
        images: [
          { candidateId: "img_1", role: "lead" },
          { candidateId: "img_2", role: "supporting" },
          { candidateId: "img_3", role: "supporting" },
          { candidateId: "img_4", role: "supporting" },
          { candidateId: "img_5", role: "supporting" },
        ],
      }),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.page.images).toHaveLength(4);
    expect(rehostImageToStorageMock).toHaveBeenCalledTimes(4);
  });

  it("spends the budget by ROLE, not by where the image sat on the page", async () => {
    /*
      The whole reason for a priority order. A portrait assigned to the LAST
      candidate must still be copied ahead of three supporting images that came
      first — on a page about a person, their face is what the email most
      needs, and document order would have spent the budget before reaching it.
    */
    const result = await ingestPage({
      url: PAGE_URL,
      classify: cannedReader({
        pageType: "person_profile",
        confidence: "high",
        sourceSummary: "A studio page.",
        isPlanUsable: true,
        images: [
          { candidateId: "img_2", role: "supporting" },
          { candidateId: "img_3", role: "supporting" },
          { candidateId: "img_4", role: "supporting" },
          { candidateId: "img_5", role: "portrait", subject: "Rowan Ellis" },
        ],
      }),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.page.images[0]).toMatchObject({ role: "portrait", subject: "Rowan Ellis" });
  });

  it("drops one image that will not store without dropping the rest", async () => {
    rehostImageToStorageMock.mockResolvedValueOnce(null);
    rehostImageToStorageMock.mockResolvedValue("https://storage.convex.cloud/ok.png");
    const result = await ingestPage({
      url: PAGE_URL,
      classify: cannedReader({
        pageType: "portfolio",
        confidence: "high",
        sourceSummary: "A studio page.",
        isPlanUsable: true,
        images: [
          { candidateId: "img_1", role: "lead" },
          { candidateId: "img_2", role: "supporting" },
        ],
      }),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.page.images).toHaveLength(1);
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
    expect(result.page.images).toEqual([]);
    expect(JSON.stringify(result.page)).not.toContain("social/card.png");
  });

  it("files the copy under the caller's session", async () => {
    await ingestPage({ url: PAGE_URL, sessionId: "sess_xyz" });
    expect(rehostImageToStorageMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_xyz" }),
    );
  });
});

describe("ingestPage — the reading reaches the model", () => {
  it("carries what the page turned out to be, and how sure that was", async () => {
    const result = await ingestPage({
      url: PAGE_URL,
      classify: cannedReader({
        pageType: "portfolio",
        confidence: "medium",
        uncertaintyNote: "Could equally be read as a studio's own page.",
        sourceSummary: "Rowan Ellis's portfolio.",
        isPlanUsable: true,
        images: [],
      }),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.page).toMatchObject({
      pageType: "portfolio",
      confidence: "medium",
      uncertaintyNote: "Could equally be read as a studio's own page.",
      isPlanUsable: true,
    });
  });

  it("still returns the page when the reader fails, marked unusable", async () => {
    /*
      The house rule at the reading layer. The page WAS fetched, so the caller
      gets a successful result carrying everything the scrape knows — it simply
      declines to claim what it could not work out.
    */
    const result = await ingestPage({
      url: PAGE_URL,
      classify: async () => {
        throw new Error("quota exhausted");
      },
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.page.isPlanUsable).toBe(false);
    expect(result.page.title).toBe("Rowan Ellis");
    expect(result.page.lists.length).toBeGreaterThan(0);
  });

  it("spends no reading call at all when there is no reader", async () => {
    const classify = vi.fn();
    await ingestPage({ url: PAGE_URL, classify: null });
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("ingestPage — the pipeline writes image addresses, never the reader", () => {
  const planWith = (sections: unknown[], images: unknown[]) =>
    cannedReader({
      pageType: "portfolio",
      confidence: "high",
      sourceSummary: "A studio page.",
      isPlanUsable: true,
      images,
      sections,
    });

  it("fills a section's image from the rehosted URL", async () => {
    const result = await ingestPage({
      url: PAGE_URL,
      classify: planWith(
        [
          {
            templateId: "hero",
            copy: { headline: "Rowan Ellis", body: "Nine years of clinical software.", imageAlt: "Rowan Ellis" },
            sourceBlockIndices: [0],
            rationale: "Her name.",
          },
        ],
        [{ candidateId: "img_5", role: "portrait", subject: "Rowan Ellis" }],
      ),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.page.sections[0].params.imageSrc).toBe("https://storage.convex.cloud/card.png");
  });

  it("ignores an image address the reader tried to smuggle in", async () => {
    /*
      Belt and braces. The copy vocabulary has no image-address field at all,
      so a well-formed reading CANNOT carry one — but the pipeline strips the
      key anyway before filling it, because the value of the guarantee is that
      it holds regardless of what arrives.
    */
    const result = await ingestPage({
      url: PAGE_URL,
      classify: planWith(
        [
          {
            templateId: "hero",
            copy: { headline: "Rowan Ellis", body: "Nine years of clinical software.", imageAlt: "Rowan Ellis" },
            /* Not part of the vocabulary; present as if smuggled. */
            params: { imageSrc: "https://evil.example/tracker.gif" },
            sourceBlockIndices: [0],
            rationale: "Her name.",
          },
        ],
        [{ candidateId: "img_5", role: "portrait" }],
      ),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(JSON.stringify(result.page.sections)).not.toContain("evil.example");
  });

  it("gives a section no image address when there is no stored image", async () => {
    const result = await ingestPage({
      url: PAGE_URL,
      classify: planWith(
        [
          {
            templateId: "hero",
            copy: { headline: "Rowan Ellis", body: "Nine years of clinical software." },
            sourceBlockIndices: [0],
            rationale: "Her name.",
          },
        ],
        [],
      ),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.page.sections[0].params.imageSrc).toBeUndefined();
  });

  it("gives a section with no image left nothing rather than reusing one", async () => {
    const result = await ingestPage({
      url: PAGE_URL,
      classify: planWith(
        [
          {
            templateId: "hero",
            copy: { headline: "One", body: "First.", imageAlt: "One" },
            sourceBlockIndices: [0],
            rationale: "a",
          },
          {
            templateId: "hero-split",
            copy: { headline: "Two", body: "Second.", imageAlt: "Two" },
            sourceBlockIndices: [1],
            rationale: "b",
          },
        ],
        [{ candidateId: "img_5", role: "portrait" }],
      ),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.page.sections[0].params.imageSrc).toBeDefined();
    expect(result.page.sections[1].params.imageSrc).toBeUndefined();
  });

  it("leaves a template that carries no image untouched", async () => {
    const result = await ingestPage({
      url: PAGE_URL,
      classify: planWith(
        [
          {
            templateId: "feature-list",
            copy: { headline: "Skills", body: "What I work with.", items: [{ title: "TypeScript" }, { title: "React" }] },
            sourceBlockIndices: [0],
            rationale: "the list",
          },
        ],
        [{ candidateId: "img_5", role: "portrait" }],
      ),
    });
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.page.sections[0].params.imageSrc).toBeUndefined();
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
