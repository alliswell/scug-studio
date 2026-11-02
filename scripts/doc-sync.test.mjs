// The editor's three-way merge: what happens when two people are in one document at once.
//
// This is the one place in the app where somebody's words could go missing without a trace, and it
// cannot be exercised by running the app here, so it is tested directly. Run: npm run test:sync
import assert from "node:assert/strict";
import test from "node:test";
import { baseOf, mergeBlocks } from "../src/lib/docMerge.ts";

/** A line as the editor holds it. */
const line = (id, content, extra = {}) => ({ id, type: "p", content, checked: false, color: null, source_block_id: null, ...extra });
/** The same line as the server returns it, with the rev the editor checks against. */
const row = (id, content, rev, extra = {}) => ({ ...line(id, content, extra), rev });

/** The state right after a load: local matches server, and every base is in step. */
const loaded = (rows) => ({
  local: rows.map(({ rev: _rev, ...b }) => b),
  base: new Map(rows.map((r, i) => [r.id, baseOf(r, i, r.rev)])),
  server: rows,
});

test("a quiet document merges to nothing, and does so every time", () => {
  const { local, base, server } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const first = mergeBlocks(local, base, server);
  assert.equal(first.changed, false);
  assert.equal(first.blocks, local, "an unchanged merge must hand back the very same array");
  const again = mergeBlocks(first.blocks, first.base, server);
  assert.equal(again.changed, false);
});

