import type { IntegrityError } from "../store/integrity";

/**
 * Thrown by the renderers when a document fails checkDocumentIntegrity.
 * Carries the full structured error list so callers (API routes, agents) can
 * return machine-readable diagnostics instead of a flat message.
 */
export class DocumentIntegrityError extends Error {
  readonly errors: readonly IntegrityError[];

  constructor(errors: readonly IntegrityError[]) {
    const summary = errors.map((error) => `${error.code}: ${error.message}`).join(" · ");
    super(
      `Email document failed integrity check (${errors.length} error${
        errors.length === 1 ? "" : "s"
      }): ${summary}`,
    );
    this.name = "DocumentIntegrityError";
    this.errors = errors;
  }
}
