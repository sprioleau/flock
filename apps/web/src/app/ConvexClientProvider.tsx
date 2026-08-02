"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ReactNode } from "react";

/**
 * Built on first render, never at import time — prerendering a page that never
 * talks to Convex (e.g. /_not-found) must not require a deployment address.
 * Cached at module scope, so every render still shares the one client.
 */
let convex: ConvexReactClient | undefined;

function getConvexClient(): ConvexReactClient {
  if (convex === undefined) {
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (convexUrl === undefined || convexUrl === "") {
      throw new Error("Convex is not configured (NEXT_PUBLIC_CONVEX_URL is not set).");
    }
    convex = new ConvexReactClient(convexUrl);
  }
  return convex;
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexProvider client={getConvexClient()}>{children}</ConvexProvider>;
}
