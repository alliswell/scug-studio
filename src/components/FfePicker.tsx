"use client";

// FF&E where the work happens: the picker, and the few pieces the club page and the project page
// both need to show a placement. The catalogue itself is the FF&E app — nothing here repeats it.

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ffeCategoryOf, productLabel, type FfeCategory } from "@/lib/types";
import { IconX } from "./icons";

/** A picked product: the id to place, plus enough to show what was picked without reading it again. */
export type FfePick = {
  id: Id<"ffeProducts">;
  name: string;
  maker: string | null;
  finish: string | null;
  category: FfeCategory | null;
};

/** A row of `api.ffe.products`, as far as these surfaces read it. */
type ProductRow = {
  _id: Id<"ffeProducts">;
  name: string;
  maker?: string;
  finish?: string;
  category?: FfeCategory;
  imageUrl: string | null;
};

export const ffeError = (e: unknown, fallback: string) =>
  e instanceof ConvexError
    ? String(e.data)
    : e instanceof Error
      ? e.message.replace(/^[\s\S]*ConvexError:\s*/, "").replace(/\s+at [\s\S]*$/, "")
      : fallback;

const FIELD =
  "h-9 rounded-lg bg-(--c-b-ffffff) px-2.5 text-[13.5px] text-(--c-t-1b1b1b) outline-none ring-1 ring-(--c-l-e3e3e0) focus:ring-(--c-l-c9c9c6) placeholder:text-(--c-t-9a9a9a)";

/**
 * A category's glyph, with its name for anyone who can't see it. The colour is the second telling
 * and never the only one — a bare coloured dot says nothing to the person this is built for.
 */
export function CategoryGlyph({ category, size = 13 }: { category?: string | null; size?: number }) {
  const c = ffeCategoryOf(category);
  return (
    <span
      className="inline-flex shrink-0 leading-none"
      style={{ color: c ? c.hex : "var(--c-t-b0b0b0)", fontSize: size }}
      title={c ? `${c.label} (${c.colorName})` : "No category"}
    >
      <span aria-hidden="true">{c ? c.glyph : "▫"}</span>
      <span className="sr-only">{c ? c.label : "No category"}</span>
    </span>
  );
}

/** The product's picture, or its category glyph standing in for one. */
export function ProductThumb({ imageUrl, category, size = 36 }: { imageUrl: string | null; category?: string | null; size?: number }) {
  const c = ffeCategoryOf(category);
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-(--c-b-f1f1ef)"
      style={{ width: size, height: size }}
      title={c ? `${c.label} (${c.colorName})` : "No category"}
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <>
          <span aria-hidden="true" className="leading-none" style={{ color: c ? c.hex : "var(--c-t-b0b0b0)", fontSize: Math.round(size * 0.48) }}>
            {c ? c.glyph : "▫"}
          </span>
          <span className="sr-only">{c ? c.label : "No category"}</span>
        </>
      )}
    </span>
  );
}

/** A furniture schedule is read area by area, and each area's own total is the number anyone asks for. */
export function groupByArea<T extends { area: string; quantity: number }>(rows: T[]) {
  const out: { area: string; total: number; rows: T[] }[] = [];
  for (const r of rows) {
    const group = out.find((g) => g.area === r.area);
    if (group) {
      group.rows.push(r);
      group.total += r.quantity;
    } else out.push({ area: r.area, total: r.quantity, rows: [r] });
  }
  return out;
}

/**
 * Pick a product by typing at it. This is the only product-choosing UI outside the catalogue: both
 * places that place furniture use this one, so there is a single way to find a chair.
 */
