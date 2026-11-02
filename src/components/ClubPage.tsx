"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { CLUB_STATUSES, PROJECT_TYPES, reviewStatusOf, stagesFor, type ClubStatus, type ProjectType } from "@/lib/types";
import { ShowSidebarButton, useGoBack, useMaybeAppSidebar } from "./HomeSidebar";
import { IconArrowLeft, IconPlus, IconTrash } from "./icons";
import { ClubStatusMark, clubDate } from "./ClubsList";

type ProjectRow = {
  id: Id<"projects">;
  title: string;
  type: ProjectType;
  stage: string;
  targetDate: string | null;
  pinnedAt: number | null;
  updatedAt: number;
};
type ReviewRow = {
  id: Id<"reviews">;
  title: string;
  status: Doc<"reviews">["status"];
  roundCount: number;
  openMarks: number;
  projectId: Id<"projects"> | null;
  projectTitle: string | null;
  thumbUrl: string | null;
  updatedAt: number;
};

/** The fields the club header edits, exactly as convex/clubs.ts takes them. */
type ClubPatch = {
  name?: string;
  neighborhood?: string;
  city?: string;
  address?: string;
  status?: ClubStatus;
  openedAt?: string | null;
  squareFeet?: number | null;
  seats?: number | null;
  notes?: string;
};

/** Where a review lives: the Reviews board, opened on this one. */
const reviewHref = (id: string) => `/?view=reviews&review=${id}`;

const errorText = (e: unknown, fallback: string) =>
  e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.message.replace(/^[\s\S]*ConvexError:\s*/, "").replace(/\s+at [\s\S]*$/, "") : fallback;

/**
 * One club: what it is, what is being built there, and what is waiting to be signed off. Everything
 * in the header is edited in place — there is no separate edit mode to get stuck in.
 */
