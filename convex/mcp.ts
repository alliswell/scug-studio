// MCP server for Switchyards Studio (Streamable HTTP, stateless, JSON responses). Same key and the same
// safe operations as the /agent routes. Lets a tool hold the key as a connected account, so agents call
// Studio tools without ever seeing the key.

import { ConvexError } from "convex/values";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { authorized } from "./agentAuth";
import { HELP } from "./agentHelp";
import { attachFiles, resolveAttachments } from "./agentFiles";

const PROTOCOL = "2025-06-18";

const RULES = `Switchyards Studio is the design studio's app for its neighborhood work clubs. A club is a location; a project is a piece of work on one (or on the network). A physical project is a build-out and runs concept → spacePlan → ffe → ordered → install → punch → open; a digital project is brand, signage artwork, web or a campaign and runs briefing → design → review → approved → shipped. Drawings and renders go through reviews: numbered rounds with marks pinned to a spot on a sheet. You can change anything except delete a project. Edit a project's document directly with edit_lines or replace_document: every edit saves the previous text as a version that can be restored. FF&E is the furniture, lighting and fittings: a product is specified once and placed in as many clubs as it goes in, and the club owns a placement while the project only specced it. It is a specification tool, not a procurement one — there is no cost, budget, lead time, order status or PO anywhere in it, so never report or invent one. Read a project (get_project) before changing it, and tell the user what you changed. Never say a mark, a stage or an FF&E category by its colour alone — each one has a label and a glyph; use those.`;

const projectArg = { type: "string", description: "The project's id or its share link" };
const clubArg = { type: "string", description: "The club's id or its name (an exact name first, then a single partial match)" };
const reviewArg = { type: "string", description: "Review id (from list_reviews), its link, or its exact title" };
const sheetArg = {
  type: "object",
  description: "One sheet: an image or a PDF. ONE of {url}, {storageId} (from get_upload_url), {base64, name}",
  properties: { url: { type: "string" }, storageId: { type: "string" }, base64: { type: "string" }, name: { type: "string" }, mime: { type: "string" } },
};
const typeArg = {
  type: "string",
  enum: ["physical", "digital"],
  description: "physical = a build-out (space plan, FF&E, install); digital = brand, signage artwork, web, a campaign",
};
const stageArg = {
  type: "string",
  enum: ["concept", "spacePlan", "ffe", "ordered", "install", "punch", "open", "briefing", "design", "review", "approved", "shipped"],
  description:
    "Must belong to the project's own pipeline. physical: concept, spacePlan, ffe (FF&E spec), ordered, install, punch, open. digital: briefing, design, review, approved, shipped.",
};
const targetDateArg = { type: ["string", "null"], description: "Open date for a build-out, ship date for digital work. YYYY-MM-DD, or null to clear." };
const reviewStatusArg = {
  type: "string",
  enum: ["inReview", "changesRequested", "approved", "archived"],
  description: "The review's own state, never the project's stage. archived = the set was dropped.",
};
const markKindArg = {
  type: "string",
  enum: ["fix", "question", "note", "approve"],
  description: "fix = must fix (✕), question = a question (?), note = a note (•), approve = looks right (✓). The app draws the glyph, not just a colour.",
};
const updateProps = {
  title: { type: "string", description: "What happened, in a few words, e.g. \"Landlord approved the storefront\"" },
  details: { type: "string", description: "The details: what was said or decided, dates, requirements" },
  link: { type: "string", description: "Where to find the conversation (email thread, Slack message, doc URL)" },
  source: { type: "string", description: "e.g. Email, Slack, Call, Site visit" },
  date: { type: "string", description: "When it happened, YYYY-MM-DD or ISO time; defaults to now" },
  urgent: { type: "boolean", description: "True if it needs a response right away (e.g. a GC waiting on an answer). Pinned to the top of the Log until someone marks it handled." },
};
const lineArg = {
  type: "object",
  properties: {
    key: { type: "string", description: "Existing line key (keep it when you keep or edit that line; omit for new lines)" },
    type: { type: "string", enum: ["p", "h1", "bullet", "number", "todo", "board"], description: "board = an Excalidraw board shown in the document; its text is the board id (from list_boards) or its /b/<id> link" },
    text: { type: "string", description: "The line's text. Link words with [words](https://…), bold with **words**." },
    textColor: { type: ["string", "null"], enum: ["gray", "red", "orange", "green", "blue", "purple", null], description: "Color of the text (null = default). Never the only thing carrying a meaning — write the word too." },
    color: { type: ["string", "null"], enum: ["yellow", "blue", "green", "red", "rose", null], description: "Background color of the block (red shows as purple, rose shows as red)" },
    indent: { type: "number", description: "Sub-bullet level for bullet/number/todo lines: 1-4 (0 = top level)" },
  },
  required: ["text"],
};

