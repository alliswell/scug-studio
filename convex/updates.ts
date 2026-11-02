// Log tab: a per-project record of what happened, newest first. Team only (never on share links).
// People add and remove entries in the app; agents add them through the agent API (they can't remove).

import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib";

const MAX_TITLE = 300;
const MAX_DETAILS = 20000;

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    await requireUser(ctx);
    const rows = await ctx.db
      .query("updates")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .order("desc")
      .collect();
    return rows.map((u) => ({
      id: u._id,
      title: u.title,
      details: u.details,
      link: u.link,
      source: u.source,
      happenedAt: u.happenedAt,
      authorName: u.authorName,
      agent: u.agent,
      urgent: !!u.urgent,
    }));
  },
});

/** The Feed: the latest updates across every project, newest first. */
export const feed = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireUser(ctx);
    const rows = await ctx.db
      .query("updates")
      .withIndex("by_happened")
      .order("desc")
      .take(Math.min(Math.max(limit ?? 200, 1), 500));
    // Urgent ones are always included, however old, so they stay pinned until handled
    const urgent = (await ctx.db.query("updates").collect()).filter((u) => u.urgent && !rows.some((r) => r._id === u._id));
    const projects = new Map<string, Doc<"projects"> | null>();
    const clubNames = new Map<string, string | null>();
    const out = [];
    for (const u of [...rows, ...urgent]) {
      if (!projects.has(u.projectId)) projects.set(u.projectId, await ctx.db.get(u.projectId));
      const project = projects.get(u.projectId);
      if (!project) continue; // the project was deleted
      if (project.clubId && !clubNames.has(project.clubId)) clubNames.set(project.clubId, (await ctx.db.get(project.clubId))?.name ?? null);
      out.push({
        id: u._id,
        projectId: u.projectId,
        projectTitle: project.title,
        projectStage: project.stage,
        projectType: project.type,
        clubId: project.clubId ?? null,
        clubName: project.clubId ? (clubNames.get(project.clubId) ?? null) : null,
        urgent: !!u.urgent,
        title: u.title,
        details: u.details,
        link: u.link,
        source: u.source,
        happenedAt: u.happenedAt,
        authorName: u.authorName,
        agent: u.agent,
      });
    }
    return out;
  },
});

type NewUpdate = { title: string; details?: string; link?: string | null; source?: string | null; happenedAt?: number; urgent?: boolean };

export async function insertUpdate(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  u: NewUpdate,
  author: { name: string | null; id: Id<"users"> | null; agent: boolean },
) {
  const title = u.title.trim().slice(0, MAX_TITLE);
  if (!title) throw new ConvexError("An update needs a title");
  const link = u.link?.trim() || null;
  if (link && !/^https?:\/\//i.test(link)) throw new ConvexError("The link must start with http:// or https://");
  const now = Date.now();
  return ctx.db.insert("updates", {
    projectId,
    title,
    details: (u.details ?? "").slice(0, MAX_DETAILS),
    link,
    source: u.source?.trim().slice(0, 40) || null,
    happenedAt: u.happenedAt && Number.isFinite(u.happenedAt) ? u.happenedAt : now,
    authorName: author.name,
    authorId: author.id,
    agent: author.agent,
    urgent: !!u.urgent,
    createdAt: now,
  });
}

export const add = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    details: v.optional(v.string()),
    link: v.optional(v.union(v.string(), v.null())),
    source: v.optional(v.union(v.string(), v.null())),
    happenedAt: v.optional(v.number()),
    urgent: v.optional(v.boolean()),
  },
  handler: async (ctx, { projectId, ...u }) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    return insertUpdate(ctx, projectId, u, { name: user?.name || user?.email || null, id: userId, agent: false });
  },
});

/** Mark an update urgent (pinned to the top of the Feed) or handled. */
export const setUrgent = mutation({
  args: { id: v.id("updates"), urgent: v.boolean() },
  handler: async (ctx, { id, urgent }) => {
    await requireUser(ctx);
    await ctx.db.patch(id, { urgent });
  },
});

export const remove = mutation({
  args: { id: v.id("updates") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    await ctx.db.delete(id);
  },
});
