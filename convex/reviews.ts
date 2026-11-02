// Reviews: a set of visuals — renders, floor plans, elevations, finish boards, mockups — carried through
// numbered rounds until it's signed off. A designer posts a round (v1) holding one or more sheets; people
// pin marks to a spot or an area on a sheet and press "Request changes"; the designer posts the next round
// (v2, v3, …), which answers the request and resolves what was marked.
//
// A review keeps its own small status. It never holds the project's pipeline stage: a revised sheet must
// not walk a build-out backwards.

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib";
import { resolveAttachments, type AttachmentInput } from "./agentFiles";
import { markKind, markRect, reviewFile, reviewStatus } from "./schema";

const MAX_TEXT = 4000;
/** A plan set is a floor plan, an RCP, a furniture plan and elevations. Several, not hundreds. */
const MAX_FILES = 30;

const site = () => process.env.SITE_URL ?? "";
export const link = (id: string) => `${site()}/?view=reviews&review=${id}`;

type ReviewFile = Doc<"reviewRounds">["files"][number];
type MarkRow = Doc<"reviewMarks"> & { attachments: ReviewFile[] };

/** Positions are fractions of the sheet, so a mark stays where it was put at any zoom or paper size. */
const frac = (n: number) => Math.max(0, Math.min(1, n));

