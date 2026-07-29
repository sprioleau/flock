import { buildAgentActionRegistry } from "@tandem/agent";

/**
 * THE action registry for /api/chat — tool definitions AND dispatch both
 * resolve from here (Phase 3 integration). It is the email-sdk built-ins plus
 * the agent-level analysis actions (getBlockDetails, §9.4 catalog-lookup).
 *
 * Module-level singleton on purpose: buildToolGuidance(chatActionRegistry) is
 * part of the STATIC prompt prefix, so the registry must be identical for
 * every request in a server process (Gemini implicit-caching contract).
 */
export const chatActionRegistry = buildAgentActionRegistry();
