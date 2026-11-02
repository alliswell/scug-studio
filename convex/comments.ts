import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { releaseFiles, requireUser } from "./lib";
import { attachment } from "./schema";
import { MAX_ATTACHMENTS, resolvedAttachment, toAttachment } from "./agentFiles";
import { queueAssetSync } from "./library";

const MAX_TEXT = 10000;

export type CommentView = {
  id: Id<"comments">;
  blockKey: string | null;
  keyHistory: string[];
  quote: string | null;
  text: string;
  authorName: string | null;
  agent: boolean;
  mine: boolean;
  attachments: Doc<"comments">["attachments"];
  createdAt: number;
};

function view(c: Doc<"comments">, mine: boolean): CommentView {
  return {
    id: c._id,
    blockKey: c.blockKey,
    keyHistory: c.keyHistory ?? [],
    quote: c.quote,
    text: c.text,
    authorName: c.authorName,
    agent: c.agent,
    mine,
    attachments: c.attachments,
    createdAt: c.createdAt,
  };
}

async function byProject(ctx: QueryCtx, projectId: Id<"projects">) {
  return ctx.db
    .query("comments")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
}

async function projectBySlug(ctx: QueryCtx, slug: string) {
  return ctx.db
    .query("projects")
    .withIndex("by_slug", (q) => q.eq("shareSlug", slug))
    .unique();
}

async function lineText(ctx: QueryCtx, projectId: Id<"projects">, blockKey: string | null) {
  if (!blockKey) return null;
  const main = await ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId).eq("kind", "main"))
    .first();
  const tasks = await ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId).eq("kind", "tasks"))
    .first();
  for (const d of [main, tasks]) {
    if (!d) continue;
    const b = await ctx.db
      .query("blocks")
      .withIndex("by_document_key", (q) => q.eq("documentId", d._id).eq("key", blockKey))
      .unique();
    if (b) return b.content.slice(0, 300);
  }
  return null;
}

async function insert(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    blockKey: string | null;
    text: string;
    authorName: string | null;
    authorId: Id<"users"> | null;
    agent: boolean;
    guestToken: string | null;
    attachments?: Doc<"comments">["attachments"];
  },
) {
  const now = Date.now();
  const id = await ctx.db.insert("comments", {
    projectId: args.projectId,
    blockKey: args.blockKey,
    quote: await lineText(ctx, args.projectId, args.blockKey),
    text: args.text.slice(0, MAX_TEXT),
    authorName: args.authorName?.slice(0, 80) ?? null,
    authorId: args.authorId,
    agent: args.agent,
    guestToken: args.guestToken,
    attachments: args.attachments ?? [],
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(args.projectId, { updatedAt: now });
  if (args.attachments?.length) await queueAssetSync(ctx, args.projectId);
  return id;
}

// ---------- Team members ----------

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const userId = await requireUser(ctx);
    const rows = await byProject(ctx, projectId);
    return rows.map((c) => view(c, c.authorId === userId));
  },
});

export const add = mutation({
  args: { projectId: v.id("projects"), blockKey: v.union(v.string(), v.null()), text: v.string() },
  handler: async (ctx, { projectId, blockKey, text }) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    return insert(ctx, {
      projectId,
      blockKey,
      text,
      authorName: user?.name || user?.email?.split("@")[0] || null,
      authorId: userId,
      agent: false,
      guestToken: null,
    });
  },
});

export const update = mutation({
  args: { id: v.id("comments"), text: v.string() },
  handler: async (ctx, { id, text }) => {
    await requireUser(ctx);
    await ctx.db.patch(id, { text: text.slice(0, MAX_TEXT), updatedAt: Date.now() });
  },
});

