"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { JournalList } from "@/components/JournalList";
import { KanbanView, type KanbanProject } from "@/components/KanbanView";
import { CalendarView } from "@/components/CalendarView";
import { FeedView, FilterSelect } from "@/components/FeedView";
import { Mymind } from "@/components/Mymind";
import { Library } from "@/components/Library";
import { BoardsList } from "@/components/BoardsList";
import { ScratchboardList } from "@/components/ScratchboardList";
import { PdfList } from "@/components/PdfList";
import { Reviews } from "@/components/Reviews";
import { ClubsList } from "@/components/ClubsList";
import { HomeDashboard } from "@/components/HomeDashboard";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  ShowSidebarButton,
  STUDIO_VIEW_EVENT,
  VIEWS,
  isView,
  useAppSidebar,
  useHomeView,
  type View,
} from "@/components/HomeSidebar";
import { TypeIcon } from "@/components/TypeIcon";
import { IconCheck, IconPencil, IconTrash, IconX, IconPin, IconPlus, IconSearch } from "@/components/icons";
import { useIsMobile } from "@/lib/useIsMobile";
import {
  ALL_STAGES,
  PROJECT_TYPES,
  stageOf,
  stagesFor,
  typeLabel,
  type ProjectStage,
  type ProjectType,
} from "@/lib/types";

export default function Home() {
  return <ProjectList />;
}

/** The tab title for each view, and the ?view= whitelist, both read off the one registry */
const TITLES = Object.fromEntries(VIEWS.map((v) => [v.view, v.title])) as Record<View, string>;

/** Views that fill the page themselves */
const BARE: View[] = ["home", "journal"];
/** Views that sit in the padded app container, with nothing but the sidebar button above them */
const PANELS: View[] = ["clubs", "reviews", "mymind", "library", "boards", "scratchboards", "pdfs"];

