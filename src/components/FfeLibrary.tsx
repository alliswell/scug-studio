"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { uploadToUrl } from "@/lib/upload";
import { FFE_CATEGORIES, ffeCategoryOf, productLabel, type FfeCategory } from "@/lib/types";
import { FilterSelect } from "./FeedView";
import { IconPlus, IconSearch, IconTrash, IconUpload, IconX } from "./icons";

/** A row of the catalogue: the product plus how far it has spread across the network. */
type ProductRow = Doc<"ffeProducts"> & {
  imageUrl: string | null;
  clubCount: number;
  totalQuantity: number;
  placementCount: number;
};
type ProductDoc = Doc<"ffeProducts"> & { imageUrl: string | null };
type PlacementRow = Doc<"ffePlacements"> & { clubName: string; projectTitle: string | null };

/** The fields the detail edits, exactly as convex/ffe.ts takes them. */
type ProductPatch = {
  name?: string;
  maker?: string;
  finish?: string;
  category?: FfeCategory | null;
  dimensions?: string;
  url?: string | null;
  notes?: string;
};

/** A bare domain is what people paste; the server only takes a real link, so finish it for them. */
const asLink = (s: string) => {
  const t = s.trim();
  return !t || /^https?:\/\//i.test(t) ? t : `https://${t}`;
};

const errorText = (e: unknown, fallback: string) =>
  e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.message.replace(/^[\s\S]*ConvexError:\s*/, "").replace(/\s+at [\s\S]*$/, "") : fallback;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A category as a glyph and a word. The colour is only ever the third telling of it: a bare
 * coloured dot says nothing to the person this is built for.
 */
function CategoryMark({ category, size = 13 }: { category?: string | null; size?: number }) {
  const c = ffeCategoryOf(category);
  if (!c)
    return (
      <span className="inline-flex items-center gap-1.5 text-(--c-t-9a9a9a)">
        <span aria-hidden="true" style={{ fontSize: size }} className="leading-none">
          ▫
        </span>
        No category
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5">
      <span style={{ color: c.hex, fontSize: size }} className="leading-none" title={`${c.label} (${c.colorName})`} aria-hidden="true">
        {c.glyph}
      </span>
      {c.label}
    </span>
  );
}

/** What stands in for a picture: the category's glyph, large, with its name under it. */
function CategoryPlaceholder({ category }: { category?: string | null }) {
  const c = ffeCategoryOf(category);
  return (
    <span className="flex h-full w-full flex-col items-center justify-center gap-1.5">
      <span aria-hidden="true" className="text-[34px] leading-none" style={{ color: c ? c.hex : "var(--c-t-b0b0b0)" }}>
        {c ? c.glyph : "▫"}
      </span>
      <span className="text-[11.5px] text-(--c-t-9a9a9a)">{c ? c.label : "No picture"}</span>
    </span>
  );
}

/**
 * FF&E: the catalogue. A product is written down once and placed in as many clubs as it goes in,
 * so a card says what it is and how far it has spread. Opening one answers the question the whole
 * thing exists for: what do we use, and where is it.
 */