/** The id out of a bare id or one of our links. */
const tail = (s: string) => s.trim().replace(/[?#].*$/, "").split("/").filter(Boolean).pop() ?? s.trim();

const SHEET_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", heic: "image/heic", heif: "image/heif", svg: "image/svg+xml", pdf: "application/pdf",
};
const mimeFromName = (s: string | undefined) => (s ? SHEET_MIME[tail(s).split(".").pop()?.toLowerCase() ?? ""] : undefined);

// ---------- Sheets ----------

/**
 * A round holds sheets, not arbitrary files. The type is checked here rather than trusted from the
 * client, which is what sends it: anything that isn't an image or a PDF has nothing to pin a mark to.
 */
async function sheet(ctx: MutationCtx, f: ReviewFile): Promise<ReviewFile> {
  const url = f.url?.trim();
  if (!f.storageId && !url) throw new ConvexError("Each sheet needs an uploaded file or a link");
  const stored = f.storageId ? await ctx.db.system.get(f.storageId) : null;
  if (f.storageId && !stored) throw new ConvexError("That upload didn't arrive. Try again.");
  const name = f.name?.trim().slice(0, 200) || undefined;
  // Browsers and plain web servers hand back application/octet-stream often enough that it tells us
  // nothing; fall through to the file name when they do.
  const mime = [f.mime, stored?.contentType, mimeFromName(name), mimeFromName(url)]
    .map((m) => m?.split(";")[0].trim().toLowerCase())
    .find((m) => m && m !== "application/octet-stream" && m !== "binary/octet-stream");
  if (!mime) throw new ConvexError("Can't tell what that file is. Send its mime type — image/* or application/pdf.");
  if (!mime.startsWith("image/") && mime !== "application/pdf") throw new ConvexError(`A review sheet has to be an image or a PDF — ${mime} isn't one`);
  return { ...(f.storageId ? { storageId: f.storageId } : {}), ...(url ? { url: url.slice(0, 2000) } : {}), mime, ...(name ? { name } : {}) };
}

async function sheets(ctx: MutationCtx, files: ReviewFile[]) {
  if (!files.length) throw new ConvexError("A round needs at least one sheet");
  if (files.length > MAX_FILES) throw new ConvexError(`A round holds at most ${MAX_FILES} sheets`);
  const out: ReviewFile[] = [];
  for (const f of files) out.push(await sheet(ctx, f));
  return out;
}

/**
 * A mark can carry evidence — a site photo, a cutsheet, a link to a vendor page. Unlike a sheet it
 * isn't restricted to images and PDFs, so it's only trimmed here.
 */
function markFile(f: ReviewFile): ReviewFile {
  const url = f.url?.trim();
  if (!f.storageId && !url) throw new ConvexError("Each attachment needs an uploaded file or a link");
  return {
    ...(f.storageId ? { storageId: f.storageId } : {}),
    ...(url ? { url: url.slice(0, 2000) } : {}),
    ...(f.mime ? { mime: f.mime.slice(0, 100) } : {}),
    ...(f.name ? { name: f.name.trim().slice(0, 200) } : {}),
  };
}

/** Stored files get their URL at read time; a URL written onto a row goes stale. */
const fileUrls = (ctx: QueryCtx, files: ReviewFile[]) =>
  Promise.all(
    files.map(async (f) => ({
      url: f.storageId ? await ctx.storage.getUrl(f.storageId) : (f.url ?? null),
      mime: f.mime ?? null,
      name: f.name ?? null,
    })),
  );

const markFiles = (ctx: QueryCtx, files: ReviewFile[] | undefined): Promise<ReviewFile[]> =>
  Promise.all(
    (files ?? []).map(async (f) => {
      if (!f.storageId) return f;
      const url = await ctx.storage.getUrl(f.storageId);
      return { ...f, ...(url ? { url } : {}) };
    }),
  );

// ---------- Reading ----------

async function roundsOf(ctx: QueryCtx, reviewId: Id<"reviews">) {
  const rows = await ctx.db
    .query("reviewRounds")
    .withIndex("by_review", (q) => q.eq("reviewId", reviewId))
    .collect();
  return Promise.all(
    rows.map(async (r) => ({
      _id: r._id,
      number: r.number,
      note: r.note,
      by: r.by,
      agent: r.agent,
      createdAt: r.createdAt,
      files: await fileUrls(ctx, r.files),
    })),
  );
}

const down = (m: Doc<"reviewMarks">) => m.y ?? m.rects?.[0]?.y ?? 0;
const across = (m: Doc<"reviewMarks">) => m.x ?? m.rects?.[0]?.x ?? 0;

/**
 * A sheet has no timeline, so marks read the way an eye crosses a drawing: round, then sheet, then
 * page, then down and across it.
 */
async function marksOf(ctx: QueryCtx, reviewId: Id<"reviews">): Promise<MarkRow[]> {
  const rows = await ctx.db
    .query("reviewMarks")
    .withIndex("by_review", (q) => q.eq("reviewId", reviewId))
    .collect();
  const out = await Promise.all(rows.map(async (m) => ({ ...m, attachments: await markFiles(ctx, m.attachments) })));
  return out.sort(
    (a, b) =>
      a.roundNumber - b.roundNumber ||
      a.fileIndex - b.fileIndex ||
      (a.page ?? 1) - (b.page ?? 1) ||
      down(a) - down(b) ||
      across(a) - across(b) ||
      a.createdAt - b.createdAt,
  );
}

/** The marks still open on the round that's on the table. Those are the ones anyone has to act on. */
const openOnLatest = async (ctx: QueryCtx, r: Doc<"reviews">) =>
  (
    await ctx.db
      .query("reviewMarks")
      .withIndex("by_review", (q) => q.eq("reviewId", r._id).eq("roundNumber", r.roundCount))
      .collect()
  ).filter((m) => !m.resolved);

async function scopedRows(ctx: QueryCtx, projectId: Id<"projects"> | null, clubId: Id<"clubs"> | null) {
  const rows = projectId
    ? await ctx.db.query("reviews").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()
    : clubId
      ? await ctx.db.query("reviews").withIndex("by_club", (q) => q.eq("clubId", clubId)).collect()
      : await ctx.db.query("reviews").withIndex("by_updated").order("desc").collect();
  // by_project and by_club aren't ordered by activity, so settle the order here.
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------- The app ----------

export const list = query({
  args: {
    projectId: v.optional(v.union(v.id("projects"), v.null())),
    clubId: v.optional(v.union(v.id("clubs"), v.null())),
  },
  handler: async (ctx, { projectId, clubId }) => {
    await requireUser(ctx);
    const rows = await scopedRows(ctx, projectId ?? null, clubId ?? null);
    return Promise.all(
      rows.map(async (r) => {
        const latest = await ctx.db
          .query("reviewRounds")
          .withIndex("by_review", (q) => q.eq("reviewId", r._id).eq("number", r.roundCount))
          .unique();
        const first = latest?.files[0];
        const project = r.projectId ? await ctx.db.get(r.projectId) : null;
        const club = r.clubId ? await ctx.db.get(r.clubId) : null;
        return {
          ...r,
          thumbUrl: first ? (first.storageId ? await ctx.storage.getUrl(first.storageId) : (first.url ?? null)) : null,
          fileCount: latest?.files.length ?? 0,
          openMarks: (await openOnLatest(ctx, r)).length,
          projectTitle: project?.title ?? null,
          clubName: club?.name ?? null,
        };
      }),
    );
  },
});

export const get = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const rid = ctx.db.normalizeId("reviews", id);
    const r = rid ? await ctx.db.get(rid) : null;
    if (!r) return null;
    const project = r.projectId ? await ctx.db.get(r.projectId) : null;
    const club = r.clubId ? await ctx.db.get(r.clubId) : null;
    return {
      review: r,
      project: project ? { id: project._id, title: project.title, type: project.type } : null,
      club: club ? { id: club._id, name: club.name } : null,
      rounds: await roundsOf(ctx, r._id),
      marks: await marksOf(ctx, r._id),
    };
  },
});

