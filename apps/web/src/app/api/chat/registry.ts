import { buildAgentActionRegistry } from "@flock/agent";
import { readWebPage } from "@/lib/content-ingestion/ingest-page";

/**
 * THE action registry for /api/chat — tool definitions AND dispatch both
 * resolve from here (Phase 3 integration). It is the email-sdk built-ins plus
 * the agent-level analysis actions (getBlockDetails, §9.4 catalog-lookup) plus
 * the ingestion tool — readWebPage — whose network executor (robots.txt check,
 * SSRF-guarded fetch, extraction, image rehosting) only this app can provide.
 *
 * There were two ingestion tools here, one per kind of page. Choosing between
 * them meant classifying a page nobody had fetched, so the choice could only
 * be made from the user's phrasing. One reader removes the choice.
 *
 * The injected executor is SESSION-LESS: this registry is a module-level
 * singleton on purpose, because buildToolGuidance(chatActionRegistry) is part
 * of the STATIC prompt prefix and must be identical for every request in a
 * server process (Gemini implicit-caching contract). The chat route fulfills
 * the ingestion tool host-side with the caller's session so a rehosted image
 * lands in that session's Asset Library — see tools.ts.
 */
export const chatActionRegistry = buildAgentActionRegistry({
  readWebPage,
  // Generative-UI widget tools: this app renders the widgets (chat/widgets/)
  // and fulfills the host-side executions in tools.ts.
  shouldIncludeWidgetActions: true,
});