const colorArg = { type: "string", description: "yellow, orange, red, pink, purple, blue, teal, green, gray, or #hex. Leave out to match the board." };
/** One thing to draw on a board (see add_to_board) */
const boardItemArg = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["text", "shape", "sticky", "arrow", "image"] },
    id: { type: "string", description: "Your own name for this item so arrows can point at it (e.g. \"lobby\")" },
    text: { type: "string", description: "text and sticky: the words (\\n for new lines)" },
    label: { type: "string", description: "shape: the words inside it" },
    shape: { type: "string", enum: ["rectangle", "ellipse", "diamond"], description: "shape: defaults to the board's usual shape" },
    size: { type: "string", enum: ["s", "m", "l", "xl"], description: "text: xl = the board's heading size, l = subheading; defaults to the board's text size" },
    fontSize: { type: "number", description: "text: exact font size (overrides size)" },
    color: colorArg,
    from: { type: "string", description: "arrow: item id, element id, or the label of something on the board" },
    to: { type: "string", description: "arrow: item id, element id, or the label of something on the board" },
    dashed: { type: "boolean" },
    url: { type: "string", description: "image: https link to the picture" },
    link: { type: "string", description: "text or shape: makes it a clickable link" },
    width: { type: "number" },
    height: { type: "number" },
    x: { type: "number", description: "Optional: position relative to where the new group starts" },
    y: { type: "number" },
  },
  required: ["type"],
};
const drawOptionArgs = {
  layout: { type: "string", enum: ["auto", "flow", "row", "column", "grid"], description: "auto = flowchart when there are arrows, grid for stickies, else a row/column" },
  direction: { type: "string", enum: ["right", "down"], description: "Which way a flowchart runs; defaults to the board's direction" },
  placement: { type: "string", enum: ["right", "below"], description: "Where the group goes next to what's there; defaults to the board's direction" },
  styleFrom: { type: "string", description: "Draw in the style of another board (its id or link), e.g. for a new board that should look like an existing one" },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  run: (ctx: ActionCtx, a: any) => Promise<unknown>;
};

const attachmentsArg = {
  type: "array",
  description:
    "Files to attach. Each item is ONE of: {url} a link (image/video URLs show as media); {base64, name} the file's bytes inline, stored in the studio (under 20 MB); {storageId, name} a file you uploaded via get_upload_url (any size; use this for files on your computer). Optional mime.",
  items: {
    type: "object",
    properties: {
      url: { type: "string" },
      base64: { type: "string", description: "Raw base64 or a data: URL" },
      storageId: { type: "string", description: "From uploading to get_upload_url's uploadUrl" },
      name: { type: "string", description: "File name, e.g. floor-plan.pdf" },
      mime: { type: "string", description: "e.g. image/png (guessed from the name if left out)" },
    },
  },
};

const ffeProductArg = {
  type: "string",
  description: "The product's id, or its name: an exact name first (\"maker · name\" works too), then a single partial match",
};
const ffeCategoryArg = {
  type: "string",
  enum: ["seating", "tables", "lighting", "soft", "storage", "fixtures", "equipment", "art"],
  description:
    "What kind of thing it is. Each one has a glyph as well as a colour, and the app draws the glyph: seating ◖, tables ▭, lighting ◌, soft (soft goods) ◠, storage ▤, fixtures ◈, equipment ⊞, art ◇.",
};
const ffeProductFields = {
  maker: { type: "string", description: "Who makes it. Part of the name — \"AAC22\" on its own names nothing." },
  finish: { type: "string", description: "e.g. \"Grey felt, oak base\"" },
  category: ffeCategoryArg,
  dimensions: { type: "string", description: "Free text, e.g. \"W62 × D55 × H79 cm\"" },
  url: { type: ["string", "null"], description: "The product page, for when someone needs to look it up" },
  notes: { type: "string", description: "Anything worth keeping about the product itself" },
};

const clubFields = {
  name: { type: "string" },
  neighborhood: { type: "string", description: "e.g. the neighborhood or the building the club sits in" },
  city: { type: "string" },
  address: { type: "string" },
  status: { type: "string", enum: ["prospect", "signed", "design", "construction", "open", "closed"] },
  openedAt: { type: ["string", "null"], description: "The day it opened, or is due to, YYYY-MM-DD" },
  squareFeet: { type: ["number", "null"] },
  seats: { type: ["number", "null"] },
  notes: { type: "string", description: "Landlord, GC, lease dates — anything worth keeping on the club itself" },
};

