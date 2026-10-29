import { describe, expect, it, vi } from "vitest";
import type { BrandSourceImage } from "@/lib/brand-kit";
import { downloadSourceImageFiles } from "./download-source-image-files";

function image(url: string): BrandSourceImage {
  return { url };
}

function imageResult(bytes: Uint8Array, contentType = "image/png") {
  return { isOk: true as const, bytes, contentType };
}

describe("downloadSourceImageFiles", () => {
  it("starts three downloads, caps work at five inputs, and returns input order after reordering completions", async () => {
    const pending = new Map<
      string,
      (result: ReturnType<typeof imageResult>) => void
    >();
    let activeCount = 0;
    let maximumActiveCount = 0;
    const fetchImage = vi.fn(({ url }: { url: string }) => {
      activeCount += 1;
      maximumActiveCount = Math.max(maximumActiveCount, activeCount);
      return new Promise<ReturnType<typeof imageResult>>((resolve) => {
        pending.set(url, (result) => {
          activeCount -= 1;
          resolve(result);
        });
      });
    });
    const sourceImages = Array.from({ length: 7 }, (_, index) =>
      image(`https://example.com/${index}.png`),
    );
    const resultPromise = downloadSourceImageFiles({ sourceImages, fetchImage });

    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(3));
    expect(maximumActiveCount).toBe(3);
    expect(fetchImage.mock.calls.map(([args]) => args.url)).toEqual([
      "https://example.com/0.png",
      "https://example.com/1.png",
      "https://example.com/2.png",
    ]);
    pending.get("https://example.com/2.png")?.(
      imageResult(new Uint8Array([3])),
    );
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(4));
    pending.get("https://example.com/1.png")?.(
      imageResult(new Uint8Array([2])),
    );
    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledTimes(5));
    pending.get("https://example.com/0.png")?.(
      imageResult(new Uint8Array([1])),
    );
    pending.get("https://example.com/4.png")?.(
      imageResult(new Uint8Array([5])),
    );
    pending.get("https://example.com/3.png")?.(
      imageResult(new Uint8Array([4])),
    );

    const files = await resultPromise;
    expect(maximumActiveCount).toBe(3);
    expect(files.map((file) => [...file.data])).toEqual([[1], [2], [3], [4], [5]]);
    expect(fetchImage).toHaveBeenCalledTimes(5);
  });

  it("applies the aggregate byte cap in input order and skips an oversized candidate without stopping later candidates", async () => {
    const fetchImage = vi.fn(async ({ url }: { url: string }) => {
      if (url.endsWith("/0.png") || url.endsWith("/1.png") || url.endsWith("/2.png")) {
        return imageResult(new Uint8Array(750_000));
      }
      if (url.endsWith("/3.png")) {
        return imageResult(new Uint8Array(400_000));
      }
      return imageResult(new Uint8Array(200_000));
    });

    const files = await downloadSourceImageFiles({
      sourceImages: Array.from({ length: 5 }, (_, index) =>
        image(`https://example.com/${index}.png`),
      ),
      fetchImage,
    });

    expect(files.map((file) => file.data.byteLength)).toEqual([
      750_000,
      750_000,
      750_000,
      200_000,
    ]);
  });

  it("requests no images for an empty selection", async () => {
    const fetchImage = vi.fn();

    await expect(
      downloadSourceImageFiles({ sourceImages: [], fetchImage }),
    ).resolves.toEqual([]);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("skips failed downloads and non-image MIME types without losing valid siblings", async () => {
    const fetchImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce({
        isOk: false as const,
        reason: "network" as const,
        message: "unavailable",
      })
      .mockResolvedValueOnce(imageResult(new Uint8Array([3]), "text/html"))
      .mockResolvedValueOnce(imageResult(new Uint8Array([4]), "IMAGE/WEBP"));

    const files = await downloadSourceImageFiles({
      sourceImages: Array.from({ length: 4 }, (_, index) =>
        image(`https://example.com/${index}.png`),
      ),
      fetchImage,
    });

    expect(fetchImage).toHaveBeenCalledTimes(4);
    expect(files).toEqual([
      { type: "file", mediaType: "IMAGE/WEBP", data: new Uint8Array([4]) },
    ]);
  });
});
