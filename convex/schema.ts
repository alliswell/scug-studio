import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

/**
 * A project is either a PHYSICAL build-out (a club: concept, space plan, furniture, install)
 * or DIGITAL work (brand, signage artwork, a site, a campaign). The two run different pipelines,
 * so the type decides which stages are legal. Convex validators can't express "stage must belong
 * to type", so `stage` is the union of both pipelines and the mutations enforce the pairing —
 * see `assertStage` in convex/projects.ts.
 */
export const projectType = v.union(v.literal("physical"), v.literal("digital"));

/** Physical build-out, in pipeline order. Concept → Space plan → FF&E → Ordered → Install → Punch → Open. */
export const physicalStage = v.union(
  v.literal("concept"),
  v.literal("spacePlan"),
  v.literal("ffe"),
  v.literal("ordered"),
  v.literal("install"),
  v.literal("punch"),
  v.literal("open"),
);

/** Digital work, in pipeline order. Brief → Design → Review → Approved → Shipped.
 *  Stored as "briefing" so it never reads as the `brief` text field on the row. */
export const digitalStage = v.union(
  v.literal("briefing"),
  v.literal("design"),
  v.literal("review"),
  v.literal("approved"),
  v.literal("shipped"),
);

/** Every legal stage. Which ones a given project may use depends on its `type`. */
export const projectStage = v.union(physicalStage, digitalStage);

/** Where a club is in its life. Drives the Clubs list and the club page header. */
export const clubStatus = v.union(
  v.literal("prospect"),
  v.literal("signed"),
  v.literal("design"),
  v.literal("construction"),
  v.literal("open"),
  v.literal("closed"),
);

export const blockType = v.union(
  v.literal("p"),
  v.literal("h1"),
  v.literal("bullet"),
  v.literal("number"),
  v.literal("todo"),
  v.literal("images"),
  /** An Excalidraw board shown in the document; its content is the board's id */
  v.literal("board"),
);
export const blockColor = v.union(v.literal("yellow"), v.literal("blue"), v.literal("green"), v.literal("red"), v.literal("rose"), v.null());
/** Color of a line's text (separate from the block's background color) */
export const textColor = v.union(
  v.literal("gray"),
  v.literal("red"),
  v.literal("orange"),
  v.literal("green"),
  v.literal("blue"),
  v.literal("purple"),
  v.null(),
);
export const attachment = v.object({
  id: v.string(),
  kind: v.union(v.literal("image"), v.literal("video"), v.literal("audio"), v.literal("file"), v.literal("link")),
  url: v.union(v.string(), v.null()),
  storageId: v.union(v.id("_storage"), v.null()),
  name: v.union(v.string(), v.null()),
  mime: v.union(v.string(), v.null()),
  size: v.union(v.number(), v.null()),
});
export const comment = v.object({
  id: v.string(),
  text: v.string(),
  author: v.union(v.string(), v.null()),
  createdAt: v.number(),
  attachments: v.array(attachment),
});
export const blockFields = {
  key: v.string(),
  position: v.number(),
  type: blockType,
  content: v.string(),
  checked: v.boolean(),
  color: blockColor,
  textColor: v.optional(textColor),
  sourceBlockId: v.union(v.string(), v.null()),
  /** Nesting for list lines (sub-bullets): 1 to 4; missing = top level */
  indent: v.optional(v.number()),
  /** Who a to-do is assigned to */
  assignee: v.optional(v.id("users")),
  /** An "images" block's pictures, shown side by side */
  images: v.optional(v.array(attachment)),
  // Legacy: files and comments attached straight to a block (both now live in the comments table)
  attachments: v.optional(v.array(attachment)),
  comments: v.optional(v.array(comment)),
};

/** Where a set of visuals sits in its review: being looked at, redlined, signed off, or dropped. */
export const reviewStatus = v.union(v.literal("inReview"), v.literal("changesRequested"), v.literal("approved"), v.literal("archived"));

/** One file in a review round, or on a review mark: stored here, or a link. */
export const reviewFile = v.object({
  storageId: v.optional(v.id("_storage")),
  url: v.optional(v.string()),
  mime: v.optional(v.string()),
  name: v.optional(v.string()),
});

/** A rectangle on a sheet, as fractions of the sheet (0–1), so it survives any zoom. */
export const markRect = v.object({ x: v.number(), y: v.number(), w: v.number(), h: v.number() });

/**
 * What a mark is about. Carries meaning on its own, never by color alone: the UI draws a
 * distinct glyph per kind as well as a color (see MARK_KINDS in src/lib/types.ts).
 */
export const markKind = v.union(v.literal("fix"), v.literal("question"), v.literal("note"), v.literal("approve"));

