import "server-only";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";

/*
  Read `documents.isDemo` for a chat turn — the one lookup that stops a public
  /demo link from spending the deployment's real Gemini quota.

  WHY THIS ROUTE NEEDS A LOOKUP AT ALL, when /api/personas does not: the
  personas route already fetches the document to build its outline, so its copy
  of this answer is free. A chat turn carries the document IN THE REQUEST and
  touches Convex not at all, so answering "is this a demo document?" costs a
  round trip that did not exist before.

  WHAT THAT COSTS, and why it is worth it. `documents.getDocumentIsDemo` is a
  single normalizeId + row get returning one boolean — deliberately NOT
  `getDocumentByKey`, which replays the version-0 snapshot plus every operation
  since to rebuild a document this route was already sent. One indexed point
  read against a turn that is about to spend seconds inside a language model is
  not a cost worth optimising, and the alternative — trusting a client header —
  is not a guard at all.

  IT IS SKIPPED WHENEVER THE ANSWER CANNOT CHANGE THE OUTCOME: the caller
  short-circuits when the request already forces the mock, and this function
  returns immediately when the request named no document.

  FAILS CLOSED, which is the opposite of the credit path next door. A lookup
  that cannot answer must not authorise spend, so an unreachable Convex means
  "treat it as a demo" — the mock. The blast radius of that choice is small
  because it is self-limiting: this app's documents LIVE in Convex, so a
  deployment that cannot reach Convex has no document to chat about either. The
  visitor loses a real turn they could not have had anyway; the alternative
  failure mode is a public demo quietly billing the owner's shared free tier
  through an outage.
*/
export async function resolveIsDemoDocument({
  documentId,
}: {
  documentId: string | undefined;
}): Promise<boolean> {
  if (documentId === undefined) {
    return false;
  }
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl === undefined) {
    /* No Convex configured at all is a local/test shape, not an outage: there
       are no demo documents to protect because there are no documents. */
    return false;
  }
  try {
    return await new ConvexHttpClient(convexUrl).query(api.documents.getDocumentIsDemo, {
      documentKey: documentId,
    });
  } catch (error) {
    console.warn("[chat] could not resolve isDemo; forcing the mock for this turn", error);
    return true;
  }
}
