"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { clubStatusOf, reviewStatusOf, stageOf } from "@/lib/types";
import { initials, personColor } from "@/lib/people";
import { linkSegments, mentionOf } from "@/lib/docLinks";
import { TypeIcon } from "./TypeIcon";
import { openCommandPalette, useHomeView, type View } from "./HomeSidebar";
import { IconSearch } from "./icons";

/**
 * Home: a search box that opens the ⌘K switcher, then what matters right now: the shared Todo list,
 * anything urgent, the work in flight, what lands next, where each club stands and which review
 * rounds are waiting on an answer. Everything is read from the same queries the other pages use.
 */

const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "Today", "Tomorrow", "Thu, Oct 9" */
function dayLabel(iso: string, today: string, tomorrow: string) {
  if (iso === today) return "Today";
  if (iso === tomorrow) return "Tomorrow";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function HomeDashboard() {
  const { setView } = useHomeView();
  const me = useQuery(api.users.me);
  const projects = useQuery(api.projects.list);
  const clubs = useQuery(api.clubs.list);
  const reviews = useQuery(api.reviews.list, {});
  const feed = useQuery(api.updates.feed, { limit: 30 });
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => setNow(new Date()), []);

  const go = (v: View) => {
    setView(v);
    try {
      localStorage.setItem("home-view", v);
    } catch {}
    window.scrollTo({ top: 0 });
  };

  const name = me?.name?.trim().split(/\s+/)[0] || "";
  const hour = now?.getHours() ?? 12;
  const greeting = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${name ? `, ${name}` : ""}`;

  const today = now ? localIso(now) : "";
  const tomorrow = now ? localIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) : "";

  // Real work, in either pipeline: past the idea stage and not finished
  const inProgress = (projects ?? [])
    .filter((p) => {
      const st = stageOf(p.stage, p.type);
      return !st.quiet && !st.terminal;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const comingUp = (projects ?? [])
    .filter((p) => p.targetDate && p.targetDate >= today && !stageOf(p.stage, p.type).terminal)
    .sort((a, b) => a.targetDate!.localeCompare(b.targetDate!));
  const urgent = (feed ?? []).filter((u) => u.urgent).sort((a, b) => b.happenedAt - a.happenedAt);
  const latest = (feed ?? []).filter((u) => !u.urgent).slice(0, 5);
  // Rounds nobody has signed off or redlined yet: the ones that stall a project
  const waiting = (reviews ?? [])
    .filter((r) => r.status === "inReview" || r.status === "changesRequested")
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="mx-auto max-w-[960px] px-5 pb-28">
      <h1 className="m-0 pt-[9vh] text-center text-[30px] font-semibold tracking-[-0.015em] text-(--c-t-1b1b1b)">
        {me === undefined ? " " : greeting}
      </h1>
      <button
        type="button"
        onClick={openCommandPalette}
        className="mx-auto mt-6 flex h-12 w-full max-w-[560px] items-center gap-3 rounded-xl bg-(--c-b-ffffff) px-4 text-left text-[15px] text-(--c-t-9a9a9a) shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-(--c-l-e3e3e0) transition-shadow hover:ring-(--c-l-c9c9c9)"
      >
        <IconSearch size={16} />
        <span className="flex-1">Search Switchyards Studio</span>
        <kbd className="hidden font-sans text-[12px] tracking-wide text-(--c-t-b0b0b0) sm:inline">⌘K</kbd>
      </button>

      <TodoSection className="mt-14" />

      {urgent.length > 0 && (
        <Section className="mt-12" title="Needs attention" count={urgent.length} tone="urgent" more={{ label: "Feed", run: () => go("feed") }}>
          {urgent.slice(0, 5).map((u) => (
            <Row key={u.id} href={`/p/${u.projectId}`} right={ago(u.happenedAt)}>
              <span className="shrink-0 text-(--c-t-b42318)" aria-hidden="true">
                ✕
              </span>
              <span className="truncate text-(--c-t-1b1b1b)">{u.title}</span>
              <span className="hidden truncate text-(--c-t-9a9a9a) sm:inline">{u.projectTitle || "Untitled"}</span>
            </Row>
          ))}
        </Section>
      )}

      <div className={`grid grid-cols-1 gap-x-14 gap-y-12 md:grid-cols-2 ${urgent.length ? "mt-12" : "mt-14"}`}>
        <Section title="In progress" count={projects ? inProgress.length : undefined} more={{ label: "Projects", run: () => go("list") }}>
          {projects === undefined ? (
            <Loading />
          ) : inProgress.length === 0 ? (
            <Empty>Nothing in flight.</Empty>
          ) : (
            inProgress.slice(0, 6).map((p) => {
              const st = stageOf(p.stage, p.type);
              return (
                <Row key={p._id} href={`/p/${p._id}`} right={p.targetDate && now ? dayLabel(p.targetDate, today, tomorrow) : st.label}>
                  <span className="flex w-4 shrink-0 justify-center text-(--c-t-8a8a8a)">
                    <TypeIcon type={p.type} size={14} />
                  </span>
                  <span className={`truncate ${p.title ? "text-(--c-t-1b1b1b)" : "text-(--c-t-9a9a9a)"}`}>{p.title || "Untitled"}</span>
                  <span className="shrink-0" style={{ color: st.hex }} title={`${st.label} (${st.colorName})`} aria-label={st.label}>
                    {st.glyph}
                  </span>
                  {p.openMarks > 0 && (
                    <span className="shrink-0 rounded-full bg-(--c-b-fdecea) px-2 py-px text-[11px] font-medium text-(--c-t-b42318)">
                      {p.openMarks} open {p.openMarks === 1 ? "mark" : "marks"}
                    </span>
                  )}
                </Row>
              );
            })
          )}
        </Section>

        <Section title="Coming up" more={{ label: "Calendar", run: () => go("calendar") }}>
          {projects === undefined || !now ? (
            <Loading />
          ) : comingUp.length === 0 ? (
            <Empty>Nothing scheduled.</Empty>
          ) : (
            comingUp.slice(0, 6).map((p) => {
              const st = stageOf(p.stage, p.type);
              return (
                <Row key={p._id} href={`/p/${p._id}`} right={<span className="text-(--c-t-6b6b6b)">{dayLabel(p.targetDate!, today, tomorrow)}</span>}>
                  <span className="shrink-0" style={{ color: st.hex }} title={`${st.label} (${st.colorName})`} aria-label={st.label}>
                    {st.glyph}
                  </span>
                  <span className={`truncate ${p.title ? "text-(--c-t-1b1b1b)" : "text-(--c-t-9a9a9a)"}`}>{p.title || "Untitled"}</span>
                </Row>
              );
            })
          )}
        </Section>

        <Section title="Clubs" count={clubs ? clubs.length : undefined} more={{ label: "All clubs", run: () => go("clubs") }}>
          {clubs === undefined ? (
            <Loading />
          ) : clubs.length === 0 ? (
            <Empty>No clubs yet.</Empty>
          ) : (
            clubs.slice(0, 6).map((c) => {
              const st = clubStatusOf(c.status);
              return (
                <Row
                  key={c._id}
                  href={`/c/${c._id}`}
                  right={c.activeCount ? `${c.activeCount} in flight` : <span className="text-(--c-t-b0b0b0)">nothing in flight</span>}
                >
                  <span className="shrink-0" style={{ color: st.hex }} title={`${st.label} (${st.colorName})`} aria-label={st.label}>
                    {st.glyph}
                  </span>
                  <span className="truncate text-(--c-t-1b1b1b)">{c.name || "Untitled club"}</span>
                  <span className="hidden truncate text-(--c-t-9a9a9a) sm:inline">{st.label}</span>
                </Row>
              );
            })
          )}
        </Section>

        <Section title="Waiting on you" count={reviews ? waiting.length : undefined} more={{ label: "Reviews", run: () => go("reviews") }}>
          {reviews === undefined ? (
            <Loading />
          ) : waiting.length === 0 ? (
            <Empty>No rounds waiting.</Empty>
          ) : (
            waiting.slice(0, 6).map((r) => {
              const st = reviewStatusOf(r.status);
              return (
                <Row key={r._id} onClick={() => go("reviews")} right={ago(r.updatedAt)}>
                  <span className="shrink-0" style={{ color: st.hex }} title={`${st.label} (${st.colorName})`} aria-label={st.label}>
                    {st.glyph}
                  </span>
                  <span className="truncate text-(--c-t-1b1b1b)">{r.title || "Untitled"}</span>
                  <span className="hidden shrink-0 text-(--c-t-9a9a9a) sm:inline">v{r.roundCount}</span>
                  <span className="hidden truncate text-(--c-t-9a9a9a) sm:inline">{r.projectTitle ?? r.clubName ?? ""}</span>
                  {r.openMarks > 0 && (
                    <span className="shrink-0 rounded-full bg-(--c-b-fdecea) px-2 py-px text-[11px] font-medium text-(--c-t-b42318)">{r.openMarks} open</span>
                  )}
                </Row>
              );
            })
          )}
        </Section>

        <Section title="Latest updates" more={{ label: "Feed", run: () => go("feed") }}>
          {feed === undefined ? (
            <Loading />
          ) : latest.length === 0 ? (
            <Empty>No updates yet.</Empty>
          ) : (
            latest.map((u) => (
              <Row key={u.id} href={`/p/${u.projectId}`} right={ago(u.happenedAt)}>
                <span className="min-w-0 truncate">
                  <span className="text-(--c-t-1b1b1b)">{u.title}</span>
                  <span className="text-(--c-t-9a9a9a)"> · {u.projectTitle || "Untitled"}</span>
                </span>
              </Row>
            ))
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  tone,
  more,
  className = "",
  children,
}: {
  title: string;
  count?: number;
  tone?: "urgent";
  more?: { label: string; run: () => void };
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`min-w-0 ${className}`}>
      <div className="mb-1.5 flex h-7 items-center gap-2 px-2">
        <h2 className={`m-0 text-[13px] font-medium ${tone === "urgent" ? "text-(--c-t-b42318)" : "text-(--c-t-737373)"}`}>{title}</h2>
        {count !== undefined && count > 0 && <span className="text-[12px] text-(--c-t-b0b0b0)">{count}</span>}
        {more && (
          <button type="button" onClick={more.run} className="ml-auto text-[12.5px] text-(--c-t-9a9a9a) hover:text-(--c-t-1b1b1b)">
            {more.label}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

const rowCls = "flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-[14px] no-underline hover:bg-(--c-b-f4f4f4)";

function Row({
  href,
  external,
  onClick,
  right,
  children,
}: {
  href?: string;
  external?: boolean;
  onClick?: () => void;
  right?: ReactNode;
  children: ReactNode;
}) {
  const inner = (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2.5">{children}</span>
      {right !== undefined && <span className="shrink-0 whitespace-nowrap text-[12.5px] text-(--c-t-9a9a9a)">{right}</span>}
    </>
  );
  if (href && external)
    return (
      <a href={href} target="_blank" rel="noreferrer" className={rowCls}>
        {inner}
      </a>
    );
  if (href)
    return (
      <Link href={href} className={rowCls}>
        {inner}
      </Link>
    );
  return (
    <button type="button" onClick={onClick} className={rowCls}>
      {inner}
    </button>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-2 px-2 pt-1">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-5 animate-pulse rounded bg-(--c-b-f4f4f4)" style={{ width: `${80 - i * 15}%` }} />
      ))}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-2 py-2 text-[14px] text-(--c-t-9a9a9a)">{children}</p>;
}

/** "Some **bold** and a [link](url)" → "Some bold and a link" */
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\n/g, " ");

/** The team's Todo list, at the top of Home for everyone: its items (with sub-bullets), and a quick add */
function TodoSection({ className = "" }: { className?: string }) {
  const todo = useQuery(api.todo.get);
  const openM = useMutation(api.todo.open);
  const addM = useMutation(api.todo.add);
  // Ticking shows straight away; the save follows
  const setItem = useMutation(api.todo.setItem).withOptimisticUpdate((store, a) => {
    const cur = store.getQuery(api.todo.get, {});
    if (!cur) return;
    store.setQuery(api.todo.get, {}, {
      ...cur,
      lines: cur.lines.map((l) => (l.key === a.key ? { ...l, ...(a.checked !== undefined ? { checked: a.checked } : {}), ...(a.assignee !== undefined ? { assignee: a.assignee } : {}) } : l)),
    });
  });
  const team = useQuery(api.users.list);
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [showAll, setShowAll] = useState(false);
  const open = async () => router.push(`/p/${todo?.id ?? (await openM())}`);
  const lines = (todo?.lines ?? []).filter((l) => l.content.trim() || l.files);
  const LIMIT = 12;
  const shown = showAll ? lines : lines.slice(0, LIMIT);
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    void addM({ text: t });
  };
  return (
    <Section className={className} title="Todo" count={todo ? lines.length : undefined} more={{ label: "Open", run: () => void open() }}>
      {todo === undefined ? (
        <Loading />
      ) : (
        <>
          {shown.map((l) => {
            const who = l.assignee ? team?.find((p) => p.id === l.assignee) : undefined;
            const done = l.checked;
            return (
              <div
                key={l.key}
                className="group/todo flex min-h-9 w-full items-start gap-2.5 rounded-lg px-2 py-[7px] text-[14px] leading-[1.45] hover:bg-(--c-b-f4f4f4)"
                style={{ paddingLeft: 8 + Math.min(4, l.indent) * 22 }}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={done}
                  aria-label={done ? `Mark "${plain(l.content)}" not done` : `Mark "${plain(l.content)}" done`}
                  onClick={() => void setItem({ key: l.key, checked: !done })}
                  className="flex h-[1.45em] w-4 shrink-0 items-center justify-center"
                >
                  <span
                    className={`flex h-[15px] w-[15px] items-center justify-center rounded-[4px] border-[1.4px] transition-colors ${done ? "border-(--c-t-1b1b1b) bg-(--c-t-1b1b1b) text-(--c-on-ink)" : "border-(--c-t-9a9a9a) hover:border-(--c-t-1b1b1b)"}`}
                  >
                    {done && (
                      <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m2.5 6.2 2.3 2.3 4.7-4.9" />
                      </svg>
                    )}
                  </span>
                </button>
                <button type="button" onClick={() => void open()} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
                  <span className={`min-w-0 flex-1 ${done ? "text-(--c-t-9a9a9a) line-through decoration-(--c-t-c4c4c4)" : "text-(--c-t-1b1b1b)"}`}>
                    {l.content.trim() ? (
                      <TodoText text={l.content} onOpenProject={(id) => router.push(`/p/${id}`)} />
                    ) : (
                      <span className="text-(--c-t-9a9a9a)">{l.files === 1 ? "1 file" : `${l.files} files`}</span>
                    )}
                  </span>
                  {l.comments > 0 && (
                    <span className="mt-[2px] flex shrink-0 items-center gap-1 text-[12px] text-(--c-t-9a9a9a)" title={`${l.comments} comment${l.comments === 1 ? "" : "s"}`}>
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2.75 3.25h10.5v7.5H7.5l-3 2.5v-2.5H2.75z" />
                      </svg>
                      {l.comments}
                    </span>
                  )}
                  {who && (
                    <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-(--c-t-6b6b6b)" title={`Assigned to ${who.name}`}>
                      <span className="flex h-5 w-5 items-center justify-center rounded-full text-[9.5px] font-semibold text-white" style={{ background: personColor(who.color) }}>
                        {initials(who.name)}
                      </span>
                      <span className="max-sm:hidden">{who.name.split(/\s+/)[0]}</span>
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          {lines.length > LIMIT && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="h-8 rounded-lg px-2 text-left text-[13px] text-(--c-t-8a8a8a) hover:bg-(--c-b-f4f4f4) hover:text-(--c-t-1b1b1b)">
              {showAll ? "Show less" : `Show all ${lines.length}`}
            </button>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
            className="flex h-9 items-center gap-2.5 rounded-lg px-2 focus-within:bg-(--c-b-f4f4f4) hover:bg-(--c-b-f4f4f4)"
          >
            <span className="flex w-3 shrink-0 justify-center text-(--c-t-9a9a9a)" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a to-do"
              aria-label="Add a to-do"
              className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-(--c-t-1b1b1b) outline-none placeholder:text-(--c-t-9a9a9a)"
            />
          </form>
        </>
      )}
    </Section>
  );
}

/** A to-do's words on Home: bold and links as text, mentioned projects as pills that open them */
function TodoText({ text, onOpenProject }: { text: string; onOpenProject: (id: string) => void }) {
  const segs = linkSegments(text.replace(/\n/g, " "));
  if (!segs) return <>{text.replace(/\n/g, " ")}</>;
  return (
    <>
      {segs.map((s, i) => {
        const id = mentionOf(s);
        if (id)
          return (
            <span
              key={i}
              role="link"
              tabIndex={0}
              className="doc-pill"
              onClick={(e) => {
                e.stopPropagation();
                onOpenProject(id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  e.preventDefault();
                  onOpenProject(id);
                }
              }}
            >
              {s.text.slice(1)}
            </span>
          );
        return s.bold ? (
          <strong key={i} className="font-semibold">
            {s.text}
          </strong>
        ) : (
          <span key={i}>{s.text}</span>
        );
      })}
    </>
  );
}
