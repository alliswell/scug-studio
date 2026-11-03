// Clubs: the neighborhood locations the studio designs and builds. A club is first class — it has a
// page listing its projects and its reviews — so everything else hangs off it rather than the other way round.

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib";
import { lastStage } from "./projects";
import { clubStatus } from "./schema";

const MAX_NOTES = 20000;

/** Blank clears the field rather than storing an empty string, so "unset" reads the same everywhere. */
const trimmed = (s: string | undefined, max: number) => (s === undefined ? undefined : s.trim().slice(0, max) || undefined);

function checkDate(d: string | null | undefined) {
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new ConvexError("The open date must be YYYY-MM-DD");
}

function checkCount(n: number | null | undefined, what: string) {
  if (n !== undefined && n !== null && (!Number.isFinite(n) || n < 0)) throw new ConvexError(`${what} can't be negative`);
}

async function projectsOf(ctx: QueryCtx, clubId: Id<"clubs">) {
  return ctx.db
    .query("projects")
    .withIndex("by_club", (q) => q.eq("clubId", clubId))
    .collect();
}

const placementsOf = (ctx: QueryCtx, clubId: Id<"clubs">) =>
  ctx.db
    .query("ffePlacements")
    .withIndex("by_club", (q) => q.eq("clubId", clubId))
    .collect();

/** Hand-ordered first, in the order someone dragged them; everything else after, by name. */
const byOrderThenName = (a: Doc<"clubs">, b: Doc<"clubs">) => {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  return ao === bo ? a.name.localeCompare(b.name) : ao - bo;
};

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    // by_name first, so clubs that share an order (or have none) stay in name order after the sort
    const clubs = (await ctx.db.query("clubs").withIndex("by_name").collect()).sort(byOrderThenName);
    return Promise.all(
      clubs.map(async (club) => {
        // Journal entries and the Todo list are never a club's work
        const projects = (await projectsOf(ctx, club._id)).filter((p) => !p.kind);
        return {
          ...club,
          projectCount: projects.length,
          activeCount: projects.filter((p) => p.stage !== lastStage(p.type)).length,
        };
      }),
    );
  },
});

/** The latest round's first sheet, resolved now — a stored URL goes stale, a storage id doesn't. */
async function thumbOf(ctx: QueryCtx, reviewId: Id<"reviews">) {
  const round = await ctx.db
    .query("reviewRounds")
    .withIndex("by_review", (q) => q.eq("reviewId", reviewId))
    .order("desc")
    .first();
  const sheet = round?.files[0];
  if (!sheet) return null;
  return sheet.storageId ? await ctx.storage.getUrl(sheet.storageId) : (sheet.url ?? null);
}

export const get = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const clubId = ctx.db.normalizeId("clubs", id);
    if (!clubId) return null;
    const club = await ctx.db.get(clubId);
    if (!club) return null;

    const projects = (await projectsOf(ctx, clubId))
      .filter((p) => !p.kind)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({
        id: p._id,
        title: p.title,
        type: p.type,
        stage: p.stage,
        targetDate: p.targetDate,
        pinnedAt: p.pinnedAt ?? null,
        updatedAt: p.updatedAt,
      }));

    const titles = new Map(projects.map((p) => [p.id as string, p.title]));
    const reviewRows = await ctx.db
      .query("reviews")
      .withIndex("by_club", (q) => q.eq("clubId", clubId))
      .collect();
    const reviews = await Promise.all(
      reviewRows
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(async (r) => {
          const marks = await ctx.db
            .query("reviewMarks")
            .withIndex("by_review", (q) => q.eq("reviewId", r._id))
            .collect();
          return {
            id: r._id,
            title: r.title,
            status: r.status,
            roundCount: r.roundCount,
            openMarks: marks.filter((m) => !m.resolved).length,
            projectId: r.projectId ?? null,
            projectTitle: r.projectId ? (titles.get(r.projectId) ?? null) : null,
            thumbUrl: await thumbOf(ctx, r._id),
            updatedAt: r.updatedAt,
          };
        }),
    );

    return { club, projects, reviews };
  },
});

const fields = {
  name: v.optional(v.string()),
  neighborhood: v.optional(v.string()),
  city: v.optional(v.string()),
  address: v.optional(v.string()),
  status: v.optional(clubStatus),
  openedAt: v.optional(v.union(v.string(), v.null())),
  squareFeet: v.optional(v.union(v.number(), v.null())),
  seats: v.optional(v.union(v.number(), v.null())),
  notes: v.optional(v.string()),
};

