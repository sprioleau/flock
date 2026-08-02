import { handler } from "@/lib/auth/auth-server";

/**
 * Better Auth's endpoints, served from Flock's own origin and forwarded to the
 * Convex site domain. Same-origin is the point: the session cookie stays
 * first-party, which is the difference between "signed in" and "signed in
 * until Safari decides otherwise".
 *
 * Not gated by apps/web/src/proxy.ts — its matcher excludes /api by design, so
 * magic-link verification works on a device that has never seen the password
 * page. The visitor still meets the gate on the way to /studio afterwards.
 */
export const { GET, POST } = handler;
