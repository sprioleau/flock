import { buildAgentActionRegistry } from "@flock/agent";
import { fetchWebArticle } from "@/lib/content-ingestion/ingest-article";
import { fetchPersonHighlight } from "@/lib/content-ingestion/ingest-person";

/**
 * THE action registry for /api/chat — tool definitions AND dispatch both
 * resolve from here (Phase 3 integration). It is the email-sdk built-ins plus
 * the agent-level analysis actions (getBlockDetails, §9.4 catalog-lookup) plus
 * the Phase 7.4 ingestion tools — fetchWebContent (a) and fetchPersonHighlight
 * (b) — whose network executors (robots.txt check, SSRF-guarded fetch,
 * extraction, image rehosting, search fan-out) only this app can provide.
 *
 * The injected executors are SESSION-LESS: this registry is a module-level
 * singleton on purpose, because buildToolGuidance(chatActionRegistry) is part
 * of the STATIC prompt prefix and must be identical for every request in a
 * server process (Gemini implicit-caching contract). The chat route fulfills
 * both ingestion tools host-side with the caller's session so a rehosted
 * image lands in that session's Asset Library — see tools.ts.
 */
export const chatActionRegistry = buildAgentActionRegistry({
  fetchWebArticle,
  fetchPersonHighlight,
  // Generative-UI widget tools: this app renders the widgets (chat/widgets/)
  // and fulfills the host-side executions in tools.ts.
  shouldIncludeWidgetActions: true,
});