async function me(ctx: MutationCtx) {
  const userId = await requireUser(ctx);
  const user = await ctx.db.get(userId);
  return { userId, name: user?.name || user?.email?.split("@")[0] || null };
}

async function mustGet(ctx: QueryCtx, id: Id<"reviews">) {
  const r = await ctx.db.get(id);
  if (!r) throw new ConvexError("This review was deleted");
  return r;
}

async function drop(ctx: MutationCtx, storageId: Id<"_storage">) {
  try {
    await ctx.storage.delete(storageId);
  } catch {
    // already gone
  }
}

/** A review carries its club as well as its project, so a club page lists its reviews without reading every project. */
async function placeOf(ctx: MutationCtx, projectId: Id<"projects"> | null | undefined, clubId: Id<"clubs"> | null | undefined) {
  const project = projectId ? await ctx.db.get(projectId) : null;
  if (projectId && !project) throw new ConvexError("That project is gone");
  return { projectId: projectId ?? null, clubId: clubId !== undefined ? clubId : (project?.clubId ?? null) };
}

/**
 * The one place a round is minted. The number comes from the parent's roundCount, so the counter
 * can't drift however a round arrives — the app, an agent, or a first round at create time.
 *
 * It sets the REVIEW's status and nothing else. It must never read or write a project's stage:
 * posting a revised sheet would otherwise walk a whole build-out backwards.
 */
async function insertRound(ctx: MutationCtx, r: Doc<"reviews">, files: ReviewFile[], note: string, by: string | null, agent: boolean) {
  const number = r.roundCount + 1;
  const now = Date.now();
  await ctx.db.insert("reviewRounds", { reviewId: r._id, number, files, note: note.slice(0, MAX_TEXT), by, agent, createdAt: now });
  // A new round is the answer to any request for changes.
  await ctx.db.patch(r._id, { roundCount: number, status: "inReview", changesRequestedAt: null, changesRequestNote: "", updatedAt: now });
  return number;
}

async function newReview(
  ctx: MutationCtx,
  a: { title: string; projectId?: Id<"projects"> | null; clubId?: Id<"clubs"> | null; files: ReviewFile[]; note: string; by: string | null; agent: boolean },
) {
  const now = Date.now();
  const place = await placeOf(ctx, a.projectId, a.clubId);
  const id = await ctx.db.insert("reviews", {
    title: a.title.trim().slice(0, 300) || "Untitled review",
    projectId: place.projectId,
    clubId: place.clubId,
    status: "inReview",
    roundCount: 0,
    createdBy: a.by,
    createdAt: now,
    updatedAt: now,
  });
  await insertRound(ctx, (await ctx.db.get(id))!, a.files, a.note, a.by, a.agent);
  return id;
}

/** A new round answers what was marked on the one before it. */
async function nextRound(
  ctx: MutationCtx,
  r: Doc<"reviews">,
  files: ReviewFile[],
  note: string,
  by: string | null,
  agent: boolean,
  resolveMarks?: boolean,
) {
  const number = await insertRound(ctx, r, files, note, by, agent);
  if (resolveMarks !== false)
    for (const m of await ctx.db
      .query("reviewMarks")
      .withIndex("by_review", (q) => q.eq("reviewId", r._id).eq("roundNumber", number - 1))
      .collect())
      // Stamped with the round that answered it, so an auto-resolve can be audited and undone.
      if (!m.resolved) await ctx.db.patch(m._id, { resolved: true, resolvedByRound: number });
  return number;
}

