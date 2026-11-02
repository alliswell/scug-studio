import { ConvexError, v } from "convex/values";
import { queueAssetSync } from "./library";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { blockFields } from "./schema";
import { reattachComments } from "./commentAnchors";
import { blockView, contentSig, deleteDocument, docBlocks, filesOf, releaseFiles, requireUser } from "./lib";

export const blocks = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    await requireUser(ctx);
    return docBlocks(ctx, documentId);
  },
});

/**
 * Applies the editor's changes: upserts by block key, deletes removed keys, frees unused files.
 *
 * Each change carries the `rev` the editor last read for that line. A line whose rev has moved on
 * belongs to someone else now, so it is handed back as a clash instead of being written over — the
 * editor keeps the local text and shows both versions. Nothing here ever discards a line's words
 * on the strength of an older read, which is exactly what the previous blind patch did.
 *
 * A line that has only MOVED is not a clash: its content signature is unchanged, so the new
 * position is applied and the rev is left alone.
 */
export const sync = mutation({
  args: {
    documentId: v.id("documents"),
    upserts: v.array(v.object({ ...blockFields, baseRev: v.optional(v.number()) })),
    deletes: v.array(v.object({ key: v.string(), baseRev: v.optional(v.number()) })),
  },
  handler: async (ctx, { documentId, upserts, deletes }) => {
    await requireUser(ctx);
    const doc = await ctx.db.get(documentId);
    if (!doc) throw new ConvexError("Document not found");
    const dropped: Id<"_storage">[] = [];
    const applied: { key: string; rev: number }[] = [];
    const clashes: { key: string; reason: "changed" | "removed"; theirs: ReturnType<typeof blockView> | null }[] = [];
    const byKey = async (key: string) =>
      ctx.db
        .query("blocks")
        .withIndex("by_document_key", (q) => q.eq("documentId", documentId).eq("key", key))
        .unique();

    for (const { baseRev, ...b } of upserts) {
      const existing = await byKey(b.key);
      if (!existing) {
        // baseRev set means the editor had read this line, so its absence is someone else's delete.
        // Re-inserting would quietly undo that, so hand it back instead.
        if (baseRev !== undefined) {
          clashes.push({ key: b.key, reason: "removed", theirs: null });
          continue;
        }
        await ctx.db.insert("blocks", { ...b, documentId, projectId: doc.projectId, rev: 1 });
        applied.push({ key: b.key, rev: 1 });
        continue;
      }
      const stored = existing.rev ?? 0;
      const onlyMoved = contentSig(existing) === contentSig(b);
      if (baseRev !== undefined && stored !== baseRev && !onlyMoved) {
        clashes.push({ key: b.key, reason: "changed", theirs: blockView(existing) });
        continue;
      }
      const kept = new Set(filesOf(b));
      for (const f of filesOf(existing)) if (!kept.has(f)) dropped.push(f);
      const rev = onlyMoved ? stored : stored + 1;
      // Fields a line can lose (back to the top level, unassigned) are cleared when they're not sent
      await ctx.db.patch(existing._id, { ...b, indent: b.indent, assignee: b.assignee, attachments: undefined, rev });
      applied.push({ key: b.key, rev });
    }
    for (const { key, baseRev } of deletes) {
      const existing = await byKey(key);
      if (!existing) continue;
      // Removing a line somebody has just rewritten would throw their work away without a word.
      if (baseRev !== undefined && (existing.rev ?? 0) !== baseRev) {
        clashes.push({ key, reason: "changed", theirs: blockView(existing) });
        continue;
      }
      dropped.push(...filesOf(existing));
      await ctx.db.delete(existing._id);
    }
    if (!applied.length && !dropped.length && clashes.length) return { applied, clashes };
    const now = Date.now();
    await ctx.db.patch(documentId, { updatedAt: now });
    await ctx.db.patch(doc.projectId, { updatedAt: now });
    await releaseFiles(ctx, doc.projectId, dropped);
    // Keep the Library's "linked line" text current for this project's files
    const hasAssets = await ctx.db
      .query("assets")
      .withIndex("by_project", (q) => q.eq("projectId", doc.projectId))
      .first();
    if (hasAssets) await queueAssetSync(ctx, doc.projectId);
    return { applied, clashes };
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return ctx.storage.generateUploadUrl();
  },
});

export const fileUrl = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    await requireUser(ctx);
    return ctx.storage.getUrl(storageId);
  },
});

/** Makes an edited (or archived) copy the main document; the current main is kept as archived. */
export const promote = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    const doc = await ctx.db.get(documentId);
    if (!doc || (doc.kind !== "edited" && doc.kind !== "archived")) throw new ConvexError("Version not found");
    const now = Date.now();
    const mains = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", doc.projectId).eq("kind", "main"))
      .collect();
    // An archived version's editorName says who replaced it
    for (const m of mains) await ctx.db.patch(m._id, { kind: "archived", editorName: user?.name || user?.email || null, updatedAt: now });
    await ctx.db.patch(documentId, { kind: "main", guestToken: null, updatedAt: now });
    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect();
    // Comments point at lines by key; move them onto the matching lines of the new version
    const newKeyFor = new Map<string, string>();
    for (const b of blocks) if (b.sourceBlockId && !newKeyFor.has(b.sourceBlockId)) newKeyFor.set(b.sourceBlockId, b.key);
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_project", (q) => q.eq("projectId", doc.projectId))
      .collect();
    for (const c of comments) {
      const next = c.blockKey ? newKeyFor.get(c.blockKey) : undefined;
      if (next && c.blockKey) await ctx.db.patch(c._id, { blockKey: next, keyHistory: [...(c.keyHistory ?? []), c.blockKey].slice(-20) });
    }
    // Comments whose line isn't in this version: bring back ones it used to have, re-attach rewritten ones
    const oldBlocks = [];
    for (const m of mains)
      oldBlocks.push(
        ...(await ctx.db
          .query("blocks")
          .withIndex("by_document", (q) => q.eq("documentId", m._id))
          .collect()),
      );
    const tasks = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", doc.projectId).eq("kind", "tasks"))
      .first();
    const taskKeys = new Set(
      tasks
        ? (
            await ctx.db
              .query("blocks")
              .withIndex("by_document", (q) => q.eq("documentId", tasks._id))
              .collect()
          ).map((b) => b.key)
        : [],
    );
    await reattachComments(
      ctx,
      doc.projectId,
      oldBlocks.map((b) => ({ key: b.key, content: b.content })),
      blocks.map((b) => ({ key: b.key, content: b.content })),
      taskKeys,
    );
    for (const b of blocks) if (b.sourceBlockId) await ctx.db.patch(b._id, { sourceBlockId: null });
    await ctx.db.patch(doc.projectId, { updatedAt: now });
  },
});

export const remove = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    await requireUser(ctx);
    const doc = await ctx.db.get(documentId);
    if (!doc || doc.kind === "main" || doc.kind === "tasks") throw new ConvexError("The project document and its task list can't be deleted");
    await deleteDocument(ctx, documentId);
  },
});
