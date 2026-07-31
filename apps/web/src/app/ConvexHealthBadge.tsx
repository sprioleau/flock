"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";

export function ConvexHealthBadge() {
  const health = useQuery(api.healthcheck.status);
  const isConnected = health?.isHealthy === true;

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${
        isConnected
          ? "border-green-600/40 text-green-700 dark:text-green-400"
          : "border-border text-muted-foreground"
      }`}
    >
      <span
        className={`size-2 rounded-full ${
          isConnected ? "bg-green-500" : "bg-muted-foreground animate-pulse"
        }`}
      />
      {isConnected ? "Convex connected" : "Connecting to Convex…"}
    </span>
  );
}