/** "Sep 12", with the year only when it isn't this year. */
function shortDate(d: string | null) {
  if (!d) return "";
  const date = new Date(`${d}T00:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
}

function edited(ts: number) {
  const now = new Date();
  const d = new Date(ts);
  const mins = (now.getTime() - ts) / 60000;
  if (mins < 60) return mins < 2 ? "Just now" : `${Math.floor(mins)} minutes ago`;
  if (mins < 60 * 6) return `${Math.floor(mins / 60)} hour${mins < 120 ? "" : "s"} ago`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type SortKey = "title" | "type" | "targetDate" | "stage" | "edited";
type Sortable = { title: string; type: string; targetDate: string | null; stage: string; updatedAt: number };

/** Compares two projects on one column; empty values (no title, no target date) always go last. */
function compare(a: Sortable, b: Sortable, key: SortKey): number {
  switch (key) {
    case "title":
      return (a.title || "￿").localeCompare(b.title || "￿", undefined, { sensitivity: "base", numeric: true });
    case "type":
      return a.type.localeCompare(b.type);
    case "targetDate":
      return (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999");
    case "stage":
      // One order across both pipelines: physical first, then digital, each in pipeline order
      return ALL_STAGES.findIndex((s) => s.value === a.stage) - ALL_STAGES.findIndex((s) => s.value === b.stage);
    case "edited":
      return a.updatedAt - b.updatedAt;
  }
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "edited", label: "Last edited" },
  { key: "title", label: "Title" },
  { key: "targetDate", label: "Target date" },
  { key: "stage", label: "Stage" },
  { key: "type", label: "Type" },
];

/** A small sort button that opens a menu (like Notion): pick a field, then the direction. */
function SortMenu({ sort, onChange }: { sort: { key: SortKey; dir: 1 | -1 }; onChange: (s: { key: SortKey; dir: 1 | -1 }) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const custom = !(sort.key === "edited" && sort.dir === -1);
  const current = SORTS.find((x) => x.key === sort.key)?.label;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sort: ${current}, ${sort.dir === 1 ? "ascending" : "descending"}`}
        title="Sort"
        onClick={() => setOpen(!open)}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] hover:bg-(--c-b-f4f4f4) ${custom ? "text-(--c-t-2358d8)" : "text-(--c-t-737373)"}`}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4.5 2.5v11M2 11l2.5 2.5L7 11M11.5 13.5v-11M9 5l2.5-2.5L14 5" />
        </svg>
        {custom && <span>{current}</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-40 w-52 rounded-xl border border-(--c-l-ebebeb) bg-(--c-b-ffffff) p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.10)]">
          <div className="px-2 pb-1 pt-1 text-[12px] text-(--c-t-9a9a9a)">Sort by</div>
          {SORTS.map((x) => (
            <button
              key={x.key}
              type="button"
              role="menuitemradio"
              aria-checked={sort.key === x.key}
              onClick={() => onChange({ key: x.key, dir: x.key === "edited" ? -1 : 1 })}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[14px] text-(--c-t-1b1b1b) hover:bg-(--c-b-f4f4f4)"
            >
              {x.label}
              {sort.key === x.key && <IconCheck size={14} />}
            </button>
          ))}
          <div className="mx-1 my-1 h-px bg-(--c-b-ebebeb)" />
          <div className="flex gap-1 p-1">
            {([1, -1] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                aria-pressed={sort.dir === dir}
                onClick={() => onChange({ key: sort.key, dir })}
                className={`h-7 flex-1 rounded-md text-[13px] ${sort.dir === dir ? "bg-(--c-b-f0f0f0) font-medium text-(--c-t-1b1b1b)" : "text-(--c-t-737373) hover:bg-(--c-b-f7f7f7)"}`}
              >
                {dir === 1 ? "Ascending" : "Descending"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const cellCls = "relative inline-flex w-fit items-center rounded-md px-1.5 py-0.5 hover:bg-(--c-b-f0f0f0)";

/** A spot inside a row link that can be edited in place: clicks here don't open the project. */
function Cell({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={className}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {children}
    </span>
  );
}

/** The title, with a pencil (on hover) to rename it without opening the project. */
function TitleCell({ title, onRename }: { title: string; onRename: (t: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  if (editing)
    return (
      <Cell className="block">
        <input
          autoFocus
          value={draft}
          aria-label="Title"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft.trim() !== title) onRename(draft.trim().slice(0, 300));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(title);
              setEditing(false);
            }
          }}
          className="w-full rounded-md border border-(--c-l-dcdcdc) bg-(--c-b-ffffff) px-1.5 py-0.5 text-[16px] font-medium text-(--c-t-1b1b1b) outline-none"
        />
      </Cell>
    );
  return (
    <div className="text-[16px] font-medium leading-[1.4] sm:flex sm:min-w-0 sm:items-center">
      <span className={`break-words sm:truncate ${title ? "text-(--c-t-1b1b1b)" : "text-(--c-t-9a9a9a)"}`} title={title || undefined}>
        {title || "Untitled"}
      </span>
      <Cell className="ml-1 inline-flex shrink-0 align-[-4px]">
        <button
          type="button"
          aria-label={`Rename ${title || "Untitled"}`}
          title="Rename"
          onClick={() => {
            setDraft(title);
            setEditing(true);
          }}
          className="flex h-6 w-6 items-center justify-center rounded text-(--c-t-9a9a9a) opacity-0 hover:bg-(--c-b-f0f0f0) hover:text-(--c-t-1b1b1b) focus-visible:opacity-100 group-hover:opacity-100"
        >
          <IconPencil size={13} />
        </button>
      </Cell>
    </div>
  );
}

function ProjectList() {
  const router = useRouter();
  const projects = useQuery(api.projects.list);
  const clubs = useQuery(api.clubs.list);
  const me = useQuery(api.users.me);
  const create = useMutation(api.projects.create);
  const remove = useMutation(api.projects.remove);
  const update = useMutation(api.projects.update);
  const reorder = useMutation(api.projects.reorder);
  const setPinned = useMutation(api.projects.setPinned);
  const [typeFilter, setTypeFilter] = useState<"all" | ProjectType>("all");
  const [stageFilter, setStageFilter] = useState<string>("all");
  /** "all", "none" (network-wide work), or a club's id */
  const [clubFilter, setClubFilter] = useState<string>("all");
  /** Which pipeline the board shows. A board may only ever hold one: the other type has no column here. */
  const [boardType, setBoardType] = useState<ProjectType>("physical");
  const [search, setSearch] = useState("");
  // Newest edits first until a column header is clicked
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "edited", dir: -1 });
  const [creating, setCreating] = useState(false);
  const mobile = useIsMobile();
  const { view, setView, newProject: newProjectRef } = useHomeView();
  useDocumentTitle(TITLES[view]);
  /** The stage / type / club filters only show after pressing Filter */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const side = useAppSidebar();
  const sidebarOpen = side.shown;
  /** The view this page was opened with (from the address or last time), until it's switched to */
  const viewAsked = useRef<View | null>(null);
  // Remember the view, per browser
  useEffect(() => {
    try {
      const saved = localStorage.getItem("home-view");
      // ?view=… (e.g. coming back from a board) wins over the remembered view
      const asked = new URLSearchParams(window.location.search).get("view") ?? saved;
      if (asked && isView(asked)) {
        viewAsked.current = asked;
        setView(asked);
      }
      setFiltersOpen(localStorage.getItem("home-filters") === "1");
    } catch {}
  }, [setView]);
  // Filters and sort stay as you left them (saved in this browser)
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem("home-prefs") ?? "{}");
      if (p.stage === "all" || ALL_STAGES.some((x) => x.value === p.stage)) setStageFilter(p.stage ?? "all");
      if (typeof p.club === "string") setClubFilter(p.club);
      if (PROJECT_TYPES.some((x) => x.value === p.type) || p.type === "all") setTypeFilter(p.type);
      if (PROJECT_TYPES.some((x) => x.value === p.boardType)) setBoardType(p.boardType);
      if (p.sort && SORTS.some((x) => x.key === p.sort.key) && (p.sort.dir === 1 || p.sort.dir === -1)) setSort(p.sort);
    } catch {}
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      localStorage.setItem("home-prefs", JSON.stringify({ stage: stageFilter, club: clubFilter, type: typeFilter, boardType, sort }));
    } catch {}
  }, [prefsLoaded, stageFilter, clubFilter, typeFilter, boardType, sort]);
  // The open view lives in the address too, so the browser's Back (and back arrows) return to exactly this view
  useEffect(() => {
    // (not before the view asked for on opening has been switched to)
    if (viewAsked.current && view !== viewAsked.current) return;
    viewAsked.current = null;
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("view") === view) return;
      url.searchParams.set("view", view);
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    } catch {}
  }, [view]);
  // The ⌘K switcher asks for a view while this page is already open
  useEffect(() => {
    const onView = (e: Event) => {
      const v = (e as CustomEvent<View>).detail;
      setView(v);
      try {
        localStorage.setItem("home-view", v);
      } catch {}
    };
    window.addEventListener(STUDIO_VIEW_EVENT, onView);
    return () => window.removeEventListener(STUDIO_VIEW_EVENT, onView);
  }, [setView]);
  const remember = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  };
  const toggleSidebar = side.toggle;

  /** A club picked in the filters is where a new project belongs; "all" and "none" mean network-wide */
  const filterClubId = clubs?.some((c) => c._id === clubFilter) ? (clubFilter as Id<"clubs">) : null;

  const newProject = async () => {
    setCreating(true);
    try {
      const type = typeFilter === "all" ? (view === "board" ? boardType : "physical") : typeFilter;
      const stage = ALL_STAGES.some((s) => s.value === stageFilter) && stagesFor(type).some((s) => s.value === stageFilter) ? (stageFilter as ProjectStage) : undefined;
      const id = await create({ type, ...(stage ? { stage } : {}), ...(filterClubId ? { clubId: filterClubId } : {}) });
      router.push(`/p/${id}`);
    } catch {
      setCreating(false);
    }
  };
  // The sidebar's New project starts one that matches the filters here
  useEffect(() => {
    newProjectRef.current = () => void newProject();
    return () => {
      newProjectRef.current = null;
    };
  });

  const q = search.trim().toLowerCase();
  const inClub = (clubId: string | null | undefined, want: string) => (want === "all" ? true : want === "none" ? !clubId : clubId === want);
  const shown = (projects ?? []).filter(
    (p) =>
      (stageFilter === "all" || p.stage === stageFilter) &&
      (typeFilter === "all" || p.type === typeFilter) &&
      inClub(p.clubId, clubFilter) &&
      (!q || (p.title || "untitled").toLowerCase().includes(q)),
  );
  shown.sort((a, b) => {
    const c = compare(a, b, sort.key);
    // Empty titles and dates stay at the bottom whichever way you sort
    const emptyA = (sort.key === "title" && !a.title) || (sort.key === "targetDate" && !a.targetDate);
    const emptyB = (sort.key === "title" && !b.title) || (sort.key === "targetDate" && !b.targetDate);
    if (emptyA !== emptyB) return emptyA ? 1 : -1;
    return c * sort.dir || b.updatedAt - a.updatedAt;
  });

  const onMove = (id: string, targetDate: string) => void update({ id: id as Id<"projects">, targetDate: targetDate || null });
  // The board is one pipeline at a time (the columns are that pipeline's stages), with the club
  // filter and the search applied. The stage filter doesn't apply: the columns are the stages.
  const board =
    view === "board"
      ? (projects ?? []).filter((p) => p.type === boardType && inClub(p.clubId, clubFilter) && (!q || (p.title || "untitled").toLowerCase().includes(q)))
      : [];
  const all = projects ?? [];
  const counts = projects
    ? {
        stage: Object.fromEntries([...ALL_STAGES.map((x) => x.value), "all"].map((k) => [k, all.filter((p) => k === "all" || p.stage === k).length])),
        type: Object.fromEntries([...PROJECT_TYPES.map((x) => x.value), "all"].map((k) => [k, all.filter((p) => k === "all" || p.type === k).length])),
        club: Object.fromEntries([...(clubs ?? []).map((c) => c._id as string), "all", "none"].map((k) => [k, all.filter((p) => inClub(p.clubId, k)).length])),
      }
    : undefined;
  const activeFilters = (stageFilter !== "all" && view !== "board" ? 1 : 0) + (typeFilter !== "all" && view !== "board" ? 1 : 0) + (clubFilter !== "all" ? 1 : 0);
  const clubLabel = clubFilter === "all" ? null : clubFilter === "none" ? "network-wide" : (clubs?.find((c) => c._id === clubFilter)?.name ?? null);
  const heading = [
    stageFilter === "all" ? "All projects" : stageOf(stageFilter).label,
    typeFilter === "all" ? null : typeLabel(typeFilter).toLowerCase(),
    clubLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  /** Every view, so a view with no pane here is a compile error rather than a silent blank page */
  const panes: Record<View, ReactNode> = {
    home: <HomeDashboard />,
    journal: <JournalList />,
    clubs: <ClubsList />,
    reviews: <Reviews />,
    mymind: <Mymind />,
    library: <Library />,
    boards: <BoardsList />,
    scratchboards: <ScratchboardList />,
    pdfs: <PdfList />,
    feed: <FeedView />,
    calendar: projects ? <CalendarView projects={shown} onMove={onMove} /> : null,
    board: projects ? (
      <KanbanView
        stages={stagesFor(boardType)}
        projects={board as KanbanProject[]}
        onReorder={(stage, ids, moved) => void reorder({ stage: stage as ProjectStage, ids: ids as Id<"projects">[], moved: moved as Id<"projects"> })}
        onNew={(stage, d) =>
          create({
            type: boardType,
            stage: stage as ProjectStage,
            title: d.title,
            targetDate: d.targetDate,
            ...(filterClubId ? { clubId: filterClubId } : {}),
          })
        }
      />
    ) : null,
    list:
      projects === undefined ? null : shown.length === 0 ? (
        <div className="py-16 text-center text-[14px] text-(--c-t-737373)">
          {projects.length === 0 ? (
            <>
              No projects yet.{" "}
              <button type="button" onClick={newProject} className="font-medium text-(--c-t-2358d8)">
                Start one
              </button>
            </>
          ) : q ? (
            "Nothing matches."
          ) : activeFilters === 0 ? (
            "Nothing here yet."
          ) : (
            "No projects for these filters."
          )}
        </div>
      ) : (
        shown.map((p) => {
          const st = stageOf(p.stage, p.type);
          return (
            <div key={p._id} className="group relative">
              <Link
                href={`/p/${p._id}`}
                className="block rounded-md border-b border-(--c-l-f0f0f0) px-3 py-3.5 text-[14px] text-(--c-t-262626) no-underline hover:bg-(--c-b-fafafa) sm:flex sm:items-center sm:gap-4 sm:py-2.5"
              >
                <div className="min-w-0 sm:flex-1">
                  <TitleCell title={p.title} onRename={(title) => void update({ id: p._id, title })} />
                </div>
                {/* Phones: a second line. Computers: right-aligned on the same line. Each part is editable in place. */}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] sm:mt-0 sm:shrink-0 sm:flex-nowrap sm:justify-end">
                  {p.openMarks > 0 && (
                    <span className="whitespace-nowrap rounded-full bg-(--c-b-fdecea) px-2 py-0.5 text-[11px] font-medium text-(--c-t-b42318)">
                      {p.openMarks === 1 ? "1 open mark" : `${p.openMarks} open marks`}
                    </span>
                  )}
                  {p.editedCount > 0 && (
                    <span className="whitespace-nowrap rounded-full bg-(--c-b-f0f0f0) px-2 py-0.5 text-[11px] font-medium text-(--c-t-6b6b6b)">
                      {p.editedCount === 1 ? "Suggested copy" : `${p.editedCount} suggested`}
                    </span>
                  )}
                  <Cell className={`${cellCls} gap-1.5 whitespace-nowrap text-(--c-t-6b6b6b)`}>
                    {/* The glyph says the stage on its own; the colour is only a second reading of it */}
                    <span style={{ color: st.hex }} aria-hidden="true">
                      {st.glyph}
                    </span>
                    {st.label}
                    <select
                      id={`stage-${p._id}`}
                      aria-label={`Stage of ${p.title || "Untitled"}`}
                      value={st.value}
                      onChange={(e) => void update({ id: p._id, stage: e.target.value as ProjectStage })}
                      className="absolute inset-0 cursor-pointer opacity-0"
                    >
                      {stagesFor(p.type).map((x) => (
                        <option key={x.value} value={x.value}>
                          {x.glyph} {x.label}
                        </option>
                      ))}
                    </select>
                  </Cell>
                  <Cell className={`${cellCls} py-1 text-(--c-t-8a8a8a)`}>
                    <TypeIcon type={p.type} size={15} />
                    <select
                      id={`type-${p._id}`}
                      aria-label={`Type of ${p.title || "Untitled"}`}
                      value={p.type}
                      onChange={(e) => void update({ id: p._id, type: e.target.value as ProjectType })}
                      className="absolute inset-0 cursor-pointer opacity-0"
                    >
                      {PROJECT_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </Cell>
                  <span className="inline-flex items-center sm:w-[92px] sm:justify-end">
                    {p.targetDate && (
                      <Cell className="inline-flex">
                        <button
                          type="button"
                          aria-label={`Clear the target date of ${p.title || "Untitled"}`}
                          title="Clear date"
                          onClick={() => void update({ id: p._id, targetDate: null })}
                          className="flex h-6 w-5 items-center justify-center rounded text-(--c-t-9a9a9a) opacity-0 hover:bg-(--c-b-f0f0f0) hover:text-(--c-t-1b1b1b) focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <IconX size={11} />
                        </button>
                      </Cell>
                    )}
                    <Cell
                      className={`${cellCls} whitespace-nowrap ${p.targetDate ? "text-(--c-t-1b1b1b)" : "text-(--c-t-b0b0b0) sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100"}`}
                    >
                      {p.targetDate ? shortDate(p.targetDate) : "Add date"}
                      <input
                        id={`date-${p._id}`}
                        type="date"
                        aria-label={`Target date of ${p.title || "Untitled"}`}
                        value={p.targetDate ?? ""}
                        onChange={(e) => void update({ id: p._id, targetDate: e.target.value || null })}
                        onClick={(e) => (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.()}
                        className="absolute inset-0 cursor-pointer opacity-0"
                      />
                    </Cell>
                  </span>
                  {/* Which club this is for; "Network" is work that belongs to no single club */}
                  <Cell
                    className={`${cellCls} max-w-[150px] whitespace-nowrap ${p.clubName ? "text-(--c-t-6b6b6b)" : "text-(--c-t-b0b0b0) sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100"}`}
                  >
                    <span className="truncate">{p.clubName ?? "Network"}</span>
                    <select
                      id={`club-${p._id}`}
                      aria-label={`Club of ${p.title || "Untitled"}`}
                      value={p.clubId ?? ""}
                      onChange={(e) => void update({ id: p._id, clubId: (e.target.value || null) as Id<"clubs"> | null })}
                      className="absolute inset-0 cursor-pointer opacity-0"
                    >
                      <option value="">Network-wide</option>
                      {(clubs ?? []).map((c) => (
                        <option key={c._id} value={c._id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Cell>
                  <span className="ml-auto text-[12px] text-(--c-t-9a9a9a) sm:hidden">
                    Edited {edited(p.updatedAt).replace(/^(Just now|Today|Yesterday)$/, (w) => w.toLowerCase())}
                  </span>
                </div>
              </Link>
              <button
                type="button"
                aria-pressed={!!p.pinnedAt}
                aria-label={p.pinnedAt ? `Unpin ${p.title || "Untitled"}` : `Pin ${p.title || "Untitled"}`}
                title={p.pinnedAt ? "Unpin" : "Pin to the top"}
                onClick={() => void setPinned({ id: p._id, pinned: !p.pinnedAt })}
                // Just left of the row, like the delete button on the right
                className={`absolute -left-10 top-0 bottom-0 hidden w-10 items-center justify-center transition-opacity sm:flex ${
                  p.pinnedAt ? "text-(--c-t-2358d8) opacity-100" : "text-(--c-t-9a9a9a) opacity-0 hover:text-(--c-t-1b1b1b) focus-visible:opacity-100 group-hover:opacity-100"
                }`}
              >
                <IconPin size={15} filled={!!p.pinnedAt} />
              </button>
              <button
                type="button"
                aria-label={`Delete ${p.title || "Untitled"}`}
                onClick={async () => {
                  if (!confirm(`Delete "${p.title || "Untitled"}" and all its files? This can't be undone.`)) return;
                  await remove({ id: p._id });
                }}
                // Sits right against the row (no gap) and stays hoverable while faded, so the pointer can reach it
                className="absolute -right-11 top-0 bottom-0 hidden w-11 sm:flex items-center justify-center text-(--c-t-9a9a9a) opacity-0 transition-opacity hover:text-(--c-t-b42318) focus-visible:opacity-100 group-hover:opacity-100"
              >
                <IconTrash />
              </button>
            </div>
          );
        })
      ),
  };

  const pane = panes[view];
  const bare = BARE.includes(view);
  const panel = PANELS.includes(view);

  return (
    <div className="studio-whiteboard relative flex min-h-screen">
      {bare ? (
        <div className="relative min-h-screen min-w-0 flex-1">
          {(!sidebarOpen || mobile) && <AccountButton initial={(me?.name || me?.email || "?").slice(0, 1).toUpperCase()} email={me?.email ?? ""} />}
          <div className="px-5 pt-6">
            <div className="flex min-h-9 items-center">
              {(!sidebarOpen || mobile) && <ShowSidebarButton onClick={() => toggleSidebar(true)} className="-ml-1.5" />}
            </div>
          </div>
          {pane}
        </div>
      ) : panel ? (
        <div className="relative min-h-screen min-w-0 flex-1">
          <div className="px-5 pb-24 pt-6 sm:px-8">
            <div className="flex min-h-9 items-center">
              {(!sidebarOpen || mobile) && <ShowSidebarButton onClick={() => toggleSidebar(true)} className="-ml-1.5" />}
            </div>
            <div className="mt-4">{pane}</div>
          </div>
        </div>
      ) : (
        <div className="relative min-w-0 flex-1">
          {/* The account lives at the bottom of the sidebar; while it's hidden, here */}
          {(!sidebarOpen || mobile) && <AccountButton initial={(me?.name || me?.email || "?").slice(0, 1).toUpperCase()} email={me?.email ?? ""} />}
          <div className={`mx-auto px-5 pb-24 pt-6 ${view === "board" ? "max-w-[1520px]" : view === "calendar" ? "max-w-[1180px]" : "max-w-[1120px]"}`}>
            <div className="flex min-h-9 items-center gap-2 pr-12">
              {(!sidebarOpen || mobile) && <ShowSidebarButton onClick={() => toggleSidebar(true)} className="-ml-1.5" />}
              {/* Board: just the title up top, with the pipeline switch and the filters right beside it */}
              {view === "board" && (
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
                  <h1 className="m-0 text-[28px] font-semibold tracking-[-0.015em] text-(--c-t-1b1b1b)">Board</h1>
                  <div className="flex h-8 overflow-hidden rounded-lg ring-1 ring-(--c-l-e3e3e0)" role="group" aria-label="Which board">
                    {PROJECT_TYPES.map((t) => (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => setBoardType(t.value)}
                        aria-pressed={boardType === t.value}
                        title={t.hint}
                        className={`inline-flex items-center gap-1.5 px-2.5 text-[13px] ${
                          boardType === t.value ? "bg-(--c-b-1b1b1b) font-medium text-(--c-on-ink)" : "text-(--c-t-6b6b6b) hover:bg-(--c-b-f4f4f4) hover:text-(--c-t-1b1b1b)"
                        }`}
                      >
                        <TypeIcon type={t.value} size={13} />
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <label className="hidden h-8 w-[200px] items-center gap-2 rounded-lg bg-(--c-b-ffffff)/70 px-2 text-(--c-t-9a9a9a) ring-1 ring-(--c-l-e3e3e0) transition-[width] focus-within:w-[240px] focus-within:ring-(--c-l-c9c9c9) sm:flex">
                    <IconSearch size={14} />
                    <input
                      id="sidebar-search"
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Filter by title"
                      aria-label="Filter projects by title"
                      className="w-full min-w-0 border-none bg-transparent text-[13px] text-(--c-t-1b1b1b) outline-none"
                    />
                  </label>
                  <button
                    type="button"
                    aria-pressed={filtersOpen}
                    onClick={() => {
                      setFiltersOpen(!filtersOpen);
                      remember("home-filters", filtersOpen ? "0" : "1");
                    }}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] hover:bg-(--c-b-f4f4f4) ${activeFilters ? "text-(--c-t-2358d8)" : "text-(--c-t-737373)"}`}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                      <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
                    </svg>
                    Filter{activeFilters ? ` · ${activeFilters}` : ""}
                  </button>
                  <button
                    type="button"
                    onClick={newProject}
                    disabled={creating}
                    className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-(--c-b-1b1b1b) px-3 text-[13px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333) disabled:opacity-50"
                  >
                    <IconPlus size={14} color="var(--c-on-ink)" />
                    New project
                  </button>
                </div>
              )}
            </div>
            {view !== "board" && (
              <div className="mt-6 flex flex-wrap items-end justify-between gap-3 border-b border-(--c-l-ebebeb) pb-3">
                <div>
                  <h1 className="m-0 text-[32px] font-semibold tracking-[-0.015em] text-(--c-t-1b1b1b)">
                    {view === "calendar" ? "Calendar" : view === "feed" ? "Feed" : "Projects"}
                  </h1>
                  {view !== "feed" && (
                    <p className="m-0 mt-1 text-[14px] text-(--c-t-737373)">
                      {heading}
                      {q && ` · matching "${search.trim()}"`}
                      {projects && ` · ${shown.length}`}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {view !== "feed" && (
                    <label className="mr-1 hidden h-8 w-[180px] items-center gap-2 rounded-lg px-2 text-(--c-t-9a9a9a) ring-1 ring-(--c-l-e3e3e0) transition-[width] focus-within:w-[220px] focus-within:ring-(--c-l-c9c9c9) sm:flex">
                      <IconSearch size={14} />
                      <input
                        id="sidebar-search"
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Filter by title"
                        aria-label="Filter projects by title"
                        className="w-full min-w-0 border-none bg-transparent text-[13px] text-(--c-t-1b1b1b) outline-none"
                      />
                    </label>
                  )}
                  {view !== "feed" && (
                    <button
                      type="button"
                      aria-pressed={filtersOpen}
                      onClick={() => {
                        setFiltersOpen(!filtersOpen);
                        remember("home-filters", filtersOpen ? "0" : "1");
                      }}
                      className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] hover:bg-(--c-b-f4f4f4) ${
                        activeFilters ? "text-(--c-t-2358d8)" : "text-(--c-t-737373)"
                      }`}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                        <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
                      </svg>
                      Filter{activeFilters ? ` · ${activeFilters}` : ""}
                    </button>
                  )}
                  {view === "list" && <SortMenu sort={sort} onChange={setSort} />}
                  <button
                    type="button"
                    onClick={newProject}
                    disabled={creating}
                    className="ml-1.5 inline-flex h-8 items-center gap-1.5 rounded-lg bg-(--c-b-1b1b1b) px-3 text-[13px] font-medium text-(--c-on-ink) hover:bg-(--c-b-333333) disabled:opacity-50"
                  >
                    <IconPlus size={14} color="var(--c-on-ink)" />
                    New project
                  </button>
                </div>
              </div>
            )}

            {filtersOpen && view !== "feed" && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {/* The board's columns are the stages, and its segmented control is the type */}
                {view !== "board" && (
                  <FilterSelect
                    label="Stage"
                    value={stageFilter}
                    onChange={setStageFilter}
                    options={[
                      { value: "all", label: `All stages${counts ? ` (${counts.stage.all})` : ""}` },
                      ...ALL_STAGES.map((x) => ({ value: x.value, label: `${x.glyph} ${x.label}${counts ? ` (${counts.stage[x.value] ?? 0})` : ""}` })),
                    ]}
                  />
                )}
                {view !== "board" && (
                  <FilterSelect
                    label="Type"
                    value={typeFilter}
                    onChange={(v) => setTypeFilter(v as typeof typeFilter)}
                    options={[
                      { value: "all", label: `All types${counts ? ` (${counts.type.all})` : ""}` },
                      ...PROJECT_TYPES.map((x) => ({ value: x.value, label: `${x.label}${counts ? ` (${counts.type[x.value] ?? 0})` : ""}` })),
                    ]}
                  />
                )}
                <FilterSelect
                  label="Club"
                  value={clubFilter}
                  onChange={setClubFilter}
                  options={[
                    { value: "all", label: `All clubs${counts ? ` (${counts.club.all})` : ""}` },
                    { value: "none", label: `Network-wide${counts ? ` (${counts.club.none ?? 0})` : ""}` },
                    ...(clubs ?? []).map((c) => ({ value: c._id as string, label: `${c.name}${counts ? ` (${counts.club[c._id] ?? 0})` : ""}` })),
                  ]}
                />
                {activeFilters > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setStageFilter("all");
                      setTypeFilter("all");
                      setClubFilter("all");
                    }}
                    className="h-8 rounded-full px-3 text-[13px] text-(--c-t-737373) hover:bg-(--c-b-f4f4f4) hover:text-(--c-t-1b1b1b)"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}

            {view === "list" ? (
              <>
                <div className="h-2" />
                {pane}
              </>
            ) : (
              <div className="mt-5">{pane}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AccountButton({ initial, email }: { initial: string; email: string }) {
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} className="absolute right-5 top-6 sm:right-10">
      <button
        type="button"
        aria-label="Account"
        onClick={() => setOpen(!open)}
        className="h-9 w-9 rounded-full border border-(--c-l-dcdcdc) bg-(--c-b-ffffff) text-[14px] font-semibold text-(--c-t-1b1b1b)"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-40 w-64 rounded-xl border border-(--c-l-ebebeb) bg-(--c-b-ffffff) p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.10)]">
          <div className="truncate px-2 py-2 text-[13px] text-(--c-t-737373)">{email}</div>
          <div className="px-1 pb-2 pt-0.5">
            <div className="mb-1.5 px-1 text-[12px] text-(--c-t-9a9a9a)">Appearance</div>
            <ThemeToggle />
          </div>
          <div className="mx-1 mb-1 h-px bg-(--c-b-ebebeb)" />
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex h-[34px] w-full items-center rounded-md px-2 text-left text-[14px] text-(--c-t-1b1b1b) hover:bg-(--c-b-f4f4f4)"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
