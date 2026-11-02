"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { isPdfSheet, markKindOf } from "@/lib/types";

/** A loading task, typed off the real export so the viewer never needs an `any`. */
type LoadingTask = ReturnType<typeof import("pdfjs-dist").getDocument>;

export type Sheet = { url: string | null; mime: string | null; name: string | null };
export type MarkRect = { x: number; y: number; w: number; h: number };

/** A mark as the viewer needs it: where it points, what kind it is, and whether it is still open. */
export type SheetMark = {
  id: string;
  fileIndex: number;
  page: number;
  x: number | null;
  y: number | null;
  rects: MarkRect[];
  markKind: string | null;
  text: string;
  resolved: boolean;
};

/** Where a new mark is being put, in fractions of the sheet. */
export type PinPoint = { fileIndex: number; page: number; x: number; y: number };

/** A rect mark carries no point of its own, so it hangs off its first rectangle's top-left corner. */
const anchorOf = (m: SheetMark) =>
  m.x !== null && m.y !== null ? { x: m.x, y: m.y } : m.rects[0] ? { x: m.rects[0].x, y: m.rects[0].y } : null;

/**
 * The sheet under review, and the marks pinned to it. A round holds an array of sheets; this shows
 * one at a time and lets you put a point on it.
 *
 * Positions are fractions of the sheet, never pixels, so a mark lands in the same place whatever
 * width the sheet is drawn at.
 */
