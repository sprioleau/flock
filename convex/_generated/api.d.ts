/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentText from "../agentText.js";
import type * as assets from "../assets.js";
import type * as auth from "../auth.js";
import type * as authCredits from "../authCredits.js";
import type * as authEmail from "../authEmail.js";
import type * as authIdentity from "../authIdentity.js";
import type * as authMagicLink from "../authMagicLink.js";
import type * as authMigration from "../authMigration.js";
import type * as brandKits from "../brandKits.js";
import type * as cleanup from "../cleanup.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as documents from "../documents.js";
import type * as files from "../files.js";
import type * as ghost from "../ghost.js";
import type * as healthcheck from "../healthcheck.js";
import type * as history from "../history.js";
import type * as http from "../http.js";
import type * as model_assets from "../model/assets.js";
import type * as model_brandKitAssets from "../model/brandKitAssets.js";
import type * as model_cleanup from "../model/cleanup.js";
import type * as model_emailDocuments from "../model/emailDocuments.js";
import type * as model_savedSections from "../model/savedSections.js";
import type * as model_textBlockSync from "../model/textBlockSync.js";
import type * as personaFindings from "../personaFindings.js";
import type * as personas from "../personas.js";
import type * as presence from "../presence.js";
import type * as prosemirror from "../prosemirror.js";
import type * as savedSections from "../savedSections.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentText: typeof agentText;
  assets: typeof assets;
  auth: typeof auth;
  authCredits: typeof authCredits;
  authEmail: typeof authEmail;
  authIdentity: typeof authIdentity;
  authMagicLink: typeof authMagicLink;
  authMigration: typeof authMigration;
  brandKits: typeof brandKits;
  cleanup: typeof cleanup;
  comments: typeof comments;
  crons: typeof crons;
  documents: typeof documents;
  files: typeof files;
  ghost: typeof ghost;
  healthcheck: typeof healthcheck;
  history: typeof history;
  http: typeof http;
  "model/assets": typeof model_assets;
  "model/brandKitAssets": typeof model_brandKitAssets;
  "model/cleanup": typeof model_cleanup;
  "model/emailDocuments": typeof model_emailDocuments;
  "model/savedSections": typeof model_savedSections;
  "model/textBlockSync": typeof model_textBlockSync;
  personaFindings: typeof personaFindings;
  personas: typeof personas;
  presence: typeof presence;
  prosemirror: typeof prosemirror;
  savedSections: typeof savedSections;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  prosemirrorSync: import("@convex-dev/prosemirror-sync/_generated/component.js").ComponentApi<"prosemirrorSync">;
  presence: import("@convex-dev/presence/_generated/component.js").ComponentApi<"presence">;
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
