import { buildAgentActionRegistry } from "@tandem/agent";
import { fetchWebArticle } from "@/lib/article-extraction/fetch-web-article";

/**
 * THE action registry for /api/chat — tool definitions AND dispatch both
 * resolve from here (Phase 3 integration). It is the email-sdk built-ins plus
 * the agent-level analysis actions (getBlockDetails, §9.4 catalog-lookup) plus
 * the Phase 7.4 fetchWebContent tool, whose network executor (SSRF-guarded
 * fetch + article extraction) only this app can provide.
 *
 * Module-level singleton on purpose: buildToolGuidance(chatActionRegistry) is
 * part of the STATIC prompt prefix, so the registry must be identical for
 * every request in a server process (Gemini implicit-caching contract).
 */
export const chatActionRegistry = buildAgentActionRegistry({
  fetchWebArticle,
  // Generative-UI widget tools: this app renders the widgets (chat/widgets/)
  // and fulfills the host-side executions in tools.ts.
  shouldIncludeWidgetActions: true,
});