/** Puts a comment on a line (e.g. one whose line was removed). The line it was on is remembered. */
export const moveToLine = mutation({
  args: { id: v.id("comments"), blockKey: v.string() },
  handler: async (ctx, { id, blockKey }) => {
    await requireUser(ctx);
    const c = await ctx.db.get(id);
    if (!c) throw new ConvexError("Comment not found");
    const quote = await lineText(ctx, c.projectId, blockKey);
    if (quote === null) throw new ConvexError("That line isn't in the project");
    const history = c.keyHistory ?? [];
    await ctx.db.patch(id, {
      blockKey,
      quote,
      keyHistory: c.blockKey && c.blockKey !== blockKey ? [...history.filter((k) => k !== c.blockKey), c.blockKey].slice(-20) : history,
      updatedAt: Date.now(),
    });
    await queueAssetSync(ctx, c.projectId);
  },
});

/** Adds one file or link. Appending (rather than replacing the list) keeps parallel uploads safe. */
export const attach = mutation({
  args: { id: v.id("comments"), attachment },
  handler: async (ctx, { id, attachment: a }) => {
    await requireUser(ctx);
    const c = await ctx.db.get(id);
    if (!c) throw new ConvexError("Comment not found");
    if (a.url && !/^https?:\/\//i.test(a.url)) throw new ConvexError("Links must start with http:// or https://");
    await ctx.db.patch(id, { attachments: [...c.attachments, a], updatedAt: Date.now() });
    if (a.kind !== "link") await queueAssetSync(ctx, c.projectId);
  },
});

export const detach = mutation({
  args: { id: v.id("comments"), attachmentId: v.string() },
  handler: async (ctx, { id, attachmentId }) => {
    await requireUser(ctx);
    const c = await ctx.db.get(id);
    if (!c) return;
    const gone = c.attachments.filter((a) => a.id === attachmentId);
    await ctx.db.patch(id, { attachments: c.attachments.filter((a) => a.id !== attachmentId), updatedAt: Date.now() });
    await queueAssetSync(ctx, c.projectId);
    await releaseFiles(ctx, c.projectId, gone.flatMap((a) => (a.storageId ? [a.storageId] : [])));
  },
});

export const remove = mutation({
  args: { id: v.id("comments") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const c = await ctx.db.get(id);
    if (!c) return;
    await ctx.db.delete(id);
    await queueAssetSync(ctx, c.projectId);
    await releaseFiles(ctx, c.projectId, c.attachments.flatMap((a) => (a.storageId ? [a.storageId] : [])));
  },
});

// ---------- Share-link viewers ----------

export const listShared = query({
  args: { slug: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, { slug, token }) => {
    const project = await projectBySlug(ctx, slug);
    if (!project) return [];
    const rows = await byProject(ctx, project._id);
    return rows.map((c) => view(c, !!token && c.guestToken === token));
  },
});

async function guestProject(ctx: QueryCtx, slug: string, passcode: string) {
  const project = await projectBySlug(ctx, slug);
  if (!project || project.editPasscode === null || project.editPasscode !== passcode) {
    throw new ConvexError("That passcode isn't right.");
  }
  return project;
}

export const addAsGuest = mutation({
  args: {
    slug: v.string(),
    passcode: v.string(),
    token: v.string(),
    name: v.string(),
    blockKey: v.union(v.string(), v.null()),
    text: v.string(),
  },
  handler: async (ctx, { slug, passcode, token, name, blockKey, text }) => {
    if (token.length < 32) throw new ConvexError("Bad token");
    const project = await guestProject(ctx, slug, passcode);
    return insert(ctx, {
      projectId: project._id,
      blockKey,
      text,
      authorName: name.trim() || "Guest",
      authorId: null,
      agent: false,
      guestToken: token,
    });
  },
});

async function ownGuestComment(ctx: MutationCtx, id: Id<"comments">, slug: string, passcode: string, token: string) {
  const project = await guestProject(ctx, slug, passcode);
  const c = await ctx.db.get(id);
  if (!c || c.projectId !== project._id || c.guestToken !== token) throw new ConvexError("You can only change your own comments.");
  return c;
}

export const updateAsGuest = mutation({
  args: { id: v.id("comments"), slug: v.string(), passcode: v.string(), token: v.string(), text: v.string() },
  handler: async (ctx, { id, slug, passcode, token, text }) => {
    await ownGuestComment(ctx, id, slug, passcode, token);
    await ctx.db.patch(id, { text: text.slice(0, MAX_TEXT), updatedAt: Date.now() });
  },
});

export const attachLinkAsGuest = mutation({
  args: { id: v.id("comments"), slug: v.string(), passcode: v.string(), token: v.string(), url: v.string() },
  handler: async (ctx, { id, slug, passcode, token, url }) => {
    const c = await ownGuestComment(ctx, id, slug, passcode, token);
    if (!/^https?:\/\//.test(url)) throw new ConvexError("Links must start with http");
    const link = { id: crypto.randomUUID(), kind: "link" as const, url: url.slice(0, 2000), storageId: null, name: null, mime: null, size: null };
    await ctx.db.patch(id, { attachments: [...c.attachments, link], updatedAt: Date.now() });
  },
});

export const detachAsGuest = mutation({
  args: { id: v.id("comments"), slug: v.string(), passcode: v.string(), token: v.string(), attachmentId: v.string() },
  handler: async (ctx, { id, slug, passcode, token, attachmentId }) => {
    const c = await ownGuestComment(ctx, id, slug, passcode, token);
    await ctx.db.patch(id, { attachments: c.attachments.filter((a) => a.id !== attachmentId), updatedAt: Date.now() });
    await queueAssetSync(ctx, c.projectId);
  },
});

export const removeAsGuest = mutation({
  args: { id: v.id("comments"), slug: v.string(), passcode: v.string(), token: v.string() },
  handler: async (ctx, { id, slug, passcode, token }) => {
    const c = await ownGuestComment(ctx, id, slug, passcode, token);
    await ctx.db.delete(id);
    await queueAssetSync(ctx, c.projectId);
  },
});

// ---------- Agents ----------

/**
 * Posts a comment as an AI agent. Not callable from the browser: run it with
 * `npx convex run comments:addAgent '{...}'` or through the /agent/comment HTTP route.
 * Target the whole project (no line), a line by key, or a line by (part of) its text.
 */
export const addAgent = internalMutation({
  args: {
    project: v.string(),
    text: v.string(),
    agentName: v.optional(v.string()),
    blockKey: v.optional(v.string()),
    lineContains: v.optional(v.string()),
    /** Links by URL, or files already stored (see agentFiles.ts) */
    attachments: v.optional(v.array(resolvedAttachment)),
  },
  handler: async (ctx, { project: ref, text, agentName, blockKey, lineContains, attachments }) => {
    const projectId = ctx.db.normalizeId("projects", ref);
    const project = projectId ? await ctx.db.get(projectId) : await projectBySlug(ctx, ref.split("/").pop() ?? ref);
    if (!project) throw new ConvexError("Project not found. Pass its id or share link.");
    let key: string | null = blockKey ?? null;
    if (!key && lineContains) {
      const needle = lineContains.toLowerCase();
      const docs = await ctx.db
        .query("documents")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      for (const d of docs.filter((x) => x.kind === "main" || x.kind === "tasks")) {
        const blocks = await ctx.db
          .query("blocks")
          .withIndex("by_document", (q) => q.eq("documentId", d._id))
          .collect();
        const hit = blocks.find((b) => b.content.toLowerCase().includes(needle));
        if (hit) {
          key = hit.key;
          break;
        }
      }
      if (!key) throw new ConvexError(`No line contains "${lineContains}".`);
    }
    if ((attachments ?? []).length > MAX_ATTACHMENTS) throw new ConvexError(`At most ${MAX_ATTACHMENTS} attachments per comment`);
    const files = [];
    for (const a of attachments ?? []) files.push(await toAttachment(ctx, a));
    return insert(ctx, {
      projectId: project._id,
      blockKey: key,
      text,
      authorName: agentName?.trim() || "Claude",
      authorId: null,
      agent: true,
      guestToken: null,
      attachments: files,
    });
  },
});