const TOOLS: Tool[] = [
  {
    name: "read_guide",
    description: "The full Switchyards Studio guide for agents: clubs, projects, the two pipelines and their stages, reviews, the rules, every tool, and worked examples. Read it once before your first change.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => HELP,
  },
  {
    name: "list_projects",
    description: `List projects, newest activity first, with type, stage, club, target date and how many suggested edits wait for review. Filter by club or type. ${RULES}`,
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Optional title search" }, club: clubArg, type: typeArg } },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.agent.listProjects, { query: a.query, club: a.club, type: a.type }),
  },
  {
    name: "get_project",
    description: "Read one project: details, its club, lines (each with a stable key and type), tasks (the punch list, with keys and checked), the brief, its reviews, the log (newest first) and comments. Always read before changing a project.",
    inputSchema: { type: "object", properties: { project: projectArg }, required: ["project"] },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.agent.project, { project: a.project }),
  },
  {
    name: "edit_lines",
    description:
      "Edit a project's document directly, line by line, using line keys from get_project. Comments are kept: a replaced line keeps its comments, and comments on deleted lines are re-attached to the new line that reads most like the old one when possible. ops run in order as one change: {op:\"replace\", key, text?, type?} changes a line; {op:\"insert\", afterKey (null = top), lines:[{text, type?}]} adds lines; {op:\"delete\", key} removes a line; {op:\"move\", key, afterKey} moves one. The previous text is saved as a version first, so it can be restored. Returns the new lines with their keys.",
    inputSchema: {
      type: "object",
      properties: {
        project: projectArg,
        agentName: { type: "string" },
        ops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["replace", "insert", "delete", "move"] },
              key: { type: "string" },
              afterKey: { type: ["string", "null"] },
              text: { type: "string" },
              type: { type: "string", enum: ["p", "h1", "bullet", "number", "todo", "board"], description: "board = an Excalidraw board shown in the document; its text is the board id (from list_boards) or its /b/<id> link" },
              textColor: { type: ["string", "null"], enum: ["gray", "red", "orange", "green", "blue", "purple", null] },
              color: { type: ["string", "null"], enum: ["yellow", "blue", "green", "red", "rose", null] },
              indent: { type: "number", description: "Sub-bullet level 0-4 (replace)" },
              lines: { type: "array", items: lineArg },
            },
            required: ["op"],
          },
        },
      },
      required: ["project", "ops"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.editLines, a),
  },
  {
    name: "replace_document",
    description:
      "Rewrite a project's whole document directly. `lines` is the document in order: keep a line's key to keep that line (and its comments), omit key for new lines, leave lines out to delete them. The previous text is saved as a version first. Use for big rewrites; for small changes use edit_lines.",
    inputSchema: {
      type: "object",
      properties: { project: projectArg, agentName: { type: "string" }, lines: { type: "array", items: lineArg } },
      required: ["project", "lines"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.replaceDocument, a),
  },
  {
    name: "list_versions",
    description: "Earlier versions of a project's document (newest first), with when and by whom each was replaced.",
    inputSchema: { type: "object", properties: { project: projectArg }, required: ["project"] },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.agent.listVersions, a),
  },
  {
    name: "restore_version",
    description: "Bring back an earlier version of a project's document (from list_versions). The current text is saved as a version first.",
    inputSchema: { type: "object", properties: { project: projectArg, versionId: { type: "string" }, agentName: { type: "string" } }, required: ["project", "versionId"] },
    run: (ctx, a) => ctx.runMutation(internal.agent.restoreVersion, a),
  },
  {
    name: "delete_project_task",
    description: "Remove one task from a project's punch list by its key (from get_project).",
    inputSchema: { type: "object", properties: { project: projectArg, key: { type: "string" } }, required: ["project", "key"] },
    run: (ctx, a) => ctx.runMutation(internal.agent.deleteTask, a),
  },
  {
    name: "remove_brief_links",
    description: "Remove links from the Brief tab by URL.",
    inputSchema: { type: "object", properties: { project: projectArg, urls: { type: "array", items: { type: "string" } } }, required: ["project", "urls"] },
    run: (ctx, a) => ctx.runMutation(internal.agent.removeBriefLinks, a),
  },
  {
    name: "suggest_project_edit",
    description:
      "Propose new text for a person to review instead of editing directly (only when the user wants to approve changes first; normally use edit_lines / replace_document). `lines` is the WHOLE document as you want it, in order. Keep a line's key when you keep or edit it; omit key for new lines; existing lines you leave out show as removed. It is saved as an \"Edited version\" (changes in red) and nothing changes until a person clicks \"Use this version\". Sending again with the same agentName replaces your pending suggestion. Afterwards tell the user to review the Edited version button at the top right of the project.",
    inputSchema: {
      type: "object",
      properties: { project: projectArg, agentName: { type: "string", description: "Your name, e.g. Claude" }, lines: { type: "array", items: lineArg } },
      required: ["project", "lines"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.suggestEdit, a),
  },
  {
    name: "comment_on_project",
    description: "Comment on a whole project, or on one line (by blockKey from get_project, or by part of the line's text with lineContains). Can attach images, renders, PDFs or any file: by link, inline base64, or an uploaded file (see get_upload_url). Shows with an Agent badge. Comments are internal to the studio unless you pass shared: true, which puts it where anyone holding the project's share link can read it. Returns the comment id.",
    inputSchema: {
      type: "object",
      properties: {
        project: projectArg,
        text: { type: "string" },
        agentName: { type: "string" },
        blockKey: { type: "string" },
        lineContains: { type: "string" },
        shared: { type: "boolean", description: "Put it in the thread anyone with the share link can read. Default false: the studio's own thread." },
        attachments: attachmentsArg,
      },
      required: ["project", "text"],
    },
    run: async (ctx, a) => ({
      id: await ctx.runMutation(internal.comments.addAgent, { ...a, attachments: await resolveAttachments(ctx, a.attachments) }),
    }),
  },
  {
    name: "attach_files",
    description:
      "Add images, renders, PDFs or any files to an existing comment (comment id from comment_on_project or get_project). Same attachment shapes as comment_on_project. Only adds; never removes.",
    inputSchema: { type: "object", properties: { comment: { type: "string" }, attachments: attachmentsArg }, required: ["comment", "attachments"] },
    run: (ctx, a) => attachFiles(ctx, a.comment, a.attachments ?? []),
  },
  {
    name: "get_upload_url",
    description:
      "For a file on your own computer (any size): returns a one-time uploadUrl. POST the raw bytes there, e.g. curl -s -X POST -H 'Content-Type: application/pdf' --data-binary @plan.pdf '<uploadUrl>', which answers {\"storageId\":\"...\"}. Then use it as {storageId, name} in comment_on_project, attach_files, start_review or add_review_round.",
    inputSchema: { type: "object", properties: {} },
    run: async (ctx) => ({ uploadUrl: await ctx.runMutation(internal.agentFiles.uploadUrl, {}) }),
  },
  {
    name: "move_comment",
    description:
      "Move any comment to another line (toKey from get_project, or lineContains = part of the line's text), or onto the whole project (give neither). Use after an edit to put comments back on the right line; get_project marks comments that are onRemovedLine.",
    inputSchema: {
      type: "object",
      properties: { project: projectArg, commentId: { type: "string" }, toKey: { type: "string" }, lineContains: { type: "string" } },
      required: ["project", "commentId"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.moveComment, a),
  },
  {
    name: "update_comment",
    description: "Rewrite the text of a comment an agent wrote (people's comments can be moved, not rewritten).",
    inputSchema: { type: "object", properties: { project: projectArg, commentId: { type: "string" }, text: { type: "string" } }, required: ["project", "commentId", "text"] },
    run: (ctx, a) => ctx.runMutation(internal.agent.updateComment, a),
  },
  {
    name: "delete_comment",
    description: "Delete a comment an agent wrote.",
    inputSchema: { type: "object", properties: { project: projectArg, commentId: { type: "string" } }, required: ["project", "commentId"] },
    run: (ctx, a) => ctx.runMutation(internal.agent.deleteComment, a),
  },
  {
    name: "add_project_tasks",
    description: "Add tasks to a project's punch list (the Tasks tab): snags to fix, drawings to issue, things to order.",
    inputSchema: { type: "object", properties: { project: projectArg, items: { type: "array", items: { type: "string" } } }, required: ["project", "items"] },
    run: (ctx, a) => ctx.runMutation(internal.agent.addTasks, a),
  },
  {
    name: "update_project_task",
    description: "Edit one task on a project's punch list: change its text and/or tick it off (checked true) or untick it. Use the task's key from get_project.",
    inputSchema: {
      type: "object",
      properties: { project: projectArg, key: { type: "string", description: "The task's key from get_project" }, text: { type: "string" }, checked: { type: "boolean" } },
      required: ["project", "key"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.updateTask, a),
  },
  {
    name: "set_brief",
    description:
      "Write the Brief tab: scope, constraints, what done looks like. mode \"append\" (default) adds your text to the end; \"replace\" swaps the whole brief, so only replace when the user asked. Applies immediately.",
    inputSchema: {
      type: "object",
      properties: { project: projectArg, text: { type: "string" }, mode: { type: "string", enum: ["append", "replace"] } },
      required: ["project", "text"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.setBrief, a),
  },
  {
    name: "add_references",
    description:
      "Save references to the studio's reference board: product and furniture links, images, posts, any link, or a plain note. Each one is a link and/or a note (what it is and why it's worth keeping). Send up to 200 at once, e.g. when importing bookmarks; links already saved aren't duplicated. date (YYYY-MM-DD) is when it was saved, if known.",
    inputSchema: {
      type: "object",
      properties: {
        references: {
          type: "array",
          items: {
            type: "object",
            properties: { url: { type: "string" }, note: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD, optional" } },
          },
        },
        agentName: { type: "string" },
      },
      required: ["references"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.addReferences, a),
  },
  {
    name: "list_references",
    description: "Search or list the reference board (newest first). Use to check what's already saved or find a reference.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.agent.listReferences, a),
  },
  {
    name: "list_clubs",
    description: "Every club: name, neighborhood, city, address, status (prospect / signed / design / construction / open / closed), open date, square feet, seats, notes, and how many projects each has (projectCount, activeCount = not yet finished).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: (ctx) => ctx.runQuery(internal.clubs.listForAgent, {}),
  },
  {
    name: "get_club",
    description: "One club: its details, every project on it (with type, stage and target date) and every review filed against it.",
    inputSchema: { type: "object", properties: { club: clubArg }, required: ["club"] },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.clubs.getForAgent, a),
  },
  {
    name: "create_club",
    description: "Add a club (a location). Only name is required; status defaults to prospect. Only when asked.",
    inputSchema: { type: "object", properties: { ...clubFields }, required: ["name"] },
    run: (ctx, a) => ctx.runMutation(internal.clubs.createForAgent, a),
  },
  {
    name: "update_club",
    description: "Change a club's details. Only the fields you send change. A club can't be deleted while it still has projects.",
    inputSchema: { type: "object", properties: { club: clubArg, ...clubFields }, required: ["club"] },
    run: (ctx, a) => ctx.runMutation(internal.clubs.updateForAgent, a),
  },
  {
    name: "list_reviews",
    description:
      "Reviews: sets of visuals (renders, floor plans, elevations, finish boards, mockups) being carried through numbered rounds, newest activity first. Each shows its status, the latest round, whether changes were requested, and how many marks are still open on the latest round. Filter by project, club, status, or changesRequested true to see only what is waiting on a new round. Archived sets are left out unless status is archived: read those to learn what was dropped and why.",
    inputSchema: {
      type: "object",
      properties: { status: reviewStatusArg, changesRequested: { type: "boolean" }, project: projectArg, club: clubArg },
    },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.reviews.listForAgent, a),
  },
  {
    name: "get_review",
    description:
      "One review: every round (v1, v2, … each with its sheets' download URLs and a note of what changed) and every mark. Each mark says where it is in words (\"v2 sheet 1, 32% across and 61% down\"), its kind (fix / question / note / approve) and its text. toDo lists the marks still open on the latest round, in reading order down each sheet: that's what the next round has to answer.",
    inputSchema: { type: "object", properties: { review: reviewArg }, required: ["review"] },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.reviews.getForAgent, a),
  },
  {
    name: "start_review",
    description:
      "Start a review with its first round (v1). files is one or more sheets, in order — a plan set is several, a render is one. Only images and PDFs are accepted. Link it to a project and/or a club so it shows on their pages.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        files: { type: "array", items: sheetArg },
        note: { type: "string", description: "What this set is" },
        project: projectArg,
        club: clubArg,
        agentName: { type: "string" },
      },
      required: ["title", "files"],
    },
    run: (ctx, a) => ctx.runAction(internal.reviews.createForAgent, a),
  },
  {
    name: "add_review_round",
    description:
      "Post the next round of a review (v2, v3, … no limit) once the marks have been answered. It clears any request for changes, resolves the previous round's open marks (set resolveMarks false to keep them open) and puts the review back in review. Write in note what changed. This never touches the project's stage.",
    inputSchema: {
      type: "object",
      properties: { review: reviewArg, files: { type: "array", items: sheetArg }, note: { type: "string", description: "What changed in this round" }, agentName: { type: "string" }, resolveMarks: { type: "boolean" } },
      required: ["review", "files"],
    },
    run: (ctx, a) => ctx.runAction(internal.reviews.addRoundForAgent, a),
  },
  {
    name: "mark_review",
    description:
      "Pin a mark to a sheet in a review round. fileIndex is which sheet (0 = the first), page is the page within a PDF sheet (1 for an image). x and y are fractions of the sheet, 0-1 from its top left — x 0.5, y 0.25 is halfway across and a quarter down — so the mark survives any zoom. rects marks an area instead. Say the kind: fix, question, note or approve. Only when asked.",
    inputSchema: {
      type: "object",
      properties: {
        review: reviewArg,
        text: { type: "string" },
        roundNumber: { type: "number", description: "Defaults to the latest round" },
        fileIndex: { type: "number", description: "Which sheet in that round, 0-based. Defaults to 0." },
        page: { type: "number", description: "1-based page within a PDF sheet; 1 for an image" },
        x: { type: "number", description: "Across the sheet, 0-1" },
        y: { type: "number", description: "Down the sheet, 0-1" },
        rects: {
          type: "array",
          description: "An area instead of a point; each box is {x, y, w, h} as fractions of the sheet",
          items: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } }, required: ["x", "y", "w", "h"] },
        },
        quote: { type: "string", description: "Text selected on a PDF sheet, when the mark is about words" },
        markKind: markKindArg,
        attachments: attachmentsArg,
        agentName: { type: "string" },
      },
      required: ["review", "text"],
    },
    run: (ctx, a) => ctx.runAction(internal.reviews.markForAgent, a),
  },
  {
    name: "resolve_mark",
    description: "Tick a mark off once it's been dealt with, or re-open it (resolved false). Mark ids come from get_review. A new round resolves the round before it on its own, so use this for one-off marks.",
    inputSchema: { type: "object", properties: { mark: { type: "string", description: "Mark id from get_review" }, resolved: { type: "boolean", description: "Default true" } }, required: ["mark"] },
    run: (ctx, a) => ctx.runMutation(internal.agent.resolveMark, a),
  },
  {
    name: "set_review_status",
    description: "Move a review to inReview, changesRequested (note = what is being asked for), approved or archived. Only when asked. This is the review's own status; it never changes the project's stage.",
    inputSchema: { type: "object", properties: { review: reviewArg, status: reviewStatusArg, note: { type: "string" }, agentName: { type: "string" } }, required: ["review", "status"] },
    run: (ctx, a) => ctx.runMutation(internal.reviews.setStatusForAgent, a),
  },
  {
    name: "approve_review",
    description: "Sign a review off: status approved, stamped with who and when. Only when the user asked for it to be approved.",
    inputSchema: { type: "object", properties: { review: reviewArg, agentName: { type: "string" } }, required: ["review"] },
    run: (ctx, a) => ctx.runMutation(internal.reviews.setStatusForAgent, { ...a, status: "approved" as const }),
  },
  {
    name: "list_ffe_products",
    description:
      "The FF&E catalog: every product the studio has specified, with its maker, finish, category, dimensions, link and picture, plus how many clubs it is in (clubCount), how many of it there are in all (totalQuantity) and how many placements that is. A product is written down once and placed in as many clubs as it goes in. search looks at the name, maker, finish and notes. This is a specification tool: there is no cost, lead time, order status or PO here, and none can be added.",
    inputSchema: { type: "object", properties: { search: { type: "string" }, category: ffeCategoryArg } },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.ffe.listProductsForAgent, { search: a.search, category: a.category }),
  },
  {
    name: "get_ffe_product",
    description:
      "One product and every placement of it: the club, the area within it, how many, and the project that specced them (null for anything added after opening). Read this before changing a product that is already placed.",
    inputSchema: { type: "object", properties: { product: ffeProductArg }, required: ["product"] },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.ffe.getProductForAgent, a),
  },
  {
    name: "add_ffe_product",
    description:
      "Add a product to the FF&E catalog — what it is, not where it goes. Name it as the maker names it (\"About A Chair AAC22\") and give the maker. Place it with place_ffe afterwards. Check list_ffe_products first: the point of the catalog is that the same chair is one row, not twelve.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, ...ffeProductFields }, required: ["name"] },
    run: (ctx, a) => ctx.runMutation(internal.ffe.createProductForAgent, a),
  },
  {
    name: "update_ffe_product",
    description:
      "Change a product in the catalog. Only the fields you send change, and the change reaches every club it is placed in. A product that is placed anywhere can't be deleted.",
    inputSchema: { type: "object", properties: { product: ffeProductArg, name: { type: "string" }, ...ffeProductFields }, required: ["product"] },
    run: (ctx, a) => ctx.runMutation(internal.ffe.updateProductForAgent, a),
  },
  {
    name: "place_ffe",
    description:
      "Put a product in a club: area is free text for where in it (\"Lounge\", \"Phone rooms\", \"Cafe\") and quantity is a whole number, 1 or more. project is the build-out that specced it — leave it out for anything added after opening. The club owns the placement either way, and a network-wide project can spec for any club.",
    inputSchema: {
      type: "object",
      properties: {
        product: ffeProductArg,
        club: clubArg,
        area: { type: "string", description: "Where in the club, e.g. Lounge. list_ffe shows the names already in use — reuse one." },
        quantity: { type: "number", description: "A whole number, 1 or more" },
        project: { ...projectArg, description: "The build-out that specced it; leave out for anything added after opening" },
        notes: { type: "string" },
      },
      required: ["product", "club", "area", "quantity"],
    },
    run: (ctx, a) => ctx.runMutation(internal.ffe.placeForAgent, a),
  },
  {
    name: "list_ffe",
    description:
      "The FF&E in a club, or what one build-out specs: each placement with its product, finish, category, area, quantity and the project that specced it. Give neither and you get every placement across the network. Placement ids come from here.",
    inputSchema: { type: "object", properties: { club: clubArg, project: projectArg } },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.ffe.listPlacementsForAgent, a),
  },
  {
    name: "remove_ffe_placement",
    description:
      "Take one placement off a club's schedule (its id from list_ffe or get_ffe_product). The product stays in the catalog and every other club keeps it. Only when asked.",
    inputSchema: { type: "object", properties: { placement: { type: "string", description: "Placement id from list_ffe" } }, required: ["placement"] },
    run: (ctx, a) => ctx.runMutation(internal.ffe.removePlacementForAgent, a),
  },
  {
    name: "list_pdfs",
    description: "The PDFs app: drawing sets, permit sets, vendor cutsheets and papers saved to read and mark up. Lists them (newest first) with id, title, pages, authors, a line on what each is, and its link. query searches titles, authors and descriptions.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.pdfs.listForAgent, a),
  },
  {
    name: "get_pdf",
    description: "One PDF: its details, a download link to the file (fileUrl, to read its text), and every highlight and note on it, page by page (quotes, comments, voice notes with their transcript).",
    inputSchema: { type: "object", properties: { pdf: { type: "string", description: "PDF id or its /pdf/<id> link" } }, required: ["pdf"] },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.pdfs.getForAgent, a),
  },
  {
    name: "add_pdf",
    description:
      "Save a PDF to the PDFs app. Give ONE of: url (a direct link to the .pdf, which the studio downloads), storageId (a file you uploaded via get_upload_url), or base64 (small files). Also set title (the real document title), authors (the firm or vendor) and about (one or two plain sentences on what it is and why it matters). Returns its id and link.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        storageId: { type: "string" },
        base64: { type: "string" },
        title: { type: "string" },
        authors: { type: "string" },
        about: { type: "string" },
        agentName: { type: "string" },
      },
    },
    run: (ctx, a) => ctx.runAction(internal.pdfs.addForAgent, a),
  },
  {
    name: "update_pdf",
    description: "Change a PDF's title, authors or about (its one-line description).",
    inputSchema: { type: "object", properties: { pdf: { type: "string" }, title: { type: "string" }, authors: { type: "string" }, about: { type: "string" } }, required: ["pdf"] },
    run: (ctx, a) => ctx.runMutation(internal.pdfs.updateForAgent, a),
  },
  {
    name: "add_pdf_note",
    description: "Leave a note on a page of a PDF (shows in its notes panel with an AI badge). quote = the words it's about, if any. Only when asked.",
    inputSchema: { type: "object", properties: { pdf: { type: "string" }, page: { type: "number" }, text: { type: "string" }, quote: { type: "string" }, agentName: { type: "string" } }, required: ["pdf", "page", "text"] },
    run: (ctx, a) => ctx.runMutation(internal.pdfs.noteForAgent, a),
  },
  {
    name: "list_scratchboards",
    description: "Scratchboards: hand-drawn sketches in the studio's own pencil-on-paper style (hand-inked lines, colored-pencil fills, Archivo headings, handwritten notes). Separate from Excalidraw boards.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.scratchboards.listForAgent, a),
  },
  {
    name: "get_scratchboard",
    description: "Read a scratchboard: a summary plus every item (see read_guide, Scratchboard, for the item shapes).",
    inputSchema: { type: "object", properties: { board: { type: "string", description: "Scratchboard id or its /sb/<id> link" } }, required: ["board"] },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.scratchboards.getForAgent, a),
  },
  {
    name: "create_scratchboard",
    description: "Make a scratchboard, optionally drawing items on it (same items as add_to_scratchboard). Returns its id and link.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, items: { type: "array", items: { type: "object" } }, agentName: { type: "string" } }, required: ["title"] },
    run: (ctx, a) => ctx.runMutation(internal.scratchboards.createForAgent, a),
  },
  {
    name: "add_to_scratchboard",
    description:
      "Draw on a scratchboard: items are added on top, in order (which is also the order Play draws them). Item shapes: pen {pts}, line {a,b,dashed?}, arrow {a,b,bend?}, rect {x,y,width,h,r?,fill?}, diamond {x,y,width,h,fill?}, ellipse {cx,cy,rx,ry,fill?}, poly {pts,closed?,sketch?,fill?}, text {style: note|head|label|big, text, x, y (baseline), size?, align?}, badge {cx,cy,r?,text,fill?}, tick {x,y,s?}, image {x,y,width,h,url} (a picture from an https url; keep its aspect ratio). To write inside a rect/diamond/ellipse, give it an id and add a text with bind: that id (it stays centered in the shape). All take color (hex) and w (line weight, default 2.6). fill = {color, tint?}.",
    inputSchema: { type: "object", properties: { board: { type: "string" }, items: { type: "array", items: { type: "object" } } }, required: ["board", "items"] },
    run: (ctx, a) => ctx.runMutation(internal.scratchboards.addForAgent, a),
  },
  {
    name: "edit_scratchboard",
    description:
      "Change items already on a scratchboard by id (ids from get_scratchboard, or returned by add_to_scratchboard). Ops, applied in order: update {id, set:{field: value}} changes any fields (text, x, y, width, h, color, fill, style, size, url…; null removes one), move {id, dx, dy}, scale {id, scale} (resize, e.g. 1.5 or 0.5), delete {id}, front/back {id} (draw order). Each op takes id or ids:[...]. Text written inside a shape moves and deletes with it. Only touch what you drew or were asked to change. Can also rename with title.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string" },
        title: { type: "string" },
        ops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["update", "move", "scale", "delete", "front", "back"] },
              id: { type: "string" },
              ids: { type: "array", items: { type: "string" } },
              set: { type: "object" },
              dx: { type: "number" },
              dy: { type: "number" },
              scale: { type: "number" },
            },
            required: ["op"],
          },
        },
      },
      required: ["board"],
    },
    run: (ctx, a) => ctx.runMutation(internal.scratchboards.editForAgent, a),
  },
  {
    name: "list_boards",
    description: "List the studio's Excalidraw boards — space plans, bubble diagrams, adjacency studies, furniture layouts (newest first), optionally searching their titles and contents. Returns ids and links.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.boards.listForAgent, a),
  },
  {
    name: "pin_board",
    description: "Pin a board to the sidebar (pinned: false unpins). Only when the user asked.",
    inputSchema: { type: "object", properties: { board: { type: "string", description: "Board id or its /b/<id> link" }, pinned: { type: "boolean", description: "Default true" } }, required: ["board"] },
    run: (ctx, a) => ctx.runMutation(internal.boards.setPinnedForAgent, a),
  },
  {
    name: "pin_project",
    description: "Pin a project to the sidebar and the top of the project views (pinned: false unpins). Only when the user asked.",
    inputSchema: { type: "object", properties: { project: projectArg, pinned: { type: "boolean", description: "Default true" } }, required: ["project"] },
    run: (ctx, a) => ctx.runMutation(internal.agent.setProjectPinned, a),
  },
  {
    name: "get_board",
    description:
      "Read one Excalidraw board: a plain-text summary (all text top to bottom, labelled shapes, arrows between shapes, links), its style (colors, stroke, roughness, corners, font, sizes, spacing, direction: new items copy it), and items (everything on it with ids, labels, positions) to point arrows and edits at. Set includeElements for the raw Excalidraw elements. Read a board before drawing on it.",
    inputSchema: { type: "object", properties: { board: { type: "string", description: "Board id or its /b/<id> link" }, includeElements: { type: "boolean" } }, required: ["board"] },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.boards.getForAgent, a),
  },
  {
    name: "create_board",
    description:
      "Make a new Excalidraw board, optionally drawing items on it straight away (same items as add_to_board). Returns its id and link.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, items: { type: "array", items: boardItemArg }, ...drawOptionArgs, agentName: { type: "string" } },
      required: ["title"],
    },
    run: (ctx, a) => ctx.runMutation(internal.boards.createForAgent, a),
  },
  {
    name: "add_to_board",
    description:
      "Draw on an existing board without touching what's there. Describe simple items (text, shape with a label, sticky, arrow, image) and they become real Excalidraw elements, laid out together (a flowchart when there are arrows) and placed beside the existing content in the board's own style (its colors, stroke, roughness, corners, font, sizes, spacing and direction) unless you set a color. Arrows connect new items (by your item id) or things already on the board (by element id from get_board, or by their label). Returns the new elements' ids.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board id or its /b/<id> link" },
        items: { type: "array", items: boardItemArg },
        ...drawOptionArgs,
        agentName: { type: "string" },
      },
      required: ["board", "items"],
    },
    run: (ctx, a) => ctx.runMutation(internal.boards.addForAgent, a),
  },
  {
    name: "edit_board",
    description:
      "Change things already on a board by element id (ids from get_board items): setText (a text or a shape's label), setColor, move by dx/dy, or delete (a shape's label and arrows go with it). Can also rename the board with title.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string" },
        title: { type: "string" },
        ops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["setText", "setColor", "move", "delete"] },
              id: { type: "string" },
              text: { type: "string" },
              color: { type: "string" },
              dx: { type: "number" },
              dy: { type: "number" },
            },
            required: ["op", "id"],
          },
        },
      },
      required: ["board"],
    },
    run: (ctx, a) => ctx.runMutation(internal.boards.editForAgent, a),
  },
  {
    name: "add_brief_links",
    description:
      "Attach links to a project's Brief tab: the lease, the drawing set, the permit set, a vendor quote, a Figma file, an email or Slack thread. Give each a short label. A URL that's already there just gets the new label. Internal only.",
    inputSchema: {
      type: "object",
      properties: {
        project: projectArg,
        links: { type: "array", items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["label", "url"] } },
      },
      required: ["project", "links"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.addBriefLinks, a),
  },
  {
    name: "add_project_update",
    description:
      "Log something that happened on a project to its Log tab (newest first): a site visit, a vendor call, an approval, an inspection, a date moving, a brief changing. Give a short title, the details, a link to the conversation and its source. Internal only: never shown on share links. Log entries can't be removed by agents.",
    inputSchema: { type: "object", properties: { project: projectArg, agentName: { type: "string" }, ...updateProps }, required: ["project", "title"] },
    run: (ctx, a) => ctx.runMutation(internal.agent.addUpdate, a),
  },
  {
    name: "update_project",
    description: "Change a project's title, target date, type, stage or club. A stage has to belong to the type's own pipeline; changing type moves the project to the new pipeline's first stage unless this same call says where it lands. Applies immediately, so only do it when the user asked.",
    inputSchema: {
      type: "object",
      properties: { project: projectArg, title: { type: "string" }, targetDate: targetDateArg, type: typeArg, stage: stageArg, club: { ...clubArg, description: `${clubArg.description}, or null for network-wide work` } },
      required: ["project"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.updateProject, a),
  },
  {
    name: "get_todo",
    description:
      "Read the team's shared Todo list (a checklist with sub-items, at the top of the studio for everyone): its id, every item with its key, text, checked (done), indent (0 = top level, 1-4 = sub-item levels) and assignee (user id), its comments, and the team (everyone who has joined, to assign to). Tick, assign or reword items with update_todo_item; reorder or delete with edit_lines (project = the id); comment with comment_on_project.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async (ctx) => ({
      ...(await ctx.runQuery(internal.agent.project, { project: await ctx.runMutation(internal.agent.todoId, {}) })),
      team: await ctx.runQuery(internal.agent.team, {}),
    }),
  },
  {
    name: "add_todo",
    description:
      "Add to-dos to the team's Todo list: at the end, or as sub-items under one (under = its key from get_todo). indent nests an item further (1 = a sub-item of the item before it); assignee = a teammate's name or email. Only when asked.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: { text: { type: "string" }, indent: { type: "number" }, assignee: { type: "string", description: "Name or email of someone on the team" }, checked: { type: "boolean" } }, required: ["text"] } },
        under: { type: "string", description: "Line key to add the items beneath, as sub-bullets" },
        agentName: { type: "string" },
      },
      required: ["items"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.addTodoItems, a),
  },
  {
    name: "update_todo_item",
    description: "Mark a Todo item done or not done (checked), assign it to a teammate (assignee = name or email; null unassigns), or reword it (text). key from get_todo. Only when asked.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, checked: { type: "boolean" }, assignee: { type: ["string", "null"] }, text: { type: "string" } },
      required: ["key"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.updateTodoItem, a),
  },
  {
    name: "list_notes",
    description: "Studio notes: internal docs and personal entries (newest first). They're documents like projects but kept out of the project views: read one with get_project and edit it with edit_lines / replace_document using its id.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Optional title search" } } },
    annotations: { readOnlyHint: true },
    run: (ctx, a) => ctx.runQuery(internal.agent.listNotes, a),
  },
  {
    name: "create_note",
    description: "Add a studio note (an internal doc, not a project). Only when asked.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, lines: { type: "array", items: lineArg }, agentName: { type: "string" } }, required: ["title"] },
    run: (ctx, a) => ctx.runMutation(internal.agent.createProject, { title: a.title, lines: a.lines, agentName: a.agentName, journal: true }),
  },
  {
    name: "create_project",
    description: "Create a project. type decides the pipeline, so pass it; stage defaults to the pipeline's first. club is the location it belongs to — leave it out for network-wide work. Don't create projects in bulk unless asked.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        type: typeArg,
        stage: stageArg,
        club: clubArg,
        targetDate: targetDateArg,
        lines: { type: "array", items: lineArg },
        tasks: { type: "array", items: { type: "string" }, description: "Starting punch-list tasks" },
        brief: { type: "string", description: "Scope, constraints, what done looks like" },
        updates: { type: "array", description: "Starting entries for the Log tab", items: { type: "object", properties: updateProps, required: ["title"] } },
        agentName: { type: "string" },
      },
      required: ["title"],
    },
    run: (ctx, a) => ctx.runMutation(internal.agent.createProject, a),
  },
];

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

const reply = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { "content-type": "application/json" },
  });

export async function handle(ctx: ActionCtx, msg: RpcMessage) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notification: nothing to answer
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "switchyards-studio", title: "Switchyards Studio", version: "3.0.0" },
        instructions: RULES,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ run: _run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await tool.run(ctx, params?.arguments ?? {});
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return ok({ content: [{ type: "text", text }], structuredContent: { result } });
      } catch (e) {
        const text = e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.message : "Failed";
        return ok({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const mcpPost = httpAction(async (ctx, req) => {
  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized. Send Authorization: Bearer <AGENT_API_KEY>." }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
    });
  }
  const body = await req.json().catch(() => undefined);
  if (body === undefined) return reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(ctx, m)))).filter((r) => r !== null);
    return out.length ? reply(out) : reply(null, 202);
  }
  const out = await handle(ctx, body);
  return out ? reply(out) : reply(null, 202);
});

/** No server-to-client stream; this server only answers POSTs. */
export const mcpGet = httpAction(async () => new Response(null, { status: 405, headers: { allow: "POST" } }));
