// FF&E: what the studio specifies, and where each piece of it goes. A product is written down ONCE
// and placed in as many clubs as it goes in — the same chair turns up in twelve of them, and typing
// it out again each time loses the one question worth asking: what do we use, and where is it.
//
// A placement's club owns it; its project only specced it. Anything added after opening has no
// project at all.
//
// This is a specification tool, not a procurement one: no cost, no lead time, no order status, no PO.

import { ConvexError, v, type Infer } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib";
import { resolveClub } from "./clubs";
import { resolveProject } from "./agent";
import { ffeCategory } from "./schema";

type FfeCategory = Infer<typeof ffeCategory>;

const MAX_NOTES = 4000;
/** Free text, so the vocabulary is the studio's own; long enough for "Phone rooms, second floor". */
const MAX_AREA = 80;
/** A search is a way to find something, not a way to read the whole catalog. */
const MAX_SEARCH = 200;

/** Blank clears the field rather than storing an empty string, so "unset" reads the same everywhere. */
const trimmed = (s: string | undefined, max: number) => (s === undefined ? undefined : s.trim().slice(0, max) || undefined);

/** "Hay · About A Chair AAC22" — the maker is part of how a product is known. "AAC22" alone names nothing. */
const label = (p: Doc<"ffeProducts">) => (p.maker?.trim() ? `${p.maker.trim()} · ${p.name}` : p.name);

const CATEGORIES: FfeCategory[] = ffeCategory.members.map((m) => m.value);

/** The category filter arrives as free text (an agent types one); say what the legal ones are. */
function asCategory(c: string | undefined): FfeCategory | undefined {
  const want = c?.trim().toLowerCase();
  if (!want) return undefined;
  const hit = CATEGORIES.find((x) => x === want);
  if (!hit) throw new ConvexError(`"${c}" isn't an FF&E category. They are: ${CATEGORIES.join(", ")}.`);
  return hit;
}

function quantityOf(n: number) {
  if (!Number.isInteger(n) || n < 1) throw new ConvexError(`Quantity has to be a whole number, 1 or more — "${n}" isn't one.`);
  return n;
}

function areaOf(s: string) {
  const area = s.trim().slice(0, MAX_AREA);
  if (!area) throw new ConvexError("Say which area it goes in — Lounge, Phone rooms, Cafe.");
  return area;
}

/** The picture, resolved now: a stored file's URL goes stale, its id doesn't. */
const imageUrlOf = (ctx: QueryCtx, p: Doc<"ffeProducts">) =>
  p.imageStorageId ? ctx.storage.getUrl(p.imageStorageId) : Promise.resolve(p.imageUrl ?? null);

const placementsOfProduct = (ctx: QueryCtx, productId: Id<"ffeProducts">) =>
  ctx.db
    .query("ffePlacements")
    .withIndex("by_product", (q) => q.eq("productId", productId))
    .collect();

/** Where a product is, in three numbers: how many clubs, how many of it in all, how many rows. */
async function tallyOf(ctx: QueryCtx, productId: Id<"ffeProducts">) {
  const rows = await placementsOfProduct(ctx, productId);
  return {
    clubCount: new Set(rows.map((r) => r.clubId as string)).size,
    totalQuantity: rows.reduce((n, r) => n + r.quantity, 0),
    placementCount: rows.length,
  };
}

// ---------- Products ----------

const productFields = {
  maker: v.optional(v.string()),
  finish: v.optional(v.string()),
  category: v.optional(v.union(ffeCategory, v.null())),
  dimensions: v.optional(v.string()),
  url: v.optional(v.union(v.string(), v.null())),
  notes: v.optional(v.string()),
};

type ProductFields = {
  name?: string;
  maker?: string;
  finish?: string;
  category?: FfeCategory | null;
  dimensions?: string;
  url?: string | null;
  notes?: string;
};