export default defineSchema({
  ...authTables,

  /**
   * A neighborhood work club. Clubs are first class: a club has a page listing its projects,
   * its drawings, its review rounds and its site photos.
   */
  clubs: defineTable({
    name: v.string(),
    /** "Virginia-Highland", "Ponce City Market" */
    neighborhood: v.optional(v.string()),
    city: v.optional(v.string()),
    address: v.optional(v.string()),
    status: clubStatus,
    /** The day it opened, or is due to, YYYY-MM-DD */
    openedAt: v.optional(v.union(v.string(), v.null())),
    squareFeet: v.optional(v.union(v.number(), v.null())),
    /** How many people it seats */
    seats: v.optional(v.union(v.number(), v.null())),
    coverUrl: v.optional(v.union(v.string(), v.null())),
    coverStorageId: v.optional(v.union(v.id("_storage"), v.null())),
    /** Free-form: landlord, GC, lease dates, anything worth keeping on the club itself */
    notes: v.optional(v.string()),
    /** Hand-ordered in the sidebar and the Clubs list; missing = after the ordered ones */
    order: v.optional(v.number()),
    createdBy: v.union(v.id("users"), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_order", ["order"]),

  /**
   * A piece of work. Physical projects belong to a club and run the build-out pipeline;
   * digital projects may belong to a club or to the network (clubId null).
   */
  projects: defineTable({
    title: v.string(),
    /** null = network-wide work (brand standards, a furniture refresh across every club) */
    clubId: v.optional(v.union(v.id("clubs"), v.null())),
    type: projectType,
    stage: projectStage,
    /** Open date for a build-out, ship date for digital work. YYYY-MM-DD or null. */
    targetDate: v.union(v.string(), v.null()),
    /** The brief: scope, constraints, what done looks like. Absent until someone writes one. */
    brief: v.optional(v.string()),
    /** Links that go with the brief (lease, drawings, permit set, vendor quote, Figma). */
    briefLinks: v.optional(v.array(v.object({ id: v.string(), label: v.string(), url: v.string() }))),
    /** Pinned to the top of the project views while it's being worked on (when it was pinned) */
    pinnedAt: v.optional(v.union(v.number(), v.null())),
    shareSlug: v.string(),
    editPasscode: v.union(v.string(), v.null()),
    createdBy: v.union(v.id("users"), v.null()),
    updatedAt: v.number(),
    /** "journal" = a studio note: the same document and editor, kept out of the project views.
     *  "todo" = the team's one shared Todo list (a bulleted list in the editor), above Projects and on Home.
     *  NOTE: any truthy `kind` hides the row from the projects list — never reuse it for project type. */
    kind: v.optional(v.union(v.literal("journal"), v.literal("todo"))),
    /** Where the card sits in its board column (dragged there by hand). Scoped to one column. */
    boardOrder: v.optional(v.number()),
  })
    .index("by_slug", ["shareSlug"])
    .index("by_updated", ["updatedAt"])
    .index("by_club", ["clubId"]),

  // main = the project document, tasks = the punch list / checklist, edited = someone's suggested
  // copy, archived = a replaced main kept for history
  documents: defineTable({
    projectId: v.id("projects"),
    kind: v.union(v.literal("main"), v.literal("tasks"), v.literal("edited"), v.literal("archived")),
    editorName: v.union(v.string(), v.null()),
    guestToken: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId", "kind"])
    .index("by_token", ["guestToken"]),

  blocks: defineTable({
    documentId: v.id("documents"),
    projectId: v.id("projects"),
    ...blockFields,
  })
    .index("by_document", ["documentId", "position"])
    .index("by_document_key", ["documentId", "key"])
    .index("by_project", ["projectId"]),

  // Comments on a project: blockKey null = about the whole project, else about one line/block.
  comments: defineTable({
    projectId: v.id("projects"),
    blockKey: v.union(v.string(), v.null()),
    /** The line's text when the comment was made (shown if the line is later removed) */
    quote: v.union(v.string(), v.null()),
    /** Lines this comment used to be on, oldest first (it moves when an edit replaces its line) */
    keyHistory: v.optional(v.array(v.string())),
    text: v.string(),
    authorName: v.union(v.string(), v.null()),
    authorId: v.union(v.id("users"), v.null()),
    /** Posted by an AI agent through the agent API */
    agent: v.boolean(),
    /** Share-link commenters get a token so they can edit their own comments */
    guestToken: v.union(v.string(), v.null()),
    attachments: v.array(attachment),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_project", ["projectId", "createdAt"]),

  // Log tab: a running record per project of what happened (site visit, vendor call, approval,
  // inspection, a date that moved). Internal only.
  updates: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    details: v.string(),
    /** Where to find it (email thread, Slack message, doc) */
    link: v.union(v.string(), v.null()),
    /** e.g. Email, Slack, Call, Site visit */
    source: v.union(v.string(), v.null()),
    happenedAt: v.number(),
    authorName: v.union(v.string(), v.null()),
    authorId: v.union(v.id("users"), v.null()),
    agent: v.boolean(),
    /** Needs a response right away; pinned to the top of the Log until handled */
    urgent: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId", "happenedAt"])
    .index("by_happened", ["happenedAt"]),

  /**
   * REVIEW ROUNDS. A set of visuals under review — renders, floor plans, elevations, mockups,
   * finish boards — carried through numbered rounds until it's approved.
   *
   * reviews        the thing being reviewed, and where it stands
   * reviewRounds   v1, v2, v3 … each holding one or more sheets
   * reviewMarks    feedback pinned to a point or an area on one sheet of one round
   *
   * A review keeps its own small status. It must never hold the project's pipeline stage:
   * adding a round would otherwise walk the whole project backwards.
   */
  reviews: defineTable({
    title: v.string(),
    /** The project it belongs to */
    projectId: v.optional(v.union(v.id("projects"), v.null())),
    /** Denormalized so a club page can list its reviews without reading every project */
    clubId: v.optional(v.union(v.id("clubs"), v.null())),
    status: reviewStatus,
    archivedAt: v.optional(v.union(v.number(), v.null())),
    /** Someone asked for changes to the latest round; cleared when the next round lands */
    changesRequestedAt: v.optional(v.union(v.number(), v.null())),
    /** What was asked for, if anything */
    changesRequestNote: v.optional(v.string()),
    /** Who signed it off, and when */
    approvedAt: v.optional(v.union(v.number(), v.null())),
    approvedBy: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.string()),
    roundCount: v.number(),
    /** Agent name or person who started it */
    createdBy: v.union(v.string(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_updated", ["updatedAt"])
    .index("by_project", ["projectId"])
    .index("by_club", ["clubId"]),

  reviewRounds: defineTable({
    reviewId: v.id("reviews"),
    number: v.number(),
    /** The sheets in this round, in order. A plan set is several; a render is one. */
    files: v.array(reviewFile),
    /** What changed in this round */
    note: v.string(),
    by: v.union(v.string(), v.null()),
    agent: v.boolean(),
    createdAt: v.number(),
  }).index("by_review", ["reviewId", "number"]),

  reviewMarks: defineTable({
    reviewId: v.id("reviews"),
    /** The round it's about */
    roundNumber: v.number(),
    /** Which sheet in that round */
    fileIndex: v.number(),
    /** 1-based page within the sheet; 1 for an image */
    page: v.optional(v.number()),
    /** Where it points, as fractions of the sheet (0–1), so it survives any zoom. */
    x: v.optional(v.union(v.number(), v.null())),
    y: v.optional(v.union(v.number(), v.null())),
    /** An area rather than a point (a region of a plan, selected text on a spec sheet) */
    rects: v.optional(v.array(markRect)),
    /** Text selected on a PDF sheet, when the mark came from a selection */
    quote: v.optional(v.string()),
    /** What kind of mark it is. Shown as a glyph, not only a color. */
    markKind: v.optional(markKind),
    text: v.string(),
    attachments: v.optional(v.array(reviewFile)),
    authorName: v.union(v.string(), v.null()),
    authorId: v.union(v.id("users"), v.null()),
    agent: v.boolean(),
    resolved: v.optional(v.boolean()),
    /** The round that resolved it, so an auto-resolve can be audited and undone */
    resolvedByRound: v.optional(v.union(v.number(), v.null())),
    createdAt: v.number(),
  }).index("by_review", ["reviewId", "roundNumber"]),

  // PDFs: drawing sets, permit sets, vendor cutsheets and papers to read, mark up and talk about
  pdfs: defineTable({
    title: v.string(),
    storageId: v.id("_storage"),
    size: v.number(),
    pages: v.optional(v.number()),
    /** Where it came from (a vendor site, a share link…) */
    sourceUrl: v.optional(v.string()),
    authors: v.optional(v.string()),
    /** A line or two on what it is */
    about: v.optional(v.string()),
    createdBy: v.union(v.id("users"), v.null()),
    /** The agent that added it, if one did */
    addedBy: v.optional(v.string()),
    /** The page you were last reading, to pick up there */
    lastPage: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updated", ["updatedAt"]),

  // Marks on a PDF: a highlight (selected words, with an optional comment) or a note (on a spot or a whole
  // page; typed or a voice recording). Positions are fractions of the page (0-1), so they fit any zoom.
  pdfNotes: defineTable({
    pdfId: v.id("pdfs"),
    page: v.number(),
    kind: v.union(v.literal("highlight"), v.literal("note")),
    quote: v.optional(v.string()),
    rects: v.optional(v.array(markRect)),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    color: v.optional(v.string()),
    text: v.string(),
    audio: v.optional(v.object({ storageId: v.id("_storage"), seconds: v.optional(v.number()), mime: v.optional(v.string()) })),
    transcript: v.optional(v.string()),
    authorId: v.union(v.id("users"), v.null()),
    authorName: v.string(),
    agent: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_pdf", ["pdfId", "page"]),

  // Which apps each person keeps in their sidebar (all apps are hidden until pinned)
  sidebarApps: defineTable({
    userId: v.id("users"),
    apps: v.array(v.string()),
  }).index("by_user", ["userId"]),

  /** Scratchboard: hand-drawn sketching (pencil on paper), drawn by our own engine, not Excalidraw */
  scratchboards: defineTable({
    title: v.string(),
    /** The drawing: a JSON array of items (see convex/scratchboards.ts) */
    elements: v.string(),
    /** Plain-text description for AI */
    summary: v.string(),
    createdBy: v.union(v.string(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updated", ["updatedAt"]),

  // Excalidraw boards: the scene as JSON plus an AI-readable summary of it (see boards.ts).
  // Space plans, bubble diagrams, adjacency studies, furniture layouts.
  boards: defineTable({
    title: v.string(),
    /** Excalidraw elements, JSON */
    elements: v.string(),
    /** The few Excalidraw view settings worth keeping (background color, grid), JSON */
    appState: v.string(),
    /** Images on the board, stored here */
    files: v.array(v.object({ id: v.string(), url: v.string(), mimeType: v.string(), storageId: v.optional(v.id("_storage")) })),
    /** Plain-text description for AI: text, labelled shapes, connections */
    summary: v.string(),
    elementCount: v.number(),
    /** Pinned to the sidebar (when it was pinned; absent = not pinned) */
    pinnedAt: v.optional(v.union(v.number(), v.null())),
    createdBy: v.union(v.id("users"), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updated", ["updatedAt"]),

  // References: the studio's inspiration board (images, product links, posts, notes), with search.
  ideas: defineTable({
    kind: v.union(v.literal("tweet"), v.literal("video"), v.literal("image"), v.literal("link"), v.literal("note")),
    url: v.union(v.string(), v.null()),
    note: v.string(),
    /** Uploaded image or video */
    storageId: v.union(v.id("_storage"), v.null()),
    fileUrl: v.union(v.string(), v.null()),
    mime: v.union(v.string(), v.null()),
    authorName: v.union(v.string(), v.null()),
    agent: v.boolean(),
    /** What the link says (post text and author, video title…), so search finds it by topic */
    previewText: v.optional(v.string()),
    /** Lower-cased note + url + preview text, for search */
    searchText: v.string(),
    /** When it was bookmarked (absent = not bookmarked) */
    bookmarkedAt: v.optional(v.union(v.number(), v.null())),
    createdAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .index("by_url", ["url"])
    .searchIndex("search", { searchField: "searchText" }),

  // Cached post data for link cards (fetched from FxTwitter, refreshed after a few hours).
  // This is the link-preview cache, not a posting feature.
  tweets: defineTable({
    tweetId: v.string(),
    data: v.union(v.any(), v.null()),
    fetchedAt: v.number(),
  }).index("by_tweet", ["tweetId"]),

  // Cached preview cards for links in comments (Instagram, Pinterest, LinkedIn, ...)
  linkPreviews: defineTable({
    url: v.string(),
    data: v.union(v.any(), v.null()),
    fetchedAt: v.number(),
  }).index("by_url", ["url"]),

  // Library: an index of files pasted into comments (rebuilt from comments; see library.ts)
  assets: defineTable({
    projectId: v.id("projects"),
    commentId: v.id("comments"),
    attachmentId: v.string(),
    kind: v.union(v.literal("image"), v.literal("video"), v.literal("audio"), v.literal("file")),
    name: v.string(),
    url: v.union(v.string(), v.null()),
    mime: v.union(v.string(), v.null()),
    size: v.union(v.number(), v.null()),
    blockKey: v.union(v.string(), v.null()),
    /** The text of the line it was commented on (the line's last known text if it was removed) */
    linkedLine: v.string(),
    lineRemoved: v.boolean(),
    projectTitle: v.string(),
    commentText: v.string(),
    /** Lower-cased name + linked line + project title + comment, for search */
    searchText: v.string(),
    createdAt: v.number(),
  })
    .index("by_created", ["createdAt"])
    .index("by_project", ["projectId"])
    .searchIndex("search", { searchField: "searchText" }),
});