export function SheetView({
  sheets,
  index,
  onIndex,
  marks,
  pinning,
  onPinning,
  pending,
  onPin,
  onPinCancel,
  onOpenMark,
  jump,
}: {
  sheets: Sheet[];
  index: number;
  onIndex: (i: number) => void;
  /** Every mark on the round being shown; this picks out the ones on the sheet it is showing. */
  marks: SheetMark[];
  pinning: boolean;
  onPinning: (on: boolean) => void;
  /** A point placed but not yet written, drawn as a hollow pin. */
  pending: PinPoint | null;
  onPin: (p: PinPoint) => void;
  onPinCancel: () => void;
  onOpenMark: (id: string) => void;
  /** Bump `nonce` to scroll to the same mark again. */
  jump: { id: string; nonce: number } | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  const sheet = sheets[index] ?? null;
  const url = sheet?.url ?? null;
  const pdf = isPdfSheet(sheet?.mime);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ---- The document, when the sheet is a PDF ----
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setDoc(null);
    setSizes([]);
    setFailed(false);
    if (!pdf || !url) return;
    let alive = true;
    let task: LoadingTask | null = null;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        task = pdfjs.getDocument({ url });
        const d = await task.promise;
        // Every page's natural size up front, so the column has its full height before anything draws
        // and a jump to a mark on page 40 lands in the right place.
        const list: { w: number; h: number }[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const vp = (await d.getPage(i)).getViewport({ scale: 1 });
          list.push({ w: vp.width, h: vp.height });
        }
        if (!alive) return;
        setDoc(d);
        setSizes(list);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      void task?.destroy();
    };
  }, [pdf, url]);

  // ---- The pin tool ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,select,[contenteditable='true']")) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        onPinning(!pinning);
      } else if (e.key === "Escape" && (pending || pinning)) {
        if (pending) onPinCancel();
        else onPinning(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinning, pending, onPinning, onPinCancel]);

  // ---- Jump to a mark ----
  // The marks and the callback are read from refs: both arrive new on every render, and in the
  // deps they would re-scroll the sheet out from under whoever is reading it.
  const latest = useRef({ marks, onIndex });
  latest.current = { marks, onIndex };
  useEffect(() => {
    if (!jump) return;
    const m = latest.current.marks.find((x) => x.id === jump.id);
    if (!m) return;
    if (m.fileIndex !== index) {
      latest.current.onIndex(m.fileIndex);
      return; // this effect runs again once the sheet has switched
    }
    scroller.current?.querySelector(`[data-page="${m.page}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(m.id);
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [jump, index, sizes.length]);

  const mine = marks.filter((m) => m.fileIndex === index);
  const pageWidth = Math.max(240, width - 40);
  const place = (page: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (!pinning) return;
    const r = e.currentTarget.getBoundingClientRect();
    onPin({ fileIndex: index, page, x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    onPinning(false);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-(--c-b-f7f7f5)">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--c-l-ebebeb) px-3 py-2">
        {sheets.length > 1 ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" role="tablist" aria-label="Sheets">
            {sheets.map((s, i) => {
              const n = marks.filter((m) => m.fileIndex === i && !m.resolved).length;
              const on = i === index;
              return (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => onIndex(i)}
                  title={s.name ?? `Sheet ${i + 1}`}
                  className={`inline-flex h-7 max-w-[180px] items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] ring-1 ${
                    on
                      ? "bg-(--c-b-1b1b1b) font-medium text-(--c-on-ink) ring-transparent"
                      : "bg-(--c-b-ffffff) text-(--c-t-4a4a4a) ring-(--c-l-e3e3e0) hover:ring-(--c-l-c9c9c9)"
                  }`}
                >
                  <span className="truncate">{s.name?.replace(/\.[^.]+$/, "") || `Sheet ${i + 1}`}</span>
                  {n > 0 && <span className={`text-[11px] tabular-nums ${on ? "opacity-70" : "text-(--c-t-9a9a9a)"}`}>{n}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-(--c-t-8a8a8a)">{sheet?.name ?? "Sheet"}</span>
        )}
        <button
          type="button"
          onClick={() => onPinning(!pinning)}
          aria-pressed={pinning}
          title="Pin a mark to a point on the sheet (N)"
          className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium ring-1 ${
            pinning ? "bg-(--c-b-1b1b1b) text-(--c-on-ink) ring-transparent" : "text-(--c-t-6b6b6b) ring-(--c-l-e3e3e0) hover:text-(--c-t-1b1b1b)"
          }`}
        >
          <PinIcon />
          Pin a mark
        </button>
      </div>

      <div ref={scroller} className={`relative min-h-0 flex-1 overflow-y-auto p-5 ${pinning ? "cursor-crosshair" : ""}`}>
        {pinning && (
          <div className="sticky top-0 z-20 -mx-5 -mt-5 mb-4 bg-(--c-b-1b1b1b) px-4 py-1.5 text-center text-[12.5px] font-medium text-(--c-on-ink)">
            Click the sheet where the mark goes · Esc to stop
          </div>
        )}
        {!sheet ? (
          <Empty>This round has no sheets.</Empty>
        ) : !url ? (
          <Empty>This sheet&rsquo;s file is missing.</Empty>
        ) : failed ? (
          <Empty>This PDF couldn&rsquo;t be opened.</Empty>
        ) : pdf ? (
          sizes.length === 0 ? (
            <Empty>Opening the drawing set…</Empty>
          ) : (
            <div className="flex flex-col items-center gap-5">
              {sizes.map((s, i) => (
                <Surface
                  key={i}
                  page={i + 1}
                  showPage={sizes.length > 1}
                  width={pageWidth}
                  height={(pageWidth * s.h) / s.w}
                  marks={mine.filter((m) => m.page === i + 1)}
                  pending={pending && pending.fileIndex === index && pending.page === i + 1 ? pending : null}
                  flash={flash}
                  pinning={pinning}
                  onOpenMark={onOpenMark}
                  onClick={(e) => place(i + 1, e)}
                >
                  {doc && <PdfPage doc={doc} n={i + 1} scale={pageWidth / s.w} root={scroller} />}
                </Surface>
              ))}
            </div>
          )
        ) : (
          <div className="flex justify-center">
            <Surface
              page={1}
              showPage={false}
              width={pageWidth}
              height={null}
              marks={mine.filter((m) => m.page === 1)}
              pending={pending && pending.fileIndex === index ? pending : null}
              flash={flash}
              pinning={pinning}
              onOpenMark={onOpenMark}
              onClick={(e) => place(1, e)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={sheet.name ?? "Sheet"} className="block w-full select-none" draggable={false} />
            </Surface>
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-[240px] items-center justify-center text-[13.5px] text-(--c-t-9a9a9a)">{children}</div>;
}

/**
 * One drawable page: the sheet itself, the marks over it, and the click that turns a position into
 * a fraction of it. Everything inside is positioned in percentages, so it holds at any width.
 */
function Surface({
  page,
  showPage,
  width,
  height,
  marks,
  pending,
  flash,
  pinning,
  onOpenMark,
  onClick,
  children,
}: {
  page: number;
  showPage: boolean;
  width: number;
  /** null = let the picture decide (an image sheet) */
  height: number | null;
  marks: SheetMark[];
  pending: PinPoint | null;
  flash: string | null;
  pinning: boolean;
  onOpenMark: (id: string) => void;
  onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      data-page={page}
      onClick={onClick}
      style={{ width, ...(height !== null ? { height } : {}) }}
      className="relative bg-white shadow-[0_1px_3px_rgba(0,0,0,0.12),0_6px_20px_rgba(0,0,0,0.06)]"
    >
      {children}
      {/* Areas first, so a pin always sits on top of the box it belongs to */}
      {marks.map((m) => {
        const k = markKindOf(m.markKind);
        return m.rects.map((r, i) => (
          <div
            key={`${m.id}-${i}`}
            aria-hidden="true"
            className={`pointer-events-none absolute rounded-[2px] ${m.resolved ? "opacity-40" : ""}`}
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
              border: `2px solid ${k.hex}`,
              background: `${k.hex}1f`,
            }}
          />
        ));
      })}
      {marks.map((m) => {
        const at = anchorOf(m);
        if (!at) return null;
        return <Marker key={m.id} m={m} at={at} flash={flash === m.id} pinning={pinning} onOpen={onOpenMark} />;
      })}
      {pending && (
        <span
          aria-hidden="true"
          style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%` }}
          className="pointer-events-none absolute z-10 h-6 w-6 -translate-x-1/2 -translate-y-full rounded-full rounded-bl-none border-2 border-dashed border-(--c-l-1b1b1b) bg-(--c-b-ffffff)"
        />
      )}
      {showPage && <span className="pointer-events-none absolute -bottom-[16px] right-0 text-[10.5px] tabular-nums text-(--c-t-9a9a9a)">{page}</span>}
    </div>
  );
}

/**
 * A mark's pin. The tip lands on the point, not the middle of the badge, so what you clicked is what
 * it points at. The glyph is what says which kind it is — the color only repeats it, for anyone who
 * reads color.
 */
function Marker({
  m,
  at,
  flash,
  pinning,
  onOpen,
}: {
  m: SheetMark;
  at: { x: number; y: number };
  flash: boolean;
  pinning: boolean;
  onOpen: (id: string) => void;
}) {
  const k = markKindOf(m.markKind);
  const label = `${k.label} (${k.colorName}): ${m.text.trim() || "no note"}${m.resolved ? " — done" : ""}`;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(m.id);
      }}
      title={label}
      aria-label={label}
      style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%`, background: k.hex, ...(pinning ? { pointerEvents: "none" as const } : {}) }}
      className={`absolute z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-full items-center justify-center rounded-full rounded-bl-none text-[12px] font-semibold leading-none text-white shadow-md transition-transform ${
        flash ? "scale-[1.4] ring-2 ring-(--c-l-1b1b1b)" : "hover:scale-110"
      } ${m.resolved ? "opacity-45" : ""}`}
    >
      {k.glyph}
    </button>
  );
}

/** One PDF page, drawn only once it is near the viewport and at the screen's own pixel density. */
function PdfPage({ doc, n, scale, root }: { doc: PDFDocumentProxy; n: number; scale: number; root: React.RefObject<HTMLDivElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    // A generous margin: a plan set is scrolled fast, and a blank page under the cursor is worse
    // than drawing a few you never reach.
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: "1200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near || !scale) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    void (async () => {
      const page = await doc.getPage(n);
      const c = canvas.current;
      if (cancelled || !c) return;
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      task = page.render({ canvas: c, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      try {
        await task.promise;
      } catch {
        return; // a cancelled render, usually because the scale changed
      }
      if (!cancelled) setDrawn(true);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, n, scale]);

  return <canvas ref={canvas} className="absolute inset-0 h-full w-full" style={{ opacity: drawn ? 1 : 0 }} />;
}

function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 14.25s4.25-4.1 4.25-7.4a4.25 4.25 0 1 0-8.5 0c0 3.3 4.25 7.4 4.25 7.4Z" />
      <circle cx="8" cy="6.75" r="1.5" />
    </svg>
  );
}
