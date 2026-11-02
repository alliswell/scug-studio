// Projects: a build-out or a piece of digital work, and everything hanging off it.
// A project's `type` decides which pipeline it runs, and the pipeline decides which stages are legal.

import { ConvexError, v, type Infer } from "convex/values";
import { queueAssetSync } from "./library";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { deleteDocument, newSlug, requireUser } from "./lib";
import { digitalStage, physicalStage, projectStage, projectType } from "./schema";

export type ProjectType = Infer<typeof projectType>;
export type ProjectStage = Infer<typeof projectStage>;

/**
 * The two pipelines, in order, read straight off the schema's validators so the stage lists here
 * and the ones the database accepts can never drift apart.
 */
export const PIPELINES: Record<ProjectType, ProjectStage[]> = {
  physical: physicalStage.members.map((m) => m.value),
  digital: digitalStage.members.map((m) => m.value),
};

/** The stage a new project of this type starts in. */
export const firstStage = (type: ProjectType): ProjectStage => PIPELINES[type][0];

/** The stage a project of this type ends in; everything before it is live work. */
export const lastStage = (type: ProjectType): ProjectStage => PIPELINES[type][PIPELINES[type].length - 1];

/**
 * A stage only means something inside its own pipeline, and a Convex validator can't express that:
 * `stage` is the union of both pipelines, so "install" passes validation on a digital project.
 * The message names the legal stages because the MCP layer hands it to an agent verbatim.
 */
export function assertStage(type: ProjectType, stage: ProjectStage) {
  if (PIPELINES[type].includes(stage)) return;
  throw new ConvexError(`A ${type} project can't be in the "${stage}" stage. Legal stages for ${type}: ${PIPELINES[type].join(", ")}.`);
}

/** Unresolved marks across every review of this project. Read through by_project, never a table scan. */
async function openMarkCount(ctx: QueryCtx, projectId: Id<"projects">) {
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  let open = 0;
  for (const r of reviews) {
    const marks = await ctx.db
      .query("reviewMarks")
      .withIndex("by_review", (q) => q.eq("reviewId", r._id))
      .collect();
    open += marks.filter((m) => !m.resolved).length;
  }
  return open;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const projects = (await ctx.db.query("projects").withIndex("by_updated").order("desc").collect()).filter((p) => !p.kind); // Journal entries and the Todo list have their own places
    const clubNames = new Map<Id<"clubs">, string | null>();
    for (const id of new Set(projects.flatMap((p) => (p.clubId ? [p.clubId] : [])))) {
      clubNames.set(id, (await ctx.db.get(id))?.name ?? null);
    }
    return Promise.all(
      projects.map(async (project) => {
        const edited = await ctx.db
          .query("documents")
          .withIndex("by_project", (q) => q.eq("projectId", project._id).eq("kind", "edited"))
          .collect();
        return {
          ...project,
          editedCount: edited.length,
          clubName: project.clubId ? (clubNames.get(project.clubId) ?? null) : null,
          openMarks: await openMarkCount(ctx, project._id),
        };
      }),
    );
  },
});

export const get = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const projectId = ctx.db.normalizeId("projects", id);
    if (!projectId) return null;
    const project = await ctx.db.get(projectId);
    if (!project) return null;
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    return {
      project,
      documents: documents.map((d) => ({
        _id: d._id,
        kind: d.kind,
        editorName: d.editorName,
        updatedAt: d.updatedAt,
      })),
      club: project.clubId ? await ctx.db.get(project.clubId) : null,
    };
  },
});

export const create = mutation({
  args: {
    type: projectType,
    stage: v.optional(projectStage),
    clubId: v.optional(v.union(v.id("clubs"), v.null())),
    journal: v.optional(v.boolean()),
    title: v.optional(v.string()),
    targetDate: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { type, stage, clubId, journal, title, targetDate }) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new ConvexError("The target date must be YYYY-MM-DD");
    if (stage) assertStage(type, stage);
    const projectId = await ctx.db.insert("projects", {
      title: (title ?? "").slice(0, 500),
      clubId: clubId ?? null,
      type,
      stage: stage ?? firstStage(type),
      targetDate: targetDate ?? null,
      shareSlug: newSlug(),
      editPasscode: null,
      createdBy: userId,
      updatedAt: now,
      ...(journal ? { kind: "journal" as const } : {}),
    });
    for (const kind of ["main", "tasks"] as const) {
      await ctx.db.insert("documents", { projectId, kind, editorName: null, guestToken: null, updatedAt: now });
    }
    return projectId;
  },
});

