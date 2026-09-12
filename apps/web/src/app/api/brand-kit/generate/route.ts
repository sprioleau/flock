import { z } from "zod";
import { chargeCreditForRequest } from "@/lib/auth/credits";
import { generateBrandKit } from "@/lib/brand-kit-extraction/generate-brand-kit";
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

  Contract (the brand-kit panel codes against exactly this):
    request:  { url: string }
    response: { isOk: true, brandKit: BrandKit }
            | { isOk: false, message: string }   // friendly, user-facing

  The body always carries the contract shape; failure statuses are 4xx/5xx
  (400 bad request, 429 cooldown, 422 unreadable site, 5xx generation) so
  callers may branch on either `isOk` or `response.ok`.

  Pipeline: src/lib/brand-kit-extraction/ — guarded fetch → deterministic
  signal harvest → one Gemini structured call → deterministic contrast
  enforcement → Zod-validated BrandKit.
*/

const requestBodySchema = z.object({
  url: z.string().min(1).max(MAX_URL_LENGTH),
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

  const result = await generateBrandKit({ url: normalizedUrl });
  if (!result.isOk) {
    return failureResponse({ status: result.statusCode, message: result.message });
  }
  return Response.json({ isOk: true, brandKit: result.brandKit });
}
