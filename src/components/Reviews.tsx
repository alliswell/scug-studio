"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { uploadToUrl } from "@/lib/upload";
import { MARK_KINDS, REVIEW_FILE_ACCEPT, REVIEW_STATUSES, isPdfSheet, isReviewSheet, markKindOf, reviewStatusOf, type MarkKind, type ReviewStatus } from "@/lib/types";
import { IconTrash, IconUpload, IconX } from "./icons";
import { SheetView, type PinPoint, type SheetMark } from "./SheetView";

/** The board's columns. "Dropped" is not one of them — it lives behind the archive button. */
const COLUMNS = REVIEW_STATUSES.filter((s) => s.value !== "archived");

type ReviewRow = Doc<"reviews"> & {
  thumbUrl: string | null;
  fileCount: number;
  openMarks: number;
  projectTitle: string | null;
  clubName: string | null;
};
type SheetFile = { url: string | null; mime: string | null; name: string | null };
type Round = { _id: Id<"reviewRounds">; number: number; note: string; by: string | null; agent: boolean; createdAt: number; files: SheetFile[] };
type Mark = Doc<"reviewMarks"> & { attachments: Doc<"reviewRounds">["files"] };
type SheetArg = { storageId: Id<"_storage">; mime: string; name: string };

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** The status, as a glyph and a word. Never the color on its own. */
function StatusMark({ status, size = 13 }: { status: string; size?: number }) {
  const s = reviewStatusOf(status);
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
 * Reviews: sets of visuals — renders, floor plans, elevations, finish boards — carried through
 * numbered rounds. A designer posts a round; you open it, pin marks to the sheet itself and press
 * Request changes; the next round answers them.
 */
export function Reviews() {
  const reviews = useQuery(api.reviews.list, {});
  const update = useMutation(api.reviews.update);
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<ReviewStatus | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const rows: ReviewRow[] | undefined = reviews;
  const archived = (rows ?? []).filter((r) => r.status === "archived");

  // ?review=<id> (the link an agent shares) opens that review.
  // ?project=<id> arrives from a project's Visuals tab: a new review started here attaches to it.
  const [forProject, setForProject] = useState<Id<"projects"> | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get("review");
    if (id) setOpen(id);
    const p = q.get("project");
    if (p) setForProject(p as Id<"projects">);
  }, []);
  const forProjectTitle = forProject ? ((rows ?? []).find((r) => r.projectId === forProject)?.projectTitle ?? null) : null;
  const openReview = (id: string | null) => {
    setOpen(id);
    const u = new URL(window.location.href);
    if (id) u.searchParams.set("review", id);
    else u.searchParams.delete("review");
    window.history.replaceState(null, "", u);
  };

  return (
    <div className="mx-auto max-w-[1180px]">
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[28px] font-semibold tracking-[-0.015em] text-(--c-t-1b1b1b)">Reviews</h1>
          <p className="m-0 mt-1 text-[14px] text-(--c-t-737373)">
            {forProject
              ? `New sheets put up here go on ${forProjectTitle ?? "the project you came from"}.`
              : "Visuals under review. Pin marks to the sheet, request changes, and the next round comes back as v2."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowArchive(!showArchive)}
          aria-pressed={showArchive}
          title={showArchive ? "Back to the board" : "Dropped reviews"}
          className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium ring-1 ${
            showArchive ? "bg-(--c-b-1b1b1b) text-(--c-on-ink) ring-transparent" : "text-(--c-t-6b6b6b) ring-(--c-l-e3e3e0) hover:text-(--c-t-1b1b1b)"
          }`}
        >
          <ArchiveIcon />
          {archived.length > 0 && <span className="tabular-nums">{archived.length}</span>}
        </button>
        <SheetUpload label="New review" projectId={forProject ?? undefined} onDone={(id) => id && openReview(id)} />
      </div>

      {showArchive && rows !== undefined && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="m-0 text-[17px] font-semibold text-(--c-t-1b1b1b)">Dropped</h2>
            <span className="text-[13px] text-(--c-t-9a9a9a)">Directions you walked away from. The marks say why.</span>
          </div>
          {archived.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-(--c-l-dcdcdc) py-12 text-center text-[13.5px] text-(--c-t-9a9a9a)">
              Nothing dropped yet. Open a review and press the archive icon.
            </div>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {archived.map((r) => (
                <Card key={r._id} r={r} dragging={false} onOpen={() => openReview(r._id)} onDragStart={(e) => e.preventDefault()} onDragEnd={() => {}} />
              ))}
            </div>
          )}
        </div>
      )}

      {showArchive ? null : rows === undefined ? (
        <div className="grid gap-4 md:grid-cols-3">
          {COLUMNS.map((c) => (
            <div key={c.value} className="h-[220px] animate-pulse rounded-2xl bg-(--c-b-ececea)" />
          ))}
        </div>
      ) : (
        <div className="-mx-5 overflow-x-auto px-5 pb-4 max-md:snap-x max-md:snap-mandatory">
          <div className="flex min-w-max items-start gap-4 md:grid md:min-w-0 md:grid-cols-3">
            {COLUMNS.map((col) => {
              const list = rows.filter((r) => r.status === col.value);
              const isOver = over === col.value && !!dragging;
              const done = col.value === "approved";
              return (
                <section
                  key={col.value}
                  aria-label={col.label}
                  onDragOver={(e) => {
                    if (!dragging) return;
                    e.preventDefault();
                    if (over !== col.value) setOver(col.value);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === col.value ? null : o));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData("text/x-review") || dragging;
                    if (id) void update({ id: id as Id<"reviews">, status: col.value });
                    setDragging(null);
                    setOver(null);
                  }}
                  className={`flex w-[300px] shrink-0 snap-start flex-col rounded-2xl p-3 transition-colors md:w-auto ${
                    isOver ? "bg-(--kb-drop) ring-2 ring-[#2358d8]/40" : done ? "bg-(--kb-done-bg) ring-1 ring-(--kb-done-ring)" : "bg-(--c-b-efefed)"
                  }`}
                >
                  <header className="flex h-8 items-center gap-2 px-1">
                    {/* The glyph is what names the column; the color only repeats it */}
                    <span className="text-[13px] leading-none" style={{ color: col.hex }} title={`${col.label} (${col.colorName})`} aria-hidden="true">
                      {col.glyph}
                    </span>
                    <h2 className={`m-0 text-[13.5px] font-semibold ${done ? "text-(--kb-done-text)" : "text-(--c-t-1b1b1b)"}`}>{col.label}</h2>
                    <span className="text-[12.5px] tabular-nums text-(--c-t-9a9a9a)">{list.length}</span>
                  </header>
                  <div className="mt-1 flex min-h-[72px] flex-col gap-2">
                    {list.map((r) => (
                      <Card
                        key={r._id}
                        r={r}
                        dragging={dragging === r._id}
                        onOpen={() => openReview(r._id)}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/x-review", r._id);
                          e.dataTransfer.effectAllowed = "move";
                          setDragging(r._id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setOver(null);
                        }}
                      />
                    ))}
                    {!list.length && (
                      <div className="flex h-[72px] items-center justify-center rounded-xl border border-dashed border-(--c-l-dcdcdc) px-4 text-center text-[12.5px] text-(--c-t-9a9a9a)">
                        {dragging ? "Drop here" : col.value === "inReview" ? "New rounds land here" : "Nothing here"}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {open && <ReviewDetail id={open} onClose={() => openReview(null)} />}
    </div>
  );
}

function Card({
  r,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  r: ReviewRow;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const where = [r.clubName, r.projectTitle].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`group flex w-full gap-3 rounded-xl bg-(--kb-card) p-2 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-(--kb-card-ring) transition-[box-shadow,transform,opacity] hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(0,0,0,0.08)] ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <div className="relative h-[72px] w-[96px] shrink-0 overflow-hidden rounded-lg bg-(--c-b-ececea)">
        {r.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={r.thumbUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[11px] text-(--c-t-9a9a9a)">No sheet</span>
        )}
        <span className="absolute left-1 top-1 rounded bg-black/65 px-1 text-[10.5px] font-semibold leading-[16px] text-white">v{r.roundCount}</span>
        {r.fileCount > 1 && (
          <span className="absolute bottom-1 right-1 rounded bg-black/65 px-1 text-[10.5px] font-semibold leading-[16px] text-white">{r.fileCount} sheets</span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col py-0.5">
        <div className="line-clamp-2 text-[13.5px] font-medium leading-[1.35] text-(--c-t-1b1b1b)">{r.title}</div>
        {where && <div className="mt-0.5 truncate text-[12px] text-(--c-t-8a8a8a)">{where}</div>}
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-(--c-t-8a8a8a)">
          {r.changesRequestedAt ? (
            <span className="rounded-full bg-(--c-b-fdf3cf) px-1.5 py-px text-[11px] font-medium text-(--c-t-7a5b00)">Changes requested</span>
          ) : null}
          {r.openMarks > 0 && (
            <span>
              {r.openMarks} open mark{r.openMarks === 1 ? "" : "s"}
            </span>
          )}
          <span>{ago(r.updatedAt)}</span>
        </div>
      </div>
    </button>
  );
}

