"use client";

import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { TypeIcon } from "./TypeIcon";
import { PROJECT_MIME } from "./CalendarView";
import { IconPlus } from "./icons";
import type { ProjectType, Stage } from "@/lib/types";

export type KanbanProject = {
  _id: string;
  title: string;
  stage: string;
  type: ProjectType;
  targetDate: string | null;
  clubName?: string | null;
  updatedAt: number;
  /** Its place in its column, set by dragging */
  boardOrder?: number;
};

/**
 * Projects as a board, left to right through one pipeline. The columns, which ones sit back, which
 * one the board opens on and which one folds away are all read off the Stage records handed in —
 * the two pipelines have no stage in common, so naming one here would quietly break the other.
 */
export function KanbanView({
  stages,
  projects,
  onReorder,
  onNew,
}: {
  /** The pipeline this board shows, in order (from stagesFor(type)) */
  stages: Stage[];
  projects: KanbanProject[];
  /** A column's cards in their new order (top first), after `moved` was dropped into it */
  onReorder: (stage: string, ids: string[], moved: string) => void;
  /** Makes a project in a column from the quick New card; resolves with its id */
  onNew: (stage: string, details: NewDetails) => Promise<string>;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  // Where cards were just dropped, shown right away (the save takes a moment to come back)
  const [moves, setMoves] = useState<Record<string, string>>({});
  /** The column with the quick New card open */
  const [composing, setComposing] = useState<string | null>(null);
  // A column's new order, shown right away until the saved order comes back
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  /** Where the dragged card would land: the column and the slot (0 = top) */
  const [slot, setSlot] = useState<{ stage: string; index: number } | null>(null);
  useEffect(() => {
    // Forget a drop once the saved stage has arrived
    const done = Object.entries(moves).filter(([id, st]) => {
      const p = projects.find((x) => x._id === id);
      return !p || p.stage === st;
    });
    if (done.length)
      setMoves((m) => {
        const next = { ...m };
        for (const [id] of done) delete next[id];
        return next;
      });
  }, [projects, moves]);
  useEffect(() => {
    // Forget a column's shown order once the saved one matches it
    const done = Object.keys(orders).filter((st) => {
      const want = orders[st];
      const saved = projects.filter((p) => want.includes(p._id));
      return saved.every((p) => p.boardOrder === want.indexOf(p._id));
    });
    if (done.length)
      setOrders((o) => {
        const next = { ...o };
        for (const st of done) delete next[st];
        return next;
      });
  }, [projects, orders]);
  const [over, setOver] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);

  const terminal = stages.find((s) => s.terminal) ?? stages[stages.length - 1];
  const focus = stages.find((s) => s.focus) ?? stages[0];

  // Opens with the focus column at the left edge; the earlier ones are a scroll to the left
  const scroller = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  // While the focus column is still at the left edge, keep it there when the window changes size
  const atFocus = useRef(true);
  const columnAt = (box: HTMLElement | null, stage: string) => box?.querySelector<HTMLElement>(`section[data-stage="${stage}"]`) ?? null;
  const focusOffset = () => {
    const box = scroller.current;
    const col = columnAt(box, focus.value);
    if (!box || !col) return 0;
    return col.getBoundingClientRect().left - box.getBoundingClientRect().left - parseFloat(getComputedStyle(box).paddingLeft);
  };
  // Room after the last column so the focus column can sit at the left edge even on wide screens
  const [tail, setTail] = useState<number | null>(null);
  // Re-measures when the pipeline changes: the other board has different columns in different places
  const pipeline = stages.map((s) => s.value).join(",");
  useLayoutEffect(() => {
    placed.current = false;
    atFocus.current = true;
    setTail(null);
  }, [pipeline]);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const measure = () => {
      const col = columnAt(box, focus.value);
      const last = columnAt(box, terminal.value);
      if (!col || !last) return;
      const cs = getComputedStyle(box);
      const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setTail(Math.max(0, room - (last.offsetLeft + last.offsetWidth - col.offsetLeft) - 16));
      if (placed.current && atFocus.current) requestAnimationFrame(() => box && (box.scrollLeft += focusOffset()));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline]);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !columnAt(box, focus.value) || placed.current || tail === null) return;
    placed.current = true;
    box.scrollLeft += focusOffset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tail, pipeline]);

  const columns = stages.map((s) => {
    const list = projects.filter((p) => (moves[p._id] ?? p.stage) === s.value);
    const shownOrder = orders[s.value];
    // Cards keep the order you dragged them into; ones never placed go after them: dated projects
    // first, soonest first (the last column: most recent first), then the latest edits
    list.sort((a, b) => {
      if (shownOrder) {
        const ia = shownOrder.indexOf(a._id),
          ib = shownOrder.indexOf(b._id);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
      }
      const oa = a.boardOrder,
        ob = b.boardOrder;
      if (oa !== undefined || ob !== undefined) return (oa ?? Infinity) - (ob ?? Infinity);
      if (!!a.targetDate !== !!b.targetDate) return a.targetDate ? -1 : 1;
      if (a.targetDate && b.targetDate && a.targetDate !== b.targetDate)
        return (a.targetDate < b.targetDate ? -1 : 1) * (s.terminal ? -1 : 1);
      return b.updatedAt - a.updatedAt;
    });
    return { stage: s, list };
  });

  return (
    <div
      ref={scroller}
      onScroll={() => placed.current && (atFocus.current = Math.abs(focusOffset()) < 4)}
      className="-mx-5 overflow-x-auto scroll-px-5 px-5 pb-4 [scrollbar-width:thin] max-lg:snap-x max-lg:snap-mandatory"
    >
      <div className="flex min-w-max items-start gap-4">
        {columns.map(({ stage: col, list }) => {
          // The last column starts folded up: just its header and a button to open the whole column
          // (it stays folded while dragging so nothing jumps; drop on it to finish a project)
          const folded = !!col.terminal && !showTerminal;
          const shown = folded ? [] : list;
          const isOver = over === col.value && dragging !== null;
          return (
            <section
              key={col.value}
              data-stage={col.value}
              aria-label={col.label}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== col.value) setOver(col.value);
                // The slot: before the first card whose middle is below the pointer (the dragged card doesn't count)
                const cards = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-card]")].filter((c) => c.dataset.card !== dragging);
                let index = cards.findIndex((c) => {
                  const r = c.getBoundingClientRect();
                  return e.clientY < r.top + r.height / 2;
                });
                if (index === -1) index = cards.length;
                if (folded) index = 0;
                if (slot?.stage !== col.value || slot.index !== index) setSlot({ stage: col.value, index });
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setOver((o) => (o === col.value ? null : o));
                  setSlot((s) => (s?.stage === col.value ? null : s));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData(PROJECT_MIME) || dragging;
                const p = id ? projects.find((x) => x._id === id) : undefined;
                if (p) {
                  // The column's cards in their new order, with the dropped card in its slot
                  const rest = list.filter((x) => x._id !== p._id).map((x) => x._id);
                  const at = Math.max(0, Math.min(rest.length, slot?.stage === col.value ? slot.index : rest.length));
                  const ids = [...rest.slice(0, at), p._id, ...rest.slice(at)];
                  const same = p.stage === col.value && ids.every((x, i) => x === list[i]?._id);
                  if (!same) {
                    if (p.stage !== col.value) {
                      setMoves((m) => ({ ...m, [p._id]: col.value }));
                      // If the save never lands, show where it really is again
                      setTimeout(
                        () => setMoves((m) => (m[p._id] === col.value ? (({ [p._id]: _gone, ...others }) => others)(m) : m)),
                        10000,
                      );
                    }
                    setOrders((o) => ({ ...o, [col.value]: ids }));
                    setTimeout(
                      () => setOrders((o) => (o[col.value] === ids ? (({ [col.value]: _gone, ...others }) => others)(o) : o)),
                      10000,
                    );
                    onReorder(col.value, ids, p._id);
                  }
                }
                setSlot(null);
                setDragging(null);
                setOver(null);
              }}
              style={{
                // The stage's own color, laid over the column base as a wash. The glyph and the
                // label in the header are what actually say which column this is.
                background: isOver ? undefined : `linear-gradient(${col.hex}14, ${col.hex}14), var(--kb-col)`,
                ...(col.terminal && !isOver ? { boxShadow: `inset 0 0 0 1px ${col.hex}55` } : {}),
              }}
              className={`group/col flex w-[300px] shrink-0 snap-start flex-col rounded-2xl px-3.5 pb-3.5 pt-2 transition-[opacity,box-shadow,background-color] duration-200 ${
                isOver ? "bg-(--kb-drop) ring-2 ring-[#2358d8]/40" : ""
              } ${col.quiet && !isOver ? "opacity-[0.58] hover:opacity-90 focus-within:opacity-100" : ""}`}
            >
              <header className="flex h-10 items-center gap-2 px-1">
                <span className="text-[13px] leading-none" style={{ color: col.hex }} title={`${col.label} (${col.colorName})`} aria-hidden="true">
                  {col.glyph}
                </span>
                <h2 className="m-0 text-[13.5px] font-semibold text-(--c-t-1b1b1b)">{col.label}</h2>
                <span className="text-[12.5px] tabular-nums text-(--c-t-9a9a9a)">{list.length}</span>
                <button
                  type="button"
                  onClick={() => setComposing(col.value)}
                  aria-label={`New project in ${col.label}`}
                  title={`New project in ${col.label}`}
                  className={`ml-auto flex h-6 items-center gap-1 rounded-md px-1.5 text-[12.5px] font-medium text-(--c-t-6b6b6b) transition-opacity hover:bg-(--kb-card-ring) hover:text-(--c-t-1b1b1b) group-hover/col:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 ${composing === col.value ? "opacity-100" : "opacity-0"}`}
                >
                  <IconPlus size={12} />
                  New
                </button>
              </header>
              <div className={`flex flex-col gap-2 ${folded ? "" : "min-h-[64px]"}`}>
                {composing === col.value && (
                  <NewCard
                    stage={col}
                    onCancel={() => setComposing(null)}
                    onCreate={async (details, again) => {
                      if (!again) setComposing(null);
                      const id = await onNew(col.value, details);
                      // New projects go to the top of the column
                      const ids = [id, ...list.map((x) => x._id).filter((x) => x !== id)];
                      setOrders((o) => ({ ...o, [col.value]: ids }));
                      onReorder(col.value, ids, id);
                    }}
                  />
                )}
                {shown.map((p) => {
                  // The drop line sits just above the card the dragged one would land before
                  const place = shown.filter((x) => x._id !== dragging).findIndex((x) => x._id === p._id);
                  const lineHere = !!dragging && slot?.stage === col.value && place !== -1 && place === slot.index && !folded;
                  return (
                    <div key={p._id} data-card={p._id} className="relative">
                      {lineHere && <DropLine />}
                      <Card
                        project={p}
                        stage={col}
                        dragging={dragging === p._id}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(PROJECT_MIME, p._id);
                          e.dataTransfer.effectAllowed = "move";
                          // Changing the page during dragstart can cancel the drag in Chrome, so mark it just after
                          const id = p._id;
                          setTimeout(() => setDragging(id), 0);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setOver(null);
                          setSlot(null);
                        }}
                      />
                    </div>
                  );
                })}
                {!!dragging &&
                  !folded &&
                  slot?.stage === col.value &&
                  slot.index >= shown.filter((x) => x._id !== dragging).length &&
                  shown.some((x) => x._id !== dragging) && (
                    <div className="relative h-0">
                      <DropLine />
                    </div>
                  )}
                {folded && list.length > 0 && dragging && (
                  <div
                    style={{ color: col.hex, borderColor: isOver ? col.hex : `${col.hex}55`, background: isOver ? `${col.hex}14` : undefined }}
                    className="flex h-10 items-center justify-center rounded-xl border border-dashed text-[12.5px] font-medium"
                  >
                    Drop to mark {col.label.toLowerCase()}
                  </div>
                )}
                {folded && list.length > 0 && !dragging && (
                  <button
                    type="button"
                    onClick={() => setShowTerminal(true)}
                    style={{ color: col.hex, borderColor: `${col.hex}55` }}
                    className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-dashed text-[12.5px] font-medium hover:bg-(--kb-card-ring)"
                  >
                    Show all {list.length} {col.label.toLowerCase()}
                    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m3 4.5 3 3 3-3" />
                    </svg>
                  </button>
                )}
                {!list.length && (
                  <div className="flex h-16 items-center justify-center rounded-xl border border-dashed border-(--c-l-dcdcdc) text-[12.5px] text-(--c-t-9a9a9a)">
                    {dragging ? "Drop here" : "Nothing here"}
                  </div>
                )}
                {col.terminal && showTerminal && list.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowTerminal(false)}
                    style={{ color: col.hex }}
                    className="h-8 rounded-lg text-[12.5px] font-medium hover:bg-(--kb-card-ring)"
                  >
                    Collapse
                  </button>
                )}
              </div>
            </section>
          );
        })}
        {!!tail && <div aria-hidden="true" className="shrink-0" style={{ width: tail }} />}
      </div>
    </div>
  );
}

