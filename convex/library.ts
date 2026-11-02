// Library: every file pasted into a comment (images, photos, audio, other files), across every project.
// Each one is indexed with its name, the line it was commented on ("linked line") and its project, so the
// Library page can list and search them without reading every comment and document. The index is rebuilt
// per project whenever that project's comments or lines change, and fully every few minutes as a safety net.

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib";

type AssetFields = Omit<Doc<"assets">, "_id" | "_creationTime">;

/** Refresh this project's Library entries soon (after the current change is saved). */
export async function queueAssetSync(ctx: MutationCtx, projectId: Id<"projects">) {
  await ctx.scheduler.runAfter(0, internal.library.syncProject, { projectId });
}

const nameFrom = (a: Doc<"comments">["attachments"][number]) => {
  if (a.name?.trim()) return a.name.trim().slice(0, 300);
  const tail = (a.url ?? "").split("?")[0].split("/").pop() ?? "";
  return tail && tail.length < 120 ? decodeURIComponent(tail) : `Untitled ${a.kind}`;
};

export const syncProject = internalMutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }): Promise<null> => {
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const project = await ctx.db.get(projectId);
    if (!project) {
      for (const e of existing) await ctx.db.delete(e._id);
      return null;
    }
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const withFiles = comments.filter((c) => c.attachments.some((a) => a.kind !== "link" && a.url));

    // Current text of every line, from the project document and its task list
    const lines = new Map<string, string>();
    if (withFiles.length) {
      for (const kind of ["main", "tasks"] as const) {
        const doc = await ctx.db
          .query("documents")
          .withIndex("by_project", (q) => q.eq("projectId", projectId).eq("kind", kind))
          .first();
        if (!doc) continue;
        const blocks = await ctx.db
          .query("blocks")
          .withIndex("by_document", (q) => q.eq("documentId", doc._id))
          .collect();
        for (const b of blocks) lines.set(b.key, b.content);
      }
    }

    const want = new Map<string, AssetFields>();
    for (const c of withFiles) {
      const onLine = c.blockKey ? lines.get(c.blockKey) : undefined;
      const linkedLine = (onLine ?? (c.blockKey ? (c.quote ?? "") : "")).slice(0, 2000);
      for (const a of c.attachments) {
        if (a.kind === "link" || !a.url) continue;
        const name = nameFrom(a);
        const projectTitle = project.title || "Untitled";
        const commentText = c.text.slice(0, 1000);
        want.set(`${c._id}:${a.id}`, {
          projectId,
          commentId: c._id,
          attachmentId: a.id,
          kind: a.kind,
          name,
          url: a.url,
          mime: a.mime,
          size: a.size,
          blockKey: c.blockKey,
          linkedLine,
          lineRemoved: !!c.blockKey && onLine === undefined,
          projectTitle,
          commentText,
          searchText: [name, linkedLine, projectTitle, commentText].join(" \n ").toLowerCase(),
          createdAt: c.createdAt,
        });
      }
    }

    for (const e of existing) {
      const key = `${e.commentId}:${e.attachmentId}`;
      const w = want.get(key);
      if (!w) {
        await ctx.db.delete(e._id);
        continue;
      }
      want.delete(key);
      const changed = (Object.keys(w) as (keyof AssetFields)[]).some((k) => e[k] !== w[k]);
      if (changed) await ctx.db.patch(e._id, w);
    }
    for (const w of want.values()) await ctx.db.insert("assets", w);
    return null;
  },
});

/** Rebuilds every project's entries (cron safety net, and the first fill). */
export const syncAll = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const projects = await ctx.db.query("projects").collect();
    for (const p of projects) await queueAssetSync(ctx, p._id);
    // Entries whose project was deleted
    const seen = new Set(projects.map((x) => x._id));
    const orphans = await ctx.db.query("assets").collect();
    for (const o of orphans) if (!seen.has(o.projectId)) await ctx.db.delete(o._id);
    return projects.length;
  },
});

export type LibraryAsset = {
  id: Id<"assets">;
  kind: Doc<"assets">["kind"];
  name: string;
  url: string | null;
  mime: string | null;
  size: number | null;
  projectId: Id<"projects">;
  projectTitle: string;
  clubName: string | null;
  linkedLine: string;
  lineRemoved: boolean;
  wholeProject: boolean;
  commentText: string;
  createdAt: number;
};

/** One page of the Library, newest first, or the best matches for a search. */
export const list = query({
  args: { search: v.optional(v.string()), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { search, paginationOpts }) => {
    await requireUser(ctx);
    const s = search?.trim().toLowerCase();
    const page = s
      ? await ctx.db
          .query("assets")
          .withSearchIndex("search", (q) => q.search("searchText", s))
          .paginate(paginationOpts)
      : await ctx.db.query("assets").withIndex("by_created").order("desc").paginate(paginationOpts);
    // Which club a file belongs to isn't worth storing on every row; one page's worth is cheap to look up
    const clubNames = new Map<string, string | null>();
    for (const id of new Set(page.page.map((a) => a.projectId))) {
      const project = await ctx.db.get(id);
      clubNames.set(id, project?.clubId ? ((await ctx.db.get(project.clubId))?.name ?? null) : null);
    }
    return {
      ...page,
      page: page.page.map(
        (a): LibraryAsset => ({
          id: a._id,
          kind: a.kind,
          name: a.name,
          url: a.url,
          mime: a.mime,
          size: a.size,
          projectId: a.projectId,
          projectTitle: a.projectTitle,
          clubName: clubNames.get(a.projectId) ?? null,
          linkedLine: a.linkedLine,
          lineRemoved: a.lineRemoved,
          wholeProject: a.blockKey === null,
          commentText: a.commentText,
          createdAt: a.createdAt,
        }),
      ),
    };
  },
});
