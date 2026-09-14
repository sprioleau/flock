import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { after } from "next/server";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { chargeCreditForRequest } from "@/lib/auth/credits";
import { getToken } from "@/lib/auth/auth-server";
import { buildSaveBrandKitPayload, type BrandKit, type BrandSourceImage } from "@/lib/brand-kit";
import { generateBrandKit } from "@/lib/brand-kit-extraction/generate-brand-kit";
import {
  rehostSourceImages,
  type RehostedSourceImage,
} from "@/lib/brand-kit-extraction/rehost-source-images";
import type { AssetBinary } from "@/lib/brand-kit-extraction/confirm-asset";
import {
  MAX_URL_LENGTH,
  normalizeWebsiteUrl,
  validateUrlSyntax,
} from "@/lib/brand-kit-extraction/url-guard";

/*
  Browser rendering needs a full Node.js runtime. Keep this explicit so a
  future route-level default cannot silently move Chromium onto the Edge
  runtime. The brand-kit model has a 120-second budget of its own, so the
  function leaves room for the guarded page fetch and browser capture first.
*/
export const runtime = "nodejs";
export const maxDuration = 180;

/*
  POST /api/brand-kit/generate — Phase 7.4 brand-kit ingestion.

  Contract (the panel, onboarding, and chat intent use exactly this):
    request:  { url: string, sessionId: string }
    response: { isOk: true, jobId: Id<"brandKitGenerationJobs"> }
            | { isOk: false, message: string }   // friendly, user-facing

  The body always carries the contract shape; failure statuses are 4xx/5xx
  (400 bad request, 429 cooldown, 422 unreadable site, 5xx generation) so
  callers may branch on either `isOk` or `response.ok`.

  The response returns after the durable job row is created. Next `after()`
  runs the guarded extraction, writes progress to that row, saves the kit, and
  marks completion so the UI survives closing its modal or reloading.
*/

const requestBodySchema = z.object({
  url: z.string().min(1).max(MAX_URL_LENGTH),
  sessionId: z.string().min(1),
});

/*
  Demo-scale abuse guard: one generation per instance per 5s. In-memory by
  design (single dev/demo instance) — real rate limiting is a later concern.
*/
const COOLDOWN_MS = 5_000;
let lastRequestStartedAtMs = 0;

function failureResponse({ message, status }: { message: string; status: number }): Response {
  return Response.json({ isOk: false, message }, { status });
}

function sourceImageName({
  brandName,
  sourceImage,
  index,
}: {
  brandName: string;
  sourceImage: BrandSourceImage;
  index: number;
}): string {
  const alt = sourceImage.alt?.replace(/\s+/g, " ").trim() ?? "";
  return alt.length > 0 ? alt.slice(0, 60) : `${brandName} source image ${index + 1}`;
}

async function uploadScrapedSourceImage({
  convex,
  sessionId,
  brandName,
  sourceImage,
  binary,
  index,
}: {
  convex: ConvexHttpClient;
  sessionId: string;
  brandName: string;
  sourceImage: BrandSourceImage;
  binary: AssetBinary;
  index: number;
}): Promise<string | null> {
  const postUrl = await convex.mutation(api.files.generateUploadUrl, {});
  const uploadResponse = await fetch(postUrl, {
    method: "POST",
    headers: { "Content-Type": binary.contentType },
    body: new Blob([binary.bytes.buffer as ArrayBuffer], { type: binary.contentType }),
  });
  if (!uploadResponse.ok) {
    return null;
  }
  const { storageId } = (await uploadResponse.json()) as { storageId: Id<"_storage"> };
  const registered = await convex.mutation(api.assets.register, {
    sessionId,
    storageId,
    kind: "scraped",
    name: sourceImageName({ brandName, sourceImage, index }),
    ...(sourceImage.alt === undefined ? {} : { alt: sourceImage.alt }),
    sourceUrl: sourceImage.url,
  });
  return registered.url;
}

function withDurableSourceImages({
  brandKit,
  rehosted,
}: {
  brandKit: BrandKit;
  rehosted: RehostedSourceImage[];
}): BrandKit {
  if (brandKit.sourceImages === undefined) {
    return brandKit;
  }
  const sourceImages = rehosted.map(({ sourceImage, url }) => ({ ...sourceImage, url }));
  return {
    ...brandKit,
    /*
      Once a source image enters the saved kit it must be the durable storage
      URL. Failed siblings disappear from the active kit but do not fail the
      scrape; the rehosting helper has already enforced the shared byte caps.
    */
    sourceImages,
  };
}