export function FfeLibrary() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [composing, setComposing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  // ?product=<id> opens one, the way ?review= does on the Reviews board — a link an agent or a
  // colleague can paste, with no route of its own.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("product");
    if (id) setOpen(id);
  }, []);
  const openProduct = (id: string | null) => {
    setOpen(id);
    const u = new URL(window.location.href);
    if (id) u.searchParams.set("product", id);
    else u.searchParams.delete("product");
    window.history.replaceState(null, "", u);
  };

  const products = useQuery(api.ffe.products, {
    ...(debounced ? { search: debounced } : {}),
    ...(category === "all" ? {} : { category }),
  });
  const rows: ProductRow[] | undefined = products;
  const cat = ffeCategoryOf(category);
  const heading = [cat ? cat.label : "All products", debounced ? `matching "${debounced}"` : null, rows ? String(rows.length) : null].filter(Boolean).join(" · ");

  return (
    <div className="mx-auto max-w-[1180px]">
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[28px] font-semibold tracking-[-0.015em] text-(--c-t-1b1b1b)">FF&amp;E</h1>
          <p className="m-0 mt-1 text-[14px] text-(--c-t-737373)">{heading}</p>
        </div>
        <label className="flex h-9 w-[200px] items-center gap-2 rounded-lg bg-(--c-b-ffffff) px-2.5 text-(--c-t-9a9a9a) ring-1 ring-(--c-l-e3e3e0) transition-[width] focus-within:w-[260px] focus-within:ring-(--c-l-c9c9c9)">
          <IconSearch size={14} />
          <input
            id="ffe-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products"
            aria-label="Search products"
            className="w-full min-w-0 border-none bg-transparent text-[13.5px] text-(--c-t-1b1b1b) outline-none placeholder:text-(--c-t-9a9a9a)"
          />
        </label>
        <FilterSelect
          label="Category"
          value={category}
          onChange={setCategory}
          options={[{ value: "all", label: "All categories" }, ...FFE_CATEGORIES.map((c) => ({ value: c.value as string, label: `${c.glyph} ${c.label}` }))]}
        />
        <button
          type="button"
          onClick={() => setComposing(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-(--c-b-1b1b1b) px-3.5 text-[14px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333)"
        >
          <IconPlus size={14} color="var(--c-on-ink)" />
          New product
        </button>
      </div>

      {composing && <NewProduct onDone={() => setComposing(false)} onOpen={openProduct} />}

      {rows === undefined ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-[252px] animate-pulse rounded-2xl bg-(--c-b-ececea)" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-(--c-l-dcdcdc) py-16 text-center">
          <p className="m-0 text-[15px] font-medium text-(--c-t-1b1b1b)">
            {debounced || category !== "all" ? "Nothing matches." : "No products yet."}
          </p>
          <p className="m-0 mt-1 text-[13.5px] text-(--c-t-737373)">
            {debounced || category !== "all"
              ? "Try a different word, or clear the category."
              : "Write down the first chair, table or light, then place it in the clubs it goes in."}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((p) => (
            <ProductCard key={p._id} p={p} onOpen={() => openProduct(p._id)} />
          ))}
        </div>
      )}

      {open && <ProductDetail id={open} onClose={() => openProduct(null)} />}
    </div>
  );
}

function ProductCard({ p, onOpen }: { p: ProductRow; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col gap-2 rounded-2xl bg-(--kb-card) p-3 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-(--kb-card-ring) transition-[box-shadow,transform] hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(0,0,0,0.08)]"
    >
      <div className="h-[150px] w-full overflow-hidden rounded-xl bg-(--c-b-ececea)">
        {p.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <CategoryPlaceholder category={p.category} />
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[14.5px] font-semibold text-(--c-t-1b1b1b)">{productLabel(p)}</div>
        <div className={`truncate text-[12.5px] ${p.finish?.trim() ? "text-(--c-t-8a8a8a)" : "text-(--c-t-b0b0b0)"}`}>{p.finish?.trim() || "No finish noted"}</div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-[12px] text-(--c-t-737373)">
        <CategoryMark category={p.category} size={12} />
        <span aria-hidden="true" className="text-(--c-t-c4c4c4)">
          ·
        </span>
        <span className="tabular-nums">
          {p.clubCount > 0 ? `in ${plural(p.clubCount, "club", "clubs")} · ${p.totalQuantity} in total` : "Not placed anywhere yet"}
        </span>
      </div>
    </button>
  );
}

const formFieldCls =
  "h-9 w-full rounded-lg bg-(--c-b-ffffff) px-2.5 text-[14px] text-(--c-t-1b1b1b) outline-none ring-1 ring-(--c-l-e3e3e0) focus:ring-(--c-l-c9c9c9) placeholder:text-(--c-t-9a9a9a)";

