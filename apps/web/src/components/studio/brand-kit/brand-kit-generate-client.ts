import type { BrandKitGenerateResult } from "@/lib/brand-kit";

/*
  The ONE client-side call to POST /api/brand-kit/generate (the website
  scraper pipeline). Extracted out of BrandKitPanel's inline fetch so a
  second surface — the brand-first onboarding gate — can drive the exact
  same generate flow instead of growing a second copy that drifts on the
  request shape or the fallback error copy.

  Route contract (see app/api/brand-kit/generate/route.ts): the body is
  ALWAYS `{ isOk: true, brandKit }` or `{ isOk: false, message }`, on every
  status code, so a caller may read `isOk` without branching on `response.ok`
  first. This wrapper's own catch only covers what the route cannot mean to
  answer — the route unreachable, or a reply that isn't JSON at all.
*/
const UNREACHABLE_MESSAGE =
  "Couldn't generate a brand kit from that URL right now. Check the address and try again.";

export async function generateBrandKitFromUrl(url: string): Promise<BrandKitGenerateResult> {
  try {
    const response = await fetch("/api/brand-kit/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    return (await response.json()) as BrandKitGenerateResult;
  } catch {
    return { isOk: false, message: UNREACHABLE_MESSAGE };
  }
}
