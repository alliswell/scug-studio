import type { Id } from "../../convex/_generated/dataModel";
import type { Block } from "./types";

/**
 * Folding one document into another, with no React and no Convex in sight.
 *
 * This is the one place in the app where somebody's words could quietly go missing, so it is kept
 * pure and tested on its own — see scripts/doc-sync.test.mjs. src/lib/sync.ts wires it to the
 * editor; nothing here knows that an editor exists.
 */

export type ServerBlock = {
  id: string;
  type: Block["type"];
  content: string;
  checked: boolean;
  color: Block["color"];
  textColor?: Block["textColor"];
  images?: Block["images"];
  source_block_id: string | null;
  indent?: number;
  assignee?: string;
  /** See blocks.rev in the schema: what this line looked like when we last read it */
  rev: number;
};

/** A line we and someone else both changed. Ours is kept; theirs is here so nothing is lost. */
export type Clash = {
  key: string;
  reason: "changed" | "removed";
  /** Their version, or null when they removed the line */
  theirs: ServerBlock | null;
};

/** What we last knew about a line on the server. The base of the three-way merge below. */
export type Base = { csig: string; pos: number; rev: number };

/** Only what's stored for an image (drops upload progress and errors) */
export const cleanImages = (list: Block["images"]) =>
  (list ?? [])
    .filter((a) => a.url && a.progress === undefined && !a.error)
    .map((a) => ({ id: a.id, kind: a.kind, url: a.url, storageId: a.storageId as Id<"_storage"> | null, name: a.name, mime: a.mime, size: a.size }));

export const fromServer = (b: ServerBlock): Block => {
  const { rev: _rev, ...rest } = b;
  return { ...rest };
};

/**
 * A line's words and styling, with no mention of where it sits. Moving a line is not a change to
 * it — which matters, because adding one line at the top shifts every line below it and none of
 * those should read as somebody's edit.
 */
export const contentSigOf = (b: Block | ServerBlock) =>
  JSON.stringify([
    b.type,
    b.content,
    !!b.checked,
    b.color ?? null,
    b.textColor ?? null,
    b.source_block_id ?? null,
    b.indent ?? 0,
    b.assignee ?? null,
    cleanImages(b.images).map((i) => [i.id, i.url, i.storageId ?? null, i.name, i.mime, i.size]),
  ]);

export const baseOf = (b: Block | ServerBlock, pos: number, rev: number): Base => ({ csig: contentSigOf(b), pos, rev });

/**
 * Three-way merge of the server's copy into what is on screen: `base` is what we last read,
 * `local` is what this person has since done to it, `server` is what everyone else has done.
 *
 * The rules, in the order they matter:
 *   - a line only they changed takes their text
 *   - a line we changed stays ours, whatever they did to it; the save reports the clash
 *   - a line neither of us changed keeps its exact object, so React leaves the row — and any caret
 *     inside it — untouched
 *   - a line they deleted goes, unless we had rewritten it, in which case ours stays
 *   - a line we deleted stays deleted; we still hold a base for it, which is how we tell "they
 *     added this" apart from "we removed this"
 *   - a line already held in a clash is never quietly replaced: the person chooses
 *
 * Returns `local` itself when nothing applies, so calling it again with the same server state
 * changes nothing.
 */
export function mergeBlocks(
  local: Block[],
  base: Map<string, Base>,
  server: ServerBlock[],
  held: Set<string> = new Set(),
): { blocks: Block[]; base: Map<string, Base>; changed: boolean } {
  const theirs = new Map(server.map((b) => [b.id, b]));
  const mine = new Set(local.map((b) => b.id));
  const next = new Map(base);
  const out: Block[] = [];
  const took = new Map<string, number>();
  let changed = false;
  // Tracked apart from `changed`: a line can leave the document unchanged and still move our record
  // of it on — they edited it and edited it back, say. Dropping that would make us send a stale rev
  // later and clash over a line nobody is fighting about.
  let baseTouched = false;

  for (const l of local) {
    const was = base.get(l.id);
    const s = theirs.get(l.id);
    if (!was) {
      out.push(l); // a line we have just made and have not saved yet
      continue;
    }
    if (!s) {
      // They removed it. Let it go — unless we have rewritten it since, in which case ours stays
      // and the next save reports the clash rather than dropping our words on their say-so.
      if (contentSigOf(l) === was.csig && !held.has(l.id)) {
        next.delete(l.id);
        changed = true;
        baseTouched = true;
        continue;
      }
      out.push(l);
      continue;
    }
    const mineChanged = contentSigOf(l) !== was.csig;
    const theirsChanged = contentSigOf(s) !== was.csig;
    if (!mineChanged && theirsChanged && !held.has(l.id)) {
      out.push(fromServer(s));
      took.set(l.id, s.rev);
      changed = true;
    } else {
      out.push(l);
      if (!mineChanged && s.rev !== was.rev) {
        next.set(l.id, { ...was, rev: s.rev });
        baseTouched = true;
      }
    }
  }
  // Lines they added that we have never seen, dropped in where they sit on the server. A key we
  // still hold a base for but have no line for is one WE deleted: leave it deleted.
  server.forEach((s, i) => {
    if (mine.has(s.id) || base.has(s.id)) return;
    out.splice(Math.min(i, out.length), 0, fromServer(s));
    took.set(s.id, s.rev);
    changed = true;
  });
  if (!changed) return { blocks: local, base: baseTouched ? next : base, changed: false };
  out.forEach((b, i) => {
    const rev = took.get(b.id);
    if (rev !== undefined) next.set(b.id, baseOf(b, i, rev));
  });
  return { blocks: out, base: next, changed: true };
}