export const update = mutation({
  args: {
    id: v.id("projects"),
    title: v.optional(v.string()),
    targetDate: v.optional(v.union(v.string(), v.null())),
    stage: v.optional(projectStage),
    type: v.optional(projectType),
    clubId: v.optional(v.union(v.id("clubs"), v.null())),
    brief: v.optional(v.string()),
    briefLinks: v.optional(v.array(v.object({ id: v.string(), label: v.string(), url: v.string() }))),
    editPasscode: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, ...patch }) => {
    await requireUser(ctx);
    const project = await ctx.db.get(id);
    if (!project) throw new ConvexError("Project not found");
    if (patch.editPasscode !== undefined && patch.editPasscode !== null && patch.editPasscode.trim().length < 8) {
      throw new ConvexError("Passcode must be at least 8 characters");
    }
    if (patch.targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(patch.targetDate)) throw new ConvexError("The target date must be YYYY-MM-DD");
    if (patch.brief && patch.brief.length > 50000) throw new ConvexError("The brief can be at most 50,000 characters");
    if (patch.briefLinks && (patch.briefLinks.length > 100 || patch.briefLinks.some((l) => !/^https?:\/\//i.test(l.url))))
      throw new ConvexError("Links must start with http:// or https://");
    // Switching pipelines strands the old stage, so the project starts the new pipeline over
    // unless this same call says where it should land.
    const type = patch.type ?? project.type;
    const stage = patch.stage ?? (patch.type && patch.type !== project.type ? firstStage(patch.type) : project.stage);
    assertStage(type, stage);
    await ctx.db.patch(id, { ...patch, type, stage, updatedAt: Date.now() });
    if (patch.title !== undefined) await queueAssetSync(ctx, id);
  },
});

/** Pin a project to the top of the project views, or unpin it. Doesn't count as an edit. */
export const setPinned = mutation({
  args: { id: v.id("projects"), pinned: v.boolean() },
  handler: async (ctx, { id, pinned }) => {
    await requireUser(ctx);
    await ctx.db.patch(id, { pinnedAt: pinned ? Date.now() : null });
  },
});

export const resetShareLink = mutation({
  args: { id: v.id("projects") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    await ctx.db.patch(id, { shareSlug: newSlug() });
  },
});

/** Deletes a review and everything under it, including every blob on its rounds and its marks. */
async function deleteReview(ctx: MutationCtx, reviewId: Id<"reviews">) {
  const drop = async (storageId: Id<"_storage"> | undefined) => {
    if (storageId) await ctx.storage.delete(storageId).catch(() => {});
  };
  const rounds = await ctx.db
    .query("reviewRounds")
    .withIndex("by_review", (q) => q.eq("reviewId", reviewId))
    .collect();
  for (const r of rounds) {
    for (const f of r.files) await drop(f.storageId);
    await ctx.db.delete(r._id);
  }
  const marks = await ctx.db
    .query("reviewMarks")
    .withIndex("by_review", (q) => q.eq("reviewId", reviewId))
    .collect();
  for (const m of marks) {
    // A mark can carry its own sheets or photos; the old code left those behind
    for (const a of m.attachments ?? []) await drop(a.storageId);
    await ctx.db.delete(m._id);
  }
  await ctx.db.delete(reviewId);
}

export const remove = mutation({
  args: { id: v.id("projects") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", id))
      .collect();
    for (const d of docs) await deleteDocument(ctx, d._id);
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_project", (q) => q.eq("projectId", id))
      .collect();
    for (const c of comments) {
      for (const a of c.attachments) if (a.storageId) await ctx.storage.delete(a.storageId).catch(() => {});
      await ctx.db.delete(c._id);
    }
    const updates = await ctx.db
      .query("updates")
      .withIndex("by_project", (q) => q.eq("projectId", id))
      .collect();
    for (const u of updates) await ctx.db.delete(u._id);
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_project", (q) => q.eq("projectId", id))
      .collect();
    for (const r of reviews) await deleteReview(ctx, r._id);
    await ctx.db.delete(id);
    await queueAssetSync(ctx, id);
  },
});

/** The Journal: entries newest first, each with the start of what's written */
export const journal = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const rows = (await ctx.db.query("projects").withIndex("by_updated").order("desc").collect()).filter((p) => p.kind === "journal");
    return Promise.all(
      rows.map(async (p) => {
        const main = await ctx.db
          .query("documents")
          .withIndex("by_project", (q) => q.eq("projectId", p._id).eq("kind", "main"))
          .first();
        const blocks = main
          ? await ctx.db
              .query("blocks")
              .withIndex("by_document", (q) => q.eq("documentId", main._id))
              .take(12)
          : [];
        const preview = blocks
          .sort((a, b) => a.position - b.position)
          .map((b) => b.content.trim())
          .filter(Boolean)
          .join(" ")
          .slice(0, 220);
        return { id: p._id, title: p.title, preview, createdAt: p._creationTime, updatedAt: p.updatedAt, pinnedAt: p.pinnedAt ?? null };
      }),
    );
  },
});

/**
 * Board: a column's cards in the order they were dragged into (top to bottom). Moves the dropped card to that
 * column too. Doesn't touch "last edited", so other views keep their order.
 *
 * The column is a bare stage, so a card dragged across pipelines would otherwise land in a stage its
 * own type has never heard of. assertStage is what stops that.
 */
export const reorder = mutation({
  args: { stage: projectStage, ids: v.array(v.id("projects")), moved: v.optional(v.id("projects")) },
  handler: async (ctx, { stage, ids, moved }) => {
    await requireUser(ctx);
    if (ids.length > 2000) throw new ConvexError("Too many cards");
    for (const [i, id] of ids.entries()) {
      const project = await ctx.db.get(id);
      if (!project) continue;
      const patch: { boardOrder?: number; stage?: ProjectStage; updatedAt?: number } = {};
      if (project.boardOrder !== i) patch.boardOrder = i;
      // Changing column is a real change; just reordering isn't
      if (id === moved && project.stage !== stage) {
        assertStage(project.type, stage);
        Object.assign(patch, { stage, updatedAt: Date.now() });
      }
      if (Object.keys(patch).length) await ctx.db.patch(id, patch);
    }
  },
});
