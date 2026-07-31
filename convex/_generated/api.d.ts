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
import type * as brandKits from "../brandKits.js";
import type * as cleanup from "../cleanup.js";
import type * as crons from "../crons.js";
import type * as documents from "../documents.js";
import type * as files from "../files.js";
import type * as ghost from "../ghost.js";
import type * as healthcheck from "../healthcheck.js";
import type * as history from "../history.js";
import type * as model_cleanup from "../model/cleanup.js";
import type * as model_emailDocuments from "../model/emailDocuments.js";
import type * as model_textBlockSync from "../model/textBlockSync.js";
import type * as personas from "../personas.js";
import type * as presence from "../presence.js";
import type * as prosemirror from "../prosemirror.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentText: typeof agentText;
  brandKits: typeof brandKits;
  cleanup: typeof cleanup;
  crons: typeof crons;
  documents: typeof documents;
  files: typeof files;
  ghost: typeof ghost;
  healthcheck: typeof healthcheck;
  history: typeof history;
  "model/cleanup": typeof model_cleanup;
  "model/emailDocuments": typeof model_emailDocuments;
  "model/textBlockSync": typeof model_textBlockSync;
  personas: typeof personas;
  presence: typeof presence;
  prosemirror: typeof prosemirror;
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
};
