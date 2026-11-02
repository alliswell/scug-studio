"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { TypeIcon } from "./TypeIcon";
import {
  PROJECT_TYPES,
  clubStatusOf,
  firstStage,
  stageOf,
  stagesFor,
  typeLabel,
  type ProjectStage,
  type ProjectType,
} from "@/lib/types";

export type Meta = {
  title: string;
  /** Open date for a build-out, ship date for digital work. YYYY-MM-DD or null. */
  targetDate: string | null;
  type: ProjectType;
  stage: ProjectStage;
  /** null = network-wide work, which has no club */
  clubId?: string | null;
  brief?: string;
  briefLinks?: { id: string; label: string; url: string }[];
};

export type ClubOption = { id: string; name: string; status?: string };

export function longDate(d: string | null) {
  if (!d) return "";
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** The big project title. */
export function ProjectTitle({
  title,
  onChange,
  readOnly,
  onEnter,
}: {
  title: string;
  onChange?: (title: string) => void;
  readOnly?: boolean;
  onEnter?: () => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  const titleCls = "m-0 text-[36px] font-semibold leading-[1.2] tracking-[-0.015em] text-(--c-t-1b1b1b)";
  return (
    <>
      {readOnly ? (
        <h1 className={`${titleCls} ${title ? "" : "text-(--c-t-c9c9c9)"}`}>{title || "Untitled"}</h1>
      ) : (
        <textarea
          ref={ta}
          rows={1}
          value={title}
          placeholder="Untitled"
          aria-label="Title"
          onChange={(e) => onChange?.(e.target.value.replace(/\n/g, " "))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onEnter?.();
            }
          }}
          className={`${titleCls} block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-(--c-t-c9c9c9)`}
        />
      )}
    </>
  );
}

/**
 * A club in one small chip. The status glyph carries the state on its own — the colour behind it
 * is only ever the second channel, so the chip still reads in greyscale.
 * A missing name is network-wide work, which belongs to no club.
 */
export function ClubChip({ name, status, className = "" }: { name: string | null; status?: string | null; className?: string }) {
  const s = status ? clubStatusOf(status) : null;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-(--c-l-e6e6e3) px-2.5 py-0.5 text-[13px] leading-[1.6] ${
        name ? "text-(--c-t-1b1b1b)" : "text-(--c-t-737373)"
      } ${className}`}
    >
      {s && (
        <span aria-hidden="true" className="shrink-0 leading-none" style={{ color: s.hex }}>
          {s.glyph}
        </span>
      )}
      <span className="truncate">{name ?? "Network"}</span>
      {s && <span className="sr-only">{` — ${s.label}`}</span>}
    </span>
  );
}

/** The stage, as a glyph and a word. Never the colour alone. */
function StageMark({ type, stage }: { type: string; stage: string }) {
  const s = stageOf(stage, type);
  return (
    <span className="inline-flex items-center gap-1.5 text-(--c-t-1b1b1b)">
      <span aria-hidden="true" className="leading-none" style={{ color: s.hex }}>
        {s.glyph}
      </span>
      <span>{s.label}</span>
    </span>
  );
}

const fieldCls =
  "-ml-1.5 w-fit cursor-pointer appearance-none rounded-md bg-transparent px-1.5 py-0.5 text-[14px] text-(--c-t-1b1b1b) outline-none hover:bg-(--c-b-f4f4f4) focus:bg-(--c-b-f4f4f4)";

/** Club / Type / Stage / Target date, plus the share controls. */
export function ProjectDetails({
  meta,
  onChange,
  readOnly,
  clubs,
  clubName,
  share,
}: {
  meta: Meta;
  onChange?: (patch: Partial<Meta>) => void;
  readOnly?: boolean;
  /** Clubs to pick from; omitted on the share page, which never lists them */
  clubs?: ClubOption[];
  /** The club's name when the whole club isn't available (the share page gets the name only) */
  clubName?: string | null;
  /** The share popover, passed in so this file doesn't need to know how sharing works */
  share?: ReactNode;
}) {
  const club = clubs?.find((c) => c.id === meta.clubId) ?? null;
  const name = club?.name ?? clubName ?? null;
  const stages = stagesFor(meta.type);

  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-4 gap-y-2 pl-0.5 text-[14px] leading-[1.5]">
      <div className="text-(--c-t-737373)">Club</div>
      {readOnly || !clubs ? (
        <div>
          <ClubChip name={name} status={club?.status} />
        </div>
      ) : (
        // A project with no club is network-wide work (brand standards, a refresh across every club)
        <label className={`${fieldCls} relative flex w-fit items-center`}>
          <ClubChip name={name} status={club?.status} />
          <select
            aria-label="Club"
            value={meta.clubId ?? ""}
            onChange={(e) => onChange?.({ clubId: e.target.value || null })}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            <option value="">Network (no club)</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="text-(--c-t-737373)">Type</div>
      {readOnly ? (
        <div className="flex items-center gap-2 text-(--c-t-1b1b1b)">
          <TypeIcon type={meta.type} className="h-4 w-4" />
          {typeLabel(meta.type)}
        </div>
      ) : (
        <label className={`${fieldCls} relative flex items-center gap-2 py-1`}>
          <TypeIcon type={meta.type} className="h-4 w-4" />
          <span>{typeLabel(meta.type)}</span>
          <select
            aria-label="Type"
            value={meta.type}
            onChange={(e) => {
              const type = e.target.value as ProjectType;
              // The two pipelines share no stage values, so switching type strands the old stage.
              onChange?.({ type, stage: firstStage(type) });
            }}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            {PROJECT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label} — {t.hint}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="text-(--c-t-737373)">Stage</div>
      {readOnly ? (
        <div>
          <StageMark type={meta.type} stage={meta.stage} />
        </div>
      ) : (
        <label className={`${fieldCls} relative flex w-fit items-center py-0.5`}>
          <StageMark type={meta.type} stage={meta.stage} />
          <select
            aria-label="Stage"
            value={meta.stage}
            // Every option comes from `stages`, so the value is always one of this pipeline's stages
            onChange={(e) => onChange?.({ stage: e.target.value as ProjectStage })}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            {stages.map((s) => (
              // The glyph rides along in the option text: a native option can't be given a colour
              <option key={s.value} value={s.value}>
                {s.glyph} {s.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="text-(--c-t-737373)">{meta.type === "digital" ? "Ship date" : "Open date"}</div>
      {readOnly ? (
        <div className="text-(--c-t-1b1b1b)">
          {meta.targetDate ? longDate(meta.targetDate) : <span className="text-(--c-t-9a9a9a)">Not set</span>}
        </div>
      ) : (
        <label className="relative w-fit">
          <span className={`${fieldCls} block ${meta.targetDate ? "" : "text-(--c-t-9a9a9a)"}`}>
            {meta.targetDate ? longDate(meta.targetDate) : "Pick a date"}
          </span>
          <input
            type="date"
            aria-label="Target date"
            value={meta.targetDate ?? ""}
            onChange={(e) => onChange?.({ targetDate: e.target.value || null })}
            onClick={(e) => (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.()}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      )}

      {share && (
        <>
          <div className="text-(--c-t-737373)">Share</div>
          <div className="flex items-center gap-2">{share}</div>
        </>
      )}
    </div>
  );
}