test("a line only they changed takes their text", () => {
  const { local, base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const { blocks, changed } = mergeBlocks(local, base, [row("a", "one", 1), row("b", "TWO, rewritten", 2)]);
  assert.equal(changed, true);
  assert.deepEqual(blocks.map((b) => b.content), ["one", "TWO, rewritten"]);
});

test("a line neither of us touched keeps its exact object, so the caret in it does not move", () => {
  const { local, base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const { blocks } = mergeBlocks(local, base, [row("a", "one", 1), row("b", "TWO", 2)]);
  assert.equal(blocks[0], local[0], "the untouched line must be the same object React already rendered");
  assert.notEqual(blocks[1], local[1]);
});

test("THE BUG: a line we are editing is never replaced by theirs", () => {
  const { base } = loaded([row("a", "one", 1)]);
  const local = [line("a", "my new sentence")]; // typed since the load
  const { blocks, changed } = mergeBlocks(local, base, [row("a", "their new sentence", 2)]);
  assert.equal(changed, false);
  assert.equal(blocks[0].content, "my new sentence", "our words must survive their concurrent edit");
});

test("a line they deleted goes, if we had not touched it", () => {
  const { local, base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const { blocks, changed } = mergeBlocks(local, base, [row("a", "one", 1)]);
  assert.equal(changed, true);
  assert.deepEqual(blocks.map((b) => b.id), ["a"]);
});

test("a line they deleted STAYS if we had rewritten it", () => {
  const { base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const local = [line("a", "one"), line("b", "two, and more besides")];
  const { blocks } = mergeBlocks(local, base, [row("a", "one", 1)]);
  assert.deepEqual(blocks.map((b) => b.content), ["one", "two, and more besides"], "their delete must not take our rewrite with it");
});

test("a line we deleted is not resurrected by the next merge", () => {
  const { base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const local = [line("a", "one")]; // we removed b; the delete has not flushed yet
  const { blocks, changed } = mergeBlocks(local, base, [row("a", "one", 1), row("b", "two", 1)]);
  assert.equal(changed, false);
  assert.deepEqual(blocks.map((b) => b.id), ["a"]);
});

test("a line they added arrives, at the place it sits on the server", () => {
  const { local, base } = loaded([row("a", "one", 1), row("c", "three", 1)]);
  const { blocks, changed } = mergeBlocks(local, base, [row("a", "one", 1), row("b", "two", 1), row("c", "three", 1)]);
  assert.equal(changed, true);
  assert.deepEqual(blocks.map((b) => b.id), ["a", "b", "c"]);
});

test("a line we have just made, and never saved, is left alone", () => {
  const { base } = loaded([row("a", "one", 1)]);
  const local = [line("a", "one"), line("new", "just typed")];
  const { blocks } = mergeBlocks(local, base, [row("a", "one", 1)]);
  assert.deepEqual(blocks.map((b) => b.id), ["a", "new"]);
});

test("a line already held in a clash is never swapped out from under the person", () => {
  const { base } = loaded([row("a", "one", 1)]);
  const local = [line("a", "mine")];
  const { blocks, changed } = mergeBlocks(local, base, [row("a", "theirs", 2)], new Set(["a"]));
  assert.equal(changed, false);
  assert.equal(blocks[0].content, "mine");
});

test("a held line is not deleted out from under the person either", () => {
  const { base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const local = [line("a", "one"), line("b", "two")];
  const { blocks } = mergeBlocks(local, base, [row("a", "one", 1)], new Set(["b"]));
  assert.deepEqual(blocks.map((b) => b.id), ["a", "b"]);
});

test("moving a line is not an edit: reordering alone merges to nothing", () => {
  // Adding one line at the top renumbers every line below it. None of those may read as a change,
  // or a second person in the document would clash on the whole file.
  const { local, base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const { changed } = mergeBlocks(local, base, [row("b", "two", 1), row("a", "one", 1)]);
  assert.equal(changed, false, "same words, different order, same revs — nothing to apply");
});

test("taking their line brings its rev along, so our next save lands on top instead of clashing", () => {
  const { local, base } = loaded([row("a", "one", 1)]);
  const merged = mergeBlocks(local, base, [row("a", "theirs", 7)]);
  assert.equal(merged.base.get("a").rev, 7);
  assert.equal(merged.base.get("a").csig, baseOf(row("a", "theirs", 7), 0, 7).csig);
});

test("their rev moving on a line we did not touch is recorded, even when the words came back", () => {
  // They edited it and edited it back. The words match our base, but the rev has moved, and sending
  // the old rev later would be refused for no reason.
  const { local, base } = loaded([row("a", "one", 1)]);
  const merged = mergeBlocks(local, base, [row("a", "one", 3)]);
  assert.equal(merged.base.get("a").rev, 3);
});

test("the base no longer mentions a line that both sides dropped", () => {
  const { local, base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const merged = mergeBlocks(local, base, [row("a", "one", 1)]);
  assert.equal(merged.base.has("b"), false);
});

test("a merge never loses a line: every id survives unless one side deleted it", () => {
  const { base } = loaded([row("a", "1", 1), row("b", "2", 1), row("c", "3", 1)]);
  const local = [line("a", "1 mine"), line("b", "2"), line("c", "3")];
  const server = [row("a", "1 theirs", 2), row("b", "2 theirs", 2), row("c", "3", 1), row("d", "4 theirs", 1)];
  const { blocks } = mergeBlocks(local, base, server);
  assert.deepEqual(blocks.map((b) => b.id).sort(), ["a", "b", "c", "d"]);
  assert.equal(blocks.find((b) => b.id === "a").content, "1 mine", "the line we changed stays ours");
  assert.equal(blocks.find((b) => b.id === "b").content, "2 theirs", "the line only they changed takes theirs");
});

test("merging is idempotent: a second pass over the same server state changes nothing", () => {
  const { local, base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const server = [row("a", "one", 1), row("b", "TWO", 2), row("c", "three", 1)];
  const first = mergeBlocks(local, base, server);
  assert.equal(first.changed, true);
  const second = mergeBlocks(first.blocks, first.base, server);
  assert.equal(second.changed, false, "re-running the same merge must be a no-op");
  assert.equal(second.blocks, first.blocks);
});

test("checking a box counts as a change; moving the line it is on does not", () => {
  const { local, base } = loaded([row("a", "task", 1, { type: "todo" })]);
  const ticked = mergeBlocks(local, base, [row("a", "task", 2, { type: "todo", checked: true })]);
  assert.equal(ticked.changed, true);
  assert.equal(ticked.blocks[0].checked, true);
});