/** Everything create and update share: the same checks, the same trimming. */
function productPatch(f: ProductFields) {
  const patch: Partial<Doc<"ffeProducts">> = {};
  if (f.name !== undefined) {
    const name = f.name.trim().slice(0, 200);
    if (!name) throw new ConvexError("Give the product a name, as the maker names it");
    patch.name = name;
  }
  if (f.maker !== undefined) patch.maker = trimmed(f.maker, 120);
  if (f.finish !== undefined) patch.finish = trimmed(f.finish, 200);
  if (f.category !== undefined) patch.category = f.category ?? undefined;
  if (f.dimensions !== undefined) patch.dimensions = trimmed(f.dimensions, 160);
  if (f.url !== undefined) {
    const url = f.url?.trim() || null;
    if (url && !/^https?:\/\//i.test(url)) throw new ConvexError("The product link must start with http:// or https://");
    patch.url = url;
  }
  if (f.notes !== undefined) patch.notes = f.notes.slice(0, MAX_NOTES);
  return patch;
}

/** What the search index reads. Kept in step on every write, or search answers with yesterday's row. */
const searchTextOf = (p: { name: string; maker?: string; finish?: string; notes?: string }) =>
  [p.name, p.maker, p.finish, p.notes].filter(Boolean).join(" ").toLowerCase().slice(0, 4000);

async function insertProduct(ctx: MutationCtx, f: ProductFields, createdBy: Id<"users"> | null) {
  const patch = productPatch(f);
  const name = patch.name;
  if (!name) throw new ConvexError("Give the product a name, as the maker names it");
  const now = Date.now();
  return ctx.db.insert("ffeProducts", {
    ...patch,
    name,
    searchText: searchTextOf({ ...patch, name }),
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
}

async function patchProduct(ctx: MutationCtx, id: Id<"ffeProducts">, f: ProductFields) {
  const row = await ctx.db.get(id);
  if (!row) throw new ConvexError("That product is gone");
  const patch = productPatch(f);
  const next = { ...row, ...patch };
  await ctx.db.patch(id, { ...patch, searchText: searchTextOf(next), updatedAt: Date.now() });
  return id;
}

/**
 * The catalog, narrowed the only two ways anyone asks for it. A search is left in relevance order;
 * everything else reads by name. A category filter on a search is applied to the hits, not to the table.
 */
async function productRows(ctx: QueryCtx, search: string | undefined, category: string | undefined) {
  const q = search?.trim();
  const cat = asCategory(category);
  if (q)
    return (
      await ctx.db
        .query("ffeProducts")
        .withSearchIndex("search", (s) => s.search("searchText", q.toLowerCase()))
        .take(MAX_SEARCH)
    ).filter((p) => !cat || p.category === cat);
  if (cat)
    return (
      await ctx.db
        .query("ffeProducts")
        .withIndex("by_category", (x) => x.eq("category", cat))
        .collect()
    ).sort((a, b) => a.name.localeCompare(b.name));
  return ctx.db.query("ffeProducts").withIndex("by_name").collect();
}

export const products = query({
  args: { search: v.optional(v.string()), category: v.optional(v.string()) },
  handler: async (ctx, { search, category }) => {
    await requireUser(ctx);
    const rows = await productRows(ctx, search, category);
    return Promise.all(rows.map(async (p) => ({ ...p, imageUrl: await imageUrlOf(ctx, p), ...(await tallyOf(ctx, p._id)) })));
  },
});

/** Club, then area, then when it was added: the order a schedule is read in. */
const byPlace = (a: { clubName: string; area: string; createdAt: number }, b: { clubName: string; area: string; createdAt: number }) =>
  a.clubName.localeCompare(b.clubName) || a.area.localeCompare(b.area) || a.createdAt - b.createdAt;

export const product = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const productId = ctx.db.normalizeId("ffeProducts", id);
    const row = productId ? await ctx.db.get(productId) : null;
    if (!row) return null;
    const placements = await Promise.all(
      (await placementsOfProduct(ctx, row._id)).map(async (r) => {
        const club = await ctx.db.get(r.clubId);
        const project = r.projectId ? await ctx.db.get(r.projectId) : null;
        return { ...r, clubName: club?.name ?? "Unknown club", projectTitle: project?.title ?? null };
      }),
    );
    return { product: { ...row, imageUrl: await imageUrlOf(ctx, row) }, placements: placements.sort(byPlace) };
  },
});

export const createProduct = mutation({
  args: { name: v.string(), ...productFields },
  handler: async (ctx, args) => insertProduct(ctx, args, await requireUser(ctx)),
});

export const updateProduct = mutation({
  args: { id: v.id("ffeProducts"), name: v.optional(v.string()), ...productFields },
  handler: async (ctx, { id, ...f }) => {
    await requireUser(ctx);
    await patchProduct(ctx, id, f);
  },
});

/**
 * The product's picture: an upload (storageId) or a link (url). A product has one, so an upload
 * replaces a link and a link replaces an upload; passing null for both clears it.
 *
 * Only a pasted link is ever stored in `imageUrl`. A URL for a stored file is worked out at read
 * time instead, because one written onto the row goes stale.
 */