/** A product starts with a name; everything else can wait, and is edited on its own page after. */
function NewProduct({ onDone, onOpen }: { onDone: () => void; onOpen: (id: string) => void }) {
  const create = useMutation(api.ffe.createProduct);
  const [name, setName] = useState("");
  const [maker, setMaker] = useState("");
  const [finish, setFinish] = useState("");
  const [category, setCategory] = useState<FfeCategory | "">("");
  const [dimensions, setDimensions] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const save = async () => {
    const n = name.trim();
    if (!n || busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const id = await create({
        name: n,
        ...(maker.trim() ? { maker: maker.trim() } : {}),
        ...(finish.trim() ? { finish: finish.trim() } : {}),
        ...(category ? { category } : {}),
        ...(dimensions.trim() ? { dimensions: dimensions.trim() } : {}),
        ...(url.trim() ? { url: asLink(url) } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      onDone();
      onOpen(id);
    } catch (e) {
      busy.current = false;
      setError(errorText(e, "Couldn't add that product"));
    }
  };

  return (
    <div className="mb-4 rounded-2xl bg-(--c-b-fafaf9) p-3.5 ring-1 ring-(--c-l-e3e3e0)">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[12px] font-medium text-(--c-t-737373)">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              else if (e.key === "Escape") onDone();
            }}
            placeholder="About A Chair AAC22"
            className={formFieldCls}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-(--c-t-737373)">Maker</span>
          <input value={maker} onChange={(e) => setMaker(e.target.value)} placeholder="Hay" className={formFieldCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-(--c-t-737373)">Finish</span>
          <input value={finish} onChange={(e) => setFinish(e.target.value)} placeholder="Grey felt, oak base" className={formFieldCls} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-(--c-t-737373)">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as FfeCategory | "")} className={`${formFieldCls} cursor-pointer`}>
            <option value="">No category</option>
            {FFE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.glyph} {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-(--c-t-737373)">Dimensions</span>
          <input value={dimensions} onChange={(e) => setDimensions(e.target.value)} placeholder="W62 × D55 × H79 cm" className={formFieldCls} />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[12px] font-medium text-(--c-t-737373)">Product page</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={formFieldCls} />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[12px] font-medium text-(--c-t-737373)">Notes</span>
          <textarea
            value={notes}
            rows={2}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything worth knowing about it"
            className="block w-full resize-y rounded-lg bg-(--c-b-ffffff) px-2.5 py-2 text-[14px] leading-[1.55] text-(--c-t-262626) outline-none ring-1 ring-(--c-l-e3e3e0) focus:ring-(--c-l-c9c9c9) placeholder:text-(--c-t-9a9a9a)"
          />
        </label>
      </div>
      {error && <p className="m-0 mt-2.5 text-[13px] text-(--c-t-b42318)">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <span className="text-[12.5px] text-(--c-t-9a9a9a)">Only the name is needed.</span>
        <span className="flex-1" />
        <button type="button" onClick={onDone} className="h-8 rounded-lg px-2.5 text-[13px] text-(--c-t-737373) hover:bg-(--c-b-f4f4f4)">
          Cancel
        </button>
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => void save()}
          className="h-8 rounded-lg bg-(--c-b-1b1b1b) px-3.5 text-[13px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333) disabled:opacity-40"
        >
          Add product
        </button>
      </div>
    </div>
  );
}

/**
 * One product: what it is, and every club it stands in. The second half is the reason the
 * catalogue exists, so it is grouped the way someone walks it — club, then area, then the number.
 */
function ProductDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const data = useQuery(api.ffe.product, { id });
  const update = useMutation(api.ffe.updateProduct);
  const remove = useMutation(api.ffe.removeProduct);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement).closest("textarea,input,select")) return;
      onClose();
    };
    window.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const placements: PlacementRow[] | undefined = data?.placements;
  const groups = useMemo(() => {
    const byClub = new Map<string, { clubId: Id<"clubs">; clubName: string; total: number; areas: Map<string, PlacementRow[]> }>();
    for (const p of placements ?? []) {
      const g = byClub.get(p.clubId) ?? { clubId: p.clubId, clubName: p.clubName, total: 0, areas: new Map<string, PlacementRow[]>() };
      g.total += p.quantity;
      const area = p.area.trim() || "No area";
      g.areas.set(area, [...(g.areas.get(area) ?? []), p]);
      byClub.set(p.clubId, g);
    }
    return [...byClub.values()]
      .sort((a, b) => a.clubName.localeCompare(b.clubName, undefined, { sensitivity: "base", numeric: true }))
      .map((g) => ({
        clubId: g.clubId,
        clubName: g.clubName,
        total: g.total,
        areas: [...g.areas.entries()]
          .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base", numeric: true }))
          .map(([area, rows]) => ({ area, rows, total: rows.reduce((n, r) => n + r.quantity, 0) })),
      }));
  }, [placements]);

  const shell = (children: ReactNode) =>
    createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Product"
        className="fixed inset-0 z-[90] flex items-stretch justify-center bg-black/40 p-0 backdrop-blur-[2px] sm:p-6"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="flex w-full max-w-[1040px] flex-col overflow-hidden bg-(--c-b-ffffff) shadow-[0_24px_80px_rgba(0,0,0,0.3)] sm:rounded-2xl">{children}</div>
      </div>,
      document.body,
    );

  if (data === undefined) return shell(<div className="flex flex-1 items-center justify-center text-[14px] text-(--c-t-9a9a9a)">Loading…</div>);
  if (data === null)
    return shell(
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[14px] text-(--c-t-737373)">
        This product is gone.
        <button type="button" onClick={onClose} className="font-medium text-(--c-t-2358d8)">
          Close
        </button>
      </div>,
    );

  const product: ProductDoc = data.product;
  const rows: PlacementRow[] = data.placements;
  const total = rows.reduce((n, r) => n + r.quantity, 0);
  const save = (patch: ProductPatch) => void update({ id: product._id, ...patch });
  const del = () => {
    if (!confirm(`Delete "${productLabel(product)}"?`)) return;
    void (async () => {
      try {
        await remove({ id: product._id });
        onClose();
      } catch (e) {
        // It refuses while the product still stands in a club, and names them. Say exactly that —
        // a guess here would send someone looking in the wrong building.
        setError(errorText(e, "Couldn't delete this product"));
      }
    })();
  };

  return shell(
    <>
      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-(--c-l-ebebeb) px-4 py-2">
        <NameField value={product.name} onSave={(name) => save({ name })} />
        <span className="shrink-0 px-1 text-[12.5px] text-(--c-t-737373)">
          <CategoryMark category={product.category} size={12} />
        </span>
        <button
          type="button"
          onClick={del}
          aria-label="Delete product"
          title="Delete product"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-(--c-t-9a9a9a) hover:bg-(--c-b-f4f4f4) hover:text-(--c-t-b42318)"
        >
          <IconTrash size={16} />
        </button>
        <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-lg text-(--c-t-6b6b6b) hover:bg-(--c-b-f4f4f4)">
          <IconX />
        </button>
      </div>

      {error && (
        <div className="shrink-0 border-b border-(--c-l-ebebeb) bg-(--c-b-fdecea) px-4 py-2.5">
          <div className="flex items-start gap-2">
            <p className="m-0 flex-1 text-[13.5px] leading-[1.5] text-(--c-t-b42318)">{error}</p>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--c-t-b42318)">
              <IconX size={11} />
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-6 md:flex-row">
          <ImageBox product={product} />
          <div className="min-w-0 flex-1">
            <div className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-[14px] leading-[1.5]">
              <Label>Maker</Label>
              <Text value={product.maker ?? ""} placeholder="Hay" aria="Maker" onSave={(maker) => save({ maker })} />

              <Label>Finish</Label>
              <Text value={product.finish ?? ""} placeholder="Grey felt, oak base" aria="Finish" onSave={(finish) => save({ finish })} />

              <Label>Category</Label>
              <label className="relative -ml-1.5 flex w-fit cursor-pointer items-center rounded-md px-1.5 py-0.5 hover:bg-(--c-b-f4f4f4)">
                <CategoryMark category={product.category} />
                <select
                  aria-label="Category"
                  value={product.category ?? ""}
                  onChange={(e) => save({ category: (e.target.value || null) as FfeCategory | null })}
                  className="absolute inset-0 cursor-pointer opacity-0"
                >
                  <option value="">No category</option>
                  {FFE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.glyph} {c.label}
                    </option>
                  ))}
                </select>
              </label>

              <Label>Dimensions</Label>
              <Text value={product.dimensions ?? ""} placeholder="W62 × D55 × H79 cm" aria="Dimensions" onSave={(dimensions) => save({ dimensions })} />

              <Label>Product page</Label>
              <div className="flex min-w-0 items-center gap-1.5">
                <Text value={product.url ?? ""} placeholder="https://…" aria="Product page" onSave={(url) => save({ url: asLink(url) })} />
                {product.url?.trim() && (
                  <a
                    href={product.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 whitespace-nowrap text-[12.5px] font-medium text-(--c-t-2358d8) no-underline hover:underline"
                  >
                    Open
                  </a>
                )}
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.05em] text-(--c-t-9a9a9a)">Notes</div>
              <Notes value={product.notes ?? ""} onSave={(notes) => save({ notes })} />
            </div>
          </div>
        </div>

        <div className="mb-3 mt-9 flex items-center gap-2 border-b border-(--c-l-ebebeb) pb-2">
          <h2 className="m-0 text-[16px] font-semibold text-(--c-t-1b1b1b)">Where it is used</h2>
          {rows.length > 0 && (
            <span className="text-[13px] tabular-nums text-(--c-t-9a9a9a)">
              {total} across {plural(groups.length, "club", "clubs")}
            </span>
          )}
        </div>
        {groups.length === 0 ? (
          <p className="m-0 text-[13.5px] text-(--c-t-9a9a9a)">
            Not placed anywhere yet. It goes into a club from that club&rsquo;s FF&amp;E section, or from the FF&amp;E tab of the build-out that specs it.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((g) => (
              <div key={g.clubId}>
                <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
                  <Link href={`/c/${g.clubId}`} className="text-[14.5px] font-semibold text-(--c-t-1b1b1b) no-underline hover:underline">
                    {g.clubName.trim() || "Untitled club"}
                  </Link>
                  <span className="text-[12.5px] tabular-nums text-(--c-t-9a9a9a)">{g.total} in total</span>
                </div>
                <div className="flex flex-col gap-2.5">
                  {g.areas.map((a) => (
                    <div key={a.area}>
                      <div className="flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-[0.05em] text-(--c-t-9a9a9a)">
                        <span>{a.area}</span>
                        <span className="tabular-nums">{a.total}</span>
                      </div>
                      <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
                        {a.rows.map((r) => (
                          <li key={r._id} className="flex items-baseline gap-3 rounded-lg px-2 py-1 text-[13.5px] hover:bg-(--c-b-fafaf9)">
                            <span className="w-7 shrink-0 text-right font-semibold tabular-nums text-(--c-t-1b1b1b)">{r.quantity}</span>
                            <span className="min-w-0 flex-1 text-(--c-t-6b6b6b)">
                              {/* The club owns it; the project only specced it, and plenty was added with no project at all */}
                              {r.projectId && r.projectTitle ? (
                                <>
                                  Specced by{" "}
                                  <Link href={`/p/${r.projectId}`} className="text-(--c-t-2358d8) no-underline hover:underline">
                                    {r.projectTitle}
                                  </Link>
                                </>
                              ) : (
                                "Added after opening"
                              )}
                              {r.notes?.trim() ? <span className="text-(--c-t-9a9a9a)"> · {r.notes.trim()}</span> : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>,
  );
}

/** The picture, and the control that puts one there or swaps it. */
function ImageBox({ product }: { product: ProductDoc }) {
  const uploadUrl = useMutation(api.docs.generateUploadUrl);
  const setImage = useMutation(api.ffe.setProductImage);
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("That has to be a picture.");
      return;
    }
    setError(null);
    setProgress(0);
    try {
      const storageId = (await uploadToUrl(await uploadUrl(), file, setProgress)) as Id<"_storage">;
      await setImage({ id: product._id, storageId });
    } catch (e) {
      setError(errorText(e, "Upload failed"));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="w-full shrink-0 md:w-[320px]">
      <div className="h-[220px] w-full overflow-hidden rounded-xl bg-(--c-b-ececea) ring-1 ring-(--c-l-ebebeb)">
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.imageUrl} alt="" className="h-full w-full object-contain" />
        ) : (
          <CategoryPlaceholder category={product.category} />
        )}
      </div>
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={progress !== null}
          onClick={() => input.current?.click()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-(--c-t-6b6b6b) ring-1 ring-(--c-l-e0e0dd) hover:text-(--c-t-1b1b1b) disabled:opacity-60"
        >
          <IconUpload size={13} />
          {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : product.imageUrl ? "Replace picture" : "Add a picture"}
        </button>
        {product.imageUrl && progress === null && (
          <button
            type="button"
            onClick={() => void setImage({ id: product._id, storageId: null, url: null })}
            className="h-8 rounded-lg px-2 text-[13px] text-(--c-t-9a9a9a) hover:bg-(--c-b-f4f4f4) hover:text-(--c-t-1b1b1b)"
          >
            Remove
          </button>
        )}
      </div>
      {error && <p className="m-0 mt-1.5 text-[12.5px] text-(--c-t-b42318)">{error}</p>}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="text-(--c-t-737373)">{children}</div>;
}

/** The product's name, edited where it is shown. A blank name would leave the row unnameable, so it snaps back. */
function NameField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() && draft.trim() !== value) onSave(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label="Name"
      className="h-9 min-w-[200px] flex-1 rounded-md bg-transparent px-2 text-[16px] font-semibold text-(--c-t-1b1b1b) outline-none hover:bg-(--c-b-f4f4f4) focus:bg-(--c-b-f4f4f4)"
    />
  );
}

const fieldCls =
  "-ml-1.5 w-full min-w-0 rounded-md bg-transparent px-1.5 py-0.5 text-[14px] text-(--c-t-1b1b1b) outline-none hover:bg-(--c-b-f4f4f4) focus:bg-(--c-b-f4f4f4) placeholder:text-(--c-t-9a9a9a)";

function Text({ value, placeholder, aria, onSave }: { value: string; placeholder: string; aria: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onSave(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label={aria}
      placeholder={placeholder}
      className={fieldCls}
    />
  );
}

function Notes({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <textarea
      value={draft ?? value}
      rows={4}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onSave(draft);
        setDraft(null);
      }}
      aria-label="Notes"
      placeholder="Anything worth knowing: the trim it comes in, what it replaced, who to ask about it."
      className="block w-full resize-y rounded-xl bg-(--c-b-fafaf9) px-3 py-2.5 text-[14px] leading-[1.6] text-(--c-t-262626) outline-none ring-1 ring-(--c-l-ebebeb) focus:ring-(--c-l-c9c9c9) placeholder:text-(--c-t-9a9a9a)"
    />
  );
}
