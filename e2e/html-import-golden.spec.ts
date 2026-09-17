import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import {
  getCanvasRoot,
  leaveDemoNarration,
  openDemoDocument,
  suppressOnboardingTour,
} from "./support/studio";

const FIXTURE_DIRECTORY = resolve(process.cwd(), "e2e/fixtures/html-import");
const IMAGE_PATHS = {
  "/editorial.png": resolve(process.cwd(), "assets/screenshots/comments-agent.png"),
  "/hero.png": resolve(process.cwd(), "assets/screenshots/studio-hero.png"),
  "/legacy-hero.png": resolve(process.cwd(), "assets/screenshots/sections-gallery.png"),
  "/logo.png": resolve(process.cwd(), "apps/web/public/assets/flock-social-card.png"),
  "/product-a.png": resolve(process.cwd(), "assets/screenshots/brand-kit.png"),
  "/product-b.png": resolve(process.cwd(), "assets/screenshots/multi-agent-canvas.png"),
} as const;

const GOLDEN_CASES = [
  {
    fixture: "background-hero.html",
    snapshot: "background-hero.png",
    expectedText: "A warmer way to welcome autumn.",
    hasBackgroundImage: true,
    minimumImageCount: 1,
  },
  {
    fixture: "product-catalog.html",
    snapshot: "product-catalog.png",
    expectedText: "Build your desk setup",
    hasBackgroundImage: false,
    minimumImageCount: 2,
  },
  {
    fixture: "editorial-newsletter.html",
    snapshot: "editorial-newsletter.png",
    expectedText: "Designing for the long view",
    hasBackgroundImage: false,
    minimumImageCount: 1,
  },
  {
    fixture: "legacy-table.html",
    snapshot: "legacy-table.png",
    expectedText: "Legacy markup, editable result",
    hasBackgroundImage: true,
    minimumImageCount: 0,
  },
] as const;

async function openStudioForImport(page: Page): Promise<void> {
  await suppressOnboardingTour(page);
  const documentId = await openDemoDocument(page);
  await leaveDemoNarration(page);
  const brandOnboardingSkip = page.getByTestId("brand-onboarding-skip");
  const hasBrandOnboardingGate = await brandOnboardingSkip
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (hasBrandOnboardingGate) {
    await brandOnboardingSkip.click();
  }
  await expect(getCanvasRoot(page, documentId)).toBeVisible();
}

async function installFixtureImageRoutes(page: Page): Promise<void> {
  await page.route("https://fixtures.flock.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname as keyof typeof IMAGE_PATHS;
    const path = IMAGE_PATHS[pathname];
    if (path === undefined) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({ path, contentType: "image/png" });
  });
}

test.describe("HTML import golden corpus", () => {
  test.beforeEach(async ({ page }) => {
    await installFixtureImageRoutes(page);
    await openStudioForImport(page);
  });

  for (const goldenCase of GOLDEN_CASES) {
    test(`renders ${goldenCase.fixture} as an editable preview`, async ({ page }) => {
      await page.getByRole("button", { name: "Import HTML email" }).click();
      await page
        .getByLabel("Upload HTML file")
        .setInputFiles(resolve(FIXTURE_DIRECTORY, goldenCase.fixture));
      await page.getByRole("button", { name: "Preview conversion" }).click();

      const preview = page.getByTestId("html-import-converted-email");
      await expect(preview).toBeVisible();
      await expect(preview).toContainText(goldenCase.expectedText);
      await expect(preview.locator("img")).toHaveCount(goldenCase.minimumImageCount);
      await expect(preview.locator('[style*="background-image"]')).toHaveCount(
        goldenCase.hasBackgroundImage ? 1 : 0,
      );
      await expect
        .poll(async () =>
          preview.locator("img").evaluateAll((images) =>
            images.every((image) => (image as HTMLImageElement).complete),
          ),
        )
        .toBe(true);

      const renderedEmail = preview
        .getByTestId("history-version-preview")
        .locator(":scope > div");
      await expect(renderedEmail).toHaveScreenshot(
        goldenCase.snapshot,
        {
          animations: "disabled",
          caret: "hide",
          scale: "css",
        },
      );
    });
  }

  test("rolls an imported draft back to its recorded source", async ({ page }) => {
    const sourceDocumentId = new URL(page.url()).searchParams.get("doc");
    expect(sourceDocumentId).not.toBeNull();

    await page.getByRole("button", { name: "Import HTML email" }).click();
    await page
      .getByLabel("Upload HTML file")
      .setInputFiles(resolve(FIXTURE_DIRECTORY, "product-catalog.html"));
    await page.getByRole("button", { name: "Preview conversion" }).click();
    await page.getByRole("button", { name: "Import as new draft" }).click();
    await expect(page).toHaveURL(/\/studio\?doc=/);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("doc"))
      .not.toBe(sourceDocumentId);

    await page.getByRole("button", { name: "Drafts on this canvas" }).click();
    await page.getByRole("menuitem", { name: "Roll back import" }).click();
    await expect(page.getByRole("heading", { name: "Roll back this import?" })).toBeVisible();
    await page.getByRole("button", { name: "Roll back import" }).click();

    await expect
      .poll(() => new URL(page.url()).searchParams.get("doc"))
      .toBe(sourceDocumentId);
    await expect(page.getByText("Import rolled back")).toBeVisible();
  });
});