export async function POST(request: Request) {
  const now = Date.now();
  if (now - lastRequestStartedAtMs < COOLDOWN_MS) {
    return failureResponse({
      status: 429,
      message: "One moment — we're still working on the last request. Try again in a few seconds.",
    });
  }
  lastRequestStartedAtMs = now;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return failureResponse({
      status: 400,
      message: "That request wasn't valid JSON — please send { \"url\": \"https://…\" }.",
    });
  }
  const parsedBody = requestBodySchema.safeParse(json);
  if (!parsedBody.success) {
    return failureResponse({
      status: 400,
      message: "Please provide a website address (like your-brand.com).",
    });
  }

  /*
    Reject malformed and obviously private destinations at the HTTP boundary
    before charging a credit or starting Chromium. The generator repeats this
    check and adds DNS resolution immediately before each network request.
  */
  const normalizedUrl = normalizeWebsiteUrl(parsedBody.data.url);
  const syntaxResult = validateUrlSyntax(normalizedUrl);
  if (!syntaxResult.isAllowed) {
    return failureResponse({
      status: 400,
      message: "Please provide a public website address (like your-brand.com).",
    });
  }

  /*
    Scraping and summarising a site is real inference — it costs a credit.
    A deployment with no API key can only 503 below, so it is billed as a
    mock run (free) rather than charging for a request that cannot succeed.
  */
  const charge = await chargeCreditForRequest({
    request,
    isMockRun: !process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  });
  if (!charge.isAllowed) {
    return failureResponse({ status: 429, message: charge.message });
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl === undefined || convexUrl.length === 0) {
    return failureResponse({ status: 503, message: "Brand kit generation isn't configured yet." });
  }
  const token = await getToken();
  const convex = new ConvexHttpClient(convexUrl);
  if (token !== null && token !== undefined) {
    convex.setAuth(token);
  }
  const sessionId = parsedBody.data.sessionId;
  const jobId = await convex.mutation(api.brandKitGeneration.start, {
    sessionId,
    sourceUrl: normalizedUrl,
  });

  after(async () => {
    try {
      const result = await generateBrandKit({
        url: normalizedUrl,
        onProgress: async (step) => {
          await convex.mutation(api.brandKitGeneration.setProgress, { sessionId, jobId, step });
        },
      });
      if (!result.isOk) {
        await convex.mutation(api.brandKitGeneration.fail, {
          sessionId,
          jobId,
          errorMessage: result.message,
        });
        return;
      }
      await convex.mutation(api.brandKitGeneration.setProgress, {
        sessionId,
        jobId,
        step: "saving-kit",
      });
      const sourceImages = result.brandKit.sourceImages ?? [];
      let sourceImageIndex = 0;
      const rehostedSourceImages = await rehostSourceImages({
        sourceImages,
        rehost: async ({ sourceImage, binary }) => {
          const index = sourceImageIndex;
          sourceImageIndex += 1;
          return await uploadScrapedSourceImage({
            convex,
            sessionId,
            brandName: result.brandKit.name,
            sourceImage,
            binary,
            index,
          });
        },
      });
      const durableBrandKit = withDurableSourceImages({
        brandKit: result.brandKit,
        rehosted: rehostedSourceImages,
      });
      await convex.mutation(api.brandKits.saveBrandKit, {
        sessionId,
        brandKit: buildSaveBrandKitPayload(durableBrandKit),
      });
      const savedKit = await convex.query(api.brandKits.getActiveBrandKit, { sessionId });
      if (savedKit === null) {
        throw new Error("The generated brand kit was not available after saving.");
      }
      await convex.mutation(api.brandKitGeneration.complete, {
        sessionId,
        jobId,
        brandKitId: savedKit.kitId,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "The brand kit could not be generated.";
      await convex
        .mutation(api.brandKitGeneration.fail, { sessionId, jobId, errorMessage })
        .catch(() => undefined);
    }
  });

  return Response.json({ isOk: true, jobId }, { status: 202 });
}
