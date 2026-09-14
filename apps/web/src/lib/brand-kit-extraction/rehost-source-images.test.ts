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