export const create = mutation({
  args: {
    title: v.string(),
    projectId: v.optional(v.union(v.id("projects"), v.null())),
    clubId: v.optional(v.union(v.id("clubs"), v.null())),
    files: v.array(reviewFile),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { title, projectId, clubId, files, note }) => {
    const { name } = await me(ctx);
    return newReview(ctx, { title, projectId, clubId, files: await sheets(ctx, files), note: note ?? "", by: name, agent: false });
  },
});

export const addRound = mutation({
  args: { id: v.id("reviews"), files: v.array(reviewFile), note: v.optional(v.string()), resolveMarks: v.optional(v.boolean()) },
  handler: async (ctx, { id, files, note, resolveMarks }) => {
    const { name } = await me(ctx);
    return nextRound(ctx, await mustGet(ctx, id), await sheets(ctx, files), note ?? "", name, false, resolveMarks);
  },
});

export const update = mutation({
  args: {
    id: v.id("reviews"),
    title: v.optional(v.string()),
    status: v.optional(reviewStatus),
    notes: v.optional(v.string()),
    projectId: v.optional(v.union(v.id("projects"), v.null())),
    clubId: v.optional(v.union(v.id("clubs"), v.null())),
  },
  handler: async (ctx, { id, title, status, notes, projectId, clubId }) => {
    await requireUser(ctx);
    const r = await mustGet(ctx, id);
    const patch: Partial<Doc<"reviews">> = { updatedAt: Date.now() };
    if (title !== undefined) patch.title = title.trim().slice(0, 300) || "Untitled review";
    if (notes !== undefined) patch.notes = notes.slice(0, MAX_TEXT);
    if (status) {
      patch.status = status;
      // Only a move into or out of the archive touches archivedAt. Clearing it on every status
      // change, as this used to, threw away the date the moment anything else was edited.
      if (status === "archived") patch.archivedAt = Date.now();
      else if (r.status === "archived") patch.archivedAt = null;
    }
    if (projectId !== undefined || clubId !== undefined) {
      const place = await placeOf(ctx, projectId !== undefined ? projectId : r.projectId, clubId);
      patch.projectId = place.projectId;
      patch.clubId = place.clubId;
    }
    await ctx.db.patch(id, patch);
  },
});

/** "Request changes": the marks on the latest round are ready for the designer to work from. */
export const requestChanges = mutation({
  args: { id: v.id("reviews"), note: v.optional(v.string()) },
  handler: async (ctx, { id, note }) => {
    await requireUser(ctx);
    await mustGet(ctx, id);
    await ctx.db.patch(id, {
      status: "changesRequested",
      changesRequestedAt: Date.now(),
      changesRequestNote: (note ?? "").slice(0, MAX_TEXT),
      updatedAt: Date.now(),
    });
  },
});

