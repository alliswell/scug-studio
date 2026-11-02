"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { clubStatusOf } from "@/lib/types";
import { IconGrip, IconPlus } from "./icons";

type ClubRow = Doc<"clubs"> & { projectCount: number; activeCount: number };

/** YYYY-MM-DD read as a local day; the plain Date constructor would shift it by a timezone. */
export const clubDate = (d: string | null | undefined) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;

/** A club's status as a glyph and a word, so it never rests on color alone. */
export function ClubStatusMark({ status, size = 13 }: { status: string; size?: number }) {
  const s = clubStatusOf(status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span style={{ color: s.hex, fontSize: size }} className="leading-none" title={`${s.label} (${s.colorName})`} aria-hidden="true">
        {s.glyph}
      </span>
      {s.label}
    </span>
  );
}

/**
 * Every club in the network. Hand-ordered: drag a card onto another to put it there, which is the
 * order the sidebar and the Clubs list both use.
 */
export function ClubsList() {
  const clubs = useQuery(api.clubs.list);
  const reviews = useQuery(api.reviews.list, {});
  const reorder = useMutation(api.clubs.reorder);
  const [dragging, setDragging] = useState<Id<"clubs"> | null>(null);
  const [over, setOver] = useState<Id<"clubs"> | null>(null);
  const [composing, setComposing] = useState(false);
  const rows: ClubRow[] | undefined = clubs;
  const reviewRows: Doc<"reviews">[] | undefined = reviews;

  // A review is "waiting" while someone still owes it something. Approved and dropped ones don't count.
  const waiting = new Map<string, number>();
  for (const r of reviewRows ?? []) {
    if (!r.clubId || r.status === "approved" || r.status === "archived") continue;
    waiting.set(r.clubId, (waiting.get(r.clubId) ?? 0) + 1);
  }

  const drop = (targetId: Id<"clubs">) => {
    if (!rows || !dragging || dragging === targetId) return;
    const ids = rows.map((c) => c._id).filter((x) => x !== dragging);
    ids.splice(ids.indexOf(targetId), 0, dragging);
    void reorder({ ids });
  };

  return (
    <div className="mx-auto max-w-[1180px]">
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[28px] font-semibold tracking-[-0.015em] text-(--c-t-1b1b1b)">Clubs</h1>
          <p className="m-0 mt-1 text-[14px] text-(--c-t-737373)">Every neighborhood club, and what is in flight at each one.</p>
        </div>
        <button
          type="button"
          onClick={() => setComposing(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-(--c-b-1b1b1b) px-3.5 text-[14px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333)"
        >
          <IconPlus size={14} color="var(--c-on-ink)" />
          New club
        </button>
      </div>

      {composing && <NewClub onDone={() => setComposing(false)} />}

      {rows === undefined ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-[168px] animate-pulse rounded-2xl bg-(--c-b-ececea)" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-(--c-l-dcdcdc) py-16 text-center">
          <p className="m-0 text-[15px] font-medium text-(--c-t-1b1b1b)">No clubs yet.</p>
          <p className="m-0 mt-1 text-[13.5px] text-(--c-t-737373)">Add the first one and its projects, drawings and reviews hang off it.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((c) => {
            const st = clubStatusOf(c.status);
            const place = [c.neighborhood, c.city].filter(Boolean).join(", ");
            const open = clubDate(c.openedAt);
            const wait = waiting.get(c._id) ?? 0;
            return (
              <Link
                key={c._id}
                href={`/c/${c._id}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/x-club", c._id);
                  e.dataTransfer.effectAllowed = "move";
                  setDragging(c._id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  if (over !== c._id) setOver(c._id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(c._id);
                  setDragging(null);
                  setOver(null);
                }}
                className={`group relative flex flex-col gap-2 rounded-2xl bg-(--kb-card) p-3.5 no-underline shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 transition-[box-shadow,transform,opacity] hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(0,0,0,0.08)] ${
                  over === c._id && dragging !== c._id ? "ring-2 ring-[#2358d8]/50" : "ring-(--kb-card-ring)"
                } ${dragging === c._id ? "opacity-40" : ""}`}
              >
                {c.coverUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.coverUrl} alt="" className="-mx-1 -mt-1 h-[108px] w-[calc(100%+8px)] rounded-xl object-cover" />
                )}
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-(--c-t-1b1b1b)">{c.name || "Untitled club"}</div>
                    <div className="truncate text-[12.5px] text-(--c-t-8a8a8a)">{place || "No neighborhood set"}</div>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium" style={{ color: st.hex, background: `${st.hex}14` }}>
                    <span aria-hidden="true">{st.glyph}</span>
                    {st.label}
                  </span>
                  <IconGrip size={14} />
                </div>

                <dl className="m-0 grid grid-cols-3 gap-2 text-[12.5px]">
                  <Fact label={c.status === "open" ? "Opened" : "Opens"} value={open} />
                  <Fact label="Size" value={c.squareFeet ? `${c.squareFeet.toLocaleString()} sq ft` : null} />
                  <Fact label="Seats" value={c.seats ? String(c.seats) : null} />
                </dl>

                <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[12px] text-(--c-t-737373)">
                  <span>
                    {c.activeCount} in flight
                    {c.projectCount !== c.activeCount ? ` of ${c.projectCount}` : ""}
                  </span>
                  {wait > 0 && (
                    <span className="rounded-full bg-(--c-b-fdf3cf) px-1.5 py-px font-medium text-(--c-t-7a5b00)">
                      {wait} review{wait === 1 ? "" : "s"} waiting
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] uppercase tracking-[0.04em] text-(--c-t-9a9a9a)">{label}</dt>
      <dd className={`m-0 truncate ${value ? "text-(--c-t-2e2e2e)" : "text-(--c-t-b0b0b0)"}`}>{value ?? "—"}</dd>
    </div>
  );
}

/** A club starts with a name; everything else is filled in on its page. */
function NewClub({ onDone }: { onDone: () => void }) {
  const create = useMutation(api.clubs.create);
  const router = useRouter();
  const [name, setName] = useState("");
  const busy = useRef(false);
  const save = async () => {
    const n = name.trim();
    if (!n || busy.current) return;
    busy.current = true;
    try {
      router.push(`/c/${await create({ name: n })}`);
    } catch (e) {
      busy.current = false;
      alert(e instanceof Error ? e.message : "Couldn't add the club");
    }
  };
  return (
    <div className="mb-4 flex items-center gap-2 rounded-xl bg-(--c-b-ffffff) p-2 ring-1 ring-(--c-l-e3e3e0)">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          else if (e.key === "Escape") onDone();
        }}
        placeholder="Club name, e.g. Virginia-Highland"
        aria-label="Club name"
        className="h-9 min-w-0 flex-1 bg-transparent px-2 text-[14.5px] text-(--c-t-1b1b1b) outline-none placeholder:text-(--c-t-9a9a9a)"
      />
      <button type="button" onClick={onDone} className="h-8 rounded-lg px-2.5 text-[13px] text-(--c-t-737373) hover:bg-(--c-b-f4f4f4)">
        Cancel
      </button>
      <button
        type="button"
        disabled={!name.trim()}
        onClick={() => void save()}
        className="h-8 rounded-lg bg-(--c-b-1b1b1b) px-3.5 text-[13px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333) disabled:opacity-40"
      >
        Add club
      </button>
    </div>
  );
}