type ClubFields = {
  name?: string;
  neighborhood?: string;
  city?: string;
  address?: string;
  status?: Doc<"clubs">["status"];
  openedAt?: string | null;
  squareFeet?: number | null;
  seats?: number | null;
  notes?: string;
};

/** Everything create and update share: the same checks, the same trimming. */
function clubPatch(f: ClubFields) {
  checkDate(f.openedAt);
  checkCount(f.squareFeet, "Square feet");
  checkCount(f.seats, "Seats");
  const patch: Partial<Doc<"clubs">> = {};
  if (f.name !== undefined) {
    const name = f.name.trim().slice(0, 120);
    if (!name) throw new ConvexError("Give the club a name");
    patch.name = name;
  }
  if (f.neighborhood !== undefined) patch.neighborhood = trimmed(f.neighborhood, 120);
  if (f.city !== undefined) patch.city = trimmed(f.city, 120);
  if (f.address !== undefined) patch.address = trimmed(f.address, 300);
  if (f.status !== undefined) patch.status = f.status;
  if (f.openedAt !== undefined) patch.openedAt = f.openedAt || null;
  if (f.squareFeet !== undefined) patch.squareFeet = f.squareFeet === null ? null : Math.round(f.squareFeet);
  if (f.seats !== undefined) patch.seats = f.seats === null ? null : Math.round(f.seats);
  if (f.notes !== undefined) patch.notes = f.notes.slice(0, MAX_NOTES);
  return patch;
}

