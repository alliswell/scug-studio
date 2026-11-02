import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { attachment, blockColor, blockType, comment, textColor } from "./schema";
import { docBlocks, writeEditedVersion } from "./lib";
import { boardIdOf } from "./boards";

async function projectBySlug(ctx: QueryCtx, slug: string) {
  return ctx.db
    .query("projects")
    .withIndex("by_slug", (q) => q.eq("shareSlug", slug))
    .unique();
}

async function docOf(ctx: QueryCtx, projectId: Id<"projects">, kind: "main" | "tasks") {
  return ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId).eq("kind", kind))
    .first();
}

/** Everything a share-link viewer can see: this one project and nothing else. */
export const get = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const project = await projectBySlug(ctx, slug);
    if (!project) return null;
    const main = await docOf(ctx, project._id, "main");
    const tasks = await docOf(ctx, project._id, "tasks");
    const blocks = main ? await docBlocks(ctx, main._id) : [];
    // Boards shown in the document (title and AI summary; the drawing itself comes from `board`)
    const boards = [];
    for (const b of blocks) {
      const id = b.type === "board" ? boardIdOf(ctx, b.content) : null;
      const row = id ? await ctx.db.get(id) : null;
      if (row) boards.push({ id: row._id as string, title: row.title, summary: row.summary });
    }
    // The club's name is all a share link ever shows of it — never the address or the notes
    const club = project.clubId ? await ctx.db.get(project.clubId) : null;
    return {
      project: {
        title: project.title,
        targetDate: project.targetDate,
        stage: project.stage,
        type: project.type,
        clubName: club?.name ?? null,
        canEdit: project.editPasscode !== null,
      },
      blocks,
      tasks: tasks ? await docBlocks(ctx, tasks._id) : [],
      boards,
    };
  },
});

/** A board drawn in a shared project, for share-link viewers (only boards that project shows). */
export const board = query({
  args: { slug: v.string(), id: v.string() },
  handler: async (ctx, { slug, id }) => {
    const project = await projectBySlug(ctx, slug);
    const boardId = boardIdOf(ctx, id);
    if (!project || !boardId) return null;
    const main = await docOf(ctx, project._id, "main");
    if (!main) return null;
    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", main._id))
      .collect();
    if (!blocks.some((b) => b.type === "board" && boardIdOf(ctx, b.content) === boardId)) return null;
    const b = await ctx.db.get(boardId);
    if (!b) return null;
    return { id: b._id, title: b.title, elements: b.elements, appState: b.appState, files: b.files, updatedAt: b.updatedAt };
  },
});

async function checkPasscode(ctx: QueryCtx, slug: string, passcode: string) {
  const project = await projectBySlug(ctx, slug);
  if (!project || project.editPasscode === null || project.editPasscode !== passcode) {
    throw new ConvexError("That passcode isn't right.");
  }
  return project;
}

export const guestEdit = query({
  args: { slug: v.string(), passcode: v.string(), token: v.string() },
  handler: async (ctx, { slug, passcode, token }) => {
    const project = await checkPasscode(ctx, slug, passcode);
    const doc = await ctx.db
      .query("documents")
      .withIndex("by_token", (q) => q.eq("guestToken", token))
      .first();
    if (!doc || doc.projectId !== project._id || doc.kind !== "edited") return { exists: false as const };
    return { exists: true as const, editorName: doc.editorName, blocks: await docBlocks(ctx, doc._id) };
  },
});

/** Saves a guest's whole edited copy. The owner sees it as an "Edited version". */
export const saveGuestEdit = mutation({
  args: {
    slug: v.string(),
    passcode: v.string(),
    token: v.string(),
    name: v.string(),
    blocks: v.array(
      v.object({
        key: v.string(),
        type: blockType,
        content: v.string(),
        checked: v.boolean(),
        color: blockColor,
        textColor: v.optional(textColor),
        images: v.optional(v.array(attachment)),
        sourceBlockId: v.union(v.string(), v.null()),
        indent: v.optional(v.number()),
        assignee: v.optional(v.id("users")),
        comments: v.optional(v.array(comment)),
      }),
    ),
  },
  handler: async (ctx, { slug, passcode, token, name, blocks }) => {
    if (token.length < 32) throw new ConvexError("Bad token");
    if (blocks.length > 5000) throw new ConvexError("Too many blocks");
    const project = await checkPasscode(ctx, slug, passcode);
    if (blocks.some((b) => b.images?.some((a) => a.url && !/^https?:\/\//i.test(a.url)))) throw new ConvexError("Bad image link");
    return writeEditedVersion(ctx, project._id, token, name.trim().slice(0, 80) || "Someone", blocks);
  },
});
