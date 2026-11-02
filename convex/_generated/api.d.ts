/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as agentAuth from "../agentAuth.js";
import type * as agentFiles from "../agentFiles.js";
import type * as agentHelp from "../agentHelp.js";
import type * as auth from "../auth.js";
import type * as boardDraw from "../boardDraw.js";
import type * as boards from "../boards.js";
import type * as clubs from "../clubs.js";
import type * as commentAnchors from "../commentAnchors.js";
import type * as comments from "../comments.js";
import type * as crons from "../crons.js";
import type * as docs from "../docs.js";
import type * as http from "../http.js";
import type * as ideas from "../ideas.js";
import type * as lib from "../lib.js";
import type * as library from "../library.js";
import type * as links from "../links.js";
import type * as mcp from "../mcp.js";
import type * as pdfs from "../pdfs.js";
import type * as prefs from "../prefs.js";
import type * as projects from "../projects.js";
import type * as reviews from "../reviews.js";
import type * as scratchboards from "../scratchboards.js";
import type * as share from "../share.js";
import type * as socialLinks from "../socialLinks.js";
import type * as todo from "../todo.js";
import type * as transcribe from "../transcribe.js";
import type * as updates from "../updates.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  agentAuth: typeof agentAuth;
  agentFiles: typeof agentFiles;
  agentHelp: typeof agentHelp;
  auth: typeof auth;
  boardDraw: typeof boardDraw;
  boards: typeof boards;
  clubs: typeof clubs;
  commentAnchors: typeof commentAnchors;
  comments: typeof comments;
  crons: typeof crons;
  docs: typeof docs;
  http: typeof http;
  ideas: typeof ideas;
  lib: typeof lib;
  library: typeof library;
  links: typeof links;
  mcp: typeof mcp;
  pdfs: typeof pdfs;
  prefs: typeof prefs;
  projects: typeof projects;
  reviews: typeof reviews;
  scratchboards: typeof scratchboards;
  share: typeof share;
  socialLinks: typeof socialLinks;
  todo: typeof todo;
  transcribe: typeof transcribe;
  updates: typeof updates;
  users: typeof users;
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

export declare const components: {};
