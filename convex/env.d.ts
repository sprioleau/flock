/**
 * Convex's V8 function runtime exposes environment variables (dashboard-set
 * plus built-ins like CONVEX_CLOUD_URL) via `process.env`, but this tsconfig
 * deliberately excludes Node types (functions don't run in Node). This
 * minimal ambient declaration types exactly the surface the runtime provides.
 */
declare const process: {
  env: Record<string, string | undefined>;
};
