/**
 * Test-time stand-in for the `server-only` package.
 *
 * `server-only` has no runtime behaviour — it is a build-time tripwire that
 * makes Next fail the build if a server module is pulled into a client bundle.
 * Next resolves it internally, so it is not a real dependency and cannot be
 * resolved by Vitest's plain Node resolver; importing a server module under
 * test therefore dies with "Cannot find package 'server-only'".
 *
 * Aliased in vitest.config.ts. Stubbing it here costs nothing: the guard that
 * matters still runs in `next build`, which is where a client-bundle mistake
 * would actually be caught.
 */
export {};
