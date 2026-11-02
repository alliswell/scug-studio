"use client";

import { useConvex, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Block } from "./types";
import { baseOf, cleanImages, contentSigOf, fromServer, mergeBlocks, type Base, type Clash, type ServerBlock } from "./docMerge";

export type SaveState = "idle" | "saving" | "saved" | "error";

// The merge itself is pure and lives next door, where it can be tested without React.
// Re-exported so the components that already import these from here keep working.
export { cleanImages, fromServer, mergeBlocks, baseOf, contentSigOf };
export type { Base, Clash, ServerBlock };

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
    const upserts: (ReturnType<typeof toServer> & { baseRev?: number })[] = [];
    const sent = new Map<string, Base>();
    list.forEach((b, i) => {
      if (held.current.has(b.id)) return;
      const was = base.current.get(b.id);
      const csig = contentSigOf(b);
      if (was && was.csig === csig && was.pos === i) return;
      upserts.push({ ...toServer(b, i), ...(was ? { baseRev: was.rev } : {}) });
      sent.set(b.id, { csig, pos: i, rev: was?.rev ?? 0 });
    });
    const keys = new Set(list.map((b) => b.id));
    const deletes = [...base.current.entries()]
      .filter(([k]) => !keys.has(k) && !held.current.has(k))
      .map(([key, was]) => ({ key, baseRev: was.rev }));
    if (!upserts.length && !deletes.length) return;
    setState("saving");
    const res = (await syncMutation({ documentId: docId as Id<"documents">, upserts, deletes })) as {
      applied: { key: string; rev: number }[];
      clashes: Clash[];
    };
    for (const { key, rev } of res.applied) {
      const s = sent.get(key);
      if (s) base.current.set(key, { ...s, rev });
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
      return merged.changed ? merged.blocks : null;
    },
    [docId],
  );

  /**
   * Settle a clash. "theirs" swaps their line in; "mine" keeps yours and writes it over theirs on
   * the next save. Either way the line starts saving again.
   */
  const resolve = useCallback((key: string, winner: "mine" | "theirs"): Block | null => {
    const clash = clashes.find((c) => c.key === key);
    held.current.delete(key);
    setClashes((prev) => prev.filter((c) => c.key !== key));
    if (!clash) return null;
    const was = base.current.get(key);
    // Either way we are now up to date with their rev, so our next write lands on top of it
    // instead of clashing again.
    if (clash.theirs) base.current.set(key, { csig: contentSigOf(fromServer(clash.theirs)), pos: was?.pos ?? 0, rev: clash.theirs.rev });
    else base.current.delete(key);
    if (winner === "theirs") return clash.theirs ? fromServer(clash.theirs) : null;
    // Keeping ours: mark the line dirty against their rev so the next flush sends it.
    if (was) base.current.set(key, { csig: "", pos: was.pos, rev: clash.theirs?.rev ?? was.rev });
    return null;
  }, [clashes]);

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
