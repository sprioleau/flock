import { rawData } from "caniemail";

/**
 * WHICH EMAIL CLIENTS THE PRE-SEND CHECK REPORTS ON, and why it is not simply
 * "all of them".
 *
 * caniemail's library API takes a list of clients and throws a RangeError the
 * moment it meets a feature the dataset has no entry for on one of them:
 *
 *     RangeError: Feature "word-wrap" not found on "gmail.ios".
 *
 * That is not a hypothetical. Every Flock email contains `word-wrap`, because
 * TextBlockView sets it unconditionally so unbroken runs wrap inside their
 * block, and the caniemail dataset has no `word-wrap` row for eleven clients
 * including three Gmail surfaces. So the very first real document crashed the
 * checker, and it would have crashed on every document forever. The library
 * treats "nobody has tested this combination" and "this input is invalid" as
 * the same event, and there is no option to soften it.
 *
 * Catching the throw is not a fix: the exception aborts the whole run, so one
 * missing data point costs every finding for every client. Running each
 * client separately would contain the blast radius but still lose those
 * eleven clients on every single email.
 *
 * THE FIX IS TO PICK CLIENTS THE DATASET ACTUALLY COVERS. Nine clients have a
 * complete row for all 307 features, so no document — whatever CSS a user's
 * styling produces — can trip the throw. They are not a compromise set:
 * they are every platform of the four providers React Email itself defaults
 * its own compatibility warnings to (gmail, outlook, apple-mail, yahoo) that
 * the data supports, and they include the two clients that matter most for
 * email QA, Word-engine Outlook on Windows and Gmail's web client.
 *
 * The choice is CHECKED, not trusted: {@link findClientsWithIncompleteData}
 * recomputes the gaps from the shipped dataset, and a test asserts this list
 * has none. When a caniemail upgrade adds coverage or a client, that test is
 * what says so, instead of a RangeError in production.
 */
export const CHECKED_EMAIL_CLIENTS = [
  "apple-mail.ios",
  "apple-mail.macos",
  "gmail.android",
  "gmail.desktop-webmail",
  "outlook.android",
  "outlook.ios",
  "outlook.outlook-com",
  "outlook.windows",
  "yahoo.desktop-webmail",
] as const;

export type CheckedEmailClient = (typeof CHECKED_EMAIL_CLIENTS)[number];

/*
  Human labels for the clients above. caniemail's own ids are `provider.platform`
  slugs; a finding shown to a user says "Outlook (Windows)", not
  `outlook.windows`.
*/
export const CHECKED_EMAIL_CLIENT_LABELS: Readonly<Record<CheckedEmailClient, string>> = {
  "apple-mail.ios": "Apple Mail (iOS)",
  "apple-mail.macos": "Apple Mail (macOS)",
  "gmail.android": "Gmail (Android)",
  "gmail.desktop-webmail": "Gmail (web)",
  "outlook.android": "Outlook (Android)",
  "outlook.ios": "Outlook (iOS)",
  "outlook.outlook-com": "Outlook.com",
  "outlook.windows": "Outlook (Windows)",
  "yahoo.desktop-webmail": "Yahoo Mail (web)",
};

/*
  Every client in `clients` for which the shipped caniemail dataset is
  missing at least one feature — i.e. every client that can make
  `caniemail()` throw. An empty result is the invariant this module exists
  to hold.
*/
export function findClientsWithIncompleteData(
  clients: readonly string[],
): { client: string; missingFeatureTitles: string[] }[] {
  const incomplete: { client: string; missingFeatureTitles: string[] }[] = [];
  for (const client of clients) {
    const [provider, platform] = client.split(".");
    if (provider === undefined || platform === undefined) {
      incomplete.push({ client, missingFeatureTitles: ["<malformed client id>"] });
      continue;
    }
    /*
      Read through Object.entries rather than by index. The dataset's type
      names each provider as a known key, so a lookup by a plain `string`
      would need a cast to compile — and a cast here would be asserting the
      very thing this function exists to verify.
    */
    const missingFeatureTitles = rawData.data
      .filter((feature) => {
        const providerStats = Object.entries(feature.stats ?? {}).find(
          ([providerKey]) => providerKey === provider,
        )?.[1];
        const platformStats = Object.entries(providerStats ?? {}).find(
          ([platformKey]) => platformKey === platform,
        )?.[1];
        return platformStats === undefined;
      })
      .map((feature) => feature.title);
    if (missingFeatureTitles.length > 0) {
      incomplete.push({ client, missingFeatureTitles });
    }
  }
  return incomplete;
}