export const cancelChanges = mutation({
  args: { id: v.id("reviews") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const r = await mustGet(ctx, id);
    await ctx.db.patch(id, {
      changesRequestedAt: null,
      changesRequestNote: "",
      ...(r.status === "changesRequested" ? { status: "inReview" as const } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const approve = mutation({
  args: { id: v.id("reviews") },
  handler: async (ctx, { id }) => {
    const { name } = await me(ctx);
    await mustGet(ctx, id);
    const now = Date.now();
    await ctx.db.patch(id, { status: "approved", approvedAt: now, approvedBy: name, changesRequestedAt: null, changesRequestNote: "", updatedAt: now });
  },
});

export const remove = mutation({
  args: { id: v.id("reviews") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    for (const r of await ctx.db.query("reviewRounds").withIndex("by_review", (q) => q.eq("reviewId", id)).collect()) {
      for (const f of r.files) if (f.storageId) await drop(ctx, f.storageId);
      await ctx.db.delete(r._id);
    }
    // Files attached to a mark are stored blobs too. Deleting only the sheets leaked every one of them.
    for (const m of await ctx.db.query("reviewMarks").withIndex("by_review", (q) => q.eq("reviewId", id)).collect()) {
      for (const f of m.attachments ?? []) if (f.storageId) await drop(ctx, f.storageId);
      await ctx.db.delete(m._id);
    }
    await ctx.db.delete(id);
  },
});

// ---------- Marks ----------

type MarkInput = {
  id: Id<"reviews">;
  roundNumber: number;
  fileIndex: number;
  page?: number;
  x?: number | null;
  y?: number | null;
  rects?: { x: number; y: number; w: number; h: number }[];
  quote?: string;
  markKind?: Doc<"reviewMarks">["markKind"];
  text: string;
  attachments?: ReviewFile[];
};

async function insertMark(ctx: MutationCtx, a: MarkInput, author: { id: Id<"users"> | null; name: string | null; agent: boolean }) {
  const r = await mustGet(ctx, a.id);
  if (!r.roundCount) throw new ConvexError("This review has no rounds yet");
  const roundNumber = Math.min(Math.max(1, Math.round(a.roundNumber)), r.roundCount);
  const round = await ctx.db
    .query("reviewRounds")
    .withIndex("by_review", (q) => q.eq("reviewId", r._id).eq("number", roundNumber))
    .unique();
  if (!round) throw new ConvexError(`This review has no round v${roundNumber}`);
  const fileIndex = Math.round(a.fileIndex);
  if (fileIndex < 0 || fileIndex >= round.files.length)
    throw new ConvexError(`v${roundNumber} holds ${round.files.length} sheet(s); there is no sheet ${fileIndex + 1}`);
  const text = a.text.trim();
  if (!text && !a.attachments?.length) throw new ConvexError("Write something first");
  if ((a.rects?.length ?? 0) > 200) throw new ConvexError("Too many boxes on one mark");
  const now = Date.now();
  const id = await ctx.db.insert("reviewMarks", {
    reviewId: r._id,
    roundNumber,
    fileIndex,
    ...(a.page !== undefined ? { page: Math.max(1, Math.round(a.page)) } : {}),
    ...(a.x !== undefined && a.x !== null ? { x: frac(a.x) } : {}),
    ...(a.y !== undefined && a.y !== null ? { y: frac(a.y) } : {}),
    ...(a.rects?.length ? { rects: a.rects.map((q) => ({ x: frac(q.x), y: frac(q.y), w: frac(q.w), h: frac(q.h) })) } : {}),
    ...(a.quote ? { quote: a.quote.slice(0, 5000) } : {}),
    ...(a.markKind ? { markKind: a.markKind } : {}),
    text: text.slice(0, MAX_TEXT),
    ...(a.attachments?.length ? { attachments: a.attachments.slice(0, 20).map(markFile) } : {}),
    authorName: author.name,
    authorId: author.id,
    agent: author.agent,
    createdAt: now,
  });
  await ctx.db.patch(r._id, { updatedAt: now });
  return { id, round: roundNumber };
}

export const addMark = mutation({
  args: {
    id: v.id("reviews"),
    roundNumber: v.number(),
    fileIndex: v.number(),
    page: v.optional(v.number()),
    x: v.optional(v.union(v.number(), v.null())),
    y: v.optional(v.union(v.number(), v.null())),
    rects: v.optional(v.array(markRect)),
    quote: v.optional(v.string()),
    markKind: v.optional(markKind),
    text: v.string(),
    attachments: v.optional(v.array(reviewFile)),
  },
  handler: async (ctx, a) => {
    const { userId, name } = await me(ctx);
    return (await insertMark(ctx, a, { id: userId, name, agent: false })).id;
  },
});

export const updateMark = mutation({
  args: { markId: v.id("reviewMarks"), text: v.optional(v.string()), resolved: v.optional(v.boolean()), markKind: v.optional(markKind) },
  handler: async (ctx, { markId, text, resolved, markKind: kind }) => {
    const userId = await requireUser(ctx);
    const m = await ctx.db.get(markId);
    if (!m) return;
    if (text !== undefined && m.authorId !== userId) throw new ConvexError("Only the author can change this mark");
    await ctx.db.patch(markId, {
      ...(text !== undefined ? { text: text.slice(0, MAX_TEXT) } : {}),
      ...(kind ? { markKind: kind } : {}),
      // resolvedByRound records which round answered it; resolving or re-opening by hand is neither.
      ...(resolved !== undefined ? { resolved, resolvedByRound: null } : {}),
    });
    await ctx.db.patch(m.reviewId, { updatedAt: Date.now() });
  },
});

export const removeMark = mutation({
  args: { markId: v.id("reviewMarks") },
  handler: async (ctx, { markId }) => {
    await requireUser(ctx);
    const m = await ctx.db.get(markId);
    if (!m) return;
    for (const f of m.attachments ?? []) if (f.storageId) await drop(ctx, f.storageId);
    await ctx.db.delete(markId);
    await ctx.db.patch(m.reviewId, { updatedAt: Date.now() });
  },
});

// ---------- For agents (see mcp.ts / agent.ts) ----------

/**
 * A review by id, by one of its links, or by title. A title that matches more than one review throws
 * and lists them: the old fuzzy substring match silently picked the first hit, so asking for "Ponce"
 * could mark up the wrong set. Pass projectId or clubId to narrow the field first.
 */
export async function resolveReview(ctx: QueryCtx, ref: string, scope?: { projectId?: Id<"projects"> | null; clubId?: Id<"clubs"> | null }) {
  const s = ref.trim();
  if (!s) throw new ConvexError("Which review? Pass its id, its link, or its title.");
  const fromLink = s.match(/[?&]review=([\w-]+)/)?.[1] ?? tail(s);
  const id = ctx.db.normalizeId("reviews", fromLink);
  const byId = id ? await ctx.db.get(id) : null;
  if (byId) return byId;

  const rows = await scopedRows(ctx, scope?.projectId ?? null, scope?.clubId ?? null);
  const q = s.toLowerCase();
  const exact = rows.filter((r) => r.title.toLowerCase() === q);
  const hits = exact.length ? exact : rows.filter((r) => r.title.toLowerCase().includes(q));
  if (!hits.length) throw new ConvexError(`No review matches "${s}". Use list_reviews for ids.`);
  if (hits.length > 1)
    throw new ConvexError(`"${s}" matches ${hits.length} reviews — say which one: ${hits.slice(0, 10).map((r) => `${r.title} (${r._id})`).join(", ")}`);
  return hits[0];
}

function projectRef(ctx: QueryCtx, ref: string) {
  const id = ctx.db.normalizeId("projects", tail(ref));
  if (!id) throw new ConvexError(`Not a project id: ${ref}. Use list_projects for ids.`);
  return id;
}

function clubRef(ctx: QueryCtx, ref: string) {
  const id = ctx.db.normalizeId("clubs", tail(ref));
  if (!id) throw new ConvexError(`Not a club id: ${ref}. Use list_clubs for ids.`);
  return id;
}

export const listForAgent = internalQuery({
  args: {
    status: v.optional(reviewStatus),
    changesRequested: v.optional(v.boolean()),
    project: v.optional(v.string()),
    club: v.optional(v.string()),
  },
  handler: async (ctx, { status, changesRequested, project, club }) => {
    const rows = await scopedRows(ctx, project ? projectRef(ctx, project) : null, club ? clubRef(ctx, club) : null);
    const out = [];
    for (const r of rows) {
      if (status ? r.status !== status : r.status === "archived") continue;
      if (changesRequested !== undefined && !!r.changesRequestedAt !== changesRequested) continue;
      out.push({
        id: r._id,
        title: r.title,
        status: r.status,
        round: r.roundCount,
        changesRequested: !!r.changesRequestedAt,
        changesRequestedAt: r.changesRequestedAt ? new Date(r.changesRequestedAt).toISOString() : null,
        openMarksOnLatest: (await openOnLatest(ctx, r)).length,
        updatedAt: new Date(r.updatedAt).toISOString(),
        link: link(r._id),
      });
    }
    return out;
  },
});

/** Where a mark sits, in words, because an agent has no canvas to look at. */
function where(m: MarkRow) {
  const sheet = `v${m.roundNumber} sheet ${m.fileIndex + 1}`;
  const page = m.page && m.page > 1 ? ` page ${m.page}` : "";
  if (m.x !== undefined && m.x !== null && m.y !== undefined && m.y !== null)
    return `${sheet}${page}, ${Math.round(m.x * 100)}% across and ${Math.round(m.y * 100)}% down`;
  if (m.rects?.length) return `${sheet}${page}, an area starting ${Math.round(m.rects[0].x * 100)}% across and ${Math.round(m.rects[0].y * 100)}% down`;
  return `${sheet}${page}`;
}

export const getForAgent = internalQuery({
  args: { review: v.string() },
  handler: async (ctx, { review }) => {
    const r = await resolveReview(ctx, review);
    const project = r.projectId ? await ctx.db.get(r.projectId) : null;
    const club = r.clubId ? await ctx.db.get(r.clubId) : null;
    const marks = await marksOf(ctx, r._id);
    const say = (m: MarkRow) => ({
      id: m._id,
      where: where(m),
      kind: m.markKind ?? "note",
      quote: m.quote ?? null,
      text: m.text,
      by: m.authorName,
      agent: m.agent,
      attachments: m.attachments,
    });
    return {
      id: r._id,
      title: r.title,
      status: r.status,
      round: r.roundCount,
      link: link(r._id),
      project: project ? { id: project._id, title: project.title, type: project.type } : null,
      club: club ? { id: club._id, name: club.name } : null,
      changesRequested: !!r.changesRequestedAt,
      changesRequestNote: r.changesRequestNote || null,
      notes: r.notes || null,
      approved: r.approvedAt ? { at: new Date(r.approvedAt).toISOString(), by: r.approvedBy ?? null } : null,
      rounds: (await roundsOf(ctx, r._id)).map((x) => ({
        round: x.number,
        files: x.files,
        note: x.note,
        by: x.by,
        agent: x.agent,
        createdAt: new Date(x.createdAt).toISOString(),
      })),
      // What to change: the open marks on the latest round, in reading order down each sheet
      toDo: marks.filter((m) => m.roundNumber === r.roundCount && !m.resolved).map(say),
      marks: marks.map((m) => ({
        ...say(m),
        round: m.roundNumber,
        resolved: !!m.resolved,
        resolvedByRound: m.resolvedByRound ?? null,
        createdAt: new Date(m.createdAt).toISOString(),
      })),
      archived: r.status === "archived" ? { at: r.archivedAt ? new Date(r.archivedAt).toISOString() : null, why: "See the marks: they say why this set was dropped." } : null,
    };
  },
});

/** What an agent sends for a sheet or an attachment: a link, an upload, or the bytes inline. */
const fileInput = v.object({
  url: v.optional(v.string()),
  base64: v.optional(v.string()),
  storageId: v.optional(v.string()),
  name: v.optional(v.string()),
  mime: v.optional(v.string()),
});

/** Stores whatever an agent sent and hands back rows a mutation can write. */
async function agentFiles(ctx: ActionCtx, files: AttachmentInput[] | undefined): Promise<ReviewFile[]> {
  const resolved = await resolveAttachments(ctx, files ?? []);
  return resolved.map((f) => ({
    ...(f.storageId ? { storageId: f.storageId } : {}),
    ...(f.url ? { url: f.url } : {}),
    ...(f.mime ? { mime: f.mime } : {}),
    ...(f.name ? { name: f.name } : {}),
  }));
}

export const writeForAgent = internalMutation({
  args: {
    title: v.string(),
    files: v.array(reviewFile),
    note: v.optional(v.string()),
    project: v.optional(v.string()),
    club: v.optional(v.string()),
    agentName: v.optional(v.string()),
  },
  handler: async (ctx, { title, files, note, project, club, agentName }) => {
    const by = agentName?.trim().slice(0, 80) || "Agent";
    const id = await newReview(ctx, {
      title,
      projectId: project ? projectRef(ctx, project) : null,
      ...(club ? { clubId: clubRef(ctx, club) } : {}),
      files: await sheets(ctx, files),
      note: note ?? "",
      by,
      agent: true,
    });
    return { id, round: 1, link: link(id) };
  },
});

export const createForAgent = internalAction({
  args: {
    title: v.string(),
    files: v.array(fileInput),
    note: v.optional(v.string()),
    project: v.optional(v.string()),
    club: v.optional(v.string()),
    agentName: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ id: Id<"reviews">; round: number; link: string }> =>
    ctx.runMutation(internal.reviews.writeForAgent, { ...a, files: await agentFiles(ctx, a.files) }),
});

export const roundWriteForAgent = internalMutation({
  args: {
    review: v.string(),
    files: v.array(reviewFile),
    note: v.optional(v.string()),
    agentName: v.optional(v.string()),
    resolveMarks: v.optional(v.boolean()),
  },
  handler: async (ctx, { review, files, note, agentName, resolveMarks }) => {
    const r = await resolveReview(ctx, review);
    const round = await nextRound(ctx, r, await sheets(ctx, files), note ?? "", agentName?.trim().slice(0, 80) || "Agent", true, resolveMarks);
    return { id: r._id, round, link: link(r._id) };
  },
});

export const addRoundForAgent = internalAction({
  args: {
    review: v.string(),
    files: v.array(fileInput),
    note: v.optional(v.string()),
    agentName: v.optional(v.string()),
    resolveMarks: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<{ id: Id<"reviews">; round: number; link: string }> =>
    ctx.runMutation(internal.reviews.roundWriteForAgent, { ...a, files: await agentFiles(ctx, a.files) }),
});

export const markWriteForAgent = internalMutation({
  args: {
    review: v.string(),
    text: v.string(),
    roundNumber: v.optional(v.number()),
    fileIndex: v.optional(v.number()),
    page: v.optional(v.number()),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    rects: v.optional(v.array(markRect)),
    quote: v.optional(v.string()),
    markKind: v.optional(markKind),
    agentName: v.optional(v.string()),
    attachments: v.optional(v.array(reviewFile)),
  },
  handler: async (ctx, a) => {
    const r = await resolveReview(ctx, a.review);
    const { id, round } = await insertMark(
      ctx,
      {
        id: r._id,
        roundNumber: a.roundNumber ?? r.roundCount,
        fileIndex: a.fileIndex ?? 0,
        page: a.page,
        x: a.x,
        y: a.y,
        rects: a.rects,
        quote: a.quote,
        markKind: a.markKind,
        text: a.text,
        attachments: a.attachments,
      },
      { id: null, name: a.agentName?.trim().slice(0, 80) || "Agent", agent: true },
    );
    return { id, round, link: link(r._id) };
  },
});

export const markForAgent = internalAction({
  args: {
    review: v.string(),
    text: v.string(),
    roundNumber: v.optional(v.number()),
    fileIndex: v.optional(v.number()),
    page: v.optional(v.number()),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    rects: v.optional(v.array(markRect)),
    quote: v.optional(v.string()),
    markKind: v.optional(markKind),
    agentName: v.optional(v.string()),
    attachments: v.optional(v.array(fileInput)),
  },
  handler: async (ctx, a): Promise<{ id: Id<"reviewMarks">; round: number; link: string }> =>
    ctx.runMutation(internal.reviews.markWriteForAgent, { ...a, attachments: await agentFiles(ctx, a.attachments) }),
});

export const setStatusForAgent = internalMutation({
  args: { review: v.string(), status: reviewStatus, note: v.optional(v.string()), agentName: v.optional(v.string()) },
  handler: async (ctx, { review, status, note, agentName }) => {
    const r = await resolveReview(ctx, review);
    const now = Date.now();
    const patch: Partial<Doc<"reviews">> = { status, updatedAt: now };
    if (status === "archived") patch.archivedAt = now;
    else if (r.status === "archived") patch.archivedAt = null;
    if (status === "changesRequested") {
      patch.changesRequestedAt = now;
      patch.changesRequestNote = (note ?? "").slice(0, MAX_TEXT);
    }
    if (status === "approved") {
      patch.approvedAt = now;
      patch.approvedBy = agentName?.trim().slice(0, 80) || "Agent";
      patch.changesRequestedAt = null;
      patch.changesRequestNote = "";
    }
    await ctx.db.patch(r._id, patch);
    return { id: r._id, status, link: link(r._id) };
  },
});