export function ClubPage({ id }: { id: string }) {
  const data = useQuery(api.clubs.get, { id });
  const update = useMutation(api.clubs.update);
  const remove = useMutation(api.clubs.remove);
  const createProject = useMutation(api.projects.create);
  const router = useRouter();
  const goBack = useGoBack("/?view=clubs");
  const side = useMaybeAppSidebar();
  const club: Doc<"clubs"> | null = data ? data.club : null;
  useDocumentTitle(club ? club.name : null);

  const header = (
    <div className="flex h-[56px] shrink-0 items-center gap-1.5 border-b border-(--c-l-ebebeb) px-3">
      {side && (!side.shown || side.mobile) && <ShowSidebarButton onClick={() => side.toggle(true)} />}
      <Link href="/?view=clubs" onClick={goBack} aria-label="Back" title="Back" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-(--c-t-6b6b6b) hover:bg-(--c-b-f4f4f4)">
        <IconArrowLeft size={16} />
      </Link>
      <span className="min-w-0 flex-1 truncate px-1.5 text-[14.5px] font-medium text-(--c-t-1b1b1b)">{club?.name ?? "Club"}</span>
      {club && (
        <button
          type="button"
          onClick={() => {
            if (!confirm(`Delete "${club.name}"?`)) return;
            void (async () => {
              try {
                await remove({ id: club._id });
                router.push("/?view=clubs");
              } catch (e) {
                alert(errorText(e, "Couldn't delete this club"));
              }
            })();
          }}
          aria-label="Delete club"
          title="Delete club"
          className="flex h-8 w-8 items-center justify-center rounded-md text-(--c-t-9a9a9a) hover:bg-(--c-b-f4f4f4) hover:text-(--c-t-b42318)"
        >
          <IconTrash size={15} />
        </button>
      )}
    </div>
  );

  if (data === undefined)
    return (
      <div className="flex min-h-screen flex-col bg-(--c-b-ffffff)">
        {header}
        <div className="flex flex-1 items-center justify-center text-[14px] text-(--c-t-9a9a9a)">Loading…</div>
      </div>
    );
  if (data === null || !club)
    return (
      <div className="flex min-h-screen flex-col bg-(--c-b-ffffff)">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[14px] text-(--c-t-737373)">
          This club is gone.
          <Link href="/?view=clubs" className="font-medium text-(--c-t-2358d8) no-underline hover:underline">
            All clubs
          </Link>
        </div>
      </div>
    );

  const projects: ProjectRow[] = data.projects;
  const reviews: ReviewRow[] = data.reviews;
  const open = reviews.filter((r) => r.status !== "approved" && r.status !== "archived");
  const settled = reviews.length - open.length;
  const save = (patch: ClubPatch) => void update({ id: club._id, ...patch });

  const start = (type: ProjectType) =>
    void (async () => {
      try {
        router.push(`/p/${await createProject({ type, clubId: club._id })}`);
      } catch (e) {
        alert(errorText(e, "Couldn't start that project"));
      }
    })();

  return (
    <div className="flex min-h-screen flex-col bg-(--c-b-ffffff)">
      {header}
      <main className="mx-auto w-full max-w-[880px] px-5 pb-24 pt-8 sm:px-8">
        <NameField value={club.name} onSave={(name) => save({ name })} />
        <div className="mt-5 grid grid-cols-[112px_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-[14px] leading-[1.5]">
          <Label>Status</Label>
          <label className="relative -ml-1.5 flex w-fit cursor-pointer items-center rounded-md px-1.5 py-0.5 hover:bg-(--c-b-f4f4f4)">
            <ClubStatusMark status={club.status} />
            <select
              aria-label="Status"
              value={club.status}
              onChange={(e) => save({ status: e.target.value as ClubStatus })}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {CLUB_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.glyph} {s.label}
                </option>
              ))}
            </select>
          </label>

          <Label>Neighborhood</Label>
          <Text value={club.neighborhood ?? ""} placeholder="Virginia-Highland" aria="Neighborhood" onSave={(neighborhood) => save({ neighborhood })} />

          <Label>City</Label>
          <Text value={club.city ?? ""} placeholder="Atlanta" aria="City" onSave={(city) => save({ city })} />

          <Label>Address</Label>
          <Text value={club.address ?? ""} placeholder="Street address" aria="Address" onSave={(address) => save({ address })} />

          <Label>{club.status === "open" ? "Opened" : "Opens"}</Label>
          <label className="relative w-fit">
            <span className={`-ml-1.5 block w-fit rounded-md px-1.5 py-0.5 hover:bg-(--c-b-f4f4f4) ${club.openedAt ? "text-(--c-t-1b1b1b)" : "text-(--c-t-9a9a9a)"}`}>
              {clubDate(club.openedAt) ?? "Pick a date"}
            </span>
            <input
              type="date"
              aria-label="Open date"
              value={club.openedAt ?? ""}
              onChange={(e) => save({ openedAt: e.target.value || null })}
              onClick={(e) => (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.()}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>

          <Label>Square feet</Label>
          <Count value={club.squareFeet ?? null} placeholder="3,200" aria="Square feet" onSave={(squareFeet) => save({ squareFeet })} />

          <Label>Seats</Label>
          <Count value={club.seats ?? null} placeholder="64" aria="Seats" onSave={(seats) => save({ seats })} />
        </div>

        <Section title="Projects" count={projects.length}>
          <div className="flex items-center gap-1.5">
            {PROJECT_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => start(t.value)}
                title={t.hint}
                className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[13px] font-medium text-(--c-t-6b6b6b) ring-1 ring-(--c-l-e3e3e0) hover:text-(--c-t-1b1b1b)"
              >
                <IconPlus size={13} />
                {t.label}
              </button>
            ))}
          </div>
        </Section>
        {projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-(--c-l-dcdcdc) px-5 py-10 text-center">
            <p className="m-0 text-[14px] text-(--c-t-737373)">Nothing is being worked on at {club.name} yet.</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {PROJECT_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => start(t.value)}
                  className="inline-flex h-9 items-center rounded-lg bg-(--c-b-1b1b1b) px-3.5 text-[13.5px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333)"
                >
                  Start {t.label.toLowerCase()} work
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {PROJECT_TYPES.map((t) => {
              const mine = projects.filter((p) => p.type === t.value);
              if (!mine.length) return null;
              return (
                <div key={t.value}>
                  <h3 className="m-0 mb-1.5 text-[12px] font-medium uppercase tracking-[0.05em] text-(--c-t-9a9a9a)">{t.label}</h3>
                  <div className="flex flex-col gap-3">
                    {/* Each project's own pipeline decides its stages; the two never share a value */}
                    {stagesFor(t.value).map((stage) => {
                      const list = mine.filter((p) => p.stage === stage.value);
                      if (!list.length) return null;
                      return (
                        <div key={stage.value}>
                          <div className="mb-1 flex items-center gap-1.5 text-[12.5px] text-(--c-t-737373)">
                            <span style={{ color: stage.hex }} className="leading-none" title={`${stage.label} (${stage.colorName})`} aria-hidden="true">
                              {stage.glyph}
                            </span>
                            <span className="font-medium text-(--c-t-4a4a4a)">{stage.label}</span>
                            <span className="tabular-nums text-(--c-t-9a9a9a)">{list.length}</span>
                          </div>
                          <ul className="m-0 flex list-none flex-col gap-1 p-0">
                            {list.map((p) => (
                              <li key={p.id}>
                                <Link
                                  href={`/p/${p.id}`}
                                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[14px] text-(--c-t-1b1b1b) no-underline hover:bg-(--c-b-f4f4f4)"
                                >
                                  <span className="min-w-0 flex-1 truncate">{p.title || "Untitled project"}</span>
                                  {p.targetDate && <span className="shrink-0 text-[12.5px] text-(--c-t-8a8a8a)">{clubDate(p.targetDate)}</span>}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <Section title="Reviews" count={open.length} />
        {open.length === 0 ? (
          <p className="m-0 text-[13.5px] text-(--c-t-9a9a9a)">
            Nothing waiting to be looked at.{settled > 0 ? ` ${settled} already settled.` : ""}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {open.map((r) => {
                const st = reviewStatusOf(r.status);
                return (
                  <Link
                    key={r.id}
                    href={reviewHref(r.id)}
                    className="flex items-center gap-3 rounded-xl bg-(--c-b-ffffff) p-2 no-underline ring-1 ring-(--c-l-ebebeb) hover:bg-(--c-b-fafaf9)"
                  >
                    <div className="h-[44px] w-[60px] shrink-0 overflow-hidden rounded-md bg-(--c-b-ececea)">
                      {r.thumbUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.thumbUrl} alt="" className="h-full w-full object-cover" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-(--c-t-1b1b1b)">{r.title}</div>
                      <div className="truncate text-[12.5px] text-(--c-t-8a8a8a)">
                        v{r.roundCount}
                        {r.projectTitle ? ` · ${r.projectTitle}` : ""}
                        {r.openMarks > 0 ? ` · ${r.openMarks} open mark${r.openMarks === 1 ? "" : "s"}` : ""}
                      </div>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium" style={{ color: st.hex, background: `${st.hex}14` }}>
                      <span aria-hidden="true">{st.glyph}</span>
                      {st.label}
                    </span>
                  </Link>
                );
              })}
            </div>
            {settled > 0 && <p className="m-0 mt-2 text-[12.5px] text-(--c-t-9a9a9a)">{settled} more already settled.</p>}
          </>
        )}

        <Section title="Notes" />
        <Notes value={club.notes ?? ""} onSave={(notes) => save({ notes })} />
      </main>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-(--c-t-737373)">{children}</div>;
}

function Section({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
  return (
    <div className="mb-3 mt-10 flex items-center gap-2 border-b border-(--c-l-ebebeb) pb-2">
      <h2 className="m-0 text-[16px] font-semibold text-(--c-t-1b1b1b)">{title}</h2>
      {count !== undefined && <span className="text-[13px] tabular-nums text-(--c-t-9a9a9a)">{count}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

const fieldCls = "-ml-1.5 w-full max-w-[420px] rounded-md bg-transparent px-1.5 py-0.5 text-[14px] text-(--c-t-1b1b1b) outline-none hover:bg-(--c-b-f4f4f4) focus:bg-(--c-b-f4f4f4) placeholder:text-(--c-t-9a9a9a)";

/** The club's name, big, edited where it is shown. */
function NameField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() && draft !== value) onSave(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label="Club name"
      placeholder="Untitled club"
      className="-ml-1.5 block w-full rounded-md bg-transparent px-1.5 text-[32px] font-semibold leading-[1.2] tracking-[-0.015em] text-(--c-t-1b1b1b) outline-none hover:bg-(--c-b-f4f4f4) focus:bg-(--c-b-f4f4f4) placeholder:text-(--c-t-c9c9c9)"
    />
  );
}

function Text({ value, placeholder, aria, onSave }: { value: string; placeholder: string; aria: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onSave(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label={aria}
      placeholder={placeholder}
      className={fieldCls}
    />
  );
}

/** A plain count. Blank clears it rather than storing a zero, which would read as "none of them". */
function Count({ value, placeholder, aria, onSave }: { value: number | null; placeholder: string; aria: string; onSave: (v: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={0}
      value={draft ?? (value === null ? "" : String(value))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) {
          const next = draft.trim() === "" ? null : Number(draft);
          if (next !== value && (next === null || Number.isFinite(next))) onSave(next);
        }
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-label={aria}
      placeholder={placeholder}
      className={`${fieldCls} max-w-[160px]`}
    />
  );
}

/** Landlord, GC, lease dates — anything worth keeping on the club itself. */
function Notes({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <textarea
      value={draft ?? value}
      rows={5}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onSave(draft);
        setDraft(null);
      }}
      aria-label="Notes"
      placeholder="Landlord, GC, lease dates, anything worth keeping on the club itself."
      className="block w-full resize-y rounded-xl bg-(--c-b-fafaf9) px-3 py-2.5 text-[14px] leading-[1.6] text-(--c-t-262626) outline-none ring-1 ring-(--c-l-ebebeb) focus:ring-(--c-l-c9c9c9) placeholder:text-(--c-t-9a9a9a)"
    />
  );
}
