"use client";

import { useConvex, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Block } from "./types";
import { baseOf, cleanImages, contentSigOf, fromServer, mergeBlocks, planSave, toServer, type Base, type Clash, type ServerBlock } from "./docMerge";

export type SaveState = "idle" | "saving" | "saved" | "error";

// The merge itself is pure and lives next door, where it can be tested without React.
// Re-exported so the components that already import these from here keep working.
export { cleanImages, fromServer, mergeBlocks, planSave, baseOf, contentSigOf, toServer };
export type { Base, Clash, ServerBlock };

export function useLoadBlocks() {
  const convex = useConvex();
  return useCallback(
    async (documentId: string): Promise<Block[]> =>
      ((await convex.query(api.docs.blocks, { documentId: documentId as Id<"documents"> })) as ServerBlock[]).map(fromServer),
    [convex],
  );
}

/**
 * Autosaves a document, and folds in what other people change while you are in it.
 *
 * Every line carries the rev we last read for it. The server refuses to write over a line whose rev
 * has moved on, so a second editor can no longer wipe your sentence without either of you noticing;
 * the lines you both touched come back as clashes with their text attached.
 *
 * `mergeServer` is the other half: it takes the document as the server currently has it and folds
 * it into what is on screen. Lines you have not touched take their new text, lines you are working
 * on stay yours, and lines nobody changed keep their exact object identity so React leaves the row
 * — and your caret inside it — alone.
 */
export function useDocSync(docId: string | null, blocks: Block[] | null) {
  const syncMutation = useMutation(api.docs.sync);
  const [state, setState] = useState<SaveState>("idle");
  const [clashes, setClashes] = useState<Clash[]>([]);
  const base = useRef(new Map<string, Base>());
  const current = useRef<Block[] | null>(blocks);
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const seededFor = useRef<string | null>(null);
  /** Keys held back from saving until the person says whose version wins */
  const held = useRef(new Set<string>());
  /** Bumped by every merge, so an in-flight save can tell its snapshot has been superseded */
  const mergeGen = useRef(0);

  useEffect(() => {
    current.current = blocks;
  }, [blocks]);

  /** Call right after loading so the loaded state counts as saved. */
  const seed = useCallback((id: string, loaded: Block[], revs?: Map<string, number>) => {
    base.current = new Map(loaded.map((b, i) => [b.id, baseOf(b, i, revs?.get(b.id) ?? 0)]));
    held.current = new Set();
    seededFor.current = id;
    setClashes([]);
  }, []);

  const flushOnce = useCallback(async () => {
    const list = current.current;
    if (!docId || !list || seededFor.current !== docId) return;
    const { upserts, moves, deletes, sent } = planSave(list, base.current, held.current);
    if (!upserts.length && !moves.length && !deletes.length) return;
    setState("saving");
    // Noted before the await: a merge may land while this is in flight, and its decisions are
    // newer than the snapshot we are about to be acknowledged for.
    const gen = mergeGen.current;
    const res = (await syncMutation({ documentId: docId as Id<"documents">, upserts, moves, deletes })) as {
      applied: { key: string; rev: number }[];
      clashes: Clash[];
    };
    for (const { key, rev } of res.applied) {
      const s = sent.get(key);
      if (!s) continue;
      const now = base.current.get(key);
      // A merge took this line while we were in flight: keep what it decided and take only the rev,
      // or we would quietly revert the other person on the strength of a pre-flight snapshot.
      if (mergeGen.current !== gen && now && now.csig !== s.csig) base.current.set(key, { ...now, rev });
      else base.current.set(key, { ...s, rev });
    }
    // Only once the server has them: a failed save must leave the moves queued, or the document
    // keeps a position nobody ever wrote.
    for (const m of moves) {
      const was = base.current.get(m.key);
      if (was) base.current.set(m.key, { ...was, pos: m.position });
    }
    const clashed = new Set(res.clashes.map((c) => c.key));
    // A delete the server accepted is gone for good; one it refused stays known, so the line their
    // edit saved comes back on the next merge instead of vanishing from both sides.
    for (const d of deletes) if (!clashed.has(d.key)) base.current.delete(d.key);
    if (res.clashes.length) {
      for (const c of res.clashes) held.current.add(c.key);
      setClashes((prev) => [...prev.filter((c) => !clashed.has(c.key)), ...res.clashes]);
    }
    setState("saved");
  }, [docId, syncMutation]);

  const flush = useCallback(async () => {
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const run = async () => {
      do {
        again.current = false;
        try {
          await flushOnce();
        } catch (e) {
          console.error("save failed", e);
          setState("error");
          return;
        }
      } while (again.current);
    };
    running.current = run().finally(() => {
      running.current = null;
    });
    return running.current;
  }, [flushOnce]);

  /**
   * Folds the server's copy into what is on screen. Returns the new list, or null when there is
   * nothing to apply — so calling it repeatedly with the same server state is a no-op.
   */
  const mergeServer = useCallback(
    (server: ServerBlock[]): Block[] | null => {
      const local = current.current;
      if (!docId || !local || seededFor.current !== docId) return null;
      const merged = mergeBlocks(local, base.current, server, held.current);
      // Always taken, even when the document itself is unchanged: the merge may still have moved
      // our record of a line's rev on, and losing that would clash us over nothing later.
      base.current = merged.base;
      mergeGen.current++;
      return merged.changed ? merged.blocks : null;
    },
    [docId],
  );

  /**
   * Settle a clash, and say what the document should now do about it.
   *
   * `block` is the line to put back on screen, `at` where to put it if it is not there any more
   * (choosing their version of a delete you asked for means restoring their line), and `removed`
   * that the line should go.
   */
  const resolve = useCallback(
    (key: string, winner: "mine" | "theirs"): { block: Block | null; at: number; removed: boolean } => {
      const clash = clashes.find((c) => c.key === key);
      held.current.delete(key);
      setClashes((prev) => prev.filter((c) => c.key !== key));
      const was = base.current.get(key);
      const at = was?.pos ?? 0;
      if (!clash) return { block: null, at, removed: false };

      if (winner === "theirs") {
        if (!clash.theirs) {
          // They removed the line and we agree: forget it entirely, so no later save re-creates it.
          base.current.delete(key);
          return { block: null, at, removed: true };
        }
        base.current.set(key, { csig: contentSigOf(fromServer(clash.theirs)), pos: at, rev: clash.theirs.rev });
        return { block: fromServer(clash.theirs), at, removed: false };
      }

      // Keeping ours.
      if (!clash.theirs) {
        // They removed the line; we want it back. It must go up as a NEW line, with no claim to
        // have read a row that no longer exists — claiming one got refused again on every save,
        // forever, and the words only ever lived in the tab until it was closed.
        base.current.delete(key);
        return { block: null, at, removed: false };
      }
      // Their row is still there: mark ours dirty against the rev we have now been shown, so the
      // next save lands on top of it rather than clashing again.
      base.current.set(key, { csig: "", pos: at, rev: clash.theirs.rev });
      return { block: null, at, removed: false };
    },
    [clashes],
  );

  useEffect(() => {
    if (!blocks || !docId) return;
    const t = setTimeout(() => void flush(), 500);
    return () => clearTimeout(t);
  }, [blocks, docId, flush]);

  useEffect(() => {
    if (state !== "error") return;
    const t = setTimeout(() => void flush(), 4000);
    return () => clearTimeout(t);
  }, [state, flush]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flush]);

  return { state, flush, seed, mergeServer, clashes, resolve };
}