/**
 * Put sheets up: a new review (v1), or the next round of one. A round holds several sheets, so this
 * takes a whole plan set at once and keeps them in the order they were picked.
 */
function SheetUpload({
  label,
  reviewId,
  projectId,
  onDone,
  small,
}: {
  label: string;
  reviewId?: Id<"reviews">;
  /** Set when the upload came from a project's Visuals tab, so the new review lands on that project */
  projectId?: Id<"projects">;
  onDone?: (id: string | null) => void;
  small?: boolean;
}) {
  const uploadUrl = useMutation(api.docs.generateUploadUrl);
  const create = useMutation(api.reviews.create);
  const addRound = useMutation(api.reviews.addRound);
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const pick = async (picked: File[]) => {
    const files = picked.filter((f) => isReviewSheet(f.type));
    if (!files.length) return alert("A sheet has to be an image or a PDF — something you can mark up.");
    setProgress(0);
    try {
      const out: SheetArg[] = [];
      for (const [i, f] of files.entries()) {
        const storageId = (await uploadToUrl(await uploadUrl(), f, (p) => setProgress((i + p) / files.length))) as Id<"_storage">;
        out.push({ storageId, mime: f.type, name: f.name });
      }
      if (reviewId) {
        await addRound({ id: reviewId, files: out });
        onDone?.(reviewId);
      } else {
        const title = files[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
        onDone?.(await create({ title, files: out, projectId }));
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setProgress(null);
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={REVIEW_FILE_ACCEPT}
        multiple
        hidden
        onChange={(e) => void pick(Array.from(e.target.files ?? [])).finally(() => (e.target.value = ""))}
      />
      <button
        type="button"
        disabled={progress !== null}
        onClick={() => input.current?.click()}
        className={
          small
            ? "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-(--c-t-6b6b6b) ring-1 ring-(--c-l-e0e0dd) hover:text-(--c-t-1b1b1b) disabled:opacity-60"
            : "inline-flex h-9 items-center gap-1.5 rounded-lg bg-(--c-b-1b1b1b) px-3.5 text-[14px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333) disabled:opacity-60"
        }
      >
        <IconUpload size={14} color={small ? undefined : "var(--c-on-ink)"} />
        {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : label}
      </button>
    </>
  );
}

/** One review: the round's sheets on the left, the marks on them down the right. */
function ReviewDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const data = useQuery(api.reviews.get, { id });
  const update = useMutation(api.reviews.update);
  const requestChanges = useMutation(api.reviews.requestChanges);
  const cancelChanges = useMutation(api.reviews.cancelChanges);
  const approve = useMutation(api.reviews.approve);
  const remove = useMutation(api.reviews.remove);
  const [round, setRound] = useState<number | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [pinning, setPinning] = useState(false);
  const [pending, setPending] = useState<PinPoint | null>(null);
  const [jump, setJump] = useState<{ id: string; nonce: number } | null>(null);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const nonce = useRef(0);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement).closest("textarea,input")) return;
      // The sheet gets Escape first while a mark is being placed
      if (pinning || pending) return;
      onClose();
    };
    window.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = prev;
    };
  }, [onClose, pinning, pending]);

  // Show the newest round, and jump to it when one lands
  const latest: number = data?.review?.roundCount ?? 0;
  const lastSeen = useRef(0);
  useEffect(() => {
    if (latest && latest !== lastSeen.current) {
      lastSeen.current = latest;
      setRound(latest);
      setFileIndex(0);
    }
  }, [latest]);

  const shell = (children: ReactNode) =>
    createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Review"
        className="fixed inset-0 z-[90] flex items-stretch justify-center bg-black/40 p-0 backdrop-blur-[2px] sm:p-6"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="flex w-full max-w-[1240px] flex-col overflow-hidden bg-(--c-b-ffffff) shadow-[0_24px_80px_rgba(0,0,0,0.3)] sm:rounded-2xl">{children}</div>
      </div>,
      document.body,
    );

  if (data === undefined) return shell(<div className="flex flex-1 items-center justify-center text-[14px] text-(--c-t-9a9a9a)">Loading…</div>);
  if (data === null)
    return shell(
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[14px] text-(--c-t-737373)">
        This review was deleted.
        <button type="button" onClick={onClose} className="font-medium text-(--c-t-2358d8)">
          Close
        </button>
      </div>,
    );

  const review: Doc<"reviews"> = data.review;
  const rounds: Round[] = data.rounds;
  const allMarks: Mark[] = data.marks;
  const reviewId = review._id;
  const shown = rounds.find((x) => x.number === round) ?? rounds[rounds.length - 1];
  const marks = allMarks.filter((m) => m.roundNumber === shown?.number);
  const sheetMarks: SheetMark[] = marks.map((m) => ({
    id: m._id,
    fileIndex: m.fileIndex,
    page: m.page ?? 1,
    x: m.x ?? null,
    y: m.y ?? null,
    rects: m.rects ?? [],
    markKind: m.markKind ?? null,
    text: m.text,
    resolved: !!m.resolved,
  }));
  const where = [data.club?.name, data.project?.title].filter(Boolean).join(" · ");
  // The two panes point at each other: a row scrolls the sheet to its pin, a pin scrolls the
  // panel to its row. Either way you end up looking at the same mark twice.
  const jumpTo = (markId: string) => setJump({ id: markId, nonce: ++nonce.current });
  const focusOn = (markId: string) => setFocus({ id: markId, nonce: ++nonce.current });

  return shell(
    <>
      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-(--c-l-ebebeb) px-4 py-2">
        <div className="flex min-w-[200px] flex-1 flex-col">
          <input
            value={title ?? review.title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (title !== null && title !== review.title) void update({ id: reviewId, title });
              setTitle(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Title"
            className="h-9 min-w-0 rounded-md bg-transparent px-2 text-[16px] font-semibold text-(--c-t-1b1b1b) outline-none hover:bg-(--c-b-f4f4f4) focus:bg-(--c-b-f4f4f4)"
          />
          {where && <span className="truncate px-2 text-[12px] text-(--c-t-8a8a8a)">{where}</span>}
        </div>
        <div className="hidden items-center rounded-lg bg-(--c-b-f4f4f2) p-0.5 sm:flex" role="radiogroup" aria-label="Status">
          {review.status === "archived" && <span className="px-2.5 text-[13px] font-medium text-(--c-t-737373)">Dropped</span>}
          {review.status !== "archived" &&
            COLUMNS.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={review.status === c.value}
                onClick={() => void update({ id: reviewId, status: c.value })}
                className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] ${
                  review.status === c.value ? "bg-(--c-b-ffffff) font-medium text-(--c-t-1b1b1b) shadow-sm" : "text-(--c-t-737373) hover:text-(--c-t-1b1b1b)"
                }`}
              >
                <StatusMark status={c.value} size={12} />
              </button>
            ))}
        </div>
        {review.status === "archived" ? (
          <button
            type="button"
            onClick={() => void update({ id: reviewId, status: "inReview" })}
            title="Put it back in review"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-(--c-t-6b6b6b) ring-1 ring-(--c-l-e3e3e0) hover:text-(--c-t-1b1b1b)"
          >
            <ArchiveIcon />
            Restore
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void update({ id: reviewId, status: "archived" })}
            aria-label="Drop this review"
            title="Drop this review. Say why in a mark, so the reasoning survives."
            className="flex h-9 w-9 items-center justify-center rounded-lg text-(--c-t-8a8a8a) hover:bg-(--c-b-f4f4f4) hover:text-(--c-t-1b1b1b)"
          >
            <ArchiveIcon />
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete "${review.title}" and all its rounds? This can't be undone.`)) {
              void remove({ id: reviewId });
              onClose();
            }
          }}
          aria-label="Delete review"
          title="Delete review"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-(--c-t-9a9a9a) hover:bg-(--c-b-f4f4f4) hover:text-(--c-t-b42318)"
        >
          <IconTrash size={16} />
        </button>
        <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-lg text-(--c-t-6b6b6b) hover:bg-(--c-b-f4f4f4)">
          <IconX />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        {/* The round's sheets */}
        <div className="flex min-h-[380px] shrink-0 flex-col md:min-h-0 md:w-[58%] md:border-r md:border-(--c-l-ebebeb)">
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pt-3" role="tablist" aria-label="Rounds">
            {rounds.map((x) => {
              const n = allMarks.filter((m) => m.roundNumber === x.number).length;
              const on = x.number === shown?.number;
              return (
                <button
                  key={x.number}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => {
                    setRound(x.number);
                    setFileIndex(0);
                    setPending(null);
                  }}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium ring-1 ${
                    on ? "bg-(--c-b-1b1b1b) text-(--c-on-ink) ring-transparent" : "bg-(--c-b-ffffff) text-(--c-t-4a4a4a) ring-(--c-l-e3e3e0) hover:ring-(--c-l-c9c9c9)"
                  }`}
                >
                  v{x.number}
                  {x.number === review.roundCount && <span className={`text-[11px] font-normal ${on ? "opacity-70" : "text-(--c-t-9a9a9a)"}`}>latest</span>}
                  {n > 0 && <span className={`text-[11px] font-normal ${on ? "opacity-70" : "text-(--c-t-9a9a9a)"}`}>· {n}</span>}
                </button>
              );
            })}
            <span className="flex-1" />
            <SheetUpload label="Post the next round" reviewId={reviewId} small />
          </div>
          {shown && (
            <div className="shrink-0 px-3 pt-2 text-[12px] text-(--c-t-9a9a9a)">
              v{shown.number} · {shown.by ?? "Someone"}
              {shown.agent && shown.by !== "Agent" ? " (agent)" : ""} · {ago(shown.createdAt)}
              {shown.note && <span className="ml-1.5 whitespace-pre-wrap text-(--c-t-2e2e2e)">{shown.note}</span>}
            </div>
          )}
          <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-hidden border-t border-(--c-l-ebebeb)">
            <SheetView
              key={shown?.number}
              sheets={shown?.files ?? []}
              index={fileIndex}
              onIndex={(i) => {
                setFileIndex(i);
                setPending(null);
              }}
              marks={sheetMarks}
              pinning={pinning}
              onPinning={setPinning}
              pending={pending}
              onPin={setPending}
              onPinCancel={() => setPending(null)}
              onOpenMark={focusOn}
              jump={jump}
            />
          </div>
        </div>

        {/* The marks on it */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--c-l-ebebeb) px-5 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="m-0 text-[14px] font-semibold text-(--c-t-1b1b1b)">
                Marks <span className="font-normal text-(--c-t-9a9a9a)">v{shown?.number}{shown?.number === review.roundCount ? "" : " (earlier)"}</span>
              </h2>
            </div>
            {review.status === "archived" ? (
              <span className="rounded-full bg-(--c-b-f1f1ef) px-2.5 py-1 text-[12.5px] text-(--c-t-6b6b6b)">Dropped: say why in a mark</span>
            ) : review.changesRequestedAt ? (
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-(--c-b-fdf3cf) px-2.5 py-1 text-[12.5px] font-medium text-(--c-t-7a5b00)">Changes requested · {ago(review.changesRequestedAt)}</span>
                <button type="button" onClick={() => void cancelChanges({ id: reviewId })} className="text-[12.5px] text-(--c-t-737373) hover:text-(--c-t-1b1b1b)">
                  Undo
                </button>
              </div>
            ) : review.status === "approved" ? (
              <span className="rounded-full bg-(--c-b-e6f4ea) px-2.5 py-1 text-[12.5px] font-medium text-(--c-t-15803d)">
                <StatusMark status="approved" size={12} />
                {review.approvedBy ? ` by ${review.approvedBy}` : ""}
              </span>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void requestChanges({ id: reviewId })}
                  title="Hand the marks on this round back to the designer; the next round answers them"
                  className="inline-flex h-9 items-center rounded-lg bg-(--c-b-1b1b1b) px-3.5 text-[13.5px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333)"
                >
                  Request changes
                </button>
                <button
                  type="button"
                  onClick={() => void approve({ id: reviewId })}
                  title="Sign this round off"
                  className="inline-flex h-9 items-center rounded-lg px-3 text-[13.5px] font-medium text-(--c-t-6b6b6b) ring-1 ring-(--c-l-e3e3e0) hover:text-(--c-t-1b1b1b)"
                >
                  Approve
                </button>
              </div>
            )}
          </div>

          <MarksPanel marks={marks} sheets={shown?.files ?? []} onJump={jumpTo} focus={focus} />
          {shown && (
            <Composer
              key={shown.number}
              reviewId={reviewId}
              round={shown.number}
              fileIndex={fileIndex}
              sheetName={shown.files[fileIndex]?.name ?? null}
              pending={pending}
              onClearPin={() => setPending(null)}
              onStartPin={() => setPinning(true)}
            />
          )}
        </div>
      </div>
    </>,
  );
}

/**
 * The marks on the round being shown, grouped by sheet. The server orders them the way an eye
 * crosses a drawing — sheet, page, down, across — so this keeps the order it is given.
 */
function MarksPanel({
  marks,
  sheets,
  onJump,
  focus,
}: {
  marks: Mark[];
  sheets: SheetFile[];
  onJump: (id: string) => void;
  /** A pin was clicked on the sheet; bring its row up and ring it. */
  focus: { id: string; nonce: number } | null;
}) {
  if (!marks.length)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p className="m-0 py-8 text-center text-[13.5px] text-(--c-t-9a9a9a)">
          Nothing marked on this round yet. Press <b className="font-medium text-(--c-t-4a4a4a)">Pin a mark</b> (or N), then click the sheet.
        </p>
      </div>
    );
  const order = [...new Set(marks.map((m) => m.fileIndex))];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-4">
        {order.map((fi) => (
          <div key={fi}>
            {sheets.length > 1 && (
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-(--c-t-9a9a9a)">
                {sheets[fi]?.name?.replace(/\.[^.]+$/, "") || `Sheet ${fi + 1}`}
              </div>
            )}
            <div className="flex flex-col gap-2.5">
              {marks.filter((m) => m.fileIndex === fi).map((m) => (
                <MarkCard key={m._id} m={m} multiPage={isPdfSheet(sheets[fi]?.mime)} onJump={onJump} focus={focus} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MarkCard({
  m,
  multiPage,
  onJump,
  focus,
}: {
  m: Mark;
  multiPage: boolean;
  onJump: (id: string) => void;
  focus: { id: string; nonce: number } | null;
}) {
  const updateMark = useMutation(api.reviews.updateMark);
  const removeMark = useMutation(api.reviews.removeMark);
  const box = useRef<HTMLDivElement>(null);
  const [lit, setLit] = useState(false);
  const k = markKindOf(m.markKind);
  const pinned = (m.x !== null && m.x !== undefined) || !!m.rects?.length;
  const mine = focus?.id === m._id;
  const nonce = mine ? focus.nonce : 0;
  useEffect(() => {
    if (!nonce) return;
    box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setLit(true);
    const t = setTimeout(() => setLit(false), 1600);
    return () => clearTimeout(t);
  }, [nonce]);
  return (
    <div
      ref={box}
      className={`group rounded-xl px-3.5 py-2.5 ring-1 ${lit ? "ring-2 ring-(--c-l-2358d8)" : "ring-(--c-l-ebebeb)"} ${m.resolved ? "bg-(--c-b-fafaf9)" : "bg-(--c-b-ffffff)"}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-(--c-t-9a9a9a)">
        {/* The glyph and the word both; the color is the third telling, not the only one */}
        <button
          type="button"
          onClick={() => pinned && onJump(m._id)}
          disabled={!pinned}
          title={pinned ? `Show it on the sheet — ${k.label} (${k.colorName})` : `${k.label} (${k.colorName}), not pinned to a spot`}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11.5px] font-medium ring-1 ring-(--c-l-ebebeb) enabled:hover:bg-(--c-b-f4f4f4) disabled:opacity-80"
          style={{ color: k.hex }}
        >
          <span aria-hidden="true">{k.glyph}</span>
          {k.label}
          {multiPage && m.page ? <span className="text-(--c-t-9a9a9a)">p{m.page}</span> : null}
        </button>
        <span className="font-medium text-(--c-t-4a4a4a)">{m.authorName ?? "Someone"}</span>
        {m.agent && <span className="rounded bg-(--c-b-efe9fb) px-1 text-[11px] font-medium text-(--c-t-5b3fb0)">Agent</span>}
        <span>{ago(m.createdAt)}</span>
        <span className="flex-1" />
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
          <input
            type="checkbox"
            checked={!!m.resolved}
            onChange={() => void updateMark({ markId: m._id, resolved: !m.resolved })}
            className="nn-check h-[14px] w-[14px]"
          />
          {m.resolved ? (m.resolvedByRound ? `Done in v${m.resolvedByRound}` : "Done") : "Mark done"}
        </label>
        <button
          type="button"
          onClick={() => confirm("Delete this mark?") && void removeMark({ markId: m._id })}
          aria-label="Delete mark"
          className="flex h-6 w-6 items-center justify-center rounded text-(--c-t-9a9a9a) opacity-0 hover:text-(--c-t-b42318) group-hover:opacity-100 pointer-coarse:opacity-100"
        >
          <IconTrash size={13} />
        </button>
      </div>
      {m.quote && (
        <div className="mt-1.5 border-l-2 border-(--comment-underline) pl-2.5 text-[13px] italic leading-[1.5] text-(--c-t-737373)">&ldquo;{m.quote}&rdquo;</div>
      )}
      {m.text && (
        <div className={`mt-1 whitespace-pre-wrap break-words text-[14px] leading-[1.55] ${m.resolved ? "text-(--c-t-9a9a9a) line-through decoration-(--c-t-c4c4c4)" : "text-(--c-t-262626)"}`}>
          {m.text}
        </div>
      )}
      <AttachmentGrid items={m.attachments ?? []} />
    </div>
  );
}