async function insertClub(ctx: MutationCtx, f: ClubFields, createdBy: Id<"users"> | null) {
  const patch = clubPatch(f);
  if (!patch.name) throw new ConvexError("Give the club a name");
  const now = Date.now();
  return ctx.db.insert("clubs", {
    ...patch,
    name: patch.name,
    status: patch.status ?? "prospect",
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
}

export const create = mutation({
  args: { ...fields, name: v.string() },
  handler: async (ctx, args) => insertClub(ctx, args, await requireUser(ctx)),
});

export const update = mutation({
  args: { id: v.id("clubs"), ...fields },
  handler: async (ctx, { id, ...f }) => {
    await requireUser(ctx);
    if (!(await ctx.db.get(id))) throw new ConvexError("Club not found");
    await ctx.db.patch(id, { ...clubPatch(f), updatedAt: Date.now() });
  },
});

/** The club's photo: an upload (storageId) or a link (url). Passing null for both clears it. */
export const setCover = mutation({
  args: { id: v.id("clubs"), storageId: v.optional(v.union(v.id("_storage"), v.null())), url: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { id, storageId, url }) => {
    await requireUser(ctx);
    const club = await ctx.db.get(id);
    if (!club) throw new ConvexError("Club not found");
    if (url && !/^https?:\/\//i.test(url)) throw new ConvexError("The link must start with http:// or https://");
    const next = storageId !== undefined ? storageId : (club.coverStorageId ?? null);
    const coverUrl =
      storageId !== undefined ? (storageId ? await ctx.storage.getUrl(storageId) : null) : url !== undefined ? url : (club.coverUrl ?? null);
    // Replacing or clearing an uploaded photo leaves its blob behind otherwise
    if (club.coverStorageId && club.coverStorageId !== next) await ctx.storage.delete(club.coverStorageId).catch(() => {});
    await ctx.db.patch(id, { coverStorageId: next, coverUrl, updatedAt: Date.now() });
  },
});

export const reorder = mutation({
  args: { ids: v.array(v.id("clubs")) },
  handler: async (ctx, { ids }) => {
    await requireUser(ctx);
    if (ids.length > 500) throw new ConvexError("Too many clubs");
    for (const [i, id] of ids.entries()) {
      const club = await ctx.db.get(id);
      if (club && club.order !== i) await ctx.db.patch(id, { order: i });
    }
  },
});

/**
 * Deleting a club with work on it would leave those projects pointing at nothing, and a project
 * quietly detached from its location is worse than a refused delete. Move them first.
 *
 * Its FF&E is the same argument: the club owns what is in it, so the furniture has to be dealt
 * with by hand rather than vanishing with the row.
 */
export const remove = mutation({
  args: { id: v.id("clubs") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const club = await ctx.db.get(id);
    if (!club) return;
    const projects = await projectsOf(ctx, id);
    if (projects.length) {
      const names = projects.slice(0, 5).map((p) => p.title || "Untitled");
      const more = projects.length > names.length ? `, and ${projects.length - names.length} more` : "";
      throw new ConvexError(`${club.name} still has ${projects.length} project${projects.length === 1 ? "" : "s"}: ${names.join(", ")}${more}. Move or delete them first.`);
    }
    const placements = await placementsOf(ctx, id);
    if (placements.length) {
      const products = [...new Set(await Promise.all(placements.map(async (p) => (await ctx.db.get(p.productId))?.name ?? "a product")))].sort();
      const shown = products.slice(0, 5);
      const more = products.length > shown.length ? `, and ${products.length - shown.length} more` : "";
      throw new ConvexError(
        `${club.name} still has ${placements.length} FF&E placement${placements.length === 1 ? "" : "s"}: ${shown.join(", ")}${more}. Remove them first.`,
      );
    }
    if (club.coverStorageId) await ctx.storage.delete(club.coverStorageId).catch(() => {});
    await ctx.db.delete(id);
  },
});

// ---------- Agents ----------

/**
 * A club from an id or from its name: an exact match first (ignoring case), then a single
 * substring match. Ambiguity is reported rather than guessed at, because an agent writing to
 * the wrong club is silent and expensive.
 */
export async function resolveClub(ctx: QueryCtx, ref: string): Promise<Doc<"clubs">> {
  const text = ref.trim();
  if (!text) throw new ConvexError("Name a club");
  const id = ctx.db.normalizeId("clubs", text);
  if (id) {
    const byId = await ctx.db.get(id);
    if (byId) return byId;
  }
  const needle = text.toLowerCase();
  const clubs = await ctx.db.query("clubs").collect();
  const exact = clubs.filter((c) => c.name.toLowerCase() === needle);
  const hits = exact.length ? exact : clubs.filter((c) => c.name.toLowerCase().includes(needle));
  if (!hits.length) throw new ConvexError(`No club called "${text}". Known clubs: ${clubs.map((c) => c.name).join(", ") || "none yet"}.`);
  if (hits.length > 1) throw new ConvexError(`"${text}" matches ${hits.length} clubs: ${hits.map((c) => c.name).join(", ")}. Use the full name or the id.`);
  return hits[0];
}

const agentView = (c: Doc<"clubs">) => ({
  id: c._id,
  name: c.name,
  neighborhood: c.neighborhood ?? null,
  city: c.city ?? null,
  address: c.address ?? null,
  status: c.status,
  openedAt: c.openedAt ?? null,
  squareFeet: c.squareFeet ?? null,
  seats: c.seats ?? null,
  notes: c.notes ?? "",
  url: `${process.env.SITE_URL ?? ""}/c/${c._id}`,
});

export const listForAgent = internalQuery({
  args: {},
  handler: async (ctx) => {
    const clubs = (await ctx.db.query("clubs").withIndex("by_name").collect()).sort(byOrderThenName);
    return Promise.all(
      clubs.map(async (c) => {
        const projects = (await projectsOf(ctx, c._id)).filter((p) => !p.kind);
        return { ...agentView(c), projectCount: projects.length, activeCount: projects.filter((p) => p.stage !== lastStage(p.type)).length };
      }),
    );
  },
});

export const getForAgent = internalQuery({
  args: { club: v.string() },
  handler: async (ctx, { club }) => {
    const row = await resolveClub(ctx, club);
    const projects = (await projectsOf(ctx, row._id))
      .filter((p) => !p.kind)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({ id: p._id, title: p.title || "Untitled", type: p.type, stage: p.stage, targetDate: p.targetDate, url: `${process.env.SITE_URL ?? ""}/p/${p._id}` }));
    const reviews = (
      await ctx.db
        .query("reviews")
        .withIndex("by_club", (q) => q.eq("clubId", row._id))
        .collect()
    )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => ({ id: r._id, title: r.title, status: r.status, roundCount: r.roundCount }));
    return { ...agentView(row), projects, reviews };
  },
});

export const createForAgent = internalMutation({
  args: { ...fields, name: v.string() },
  handler: async (ctx, args) => insertClub(ctx, args, null),
});

export const updateForAgent = internalMutation({
  args: { club: v.string(), ...fields },
  handler: async (ctx, { club, ...f }) => {
    const row = await resolveClub(ctx, club);
    await ctx.db.patch(row._id, { ...clubPatch(f), updatedAt: Date.now() });
    return row._id;
  },
});
