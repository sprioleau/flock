import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config.js";
import presence from "@convex-dev/presence/convex.config.js";
import prosemirrorSync from "@convex-dev/prosemirror-sync/convex.config.js";

const app = defineApp();
app.use(prosemirrorSync);
app.use(presence);
/*
  Better Auth (docs/proposals/better-auth-evaluation.md): the anonymous →
  magic-link identity spine. Auth tables (user/session/account/verification)
  live INSIDE this component's namespace, so nothing in convex/schema.ts moves
  and no app table gains an auth foreign key — coexistence by construction.
*/
app.use(betterAuth);

export default app;
