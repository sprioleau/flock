import { describe, expect, it, vi } from "vitest";
import { selectRepresentativeSourceImages } from "./source-image-evidence";

const PAGE_COPY = "A real page paragraph with enough readable copy for deterministic extraction. ".repeat(8);

describe("selectRepresentativeSourceImages", () => {
  it("keeps at most five verified content images and excludes logos, icons, and dead assets", async () => {
    const html = `<!doctype html><html><head>
      <meta property="og:image" content="/social-card.jpg" />
    </head><body>
      <p>${PAGE_COPY}</p>
      <img src="/logo.svg" alt="Acme logo" width="240" height="80" />
      <img src="/icon.png" alt="Menu icon" width="32" height="32" />
      ${Array.from(
        { length: 7 },
        (_, index) =>
          `<img src="/work-${index + 1}.jpg" alt="Project ${index + 1}" width="${800 - index * 20}" height="500" />`,
      ).join("\n")}
    </body></html>`;
    const verifyImageUrl = vi.fn(async (url: string) => !url.endsWith("work-2.jpg"));

    const images = await selectRepresentativeSourceImages({
      html,
      finalUrl: "https://acme.test/portfolio",
      verifyImageUrl,
    });

    expect(images).toHaveLength(5);
    expect(images.map((image) => image.url)).not.toContain("https://acme.test/logo.svg");
    expect(images.map((image) => image.url)).not.toContain("https://acme.test/icon.png");
    expect(images.map((image) => image.url)).not.toContain("https://acme.test/work-2.jpg");
    expect(images[0]).toMatchObject({
      url: "https://acme.test/work-1.jpg",
      alt: "Project 1",
      width: 800,
      height: 500,
    });
    expect(verifyImageUrl).toHaveBeenCalled();
  });

  it("returns only real candidates when a page offers fewer than four", async () => {
    const html = `<!doctype html><html><body>
      <p>${PAGE_COPY}</p>
      <img src="/only.jpg" alt="Only project" width="640" height="480" />
    </body></html>`;

    const images = await selectRepresentativeSourceImages({
      html,
      finalUrl: "https://acme.test/",
      verifyImageUrl: async () => true,
    });

    expect(images).toEqual([
      {
        url: "https://acme.test/only.jpg",
        alt: "Only project",
        width: 640,
        height: 480,
      },
    ]);
  });

  it("does not let favicon metadata crowd five honest page images out of the content budget", async () => {
    const favicons = Array.from(
      { length: 10 },
      (_, index) =>
        `<link rel="icon" href="/favicons/favicon-${index + 1}.png" sizes="${index + 16}x${index + 16}" />`,
    ).join("\n");
    const pageImages = Array.from(
      { length: 5 },
      (_, index) =>
        `<img src="/product-${index + 1}.jpg" alt="Product screenshot ${index + 1}" width="1200" height="800" />`,
    ).join("\n");
    const html = `<!doctype html><html><head>
      <meta property="og:image" content="/social-card.jpg" />
      ${favicons}
    </head><body><main>
      <h1>Acme platform</h1>
      <p>${PAGE_COPY.repeat(40)}</p>
      ${pageImages}
    </main></body></html>`;

    const images = await selectRepresentativeSourceImages({
      html,
      finalUrl: "https://acme.test/",
      verifyImageUrl: async () => true,
    });

    expect(images).toHaveLength(5);
    expect(images.map((image) => image.url)).toEqual([
      "https://acme.test/product-1.jpg",
      "https://acme.test/product-2.jpg",
      "https://acme.test/product-3.jpg",
      "https://acme.test/product-4.jpg",
      "https://acme.test/product-5.jpg",
    ]);
  });
});
