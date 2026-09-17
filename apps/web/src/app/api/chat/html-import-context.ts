import { api } from "@convex/_generated/api";
import { fetchAuthQuery } from "@/lib/auth/auth-server";

const MAX_WARNING_COUNT = 12;
const MAX_UNSUPPORTED_FEATURE_COUNT = 12;
const MAX_WARNING_DETAIL_LENGTH = 240;
const MAX_FEATURE_LENGTH = 80;

export interface HtmlImportReport {
  importerVersion: "1";
  warnings: { code: string; detail: string }[];
  unsupportedFeatures: string[];
}

function safeReportText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/*
  Keep the report useful to the model without sending the retained source
  snapshot. The source is provenance for preview and rollback, not prompt
  input, and may contain arbitrary customer-authored markup.
*/
export function formatHtmlImportContextLine(report: HtmlImportReport): string {
  const warnings = report.warnings.slice(0, MAX_WARNING_COUNT).map((warning) => {
    const code = safeReportText(warning.code, MAX_FEATURE_LENGTH);
    const detail = safeReportText(warning.detail, MAX_WARNING_DETAIL_LENGTH);
    return `- ${code}: ${detail}`;
  });
  const unsupportedFeatures = report.unsupportedFeatures
    .slice(0, MAX_UNSUPPORTED_FEATURE_COUNT)
    .map((feature) => safeReportText(feature, MAX_FEATURE_LENGTH));

  return [
    "[HTML IMPORT CONTEXT — auto-attached, not written by the user]",
    `This editable document was validated from HTML by importer v${report.importerVersion}. The current Flock document is the source of truth for edits; the original HTML is retained as provenance only and is not executable editor content.`,
    "When the user asks to improve this imported design, use the normal editor tools and inspect exact blocks before changing them. Prioritize visible losses named below, while staying within supported Flock blocks and preserving confirmed image and link URLs when they are still useful. Do not claim unsupported source constructs were preserved; describe any unavoidable loss plainly.",
    warnings.length === 0 ? "Warnings: none reported." : ["Warnings:", ...warnings].join("\n"),
    unsupportedFeatures.length === 0
      ? "Unsupported constructs: none reported."
      : `Unsupported constructs: ${unsupportedFeatures.join(", ")}`,
  ].join("\n");
}

interface StoredDocumentWithHtmlImport {
  htmlImport?: HtmlImportReport;
}

/*
  Read only the active document's bounded importer report. A missing document,
  ordinary draft, deleted row, or unavailable Convex deployment fails soft so
  the ordinary chat path remains byte-for-byte equivalent in behavior.
*/
export async function resolveHtmlImportContext({
  documentId,
}: {
  documentId?: string;
}): Promise<string | null> {
  if (documentId === undefined) {
    return null;
  }
  try {
    const payload = await fetchAuthQuery(api.documents.getDocumentByKey, {
      documentKey: documentId,
    });
    const report = (payload as StoredDocumentWithHtmlImport | null)?.htmlImport;
    return report === undefined ? null : formatHtmlImportContextLine(report);
  } catch {
    return null;
  }
}
