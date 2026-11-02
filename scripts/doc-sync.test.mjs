// The editor's three-way merge: what happens when two people are in one document at once.
//
// This is the one place in the app where somebody's words could go missing without a trace, and it
// cannot be exercised by running the app here, so it is tested directly. Run: npm run test:sync
import assert from "node:assert/strict";
import test from "node:test";
import { baseOf, mergeBlocks, planSave } from "../src/lib/docMerge.ts";

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

test("a reorder they made arrives, rather than being silently dragged back", () => {
  // The merge used to emit strictly local order, so their drag never showed up — and the next
  // time this person pressed Enter, their stale order was written back over it.
  const { local, base } = loaded([row("a", "one", 1), row("b", "two", 1), row("c", "three", 1)]);
  const { blocks, changed } = mergeBlocks(local, base, [row("c", "three", 1), row("a", "one", 1), row("b", "two", 1)]);
  assert.equal(changed, true);
  assert.deepEqual(blocks.map((b) => b.id), ["c", "a", "b"]);
});

test("a reorder WE made wins over theirs, and loses no words either way", () => {
  const { base } = loaded([row("a", "one", 1), row("b", "two", 1), row("c", "three", 1)]);
  const local = [line("c", "three"), line("a", "one"), line("b", "two")]; // we dragged c to the top
  const { blocks } = mergeBlocks(local, base, [row("b", "two", 1), row("a", "one", 1), row("c", "three", 1)]);
  assert.deepEqual(blocks.map((b) => b.id), ["c", "a", "b"], "our own drag is not undone by theirs");
});

test("moving a line is not an EDIT: same words in a new order never clash", () => {
  // Adding one line at the top renumbers every line below it. None of those may read as a change
  // to its words, or a second person in the document would clash on the whole file.
  const { local, base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const { blocks } = mergeBlocks(local, base, [row("b", "two", 1), row("a", "one", 1)]);
  assert.deepEqual(blocks.map((b) => b.content).sort(), ["one", "two"], "every word survives a reorder");
});

test("a line they added lands next to the line it follows, not at its raw index", () => {
  // Our list is offset by a line we have typed and not yet saved. Splicing at the server's index
  // would drop their sentence into the wrong paragraph — and our next save would write that back.
  const { base } = loaded([row("a", "1. venue", 1), row("b", "2. catering", 1), row("c", "3. invites", 1)]);
  const local = [line("title", "Checklist"), line("a", "1. venue"), line("b", "2. catering"), line("c", "3. invites")];
  const server = [row("a", "1. venue", 1), row("b", "2. catering", 1), row("x", "2b. head count", 1), row("c", "3. invites", 1)];
  const { blocks } = mergeBlocks(local, base, server);
  assert.deepEqual(blocks.map((b) => b.id), ["title", "a", "b", "x", "c"], "their line follows the one it followed on the server");
});

test("a line they added after one we deleted still lands in the right place", () => {
  const { base } = loaded([row("a", "one", 1), row("b", "two", 1), row("c", "three", 1)]);
  const local = [line("b", "two"), line("c", "three")]; // we deleted a; not flushed yet
  const server = [row("a", "one", 1), row("b", "two", 1), row("x", "two and a half", 1), row("c", "three", 1)];
  const { blocks } = mergeBlocks(local, base, server);
  assert.deepEqual(blocks.map((b) => b.id), ["b", "x", "c"]);
});

test("a held line's rev stays pinned to the words it holds", () => {
  // Letting it drift to the server's latest is what made "keep mine" land silently on top of an
  // edit the person was never shown.
  const { base } = loaded([row("a", "one", 1)]);
  const local = [line("a", "one")]; // unchanged locally, but held from an earlier clash
  const merged = mergeBlocks(local, base, [row("a", "they moved on", 9)], new Set(["a"]));
  assert.equal(merged.base.get("a").rev, 1, "a held line must not quietly adopt a rev it has not seen");
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


// ---------------------------------------------------------------------------
// What the editor sends. The split between a content write and a plain move is the difference
// between "someone else is editing this line" and "someone typed above it".
// ---------------------------------------------------------------------------

test("THE BUG: typing one line at the top sends the rest as MOVES, not as guarded writes", () => {
  // Sending them as guarded writes made every line anyone else was editing come back as a false
  // clash, and "keep mine" then wrote this person's stale copy over the other person's words.
  const { local, base } = loaded([row("a", "one", 1), row("b", "two", 1), row("c", "three", 1)]);
  const withHeading = [line("new", "Heading"), ...local];
  const plan = planSave(withHeading, base);
  assert.deepEqual(plan.moves.map((m) => m.key), ["a", "b", "c"], "the shifted lines go as moves");
  assert.deepEqual(plan.upserts.map((u) => u.key), ["new"], "only the line actually typed is a write");
  assert.equal(plan.upserts[0].baseRev, undefined, "a brand new line claims to have read nothing");
  assert.equal(plan.deletes.length, 0);
  for (const m of plan.moves) assert.equal("baseRev" in m, false, "a move must carry no rev guard at all");
});

test("changing a line's words sends a guarded write, carrying the rev we read", () => {
  const { base } = loaded([row("a", "one", 1), row("b", "two", 4)]);
  const plan = planSave([line("a", "one"), line("b", "two, rewritten")], base);
  assert.equal(plan.moves.length, 0);
  assert.deepEqual(plan.upserts.map((u) => [u.key, u.baseRev]), [["b", 4]]);
});

test("a line that both moved and changed is a guarded write, not a move", () => {
  const { base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const plan = planSave([line("b", "two, rewritten"), line("a", "one")], base);
  assert.deepEqual(plan.upserts.map((u) => [u.key, u.baseRev, u.position]), [["b", 1, 0]]);
  assert.deepEqual(plan.moves.map((m) => [m.key, m.position]), [["a", 1]]);
});

test("a removed line is deleted against the rev we read, so their edit to it is not wiped", () => {
  const { base } = loaded([row("a", "one", 1), row("b", "two", 7)]);
  const plan = planSave([line("a", "one")], base);
  assert.deepEqual(plan.deletes, [{ key: "b", baseRev: 7 }]);
});

test("a line held in a clash is sent nowhere at all, not even as a move", () => {
  const { base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const plan = planSave([line("x", "new"), line("a", "one changed"), line("b", "two")], base, new Set(["a", "b"]));
  assert.deepEqual(plan.upserts.map((u) => u.key), ["x"]);
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.deletes.length, 0);
});

test("a quiet document sends nothing", () => {
  const { local, base } = loaded([row("a", "one", 1), row("b", "two", 1)]);
  const plan = planSave(local, base);
  assert.equal(plan.upserts.length + plan.moves.length + plan.deletes.length, 0);
});
