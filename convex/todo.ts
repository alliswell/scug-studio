// The Todo list: one shared list for the whole team, at the top of the sidebar (above Projects) and of Home.
// It's a project-like record (projects.kind = "todo") so it gets the same editor: bullets, sub-bullets (Tab),
// files, and comments on any line.

import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { newSlug, requireUser } from "./lib";
import { firstStage } from "./projects";

async function findTodo(ctx: QueryCtx) {
  // A full scan of projects on every Home render. Few rows carry a kind and there is no index on it,
  // so this is cheap today and the first thing to fix if the projects table ever grows.
  const rows = (await ctx.db.query("projects").collect()).filter((x) => x.kind === "todo");
  return rows.sort((a, b) => a._creationTime - b._creationTime)[0] ?? null;
}

export async function ensureTodo(ctx: MutationCtx, userId: Id<"users"> | null): Promise<Id<"projects">> {
  const found = await findTodo(ctx);
  if (found) return found._id;
  const now = Date.now();
  // The list isn't anyone's work and belongs to no club; it only borrows the editor.
  const projectId = await ctx.db.insert("projects", {
    title: "Todo",
    clubId: null,
    type: "physical",
    stage: firstStage("physical"),
    targetDate: null,
    shareSlug: newSlug(),
    editPasscode: null,
    createdBy: userId,
    updatedAt: now,
    kind: "todo",
  });
  const main = await ctx.db.insert("documents", { projectId, kind: "main", editorName: null, guestToken: null, updatedAt: now });
  await ctx.db.insert("documents", { projectId, kind: "tasks", editorName: null, guestToken: null, updatedAt: now });
  // Start with one empty to-do so the list is ready to type into
  await ctx.db.insert("blocks", { documentId: main, projectId, key: crypto.randomUUID(), position: 0, type: "todo", content: "", checked: false, color: null, sourceBlockId: null });
  return projectId;
}

/** The Todo list's id (made the first time anyone opens it) */
export const open = mutation({
  args: {},
  handler: async (ctx) => ensureTodo(ctx, await requireUser(ctx)),
});

export const ensureForAgent = internalMutation({
  args: {},
  handler: async (ctx) => ensureTodo(ctx, null),
});

/** For Home: the list's lines (live), and how many comments each has */
export const get = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const todo = await findTodo(ctx);
    if (!todo) return null;
    const main = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", todo._id).eq("kind", "main"))
      .first();
    const blocks = main
      ? await ctx.db
          .query("blocks")
          .withIndex("by_document", (q) => q.eq("documentId", main._id))
          .collect()
      : [];
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_project", (q) => q.eq("projectId", todo._id))
      .collect();
    const counts: Record<string, number> = {};
    for (const c of comments) if (c.blockKey) counts[c.blockKey] = (counts[c.blockKey] ?? 0) + 1;
    return {
      id: todo._id,
      updatedAt: todo.updatedAt,
      lines: blocks.map((b) => ({
        key: b.key,
        type: b.type,
        content: b.content,
        checked: b.checked,
        indent: b.indent ?? 0,
        assignee: b.assignee ?? null,
        files: (b.images ?? []).length,
        comments: counts[b.key] ?? 0,
      })),
    };
  },
});

/** Quick add from Home: a new bullet at the end of the list */
export const add = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const userId = await requireUser(ctx);
    const t = text.trim().slice(0, 20000);
    if (!t) return;
    const projectId = await ensureTodo(ctx, userId);
    const main = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", projectId).eq("kind", "main"))
      .first();
    if (!main) throw new Error("The Todo list has no text yet");
    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", main._id))
      .collect();
    // A fresh list is one empty bullet: fill it in rather than adding below it
    const lone = blocks.length === 1 && !blocks[0].content.trim() ? blocks[0] : null;
    if (lone) await ctx.db.patch(lone._id, { content: t, type: "todo" });
    else {
      const position = blocks.reduce((m, b) => Math.max(m, b.position), -1) + 1;
      await ctx.db.insert("blocks", { documentId: main._id, projectId, key: crypto.randomUUID(), position, type: "todo", content: t, checked: false, color: null, sourceBlockId: null });
    }
    const now = Date.now();
    await ctx.db.patch(main._id, { updatedAt: now });
    await ctx.db.patch(projectId, { updatedAt: now });
  },
});

/** Tick or untick an item, or assign it (null = nobody), from Home */
export const setItem = mutation({
  args: { key: v.string(), checked: v.optional(v.boolean()), assignee: v.optional(v.union(v.id("users"), v.null())) },
  handler: async (ctx, { key, checked, assignee }) => {
    await requireUser(ctx);
    const todo = await findTodo(ctx);
    if (!todo) return;
    const main = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", todo._id).eq("kind", "main"))
      .first();
    const block = main
      ? await ctx.db
          .query("blocks")
          .withIndex("by_document_key", (q) => q.eq("documentId", main._id).eq("key", key))
          .unique()
      : null;
    if (!main || !block) return;
    await ctx.db.patch(block._id, {
      ...(checked !== undefined ? { checked, type: "todo" as const } : {}),
      ...(assignee !== undefined ? { assignee: assignee ?? undefined } : {}),
      // Bump the rev so an open editor sees this as someone else's change rather than writing over it
      rev: (block.rev ?? 0) + 1,
    });
    const now = Date.now();
    await ctx.db.patch(main._id, { updatedAt: now });
    await ctx.db.patch(todo._id, { updatedAt: now });
  },
});
