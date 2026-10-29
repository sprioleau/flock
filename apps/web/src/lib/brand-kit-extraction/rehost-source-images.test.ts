import { describe, expect, it, vi } from "vitest";
import type { BrandSourceImage } from "@/lib/brand-kit";
import { rehostSourceImages } from "./rehost-source-images";

const image = (url: string): BrandSourceImage => ({ url });

function binaryResponse({
  bytes,
  contentType = "image/png",
}: {
  bytes: Uint8Array;
  contentType?: string;
}) {
  return { isOk: true as const, bytes, contentType };
}

describe("rehostSourceImages", () => {
  it("starts at most three image downloads at once", async () => {
    const pending = new Map<string, (result: ReturnType<typeof binaryResponse>) => void>();
    let activeCount = 0;
    let maximumActiveCount = 0;
    const fetchImage = vi.fn(({ url }: { url: string }) => {
      activeCount += 1;
      maximumActiveCount = Math.max(maximumActiveCount, activeCount);
      return new Promise<ReturnType<typeof binaryResponse>>((resolve) => {
        pending.set(url, (result) => {
          activeCount -= 1;
          resolve(result);
        });
      });
    });
    const rehost = vi.fn(async ({ sourceImage }: { sourceImage: BrandSourceImage }) => sourceImage.url);
    const scrapePromise = rehostSourceImages({
      sourceImages: Array.from({ length: 5 }, (_, index) => image(`https://example.com/${index}.png`)),
      fetchImage,
      rehost,
    });

    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(3));
    expect(maximumActiveCount).toBe(3);
    pending.get("https://example.com/2.png")?.(binaryResponse({ bytes: new Uint8Array([3]) }));
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(4));
    pending.get("https://example.com/1.png")?.(binaryResponse({ bytes: new Uint8Array([2]) }));
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(5));
    pending.get("https://example.com/0.png")?.(binaryResponse({ bytes: new Uint8Array([1]) }));
    pending.get("https://example.com/4.png")?.(binaryResponse({ bytes: new Uint8Array([5]) }));
    pending.get("https://example.com/3.png")?.(binaryResponse({ bytes: new Uint8Array([4]) }));

    const result = await scrapePromise;
    expect(maximumActiveCount).toBe(3);
    expect(result.map((item) => item.sourceImage.url)).toEqual(
      Array.from({ length: 5 }, (_, index) => `https://example.com/${index}.png`),
    );
  });

  it("applies the aggregate byte cap in input order despite out-of-order download completion", async () => {
    const resolvers: Array<(result: ReturnType<typeof binaryResponse>) => void> = [];
    const fetchImage = vi.fn(() => new Promise<ReturnType<typeof binaryResponse>>((resolve) => resolvers.push(resolve)));
    const rehost = vi.fn(async ({ sourceImage }: { sourceImage: BrandSourceImage }) => sourceImage.url);
    const scrapePromise = rehostSourceImages({
      sourceImages: Array.from({ length: 5 }, (_, index) => image(`https://example.com/${index}.png`)),
      fetchImage,
      rehost,
    });

    await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[2](binaryResponse({ bytes: new Uint8Array(750_000) }));
    resolvers[1](binaryResponse({ bytes: new Uint8Array(750_000) }));
    resolvers[0](binaryResponse({ bytes: new Uint8Array(750_000) }));
    await vi.waitFor(() => expect(resolvers).toHaveLength(5));
    resolvers[4](binaryResponse({ bytes: new Uint8Array(750_000) }));
    resolvers[3](binaryResponse({ bytes: new Uint8Array(750_000) }));

    const result = await scrapePromise;
    expect(result.map((item) => item.sourceImage.url)).toEqual([
      "https://example.com/0.png",
      "https://example.com/1.png",
      "https://example.com/2.png",
    ]);
    expect(rehost).toHaveBeenCalledTimes(3);
  });

  it("runs up to three uploads concurrently and keeps partial failures soft and ordered", async () => {
    const pending = new Map<string, (url: string | null) => void>();
    let activeCount = 0;
    let maximumActiveCount = 0;
    const fetchImage = vi.fn(async ({ url }: { url: string }) =>
      binaryResponse({ bytes: new Uint8Array([Number(url.match(/(\d+)\.png$/)?.[1] ?? 0)]) }),
    );
    const rehost = vi.fn(({ sourceImage }: { sourceImage: BrandSourceImage }) => {
      activeCount += 1;
      maximumActiveCount = Math.max(maximumActiveCount, activeCount);
      return new Promise<string | null>((resolve) => {
        pending.set(sourceImage.url, (url) => {
          activeCount -= 1;
          resolve(url);
        });
      });
    });
    const scrapePromise = rehostSourceImages({
      sourceImages: Array.from({ length: 5 }, (_, index) => image(`https://example.com/${index}.png`)),
      fetchImage,
      rehost,
    });

    await vi.waitFor(() => expect(rehost).toHaveBeenCalledTimes(3));
    expect(maximumActiveCount).toBe(3);
    pending.get("https://example.com/2.png")?.("https://storage.test/2.png");
    await vi.waitFor(() => expect(rehost).toHaveBeenCalledTimes(4));
    pending.get("https://example.com/3.png")?.("https://storage.test/3.png");
    await vi.waitFor(() => expect(rehost).toHaveBeenCalledTimes(5));
    pending.get("https://example.com/1.png")?.(null);
    pending.get("https://example.com/4.png")?.("https://storage.test/4.png");
    pending.get("https://example.com/0.png")?.("https://storage.test/0.png");

    const result = await scrapePromise;
    expect(maximumActiveCount).toBe(3);
    expect(result.map((item) => item.url)).toEqual([
      "https://storage.test/0.png",
      "https://storage.test/2.png",
      "https://storage.test/3.png",
      "https://storage.test/4.png",
    ]);
  });

  it("continues after thrown fetches and upload failures while preserving the input-order byte budget", async () => {
    const fetchImage = vi.fn(async ({ url }: { url: string }) => {
      if (url.endsWith("/0.png")) throw new Error("network failure");
      return binaryResponse({ bytes: new Uint8Array(750_000) });
    });
    const rehost = vi.fn(async ({ sourceImage }: { sourceImage: BrandSourceImage }) => {
      if (sourceImage.url.endsWith("/1.png")) throw new Error("storage failure");
      return sourceImage.url;
    });

    const result = await rehostSourceImages({
      sourceImages: Array.from({ length: 5 }, (_, index) => image(`https://example.com/${index}.png`)),
      fetchImage,
      rehost,
    });

    expect(rehost).toHaveBeenCalledTimes(3);
    expect(result.map((item) => item.sourceImage.url)).toEqual([
      "https://example.com/2.png",
      "https://example.com/3.png",
    ]);
  });

  it("rehosts at most five images and keeps partial failures soft", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValueOnce(binaryResponse({ bytes: new Uint8Array([1]) }))
      .mockResolvedValueOnce({
        isOk: false as const,
        reason: "network",
        message: "nope",
      })
      .mockResolvedValue(binaryResponse({ bytes: new Uint8Array([2]) }));
    const rehost = vi.fn(
      async ({ sourceImage }: { sourceImage: BrandSourceImage }) =>
        sourceImage.url.endsWith("/skip")
          ? null
          : `https://storage.test/${sourceImage.url.split("/").pop()}`,
    );

    const result = await rehostSourceImages({
      sourceImages: Array.from({ length: 7 }, (_, index) =>
        image(`https://example.com/${index}.png`),
      ),
      fetchImage,
      rehost,
    });

    expect(fetchImage).toHaveBeenCalledTimes(5);
    expect(rehost).toHaveBeenCalledTimes(4);
    expect(result).toHaveLength(4);
    expect(result.map((item) => item.url)).toEqual([
      "https://storage.test/0.png",
      "https://storage.test/2.png",
      "https://storage.test/3.png",
      "https://storage.test/4.png",
    ]);
  });

  it("does not exceed the 750 KB per-image or 2.5 MB aggregate budget", async () => {
    const fetchImage = vi.fn(async () =>
      binaryResponse({
        bytes: new Uint8Array(750_000),
        contentType: "image/png",
      }),
    );
    const rehost = vi.fn(
      async ({ sourceImage }: { sourceImage: BrandSourceImage }) =>
        sourceImage.url,
    );

    const result = await rehostSourceImages({
      sourceImages: Array.from({ length: 7 }, (_, index) =>
        image(`https://example.com/${index}.png`),
      ),
      fetchImage,
      rehost,
    });

    expect(fetchImage).toHaveBeenCalledTimes(5);
    expect(rehost).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(3);
  });

  it("sanitizes fetched SVGs and rejects unsafe or non-image content", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValueOnce(
        binaryResponse({
          bytes: new TextEncoder().encode('<svg onload="alert(1)"></svg>'),
          contentType: "image/svg+xml",
        }),
      )
      .mockResolvedValueOnce(
        binaryResponse({
          bytes: new Uint8Array([1]),
          contentType: "text/html",
        }),
      )
      .mockResolvedValueOnce(
        binaryResponse({
          bytes: new TextEncoder().encode('<svg><path d="M0 0" /></svg>'),
          contentType: "image/svg+xml",
        }),
      );
    const rehost = vi.fn(
      async ({
        binary,
      }: {
        binary: { bytes: Uint8Array; contentType: string };
      }) => {
        expect(binary.contentType).toBe("image/svg+xml");
        return "https://storage.test/safe.svg";
      },
    );

    const result = await rehostSourceImages({
      sourceImages: [
        image("https://example.com/unsafe.svg"),
        image("https://example.com/page"),
        image("https://example.com/safe.svg"),
      ],
      fetchImage,
      rehost,
    });

    expect(rehost).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        sourceImage: image("https://example.com/safe.svg"),
        url: "https://storage.test/safe.svg",
      },
    ]);
  });
});