export function FfePicker({
  value,
  onChange,
  autoFocus,
  placeholder = "Search products…",
}: {
  value: FfePick | null;
  onChange: (pick: FfePick | null) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 150);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => setActive(0), [search]);

  // Nothing is read until the field is in use; the catalogue has its own view for browsing.
  const rows: ProductRow[] | undefined = useQuery(api.ffe.products, open ? (search ? { search } : {}) : "skip");
  const hits = (rows ?? []).slice(0, 8);
  const at = Math.min(active, Math.max(0, hits.length - 1));

  const take = (p: ProductRow) => {
    onChange({ id: p._id, name: p.name, maker: p.maker ?? null, finish: p.finish ?? null, category: p.category ?? null });
    setOpen(false);
    setText("");
  };

  if (value)
    return (
      <div className={`flex min-w-0 items-center gap-2 ${FIELD} cursor-default`}>
        <CategoryGlyph category={value.category} />
        <span className="min-w-0 flex-1 truncate">
          {productLabel(value)}
          {value.finish && <span className="text-(--c-t-8a8a8a)"> · {value.finish}</span>}
        </span>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            requestAnimationFrame(() => input.current?.focus());
          }}
          aria-label="Pick a different product"
          title="Pick a different product"
          className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-(--c-t-8a8a8a) hover:bg-(--c-b-f4f4f4) hover:text-(--c-t-1b1b1b)"
        >
          <IconX size={13} />
        </button>
      </div>
    );

  return (
    <div className="relative min-w-0">
      <input
        ref={input}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, Math.max(0, hits.length - 1)));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
          else if (e.key === "Enter" && hits[at]) take(hits[at]);
          else if (e.key === "Escape") setOpen(false);
          else return;
          e.preventDefault();
        }}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && hits[at] ? `${listId}-${at}` : undefined}
        aria-autocomplete="list"
        aria-label="Product"
        placeholder={placeholder}
        className={`${FIELD} w-full`}
      />
      {open && (
        // Clicking a result must not blur the field first, or the list is gone before the click lands
        <div
          id={listId}
          role="listbox"
          aria-label="Products"
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 right-0 top-10 z-30 overflow-hidden rounded-xl border border-(--c-l-e5e5e5) bg-(--c-b-ffffff) p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
        >
          {rows === undefined ? (
            <div className="px-2 py-2.5 text-[13px] text-(--c-t-9a9a9a)">Looking…</div>
          ) : hits.length === 0 ? (
            <div className="px-2 py-2.5 text-[13px] text-(--c-t-9a9a9a)">{search ? `Nothing matches "${search}".` : "No products yet."}</div>
          ) : (
            hits.map((p, n) => (
              <button
                key={p._id}
                id={`${listId}-${n}`}
                type="button"
                role="option"
                aria-selected={n === at}
                onMouseEnter={() => setActive(n)}
                onClick={() => take(p)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px] ${n === at ? "bg-(--c-b-f1f1ef)" : ""}`}
              >
                <CategoryGlyph category={p.category} />
                <span className="min-w-0 flex-1 truncate text-(--c-t-1b1b1b)">{productLabel(p)}</span>
                {p.finish && <span className="shrink-0 truncate text-[12.5px] text-(--c-t-8a8a8a)">{p.finish}</span>}
              </button>
            ))
          )}
          {/* The way out when the thing being specced hasn't been written down yet */}
          <div className="mt-1 border-t border-(--c-l-f0f0f0) px-2 pb-0.5 pt-1.5 text-[12.5px] text-(--c-t-9a9a9a)">
            Not written down yet?{" "}
            <Link href="/?view=ffe" className="font-medium text-(--c-t-2358d8) no-underline hover:underline">
              Add it in FF&amp;E
            </Link>
            , then come back.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Put a product in a club. A placement added from a build-out carries both that project and its
 * club; one added from the club page carries no project at all, which is what the null is for.
 */
export function AddPlacement({
  clubId,
  projectId,
  onCancel,
  autoFocus,
}: {
  clubId: Id<"clubs">;
  /** The build-out that specced it. Left out on a club page: a later addition has no project. */
  projectId?: Id<"projects">;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const add = useMutation(api.ffe.addPlacement);
  const areas: string[] | undefined = useQuery(api.ffe.areas, {});
  const [pick, setPick] = useState<FfePick | null>(null);
  const [area, setArea] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const areaList = useId();

  const submit = () => {
    const n = Number(quantity);
    if (!pick) return setError("Pick a product first.");
    if (!area.trim()) return setError("Say which area it goes in — Lounge, Phone rooms, Cafe.");
    if (!Number.isInteger(n) || n < 1) return setError("Quantity has to be a whole number, 1 or more.");
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await add({ productId: pick.id, clubId, ...(projectId ? { projectId } : {}), area: area.trim(), quantity: n });
        // The area stays: a schedule is written a room at a time.
        setPick(null);
        setQuantity("1");
      } catch (e) {
        setError(ffeError(e, "Couldn't add that"));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="rounded-xl bg-(--c-b-fafaf9) p-2.5 ring-1 ring-(--c-l-ebebeb)">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[220px] flex-1">
          <FfePicker value={pick} onChange={setPick} autoFocus={autoFocus} />
        </div>
        <input
          value={area}
          onChange={(e) => setArea(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          list={areaList}
          aria-label="Area"
          placeholder="Area"
          className={`${FIELD} w-[150px]`}
        />
        <datalist id={areaList}>
          {(areas ?? []).map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        <input
          type="number"
          min={1}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          aria-label="Quantity"
          className={`${FIELD} w-[76px] tabular-nums`}
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="inline-flex h-9 items-center rounded-lg bg-(--c-b-1b1b1b) px-3.5 text-[13.5px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333) disabled:opacity-50"
        >
          Add
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-9 items-center rounded-lg px-2.5 text-[13.5px] text-(--c-t-6b6b6b) hover:bg-(--c-b-f1f1ef) hover:text-(--c-t-1b1b1b)"
          >
            Done
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="m-0 mt-2 text-[12.5px] text-(--c-t-b42318)">
          {error}
        </p>
      )}
    </div>
  );
}