export const setProductImage = mutation({
  args: {
    id: v.id("ffeProducts"),
    storageId: v.optional(v.union(v.id("_storage"), v.null())),
    url: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, storageId, url }) => {
    await requireUser(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new ConvexError("That product is gone");
    if (url && !/^https?:\/\//i.test(url)) throw new ConvexError("The image link must start with http:// or https://");
    const nextStorage = storageId !== undefined ? storageId : url !== undefined ? null : (row.imageStorageId ?? null);
    const nextUrl = url !== undefined ? url || null : storageId !== undefined ? null : (row.imageUrl ?? null);
    // Replacing or clearing an uploaded picture leaves its blob behind otherwise
    if (row.imageStorageId && row.imageStorageId !== nextStorage) await ctx.storage.delete(row.imageStorageId).catch(() => {});
    await ctx.db.patch(id, { imageStorageId: nextStorage, imageUrl: nextUrl, updatedAt: Date.now() });
  },
});

/**
 * A product placed in a dozen clubs is a dozen furniture schedules; deleting it out from under them
 * quietly is not a thing to do. The refusal names the clubs so there is somewhere to start.
 */
async function assertUnplaced(ctx: QueryCtx, row: Doc<"ffeProducts">) {
  const rows = await placementsOfProduct(ctx, row._id);
  if (!rows.length) return;
  const names = [...new Set(await Promise.all(rows.map(async (r) => (await ctx.db.get(r.clubId))?.name ?? "a club")))].sort();
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? `, and ${names.length - 5} more` : "";
  throw new ConvexError(
    `${label(row)} is placed in ${names.length} club${names.length === 1 ? "" : "s"}: ${shown}${more}. Remove those placements first.`,
  );
}

export const removeProduct = mutation({
  args: { id: v.id("ffeProducts") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    const row = await ctx.db.get(id);
    if (!row) return;
    await assertUnplaced(ctx, row);
    if (row.imageStorageId) await ctx.storage.delete(row.imageStorageId).catch(() => {});
    await ctx.db.delete(id);
  },
});

// ---------- Placements ----------

/**
 * A placement's club owns it and its project only specced it, so the two have to agree about where
 * the furniture is. Network-wide work (no club) can spec for any of them.
 */
async function checkProject(ctx: QueryCtx, projectId: Id<"projects"> | null, clubId: Id<"clubs">) {
  if (!projectId) return;
  const project = await ctx.db.get(projectId);
  if (!project) throw new ConvexError("That project is gone");
  if (project.clubId && project.clubId !== clubId) {
    const club = await ctx.db.get(clubId);
    throw new ConvexError(`${project.title || "That project"} isn't work on ${club?.name ?? "that club"}, so it can't be what specced this.`);
  }
}

type PlacementInput = {
  productId: Id<"ffeProducts">;
  clubId: Id<"clubs">;
  projectId?: Id<"projects"> | null;
  area: string;
  quantity: number;
  notes?: string;
};

async function insertPlacement(ctx: MutationCtx, a: PlacementInput, createdBy: Id<"users"> | null) {
  if (!(await ctx.db.get(a.productId))) throw new ConvexError("That product is gone");
  if (!(await ctx.db.get(a.clubId))) throw new ConvexError("That club is gone");
  const projectId = a.projectId ?? null;
  await checkProject(ctx, projectId, a.clubId);
  const now = Date.now();
  return ctx.db.insert("ffePlacements", {
    productId: a.productId,
    clubId: a.clubId,
    projectId,
    area: areaOf(a.area),
    quantity: quantityOf(a.quantity),
    ...(a.notes !== undefined ? { notes: a.notes.slice(0, MAX_NOTES) } : {}),
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
}

async function scopedPlacements(ctx: QueryCtx, clubId: Id<"clubs"> | null, projectId: Id<"projects"> | null) {
  const rows = projectId
    ? await ctx.db
        .query("ffePlacements")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect()
    : clubId
      ? await ctx.db
          .query("ffePlacements")
          .withIndex("by_club", (q) => q.eq("clubId", clubId))
          .collect()
      : await ctx.db.query("ffePlacements").collect();
  return clubId && projectId ? rows.filter((r) => r.clubId === clubId) : rows;
}

type PlacementProduct = {
  _id: Id<"ffeProducts">;
  name: string;
  maker: string | null;
  finish: string | null;
  category: FfeCategory | null;
  imageUrl: string | null;
};

/**
 * A placement with the three things it is never read without: the product, the club, the project.
 * A club's schedule is forty rows of a dozen products, so each one is read and resolved once.
 */
async function placementRows(ctx: QueryCtx, rows: Doc<"ffePlacements">[]) {
  const products = new Map<string, PlacementProduct>();
  const clubs = new Map<string, string>();
  const out = [];
  for (const r of rows) {
    if (!products.has(r.productId)) {
      const p = await ctx.db.get(r.productId);
      products.set(r.productId, {
        _id: r.productId,
        name: p?.name ?? "Unknown product",
        maker: p?.maker ?? null,
        finish: p?.finish ?? null,
        category: p?.category ?? null,
        imageUrl: p ? await imageUrlOf(ctx, p) : null,
      });
    }
    if (!clubs.has(r.clubId)) clubs.set(r.clubId, (await ctx.db.get(r.clubId))?.name ?? "Unknown club");
    const project = r.projectId ? await ctx.db.get(r.projectId) : null;
    out.push({
      ...r,
      product: products.get(r.productId)!,
      clubName: clubs.get(r.clubId)!,
      projectTitle: project?.title ?? null,
    });
  }
  return out.sort(byPlace);
}

export const placements = query({
  args: { clubId: v.optional(v.id("clubs")), projectId: v.optional(v.id("projects")) },
  handler: async (ctx, { clubId, projectId }) => {
    await requireUser(ctx);
    return placementRows(ctx, await scopedPlacements(ctx, clubId ?? null, projectId ?? null));
  },
});

export const addPlacement = mutation({
  args: {
    productId: v.id("ffeProducts"),
    clubId: v.id("clubs"),
    projectId: v.optional(v.union(v.id("projects"), v.null())),
    area: v.string(),
    quantity: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => insertPlacement(ctx, args, await requireUser(ctx)),
});

export const updatePlacement = mutation({
  args: {
    id: v.id("ffePlacements"),
    area: v.optional(v.string()),
    quantity: v.optional(v.number()),
    notes: v.optional(v.string()),
    projectId: v.optional(v.union(v.id("projects"), v.null())),
  },
  handler: async (ctx, { id, area, quantity, notes, projectId }) => {
    await requireUser(ctx);
    const row = await ctx.db.get(id);
    if (!row) throw new ConvexError("That placement is gone");
    if (projectId !== undefined) await checkProject(ctx, projectId, row.clubId);
    await ctx.db.patch(id, {
      ...(area !== undefined ? { area: areaOf(area) } : {}),
      ...(quantity !== undefined ? { quantity: quantityOf(quantity) } : {}),
      ...(notes !== undefined ? { notes: notes.slice(0, MAX_NOTES) } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const removePlacement = mutation({
  args: { id: v.id("ffePlacements") },
  handler: async (ctx, { id }) => {
    await requireUser(ctx);
    if (!(await ctx.db.get(id))) return;
    await ctx.db.delete(id);
  },
});

/**
 * The area names in use, most-used first. It backs a datalist rather than an enum, so the studio's
 * vocabulary standardises itself and anyone can still add a room nobody thought of.
 */
export const areas = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    const counts = new Map<string, number>();
    for (const p of await ctx.db.query("ffePlacements").collect()) counts.set(p.area, (counts.get(p.area) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([area]) => area);
  },
});

// ---------- Agents (see mcp.ts / agent.ts) ----------

/**
 * A product from an id or from its name: an exact match first (ignoring case, on the name or on
 * "maker · name"), then a single partial match. Ambiguity is reported rather than guessed at,
 * because a chair specced into the wrong club is silent and expensive.
 */
export async function resolveProduct(ctx: QueryCtx, ref: string): Promise<Doc<"ffeProducts">> {
  const text = ref.trim();
  if (!text) throw new ConvexError("Name a product");
  const id = ctx.db.normalizeId("ffeProducts", text);
  if (id) {
    const byId = await ctx.db.get(id);
    if (byId) return byId;
  }
  const needle = text.toLowerCase();
  const rows = await ctx.db.query("ffeProducts").withIndex("by_name").collect();
  const exact = rows.filter((p) => p.name.toLowerCase() === needle || label(p).toLowerCase() === needle);
  const hits = exact.length ? exact : rows.filter((p) => label(p).toLowerCase().includes(needle));
  if (!hits.length) throw new ConvexError(`No product matches "${text}". list_ffe_products has the names and ids.`);
  if (hits.length > 1)
    throw new ConvexError(
      `"${text}" matches ${hits.length} products — say which one: ${hits.slice(0, 10).map((p) => `${label(p)} (${p._id})`).join(", ")}.`,
    );
  return hits[0];
}

async function productView(ctx: QueryCtx, p: Doc<"ffeProducts">) {
  return {
    id: p._id,
    name: p.name,
    maker: p.maker ?? null,
    label: label(p),
    finish: p.finish ?? null,
    category: p.category ?? null,
    dimensions: p.dimensions ?? null,
    url: p.url ?? null,
    imageUrl: await imageUrlOf(ctx, p),
    notes: p.notes ?? "",
  };
}

export const listProductsForAgent = internalQuery({
  args: { search: v.optional(v.string()), category: v.optional(v.string()) },
  handler: async (ctx, { search, category }) => {
    const rows = await productRows(ctx, search, category);
    return Promise.all(rows.map(async (p) => ({ ...(await productView(ctx, p)), ...(await tallyOf(ctx, p._id)) })));
  },
});

export const getProductForAgent = internalQuery({
  args: { product: v.string() },
  handler: async (ctx, { product }) => {
    const row = await resolveProduct(ctx, product);
    const placed = await placementRows(ctx, await placementsOfProduct(ctx, row._id));
    return {
      ...(await productView(ctx, row)),
      ...(await tallyOf(ctx, row._id)),
      placements: placed.map((r) => ({
        id: r._id,
        club: r.clubName,
        clubId: r.clubId,
        area: r.area,
        quantity: r.quantity,
        project: r.projectTitle,
        notes: r.notes ?? "",
      })),
    };
  },
});

export const createProductForAgent = internalMutation({
  args: { name: v.string(), ...productFields },
  handler: async (ctx, args) => {
    const id = await insertProduct(ctx, args, null);
    return productView(ctx, (await ctx.db.get(id))!);
  },
});

export const updateProductForAgent = internalMutation({
  args: { product: v.string(), name: v.optional(v.string()), ...productFields },
  handler: async (ctx, { product, ...f }) => {
    const row = await resolveProduct(ctx, product);
    await patchProduct(ctx, row._id, f);
    return productView(ctx, (await ctx.db.get(row._id))!);
  },
});

export const placeForAgent = internalMutation({
  args: {
    product: v.string(),
    club: v.string(),
    area: v.string(),
    quantity: v.number(),
    project: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, { product, club, area, quantity, project, notes }) => {
    const row = await resolveProduct(ctx, product);
    const clubRow = await resolveClub(ctx, club);
    const projectRow = project ? await resolveProject(ctx, project) : null;
    const id = await insertPlacement(
      ctx,
      { productId: row._id, clubId: clubRow._id, projectId: projectRow?._id ?? null, area, quantity, notes },
      null,
    );
    const placed = (await ctx.db.get(id))!;
    return {
      id,
      product: label(row),
      club: clubRow.name,
      area: placed.area,
      quantity: placed.quantity,
      project: projectRow?.title ?? null,
    };
  },
});

export const listPlacementsForAgent = internalQuery({
  args: { club: v.optional(v.string()), project: v.optional(v.string()) },
  handler: async (ctx, { club, project }) => {
    const clubRow = club ? await resolveClub(ctx, club) : null;
    const projectRow = project ? await resolveProject(ctx, project) : null;
    const rows = await placementRows(ctx, await scopedPlacements(ctx, clubRow?._id ?? null, projectRow?._id ?? null));
    return rows.map((r) => ({
      id: r._id,
      product: r.product.maker ? `${r.product.maker} · ${r.product.name}` : r.product.name,
      productId: r.product._id,
      category: r.product.category,
      finish: r.product.finish,
      club: r.clubName,
      area: r.area,
      quantity: r.quantity,
      // The club owns it; the project only specced it, and there is none for anything added after opening
      project: r.projectTitle,
      notes: r.notes ?? "",
    }));
  },
});

export const removePlacementForAgent = internalMutation({
  args: { placement: v.string() },
  handler: async (ctx, { placement }) => {
    const id = ctx.db.normalizeId("ffePlacements", placement.trim());
    const row = id ? await ctx.db.get(id) : null;
    if (!row) throw new ConvexError(`No FF&E placement with id "${placement}". list_ffe has the ids.`);
    const product = await ctx.db.get(row.productId);
    const club = await ctx.db.get(row.clubId);
    await ctx.db.delete(row._id);
    return { removed: row._id, product: product ? label(product) : "a product", club: club?.name ?? "a club", area: row.area };
  },
});