/** Pictures and files on a mark: a site photo, a cutsheet, a link to a vendor page. */
function AttachmentGrid({ items }: { items: { url?: string; mime?: string; name?: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((a, i) =>
        !a.url ? null : a.mime?.startsWith("video/") ? (
          <video key={i} src={a.url} controls playsInline preload="metadata" className="max-h-[220px] max-w-full rounded-lg bg-black" />
        ) : a.mime?.startsWith("image/") || !a.mime ? (
          <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.url} alt={a.name ?? ""} className="max-h-[160px] max-w-[240px] rounded-lg object-cover ring-1 ring-(--c-l-ebebeb)" />
          </a>
        ) : (
          <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-(--c-t-2358d8) ring-1 ring-(--c-l-ebebeb)">
            {a.name ?? "File"}
          </a>
        ),
      )}
    </div>
  );
}

type Pending = { key: string; name: string; mime: string; preview: string; progress: number; storageId?: Id<"_storage">; error?: string };

/** Pasted, dropped or picked images and videos, uploaded straight away so posting is instant */
function useUploads() {
  const uploadUrl = useMutation(api.docs.generateUploadUrl);
  const [files, setFiles] = useState<Pending[]>([]);
  const add = (list: File[]) => {
    for (const f of list.filter((x) => /^(image|video)\//.test(x.type))) {
      const key = Math.random().toString(36).slice(2);
      setFiles((p) => [...p, { key, name: f.name, mime: f.type, preview: URL.createObjectURL(f), progress: 0 }]);
      void (async () => {
        try {
          const id = (await uploadToUrl(await uploadUrl(), f, (pr) => setFiles((p) => p.map((x) => (x.key === key ? { ...x, progress: pr } : x))))) as Id<"_storage">;
          setFiles((p) => p.map((x) => (x.key === key ? { ...x, storageId: id, progress: 1 } : x)));
        } catch {
          setFiles((p) => p.map((x) => (x.key === key ? { ...x, error: "Upload failed" } : x)));
        }
      })();
    }
  };
  const remove = (key: string) => setFiles((p) => p.filter((x) => x.key !== key));
  const ready = files.filter((f) => f.storageId).map((f) => ({ storageId: f.storageId!, mime: f.mime, name: f.name }));
  const busy = files.some((f) => !f.storageId && !f.error);
  return { files, add, remove, ready, busy, clear: () => setFiles([]) };
}

function PendingStrip({ up }: { up: ReturnType<typeof useUploads> }) {
  if (!up.files.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2.5">
      {up.files.map((f) => (
        <div key={f.key} className="relative h-14 w-14 overflow-hidden rounded-lg bg-(--c-b-ececea) ring-1 ring-(--c-l-ebebeb)">
          {f.mime.startsWith("video/") ? <video src={f.preview} muted className="h-full w-full object-cover" /> : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={f.preview} alt="" className="h-full w-full object-cover" />
          )}
          {!f.storageId && !f.error && <div className="absolute inset-x-1 bottom-1 h-1 overflow-hidden rounded bg-black/30"><div className="h-full bg-white" style={{ width: `${Math.round(f.progress * 100)}%` }} /></div>}
          {f.error && <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[10px] text-white">Failed</div>}
          <button type="button" onClick={() => up.remove(f.key)} aria-label="Remove" className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white">
            <IconX size={9} color="#fff" />
          </button>
        </div>
      ))}
    </div>
  );
}

function AttachButton({ up }: { up: ReturnType<typeof useUploads> }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { up.add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      <button type="button" onClick={() => input.current?.click()} title="Add images or videos (or paste them)" aria-label="Add images or videos" className="flex h-7 w-7 items-center justify-center rounded-md text-(--c-t-8a8a8a) hover:bg-(--c-b-f4f4f4) hover:text-(--c-t-1b1b1b)">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.5 7.5 8 13a3.2 3.2 0 0 1-4.6-4.6l5.8-5.8a2.1 2.1 0 0 1 3 3L6.5 11.3a1.1 1.1 0 0 1-1.6-1.5L10 4.7" />
        </svg>
      </button>
    </>
  );
}

/**
 * Write a mark. It lands on the point you pinned, or — with nothing pinned — on the sheet as a
 * whole. The kind is picked by name and glyph, so the four kinds never rely on their colors.
 */
function Composer({
  reviewId,
  round,
  fileIndex,
  sheetName,
  pending,
  onClearPin,
  onStartPin,
}: {
  reviewId: Id<"reviews">;
  round: number;
  fileIndex: number;
  sheetName: string | null;
  pending: PinPoint | null;
  onClearPin: () => void;
  onStartPin: () => void;
}) {
  const add = useMutation(api.reviews.addMark);
  const up = useUploads();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MarkKind>("fix");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const send = async () => {
    const t = text.trim();
    if ((!t && !up.ready.length) || busy || up.busy) return;
    setBusy(true);
    try {
      await add({
        id: reviewId,
        roundNumber: round,
        fileIndex: pending?.fileIndex ?? fileIndex,
        page: pending?.page ?? 1,
        x: pending ? pending.x : null,
        y: pending ? pending.y : null,
        markKind: kind,
        text: t,
        attachments: up.ready,
      });
      setText("");
      up.clear();
      onClearPin();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shrink-0 border-t border-(--c-l-ebebeb) p-4">
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDrag(true);
          }
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDrag(false);
          up.add(Array.from(e.dataTransfer.files));
        }}
        className={`rounded-xl bg-(--c-b-ffffff) ring-1 ${drag ? "ring-2 ring-(--c-l-2358d8)" : "ring-(--c-l-e3e3e0) focus-within:ring-(--c-l-c9c9c9)"}`}
      >
        <div className="flex flex-wrap items-center gap-1 px-2.5 pt-2.5" role="radiogroup" aria-label="What kind of mark">
          {MARK_KINDS.map((k) => {
            const on = k.value === kind;
            return (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setKind(k.value)}
                title={`${k.label} (${k.colorName})`}
                className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] ring-1 ${
                  on ? "bg-(--c-b-f1f1ef) font-medium text-(--c-t-1b1b1b) ring-(--c-l-d6d6d6)" : "text-(--c-t-737373) ring-transparent hover:text-(--c-t-1b1b1b)"
                }`}
              >
                <span style={{ color: k.hex }} aria-hidden="true">
                  {k.glyph}
                </span>
                {k.label}
              </button>
            );
          })}
        </div>
        <PendingStrip up={up} />
        <textarea
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) => /^(image|video)\//.test(f.type));
            if (files.length) {
              e.preventDefault();
              up.add(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="What has to change? Paste photos or cutsheets too (⌘↵ to post)"
          aria-label="Mark"
          className="block w-full resize-none bg-transparent px-3.5 pt-2.5 text-[14px] leading-[1.5] text-(--c-t-1b1b1b) outline-none placeholder:text-(--c-t-9a9a9a)"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5">
          {pending ? (
            <button
              type="button"
              onClick={onClearPin}
              title="Pinned to a point on the sheet. Click to put the mark on the whole sheet instead."
              className="inline-flex h-7 items-center gap-1 rounded-md bg-(--c-b-e7eefb) px-2 text-[12.5px] font-medium text-(--c-t-2358d8)"
            >
              Pinned
              <IconX size={10} />
            </button>
          ) : (
            <button
              type="button"
              onClick={onStartPin}
              title="Pin this mark to a point on the sheet (N)"
              className="inline-flex h-7 items-center rounded-md px-2 text-[12.5px] text-(--c-t-9a9a9a) ring-1 ring-(--c-l-e3e3e0) hover:text-(--c-t-1b1b1b)"
            >
              {sheetName ? `On ${sheetName.replace(/\.[^.]+$/, "")}` : "On this sheet"}
            </button>
          )}
          <AttachButton up={up} />
          <span className="flex-1" />
          <button
            type="button"
            disabled={(!text.trim() && !up.ready.length) || busy || up.busy}
            onClick={() => void send()}
            className="h-8 rounded-lg bg-(--c-b-1b1b1b) px-3.5 text-[13px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333) disabled:opacity-40"
          >
            {up.busy ? "Uploading…" : "Mark"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ArchiveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="3.25" rx="1" />
      <path d="M3 6v6.25a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 8.75h3" />
    </svg>
  );
}
