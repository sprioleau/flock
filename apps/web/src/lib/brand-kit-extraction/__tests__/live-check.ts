/*
  Live verification harness for POST /api/brand-kit/generate — exercises the
  route through the RUNNING dev server (port 3000, which carries whatever
  outbound TLS cert env it needs), so this checks the real pipeline end to end:
  fetch → harvest → Gemini → repair → contract.

  Run from apps/web (uses real Gemini quota — one call per real site):
    ../../packages/email-sdk/node_modules/.bin/tsx src/lib/brand-kit-extraction/__tests__/live-check.ts <url> [<url> …]

  With no URLs it only runs the failure-path checks (bogus domain, private
  address, cooldown) — no model calls.
*/

import assert from "node:assert/strict";
import {
  getVariationContrastPairs,
  MIN_THEME_CONTRAST_RATIO,
  type BrandKit,
} from "@/lib/brand-kit";
import { brandKitSchema } from "../generate-brand-kit";

const ENDPOINT = "http://localhost:3000/api/brand-kit/generate";
const COOLDOWN_WAIT_MS = 5_500;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(url: string): Promise<{ status: number; body: { isOk: boolean; message?: string; brandKit?: BrandKit } }> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  /*
    Round-trip requirement: the body must be plain JSON.parse-able text.
  */
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
}

function reportKit(brandKit: BrandKit) {
  /*
    Contract round-trip: Zod contract + the brand-kit.ts contrast guard.
  */
  assert.equal(brandKitSchema.safeParse(brandKit).success, true, "kit passes brandKitSchema");
  console.log(`  name:   ${brandKit.name}`);
  console.log(`  fonts:  heading=${brandKit.fonts.heading} | body=${brandKit.fonts.body}`);
  console.log(`  logo:   ${brandKit.logoUrl ?? "(none)"}`);
  for (const variation of brandKit.variations) {
    console.log(`  variation "${variation.name}" (${variation.id}):`);
    for (const pair of getVariationContrastPairs(variation)) {
      assert.ok(
        pair.ratio !== null && pair.ratio >= MIN_THEME_CONTRAST_RATIO,
        `${variation.id} ${pair.label} = ${pair.ratio}`,
      );
      console.log(
        `      ${pair.label}: ${pair.foreground} on ${pair.background} → ${pair.ratio?.toFixed(2)}:1`,
      );
    }
  }
}

async function main() {
  const urls = process.argv.slice(2);

  console.log("failure paths (no model calls)");
  const bogus = await post("https://this-site-definitely-does-not-exist-abc123xyz.com");
  console.log(`  bogus domain → ${bogus.status}: ${bogus.body.message}`);
  assert.equal(bogus.body.isOk, false);

  /*
    Immediately again — must hit the cooldown, proving rapid repeats bounce.
  */
  const rapid = await post("https://example.com");
  console.log(`  rapid repeat → ${rapid.status}: ${rapid.body.message}`);
  assert.equal(rapid.body.isOk, false);
  assert.equal(rapid.status, 429);

  await wait(COOLDOWN_WAIT_MS);
  const privateAddress = await post("http://169.254.169.254/latest/meta-data");
  console.log(`  private addr → ${privateAddress.status}: ${privateAddress.body.message}`);
  assert.equal(privateAddress.body.isOk, false);

  for (const url of urls) {
    await wait(COOLDOWN_WAIT_MS);
    console.log(`\n${url}`);
    const { status, body } = await post(url);
    if (!body.isOk) {
      console.log(`  FAILED (${status}): ${body.message}`);
      continue;
    }
    assert.equal(status, 200);
    reportKit(body.brandKit as BrandKit);
  }
  console.log("\nlive checks done");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
