import { logRecord } from "../observability/log";
import { fetchBinaryResource, fetchTextResource } from "./fetch-page";
import { normalizeCssColor } from "./color-utils";
import { validateUrlSyntax } from "./url-guard";

const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const RECOVERY_TIMEOUT_MS = 5_000;

export interface AssetRecoverySuccess {
  isOk: true;
  html: string;
  finalUrl: string;
  siteName: string;
  themeColor: string;
  iconUrl: string;
}

export type AssetRecoveryResult = AssetRecoverySuccess | { isOk: false; reason: string };

export interface AssetRecoveryDependencies {
  fetchText(url: string, timeoutMs: number): Promise<string | null>;
  fetchBinary(url: string, timeoutMs: number): Promise<{ isOk: true; bytes: Uint8Array; contentType: string } | { isOk: false }>;
}

function hasRasterImageSignature(bytes: Uint8Array, contentType: string): boolean {
  if (bytes.length < 12) return false;
  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp =
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  const isIcon = bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
  return (isPng && contentType === "image/png") ||
    (isJpeg && contentType === "image/jpeg") ||
    (isWebp && contentType === "image/webp") ||
    (isIcon && (contentType === "image/x-icon" || contentType === "image/vnd.microsoft.icon"));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character];
  });
}

export async function recoverBrandAssets(
  rawUrl: string,
  options: { dependencies?: Partial<AssetRecoveryDependencies> } = {},
): Promise<AssetRecoveryResult> {
  const start = Date.now();
  const pageGuard = validateUrlSyntax(rawUrl);
  if (!pageGuard.isAllowed) return { isOk: false, reason: "unsafe_page_url" };
  const baseUrl = pageGuard.url;
  const deps: AssetRecoveryDependencies = {
    fetchText: (url, timeoutMs) => fetchTextResource({ url, timeoutMs, maxBytes: MAX_MANIFEST_BYTES }),
    fetchBinary: (url, timeoutMs) => fetchBinaryResource({ url, timeoutMs, maxBytes: MAX_ICON_BYTES }),
    ...options.dependencies,
  };

  try {
    let fallbackMetadata: { siteName: string; themeColor: string } | null = null;
    for (const manifestPath of ["/manifest.json", "/site.webmanifest"]) {
      const remainingForManifest = RECOVERY_TIMEOUT_MS - (Date.now() - start);
      if (remainingForManifest <= 0) break;
      const manifestUrl = new URL(manifestPath, baseUrl).toString();
      const manifestText = await deps.fetchText(manifestUrl, remainingForManifest);
      if (manifestText === null || Date.now() - start > RECOVERY_TIMEOUT_MS) continue;
      let manifest: unknown;
      try { manifest = JSON.parse(manifestText); } catch { continue; }
      if (typeof manifest !== "object" || manifest === null) continue;
      const data = manifest as Record<string, unknown>;
      const siteName = typeof data.name === "string" ? data.name.trim() : "";
      const themeColor = typeof data.theme_color === "string" ? normalizeCssColor(data.theme_color) : null;
      if (siteName.length < 2 || siteName.length > 80 || themeColor === null) continue;
      fallbackMetadata = { siteName, themeColor };
      const icons = Array.isArray(data.icons) ? data.icons.slice(0, 1) : [];
      for (const candidate of icons) {
        if (Date.now() - start > RECOVERY_TIMEOUT_MS || typeof candidate !== "object" || candidate === null) break;
        const src = (candidate as Record<string, unknown>).src;
        if (typeof src !== "string") continue;
        const iconUrl = new URL(src, manifestUrl).toString();
        const syntax = validateUrlSyntax(iconUrl);
        if (!syntax.isAllowed || syntax.url.origin !== baseUrl.origin) continue;
        const remainingForIcon = RECOVERY_TIMEOUT_MS - (Date.now() - start);
        if (remainingForIcon <= 0) break;
        const icon = await deps.fetchBinary(iconUrl, remainingForIcon);
        if (icon.isOk && hasRasterImageSignature(icon.bytes, icon.contentType)) {
          const html = `<html><head><title>${escapeHtml(siteName)}</title><meta property="og:site_name" content="${escapeHtml(siteName)}"><meta name="theme-color" content="${themeColor}"><link rel="icon" href="${escapeHtml(iconUrl)}"></head></html>`;
          return { isOk: true, html, finalUrl: baseUrl.toString(), siteName, themeColor, iconUrl };
        }
      }
    }
    if (fallbackMetadata !== null && Date.now() - start < RECOVERY_TIMEOUT_MS) {
      const iconUrl = new URL("/favicon.ico", baseUrl).toString();
      const remainingForIcon = RECOVERY_TIMEOUT_MS - (Date.now() - start);
      const icon = await deps.fetchBinary(iconUrl, remainingForIcon);
      if (icon.isOk && hasRasterImageSignature(icon.bytes, icon.contentType)) {
        const { siteName, themeColor } = fallbackMetadata;
        const html = `<html><head><title>${escapeHtml(siteName)}</title><meta property="og:site_name" content="${escapeHtml(siteName)}"><meta name="theme-color" content="${themeColor}"><link rel="icon" href="${escapeHtml(iconUrl)}"></head></html>`;
        return { isOk: true, html, finalUrl: baseUrl.toString(), siteName, themeColor, iconUrl };
      }
    }
    return { isOk: false, reason: fallbackMetadata !== null ? "no_verified_icon" : "manifest_metadata_insufficient" };
  } catch {
    return { isOk: false, reason: "asset_fetch_failed" };
  } finally {
    logRecord({ tag: "flock.brandKit.assetRecovery", elapsedMs: Date.now() - start });
  }
}
