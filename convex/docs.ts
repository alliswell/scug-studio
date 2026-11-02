import { ConvexError, v } from "convex/values";
import { queueAssetSync } from "./library";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { blockFields } from "./schema";
import { reattachComments } from "./commentAnchors";
import { blockView, contentSig, deleteDocument, docBlocks, filesOf, imagesOf, releaseFiles, requireUser } from "./lib";

export const blocks = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, { documentId }) => {
    await requireUser(ctx);
    return docBlocks(ctx, documentId);
  },
});

/**
 * Applies the editor's changes: content upserts, pure reorders, and removals.
 *
 * Each CONTENT change carries the `rev` the editor last read for that line. A line whose rev has
 * moved on belongs to someone else now, so it is handed back as a clash instead of being written
 * over. Nothing here discards a line's words on the strength of an older read.
 *
 * Reorders come in separately, as `moves`, and carry no guard at all. They must not: a line that
 * only shifted down because somebody typed above it says nothing about its words, and guarding it
 * would turn every concurrent edit elsewhere in the document into a false clash — whose "keep
 * mine" would then write stale text over the other person's work. Position is last-writer-wins by
 * design; words are not.
 */
export const sync = mutation({
  args: {
    documentId: v.id("documents"),
    upserts: v.array(v.object({ ...blockFields, baseRev: v.optional(v.number()) })),
    /** Lines whose words are unchanged and which have only shifted. Never clash. */
    moves: v.optional(v.array(v.object({ key: v.string(), position: v.number() }))),
    deletes: v.array(v.object({ key: v.string(), baseRev: v.optional(v.number()) })),
  },
  handler: async (ctx, { documentId, upserts, moves, deletes }) => {
    await requireUser(ctx);
    const doc = await ctx.db.get(documentId);
    if (!doc) throw new ConvexError("Document not found");
    // A document that is no longer the live one was swapped out under this editor (a restored
    // version, or an agent rewrite). Writing into it would bury the text in an archived snapshot.
    if (doc.kind !== "main" && doc.kind !== "tasks") throw new ConvexError("This version isn't the live document any more. Reload to carry on editing.");
    const dropped: Id<"_storage">[] = [];
    const applied: { key: string; rev: number }[] = [];
    const clashes: { key: string; reason: "changed" | "removed" | "kept"; theirs: ReturnType<typeof blockView> | null }[] = [];
    let removed = 0;
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
      if (baseRev !== undefined && stored !== baseRev && contentSig(existing) !== contentSig(b)) {
        clashes.push({ key: b.key, reason: "changed", theirs: blockView(existing) });
        continue;
      }
      // Only the pictures in an images block are the editor's to free: it never sends `attachments`
      // or a block's own embedded comments, so an upsert carries no opinion about those and must
      // not be read as "drop them". Clearing them here used to lose a file on an unrelated edit.
      const kept = new Set(filesOf(b));
      for (const f of imagesOf(existing)) if (!kept.has(f)) dropped.push(f);
      await ctx.db.patch(existing._id, { ...b, indent: b.indent, assignee: b.assignee, rev: stored + 1 });
      applied.push({ key: b.key, rev: stored + 1 });
    }
    for (const { key, position } of moves ?? []) {
      const existing = await byKey(key);
      if (!existing) continue;
      if (existing.position !== position) await ctx.db.patch(existing._id, { position });
    }
    for (const { key, baseRev } of deletes) {
      const existing = await byKey(key);
      if (!existing) continue;
      // Removing a line somebody has just rewritten would throw their work away without a word.
      // Reported as "kept", not "changed", so the editor knows the line is still there and that
      // choosing their version means putting it back rather than editing one it already has.
      if (baseRev !== undefined && (existing.rev ?? 0) !== baseRev) {
        clashes.push({ key, reason: "kept", theirs: blockView(existing) });
        continue;
      }
      dropped.push(...filesOf(existing));
      await ctx.db.delete(existing._id);
      removed++;
    }
    // Count a plain removal as work done: it has no `applied` entry and may free no files, and
    // skipping the bookkeeping below leaves the Library pointing at a line that no longer exists.
    if (!applied.length && !dropped.length && !removed && !(moves ?? []).length && clashes.length) return { applied, clashes };
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
    // sourceBlockId is part of a line's content signature, so clearing it has to move the rev too,
    // or an editor still holding the old value would write it back as if nothing had changed.
    for (const b of blocks) if (b.sourceBlockId) await ctx.db.patch(b._id, { sourceBlockId: null, rev: (b.rev ?? 0) + 1 });
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
