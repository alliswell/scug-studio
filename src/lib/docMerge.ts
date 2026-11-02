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

/**
 * A line we and someone else both changed. Ours is kept; theirs is here so nothing is lost.
 *   changed  we edited it, they had edited it first
 *   removed  we edited it, they had deleted it
 *   kept     we deleted it, they had just edited it — so their row is still there
 */
export type Clash = {
  key: string;
  reason: "changed" | "removed" | "kept";
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
  const serverAt = new Map(server.map((b, i) => [b.id, i]));
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
      // A held line's base stays pinned to the rev whose words it actually holds. Letting it drift
      // to the server's latest would make "keep mine" land silently on top of an edit the person
      // was never shown.
      if (!mineChanged && !held.has(l.id) && s.rev !== was.rev) {
        next.set(l.id, { ...was, rev: s.rev });
        baseTouched = true;
      }
    }
  }

  // Lines they added that we have never seen. Anchored to the line they follow on the server, NOT
  // to their server index: our list is offset by every line we have typed or deleted and not yet
  // saved, so an index would drop their sentence into the wrong paragraph — and our next save
  // would then write that wrong order back for everyone.
  server.forEach((s, i) => {
    if (mine.has(s.id) || base.has(s.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((b) => b.id === server[j].id);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, fromServer(s));
    took.set(s.id, s.rev);
    changed = true;
  });

  // Reordering. A line we have not moved ourselves should sit where the server has it, or one
  // person's drag is silently dragged back by the next person who presses Enter above it. If we
  // HAVE reordered, ours wins and nothing is lost — a move loses no words either way.
  const sharedAt: number[] = [];
  const shared: Block[] = [];
  out.forEach((b, i) => {
    if (theirs.has(b.id) && base.has(b.id)) {
      sharedAt.push(i);
      shared.push(b);
    }
  });
  const byBasePos = [...shared].sort((a, b) => (base.get(a.id)?.pos ?? 0) - (base.get(b.id)?.pos ?? 0));
  const weReordered = shared.some((b, i) => b.id !== byBasePos[i].id);
  if (!weReordered) {
    const wanted = [...shared].sort((a, b) => (serverAt.get(a.id) ?? 0) - (serverAt.get(b.id) ?? 0));
    if (wanted.some((b, i) => b.id !== shared[i].id)) {
      sharedAt.forEach((slot, i) => {
        out[slot] = wanted[i];
      });
      changed = true;
    }
  }

  if (!changed) return { blocks: local, base: baseTouched ? next : base, changed: false };
  out.forEach((b, i) => {
    const rev = took.get(b.id);
    if (rev !== undefined) next.set(b.id, baseOf(b, i, rev));
  });
  return { blocks: out, base: next, changed: true };
}

export function toServer(b: Block, position: number) {
  return {
    key: b.id,
    position,
    type: b.type,
    content: b.content,
    checked: !!b.checked,
    color: b.color ?? null,
    textColor: b.textColor ?? null,
    ...(b.type === "images" ? { images: cleanImages(b.images) } : {}),
    sourceBlockId: b.source_block_id ?? null,
    ...(b.indent ? { indent: b.indent } : {}),
    ...(b.assignee ? { assignee: b.assignee as Id<"users"> } : {}),
  };
}

export type SavePlan = {
  upserts: (ReturnType<typeof toServer> & { baseRev?: number })[];
  moves: { key: string; position: number }[];
  deletes: { key: string; baseRev: number }[];
  /** What each upserted line will have been, once the server acknowledges it */
  sent: Map<string, Base>;
};

/**
 * Works out what to send: which lines changed, which only moved, which went.
 *
 * The split between `upserts` and `moves` is the load-bearing part. A line whose words are
 * untouched and which has only shifted — because somebody typed above it — goes as a MOVE, with
 * no rev guard. Sending it as a guarded write instead is what turned one keystroke at the top of
 * a document into a clash on every line anyone else was editing, whose "keep mine" then wrote
 * stale text over their words. Position is last-writer-wins; words are never.
 *
 * Pure, so the rule above is pinned by a test rather than by hope.
 */
export function planSave(local: Block[], base: Map<string, Base>, held: Set<string> = new Set()): SavePlan {
  const upserts: SavePlan["upserts"] = [];
  const moves: SavePlan["moves"] = [];
  const sent = new Map<string, Base>();
  local.forEach((b, i) => {
    if (held.has(b.id)) return;
    const was = base.get(b.id);
    const csig = contentSigOf(b);
    if (was && was.csig === csig) {
      if (was.pos !== i) moves.push({ key: b.id, position: i });
      return;
    }
    upserts.push({ ...toServer(b, i), ...(was ? { baseRev: was.rev } : {}) });
    sent.set(b.id, { csig, pos: i, rev: was?.rev ?? 0 });
  });
  const keys = new Set(local.map((b) => b.id));
  const deletes = [...base.entries()]
    .filter(([k]) => !keys.has(k) && !held.has(k))
    .map(([key, was]) => ({ key, baseRev: was.rev }));
  return { upserts, moves, deletes, sent };
}
