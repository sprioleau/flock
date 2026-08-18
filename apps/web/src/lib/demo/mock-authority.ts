/*
  WHO DECIDES that a request runs the deterministic mock instead of a real
  model — the rule `/api/chat` and `/api/personas` both apply, in one place.

  This is two lines of logic with a long comment because the comment is the
  load-bearing part. The obvious "simplification" — deleting this and testing
  the `x-flock-mock` header inline, which is what both routes did before — is
  exactly the regression this module exists to prevent.

  ---------------------------------------------------------------------------
  THE RULE
  ---------------------------------------------------------------------------

  The mock is forced when EITHER of two things is true, and the two are not
  the same kind of thing at all:

  1. THE DOCUMENT IS A DEMO DOCUMENT (`documents.isDemo`, resolved server-side
     from the row). This is a GUARD. `/demo` is a public, unauthenticated link,
     and `/api/chat` and `/api/personas` spend a Gemini free-tier quota that is
     shared with production — 15 RPM and 500 requests per day for the whole
     deployment, measured and recorded in api/chat/constants.ts. One shared
     link with traffic empties the day in minutes and takes the real product
     down with it. So the demo's spend ceiling cannot be a client's decision.

  2. THE CLIENT ASKED FOR IT (`x-flock-mock: 1`). This is a REQUEST, not a
     guard, and it is safe to honour precisely because of the direction it
     points: a client can only ever ask for LESS spend. There is no version of
     this header that buys anything — it replaces the model, so "dodging" the
     work also dodges the answer. It stays because CI, a fresh clone with no
     API key, and the settings FAB's dev toggle all rely on it.

  ---------------------------------------------------------------------------
  WHY THE ROW AND NOT THE HEADER, spelled out
  ---------------------------------------------------------------------------

  A header can be omitted. That is the whole argument. If the demo's protection
  were `x-flock-mock: 1` sent by the demo's own client — which is what stage 1
  shipped — then anyone pointing a script at a demo document, or simply opening
  devtools, could strip the header and spend the deployment's real quota
  through a link that was published for strangers. Reading `isDemo` off the
  document row moves the decision to the one place the client cannot reach.

  The two directions are NOT symmetric, and it matters:

  - Turning the mock OFF for a demo document: impossible. The row says demo,
    the mock is forced, and no header, body field or provider preference is
    consulted afterwards.
  - Turning the mock ON for a document that is not a demo: possible, via the
    header, and already possible before any of this. It is not a bypass of
    anything worth bypassing — the caller gets canned output and no model call.
    Worth knowing about, not worth breaking CI over.
*/

export interface ForcedMockInputs {
  /*
    Did the DOCUMENT ROW say this is a /demo scratch document? Server-resolved
    only — never a body field, never a header, never inferred from a referrer.
  */
  isDemoDocument: boolean;
  /* Did the request carry `x-flock-mock: 1`? A request for less spend. */
  isMockRequestedByClient: boolean;
}

/*
  Must this request run the deterministic mock, whatever else the deployment
  could have run for it?
*/
export function selectIsMockForced({
  isDemoDocument,
  isMockRequestedByClient,
}: ForcedMockInputs): boolean {
  return isDemoDocument || isMockRequestedByClient;
}