export type NewDetails = { title: string; targetDate: string | null };

/** A quick new project, made right in the column: its name and its date, without opening it */
function NewCard({ stage, onCreate, onCancel }: { stage: Stage; onCreate: (d: NewDetails, again: boolean) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = async (again: boolean) => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate({ title: title.trim(), targetDate: targetDate || null }, again);
      if (again) {
        setTitle("");
        ref.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  };
  const field = "h-7 rounded-md border border-(--kb-card-ring) bg-transparent px-1.5 text-[12.5px] text-(--c-t-1b1b1b) outline-none focus:border-(--c-t-9a9a9a)";
  return (
    <form
      data-stage-new={stage.value}
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      style={{ background: "var(--kb-card)" }}
      className="flex flex-col gap-2 rounded-xl px-3 py-2.5 shadow-[0_6px_18px_rgba(0,0,0,0.08)] ring-1 ring-(--c-t-9a9a9a)/40"
    >
      <input
        ref={ref}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          // ⌘Enter adds this one and starts another
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit(true);
          }
        }}
        placeholder="Project name"
        aria-label="Project name"
        className="w-full bg-transparent text-[13.5px] font-medium text-(--c-t-1b1b1b) outline-none placeholder:font-normal placeholder:text-(--c-t-9a9a9a)"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-(--kb-card-ring) px-1.5 text-[12px] text-(--c-t-6b6b6b)">
          <span style={{ color: stage.hex }} aria-hidden="true">
            {stage.glyph}
          </span>
          {stage.label}
        </span>
        <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} aria-label="Target date" title="Target date" className={`${field} w-[124px]`} />
      </div>
      <div className="flex items-center gap-1.5">
        <button type="submit" disabled={!title.trim() || busy} className="h-7 rounded-md bg-(--c-b-1b1b1b) px-2.5 text-[12.5px] font-medium text-(--c-on-ink) disabled:opacity-40">
          Add
        </button>
        <button type="button" onClick={onCancel} className="h-7 rounded-md px-2 text-[12.5px] text-(--c-t-6b6b6b) hover:bg-(--kb-card-ring)">
          Cancel
        </button>
        <span className="ml-auto text-[11px] text-(--c-t-9a9a9a) max-sm:hidden">⌘↵ add another</span>
      </div>
    </form>
  );
}

/** Where a dragged card will land */
function DropLine() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-1 -top-[5.5px] z-10 h-[3px] rounded-full bg-[#2358d8]"
    >
      <span className="absolute -left-1 -top-[3px] h-[9px] w-[9px] rounded-full border-2 border-[#2358d8] bg-(--kb-card)" />
    </span>
  );
}

const shortDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  const date = new Date(y, m - 1, day);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(y === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
};

function Card({
  project: p,
  stage,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  project: KanbanProject;
  stage: Stage;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  // A date that has passed only matters while there is still work to do
  const late = !stage.terminal && p.targetDate && p.targetDate < today;
  const meta: ReactNode[] = [];
  if (p.targetDate)
    meta.push(
      <span
        key="d"
        className={`inline-flex items-center gap-1 whitespace-nowrap ${late ? "font-medium text-(--c-t-b42318)" : ""}`}
        title={late ? "Target date has passed" : "Target date"}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" />
          <path d="M2.25 6.75h11.5M5.5 1.75v3M10.5 1.75v3" />
        </svg>
        {late && <span aria-hidden="true">!</span>}
        {shortDate(p.targetDate)}
      </span>,
    );
  return (
    <Link
      href={`/p/${p._id}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{ background: "var(--kb-card)" }}
      className={`group/card block rounded-xl px-3 py-2.5 no-underline shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-(--kb-card-ring) transition-[box-shadow,transform,opacity] duration-150 hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(0,0,0,0.08)] ${
        dragging ? "opacity-40" : ""
      }`}
    >
      <div className={`line-clamp-3 text-[13.5px] font-medium leading-[1.4] ${p.title.trim() ? "text-(--c-t-1b1b1b)" : "text-(--c-t-9a9a9a)"}`}>
        {p.title.trim() || "Untitled"}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[12px] text-(--c-t-8a8a8a)">
        <TypeIcon type={p.type} size={13} />
        {meta}
        <span className="flex-1" />
        {p.clubName && (
          <span className="truncate rounded-full bg-(--kb-card-ring) px-1.5 py-px text-[11px] font-medium text-(--c-t-6b6b6b)" title={`Club: ${p.clubName}`}>
            {p.clubName}
          </span>
        )}
      </div>
    </Link>
  );
}
