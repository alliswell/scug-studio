// Agent API for Switchyards Studio. Every route needs the AGENT_API_KEY bearer token.
//
// Safety model: agents can change anything except delete a project. Document edits go straight in,
// and every edit first keeps the previous text as an archived version (Versions menu) that can be
// restored. suggest_project_edit still exists for when someone wants to approve changes first.

import { ConvexError, v, type Infer } from "convex/values";
import { httpAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { newSlug, writeEditedVersion } from "./lib";
import { blockColor, blockType, projectStage, projectType, textColor } from "./schema";
import { authorized } from "./agentAuth";
import { assertStage, firstStage } from "./projects";
import { resolveClub } from "./clubs";
import { insertUpdate } from "./updates";
import { insertIdea } from "./ideas";
import { reattachComments } from "./commentAnchors";
import { queueAssetSync } from "./library";
import { boardCard, boardIdOf } from "./boards";
import { ensureTodo } from "./todo";
import { attachFiles, resolveAttachments, storeBlob } from "./agentFiles";

const line = v.object({
  key: v.optional(v.string()),
  type: v.optional(blockType),
  text: v.string(),
  checked: v.optional(v.boolean()),
  /** Background color of the block */
  color: v.optional(blockColor),
  /** Color of the text */
  textColor: v.optional(textColor),
  /** Sub-bullet level for list lines (bullet, number, todo): 1 to 4; 0 or missing = top level */
  indent: v.optional(v.number()),
});
type Line = Infer<typeof line>;

const update = v.object({
  title: v.string(),
  details: v.optional(v.string()),
  link: v.optional(v.union(v.string(), v.null())),
  source: v.optional(v.union(v.string(), v.null())),
  /** When it happened, YYYY-MM-DD or a full ISO time; defaults to now */
  date: v.optional(v.string()),
  /** Needs a response right away: pinned to the top of the Log */
  urgent: v.optional(v.boolean()),
});
type UpdateArg = Infer<typeof update>;

function parseDate(d: string | undefined) {
  if (!d) return undefined;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d);
  if (!Number.isFinite(t)) throw new ConvexError("date must be YYYY-MM-DD or an ISO time");
  return t;
}

function checkTargetDate(d: string | null | undefined) {
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new ConvexError("targetDate must be YYYY-MM-DD, or null to clear it");
}

async function addUpdates(ctx: MutationCtx, projectId: Id<"projects">, list: UpdateArg[], agentName: string | undefined) {
  if (list.length > 100) throw new ConvexError("At most 100 log entries at once");
  const name = (agentName?.trim() || "Claude").slice(0, 60);
  for (const u of list) await insertUpdate(ctx, projectId, { ...u, happenedAt: parseDate(u.date) }, { name, id: null, agent: true });
}

const MAX_LINES = 2000;
const MAX_TEXT = 20000;
const site = () => process.env.SITE_URL ?? "";
const shareUrl = (slug: string) => `${site()}/s/${slug}`;
const projectUrl = (id: Id<"projects">) => `${site()}/p/${id}`;

async function resolveProject(ctx: QueryCtx, project: string) {
  const id = ctx.db.normalizeId("projects", project);
  const row = id
    ? await ctx.db.get(id)
    : await ctx.db
        .query("projects")
        .withIndex("by_slug", (q) => q.eq("shareSlug", project.split("/").pop() ?? project))
        .unique();
  if (!row) throw new ConvexError("Project not found. Pass its id or its share link; list_projects has the ids.");
  return row;
}

async function docOf(ctx: QueryCtx, projectId: Id<"projects">, kind: "main" | "tasks") {
  return ctx.db
    .query("documents")
    .withIndex("by_project", (q) => q.eq("projectId", projectId).eq("kind", kind))
    .first();
}

async function linesOf(ctx: QueryCtx, documentId: Id<"documents"> | undefined) {
  if (!documentId) return [];
  const blocks = await ctx.db
    .query("blocks")
    .withIndex("by_document", (q) => q.eq("documentId", documentId))
    .collect();
  return Promise.all(blocks.map((b) => ({
    key: b.key,
    type: b.type,
    text: b.content,
    ...(b.type === "todo" ? { checked: b.checked } : {}),
    ...(b.color ? { color: b.color } : {}),
    ...(b.textColor ? { textColor: b.textColor } : {}),
    ...(b.indent ? { indent: b.indent } : {}),
    ...(b.assignee ? { assignee: b.assignee } : {}),
    ...(b.type === "images" ? { images: (b.images ?? []).map((a) => ({ name: a.name, url: a.url })) } : {}),
  })).map(async (l, i) => (blocks[i].type === "board" ? { ...l, board: await boardCard(ctx, blocks[i].content) } : l)));
}

function checkLines(lines: Line[]) {
  if (lines.length > MAX_LINES) throw new ConvexError(`At most ${MAX_LINES} lines`);
  for (const l of lines) if (l.text.length > MAX_TEXT) throw new ConvexError(`Lines can be at most ${MAX_TEXT} characters`);
}

// ---------- Reads ----------

export const listProjects = internalQuery({
  args: { query: v.optional(v.string()), club: v.optional(v.string()), type: v.optional(projectType) },
  handler: async (ctx, { query, club, type }) => {
    const q = query?.trim().toLowerCase();
    const clubId = club ? (await resolveClub(ctx, club))._id : null;
    const rows = await ctx.db.query("projects").withIndex("by_updated").order("desc").collect();
    const out = [];
    for (const p of rows) {
      if (p.kind) continue; // notes and the Todo list have their own tools
      if (q && !p.title.toLowerCase().includes(q)) continue;
      if (type && p.type !== type) continue;
      if (clubId && p.clubId !== clubId) continue;
      const edited = await ctx.db
        .query("documents")
        .withIndex("by_project", (x) => x.eq("projectId", p._id).eq("kind", "edited"))
        .collect();
      const clubRow = p.clubId ? await ctx.db.get(p.clubId) : null;
      out.push({
        id: p._id,
        title: p.title,
        type: p.type,
        stage: p.stage,
        club: clubRow ? { id: clubRow._id, name: clubRow.name } : null,
        targetDate: p.targetDate,
        updatedAt: new Date(p.updatedAt).toISOString(),
        suggestedEditsWaiting: edited.length,
        pinned: !!p.pinnedAt,
        url: projectUrl(p._id),
        shareUrl: shareUrl(p.shareSlug),
      });
    }
    return out;
  },
});

export const project = internalQuery({
  args: { project: v.string() },
  handler: async (ctx, { project: ref }) => {
    const p = await resolveProject(ctx, ref);
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_project", (q) => q.eq("projectId", p._id))
      .collect();
    const mainLines = await linesOf(ctx, (await docOf(ctx, p._id, "main"))?._id);
    const taskLines = await linesOf(ctx, (await docOf(ctx, p._id, "tasks"))?._id);
    const lineKeys = new Set([...mainLines, ...taskLines].map((l) => l.key));
    const club = p.clubId ? await ctx.db.get(p.clubId) : null;
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_project", (q) => q.eq("projectId", p._id))
      .collect();
    return {
      id: p._id,
      title: p.title,
      type: p.type,
      stage: p.stage,
      club: club ? { id: club._id, name: club.name, status: club.status } : null,
      targetDate: p.targetDate,
      url: projectUrl(p._id),
      shareUrl: shareUrl(p.shareSlug),
      /** Everything a GC, fabricator or vendor needs, with direct download links for every file (no sign-in) */
      filesUrl: `${shareUrl(p.shareSlug)}/agent`,
      brief: p.brief ?? "",
      briefLinks: (p.briefLinks ?? []).map(({ label, url }) => ({ label, url })),
      tasks: taskLines,
      lines: mainLines,
      reviews: reviews
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((r) => ({ id: r._id, title: r.title, status: r.status, round: r.roundCount, changesRequested: !!r.changesRequestedAt })),
      log: (
        await ctx.db
          .query("updates")
          .withIndex("by_project", (q) => q.eq("projectId", p._id))
          .order("desc")
          .collect()
      ).map((u) => ({ title: u.title, date: new Date(u.happenedAt).toISOString(), source: u.source, link: u.link, details: u.details, by: u.authorName })),
      comments: comments.map((c) => ({
        id: c._id,
        lineKey: c.blockKey,
        onRemovedLine: !!c.blockKey && !lineKeys.has(c.blockKey),
        quote: c.quote,
        text: c.text,
        author: c.authorName,
        agent: c.agent,
        files: c.attachments.map((a) => ({ name: a.name, kind: a.kind, url: a.url, mime: a.mime, size: a.size })),
        createdAt: new Date(c.createdAt).toISOString(),
      })),
    };
  },
});

// ---------- Writes (all additive or reviewable) ----------

/** Studio notes for agents: id, title, dates (read or edit one like a project with get_project / edit_lines) */
export const listNotes = internalQuery({
  args: { query: v.optional(v.string()) },
  handler: async (ctx, { query }) => {
    const q = query?.trim().toLowerCase();
    const rows = (await ctx.db.query("projects").withIndex("by_updated").order("desc").collect()).filter((p) => p.kind === "journal");
    return rows
      .filter((p) => !q || p.title.toLowerCase().includes(q))
      .map((p) => ({ id: p._id, title: p.title, createdAt: new Date(p._creationTime).toISOString(), updatedAt: new Date(p.updatedAt).toISOString(), url: projectUrl(p._id) }));
  },
});

export const createProject = internalMutation({
  args: {
    title: v.string(),
    type: v.optional(projectType),
    stage: v.optional(projectStage),
    club: v.optional(v.union(v.string(), v.null())),
    targetDate: v.optional(v.union(v.string(), v.null())),
    lines: v.optional(v.array(line)),
    tasks: v.optional(v.array(v.string())),
    brief: v.optional(v.string()),
    updates: v.optional(v.array(update)),
    agentName: v.optional(v.string()),
    /** Make a studio note instead of a project */
    journal: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    if (a.brief && a.brief.length > 50000) throw new ConvexError("The brief can be at most 50,000 characters");
    checkLines(a.lines ?? []);
    checkTargetDate(a.targetDate);
    const type = a.type ?? "physical";
    const stage = a.stage ?? firstStage(type);
    assertStage(type, stage);
    const clubId = a.club ? (await resolveClub(ctx, a.club))._id : null;
    const now = Date.now();
    const slug = newSlug();
    const projectId = await ctx.db.insert("projects", {
      title: a.title.slice(0, 300),
      clubId,
      type,
      stage,
      targetDate: a.targetDate ?? null,
      ...(a.brief ? { brief: a.brief } : {}),
      shareSlug: slug,
      editPasscode: null,
      createdBy: null,
      updatedAt: now,
      ...(a.journal ? { kind: "journal" as const } : {}),
    });
    const mainId = await ctx.db.insert("documents", { projectId, kind: "main", editorName: null, guestToken: null, updatedAt: now });
    const tasksId = await ctx.db.insert("documents", { projectId, kind: "tasks", editorName: null, guestToken: null, updatedAt: now });
    const lines = a.lines?.length ? a.lines : [{ text: "" }];
    for (const [i, l] of lines.entries()) {
      await ctx.db.insert("blocks", {
        documentId: mainId,
        projectId,
        key: crypto.randomUUID(),
        position: i,
        type: l.type ?? "p",
        content: l.text,
        checked: !!l.checked,
        color: null,
        sourceBlockId: null,
      });
    }
    for (const [i, text] of (a.tasks ?? []).slice(0, 200).entries()) {
      await ctx.db.insert("blocks", {
        documentId: tasksId,
        projectId,
        key: crypto.randomUUID(),
        position: i,
        type: "todo",
        content: text.slice(0, MAX_TEXT),
        checked: false,
        color: null,
        sourceBlockId: null,
      });
    }
    await addUpdates(ctx, projectId, a.updates ?? [], a.agentName);
    return { id: projectId, url: projectUrl(projectId), shareUrl: shareUrl(slug) };
  },
});

/** Pin a project to the top of the project views and the sidebar, or unpin it */
export const setProjectPinned = internalMutation({
  args: { project: v.string(), pinned: v.optional(v.boolean()) },
  handler: async (ctx, { project: ref, pinned = true }) => {
    const p = await resolveProject(ctx, ref);
    await ctx.db.patch(p._id, { pinnedAt: pinned ? (p.pinnedAt ?? Date.now()) : null });
    return { id: p._id, title: p.title, pinned };
  },
});

export const updateProject = internalMutation({
  args: {
    project: v.string(),
    title: v.optional(v.string()),
    targetDate: v.optional(v.union(v.string(), v.null())),
    type: v.optional(projectType),
    stage: v.optional(projectStage),
    club: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { project: ref, club, ...patch }) => {
    const p = await resolveProject(ctx, ref);
    checkTargetDate(patch.targetDate);
    if (patch.title !== undefined) patch.title = patch.title.slice(0, 300);
    // Switching pipelines strands the old stage, so the project starts the new pipeline over
    // unless this same call says where it should land.
    const type = patch.type ?? p.type;
    const stage = patch.stage ?? (patch.type && patch.type !== p.type ? firstStage(patch.type) : p.stage);
    assertStage(type, stage);
    const clubId = club === undefined ? undefined : club === null ? null : (await resolveClub(ctx, club))._id;
    await ctx.db.patch(p._id, {
      ...patch,
      type,
      stage,
      ...(clubId !== undefined ? { clubId } : {}),
      updatedAt: Date.now(),
    });
    if (patch.title !== undefined) await queueAssetSync(ctx, p._id);
    return { id: p._id, type, stage };
  },
});

/**
 * Proposes new text for the whole document. Lines that keep an existing `key` are treated as edits of
 * that line; lines without a key are new; existing lines left out are shown as removed. Nothing
 * changes until a person clicks "Use this version". One pending suggestion per agent name.
 */
export const suggestEdit = internalMutation({
  args: { project: v.string(), agentName: v.optional(v.string()), lines: v.array(line) },
  handler: async (ctx, { project: ref, agentName, lines }) => {
    checkLines(lines);
    const p = await resolveProject(ctx, ref);
    const main = await docOf(ctx, p._id, "main");
    const existing = new Map((await linesOf(ctx, main?._id)).map((l) => [l.key, l]));
    const used = new Set<string>();
    const name = (agentName?.trim() || "Claude").slice(0, 60);
    const blocks = lines.map((l) => {
      const src = l.key && existing.has(l.key) && !used.has(l.key) ? l.key : null;
      if (src) used.add(src);
      const prev = src ? existing.get(src) : undefined;
      return {
        key: crypto.randomUUID(),
        type: l.type ?? prev?.type ?? "p",
        content: l.text,
        checked: l.checked ?? !!prev?.checked,
        color: null as Doc<"blocks">["color"],
        sourceBlockId: src,
      };
    });
    // Keep line colors from the original where the line is kept
    if (main) {
      const colors = new Map(
        (
          await ctx.db
            .query("blocks")
            .withIndex("by_document", (q) => q.eq("documentId", main._id))
            .collect()
        ).map((b) => [b.key, b.color]),
      );
      for (const b of blocks) if (b.sourceBlockId) b.color = colors.get(b.sourceBlockId) ?? null;
    }
    const token = `agent:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${p._id}`.padEnd(32, "-");
    const documentId = await writeEditedVersion(ctx, p._id, token, `${name} (agent)`, blocks);
    return { editedVersionId: documentId, note: "Saved as an Edited version. A person must accept it before the document changes." };
  },
});

export const addTasks = internalMutation({
  args: { project: v.string(), items: v.array(v.string()) },
  handler: async (ctx, { project: ref, items }) => {
    if (items.length > 200) throw new ConvexError("At most 200 tasks at once");
    const p = await resolveProject(ctx, ref);
    const now = Date.now();
    let tasks = await docOf(ctx, p._id, "tasks");
    if (!tasks) {
      const id = await ctx.db.insert("documents", { projectId: p._id, kind: "tasks", editorName: null, guestToken: null, updatedAt: now });
      tasks = (await ctx.db.get(id))!;
    }
    const current = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", tasks._id))
      .collect();
    // Replace a lone empty placeholder to-do instead of appending after it
    for (const b of current) if (!b.content.trim() && current.length === 1) await ctx.db.delete(b._id);
    let position = current.reduce((m, b) => Math.max(m, b.position), -1) + 1;
    for (const text of items) {
      await ctx.db.insert("blocks", {
        documentId: tasks._id,
        projectId: p._id,
        key: crypto.randomUUID(),
        position: position++,
        type: "todo",
        content: text.slice(0, MAX_TEXT),
        checked: false,
        color: null,
        sourceBlockId: null,
      });
    }
    await ctx.db.patch(p._id, { updatedAt: now });
    return { added: items.length };
  },
});

/** Edit one task on the project's punch list: its text, or tick it off. */
export const updateTask = internalMutation({
  args: { project: v.string(), key: v.string(), text: v.optional(v.string()), checked: v.optional(v.boolean()) },
  handler: async (ctx, { project: ref, key, text, checked }) => {
    const p = await resolveProject(ctx, ref);
    const tasks = await docOf(ctx, p._id, "tasks");
    const block = tasks
      ? await ctx.db
          .query("blocks")
          .withIndex("by_document_key", (q) => q.eq("documentId", tasks._id).eq("key", key))
          .unique()
      : null;
    if (!block) throw new ConvexError("Task not found. Use a key from the project's tasks (get_project).");
    await ctx.db.patch(block._id, {
      ...(text !== undefined ? { content: text.slice(0, MAX_TEXT) } : {}),
      ...(checked !== undefined ? { checked } : {}),
      // Bump the rev so an open editor sees this as someone else's change rather than writing over it
      rev: (block.rev ?? 0) + 1,
    });
    await ctx.db.patch(p._id, { updatedAt: Date.now() });
    return { key };
  },
});

/** Add links to the brief (lease, drawings, permit set, vendor quote, Figma). A link whose URL is already there gets the new label. */
export const addBriefLinks = internalMutation({
  args: { project: v.string(), links: v.array(v.object({ label: v.string(), url: v.string() })) },
  handler: async (ctx, { project: ref, links }) => {
    const p = await resolveProject(ctx, ref);
    const list = [...(p.briefLinks ?? [])];
    for (const l of links) {
      const url = l.url.trim();
      if (!/^https?:\/\//i.test(url)) throw new ConvexError(`Links must start with http:// or https:// (${url})`);
      const label = l.label.trim().slice(0, 120) || url;
      const i = list.findIndex((x) => x.url === url);
      if (i >= 0) list[i] = { ...list[i], label };
      else list.push({ id: crypto.randomUUID(), label, url: url.slice(0, 2000) });
    }
    if (list.length > 100) throw new ConvexError("At most 100 brief links");
    await ctx.db.patch(p._id, { briefLinks: list, updatedAt: Date.now() });
    return { links: list.map(({ label, url }) => ({ label, url })) };
  },
});

/** Write the brief. mode "append" (default) adds to the end; "replace" swaps the whole brief. */
export const setBrief = internalMutation({
  args: { project: v.string(), text: v.string(), mode: v.optional(v.union(v.literal("append"), v.literal("replace"))) },
  handler: async (ctx, { project: ref, text, mode }) => {
    const p = await resolveProject(ctx, ref);
    const cur = p.brief ?? "";
    const brief = mode === "replace" || !cur.trim() ? text : `${cur.replace(/\s+$/, "")}\n\n${text}`;
    if (brief.length > 50000) throw new ConvexError("The brief can be at most 50,000 characters");
    await ctx.db.patch(p._id, { brief, updatedAt: Date.now() });
    return { length: brief.length };
  },
});

/** Log what happened on a project (Log tab): site visits, vendor calls, approvals, inspections, dates moving. Can't be removed by agents. */
export const addUpdate = internalMutation({
  args: { project: v.string(), agentName: v.optional(v.string()), ...update.fields },
  handler: async (ctx, { project: ref, agentName, ...u }) => {
    const p = await resolveProject(ctx, ref);
    await addUpdates(ctx, p._id, [u], agentName);
    return { added: 1 };
  },
});

// ---------- Direct edits (every change keeps the previous version) ----------

type NewLine = {
  key?: string;
  type?: Doc<"blocks">["type"];
  text: string;
  checked?: boolean;
  color?: Doc<"blocks">["color"];
  textColor?: Doc<"blocks">["textColor"];
  indent?: number;
  assignee?: Id<"users">;
  /** Internal only (restoring a version): an images block's pictures */
  images?: Doc<"blocks">["images"];
};

/**
 * Makes `lines` the project document's text. The current text is kept as an earlier version (the Versions
 * menu, "Replaced … by <agent>"), so any change can be undone with Restore. Lines that keep their key stay the
 * same line (their comments stay on them); lines without a key are new; lines left out are deleted.
 */
async function replaceMain(ctx: MutationCtx, p: Doc<"projects">, lines: NewLine[], agentName: string | undefined) {
  checkLines(lines);
  const name = (agentName?.trim() || "Claude").slice(0, 60);
  const now = Date.now();
  const main = await docOf(ctx, p._id, "main");
  const old = main
    ? await ctx.db
        .query("blocks")
        .withIndex("by_document", (q) => q.eq("documentId", main._id))
        .collect()
    : [];
  const byKey = new Map(old.map((b) => [b.key, b]));
  const used = new Set<string>();
  const documentId = await ctx.db.insert("documents", { projectId: p._id, kind: "main", editorName: name, guestToken: null, updatedAt: now });
  const out = [];
  for (const [position, l] of lines.entries()) {
    const prev = l.key && byKey.has(l.key) && !used.has(l.key) ? byKey.get(l.key)! : undefined;
    // A key that isn't in the current text is honoured too (restoring an earlier version brings its lines
    // back with their old keys, so their comments come back with them)
    const reuse = !prev && l.key && !used.has(l.key) && /^[\w-]{8,64}$/.test(l.key) ? l.key : undefined;
    const key = prev ? prev.key : (reuse ?? crypto.randomUUID());
    used.add(key);
    const type = l.type ?? prev?.type ?? "p";
    let text = l.text;
    if (type === "board") {
      // A board line holds the board's id; agents may give the id or its /b/<id> link
      const id = boardIdOf(ctx, text);
      if (!id || !(await ctx.db.get(id))) throw new ConvexError(`"${text.slice(0, 80)}" isn't a board. Use list_boards for ids.`);
      // One frame of the board: "<board>#frame=<frame id>" (frame ids from get_board items)
      const frame = text.match(/[#?&](?:frame|element)=([\w-]+)/)?.[1];
      text = frame ? `${id}#frame=${frame}` : id;
    }
    await ctx.db.insert("blocks", {
      documentId,
      projectId: p._id,
      key,
      position,
      type,
      content: text.slice(0, MAX_TEXT),
      checked: l.checked ?? prev?.checked ?? false,
      color: l.color !== undefined ? l.color : (prev?.color ?? null),
      textColor: l.textColor !== undefined ? l.textColor : (prev?.textColor ?? null),
      sourceBlockId: null,
      ...((l.indent ?? prev?.indent) ? { indent: Math.max(0, Math.min(4, Math.round(l.indent ?? prev?.indent ?? 0))) } : {}),
      ...(("assignee" in l ? l.assignee : prev?.assignee) ? { assignee: ("assignee" in l ? l.assignee : prev?.assignee)! } : {}),
      ...(prev?.attachments ? { attachments: prev.attachments } : {}),
      ...(l.images ? { images: l.images } : prev?.images ? { images: prev.images } : {}),
    });
    out.push({ key, type, text });
  }
  // The old text becomes an earlier version; its label says who replaced it
  if (main) await ctx.db.patch(main._id, { kind: "archived", editorName: name, updatedAt: now });
  await ctx.db.patch(p._id, { updatedAt: now });
  // Comments are never lost: they stay on kept lines, follow rewritten ones, and come back on restore
  const tasks = await docOf(ctx, p._id, "tasks");
  const taskKeys = new Set(tasks ? (await linesOf(ctx, tasks._id)).map((l) => l.key) : []);
  const comments = await reattachComments(
    ctx,
    p._id,
    old.map((b) => ({ key: b.key, content: b.content })),
    out.map((l) => ({ key: l.key, content: l.text })),
    taskKeys,
  );
  return {
    lines: out,
    ...comments,
    note:
      "Saved. The previous text (and where its comments were) is kept under Versions and can be restored." +
      (comments.commentsOnRemovedLines ? " Some comments were on lines you removed; they now show on the whole project. Use move_comment to put them on the right line." : ""),
  };
}

async function currentLines(ctx: QueryCtx, p: Doc<"projects">): Promise<NewLine[]> {
  return (await linesOf(ctx, (await docOf(ctx, p._id, "main"))?._id)).map((l) => ({ key: l.key, type: l.type, text: l.text, ...(l.indent ? { indent: l.indent } : {}) }));
}

/** Replace the whole project document (keep keys for lines you keep). Previous version is saved. */
export const replaceDocument = internalMutation({
  args: { project: v.string(), agentName: v.optional(v.string()), lines: v.array(line) },
  handler: async (ctx, { project: ref, agentName, lines }) => replaceMain(ctx, await resolveProject(ctx, ref), lines, agentName),
});

const lineOp = v.union(
  v.object({
    op: v.literal("replace"),
    key: v.string(),
    text: v.optional(v.string()),
    type: v.optional(blockType),
    checked: v.optional(v.boolean()),
    color: v.optional(blockColor),
    textColor: v.optional(textColor),
    indent: v.optional(v.number()),
  }),
  v.object({ op: v.literal("insert"), afterKey: v.optional(v.union(v.string(), v.null())), lines: v.array(line) }),
  v.object({ op: v.literal("delete"), key: v.string() }),
  v.object({ op: v.literal("move"), key: v.string(), afterKey: v.optional(v.union(v.string(), v.null())) }),
);

/**
 * Small edits by line key: replace a line's text/type, insert lines after a line (afterKey null or missing =
 * at the top), delete a line, move a line. All ops apply in order as one change; the previous version is saved.
 */
export const editLines = internalMutation({
  args: { project: v.string(), agentName: v.optional(v.string()), ops: v.array(lineOp) },
  handler: async (ctx, { project: ref, agentName, ops }) => {
    if (ops.length > 500) throw new ConvexError("At most 500 operations at once");
    const p = await resolveProject(ctx, ref);
    const list = await currentLines(ctx, p);
    const indexOf = (key: string) => {
      const i = list.findIndex((l) => l.key === key);
      if (i < 0) throw new ConvexError(`No line with key ${key}. Read the project again for current keys.`);
      return i;
    };
    const after = (key: string | null | undefined) => (key ? indexOf(key) + 1 : 0);
    for (const o of ops) {
      if (o.op === "replace") {
        const i = indexOf(o.key);
        list[i] = {
          ...list[i],
          ...(o.text !== undefined ? { text: o.text } : {}),
          ...(o.type ? { type: o.type } : {}),
          ...(o.checked !== undefined ? { checked: o.checked } : {}),
          ...(o.color !== undefined ? { color: o.color } : {}),
          ...(o.textColor !== undefined ? { textColor: o.textColor } : {}),
          ...(o.indent !== undefined ? { indent: o.indent } : {}),
        };
      } else if (o.op === "insert") {
        list.splice(after(o.afterKey), 0, ...o.lines.map((l) => ({ type: l.type, text: l.text, checked: l.checked, color: l.color, textColor: l.textColor, indent: l.indent })));
      } else if (o.op === "delete") {
        list.splice(indexOf(o.key), 1);
      } else {
        const [moved] = list.splice(indexOf(o.key), 1);
        list.splice(after(o.afterKey), 0, moved);
      }
    }
    return replaceMain(ctx, p, list, agentName);
  },
});

/** Earlier versions of the project document, newest first, to restore one. */
export const listVersions = internalQuery({
  args: { project: v.string() },
  handler: async (ctx, { project: ref }) => {
    const p = await resolveProject(ctx, ref);
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", p._id).eq("kind", "archived"))
      .collect();
    return docs
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((d) => ({ versionId: d._id, replacedAt: new Date(d.updatedAt).toISOString(), replacedBy: d.editorName }));
  },
});

/** Bring back an earlier version's text (the current text is saved as a version first). */
export const restoreVersion = internalMutation({
  args: { project: v.string(), versionId: v.string(), agentName: v.optional(v.string()) },
  handler: async (ctx, { project: ref, versionId, agentName }) => {
    const p = await resolveProject(ctx, ref);
    const id = ctx.db.normalizeId("documents", versionId);
    const doc = id ? await ctx.db.get(id) : null;
    if (!doc || doc.projectId !== p._id || doc.kind !== "archived") throw new ConvexError("Version not found. Use list_versions.");
    // Exactly as it was, colors and images included
    const blocks = await ctx.db
      .query("blocks")
      .withIndex("by_document", (q) => q.eq("documentId", doc._id))
      .collect();
    const lines = blocks.map((b) => ({
      key: b.key,
      type: b.type,
      text: b.content,
      checked: b.checked,
      color: b.color ?? null,
      textColor: b.textColor ?? null,
      ...(b.images ? { images: b.images } : {}),
    }));
    return replaceMain(ctx, p, lines, agentName);
  },
});

/** Remove a task from the project's punch list. */
export const deleteTask = internalMutation({
  args: { project: v.string(), key: v.string() },
  handler: async (ctx, { project: ref, key }) => {
    const p = await resolveProject(ctx, ref);
    const tasks = await docOf(ctx, p._id, "tasks");
    const block = tasks
      ? await ctx.db
          .query("blocks")
          .withIndex("by_document_key", (q) => q.eq("documentId", tasks._id).eq("key", key))
          .unique()
      : null;
    if (!block) throw new ConvexError("Task not found. Use a key from the project's tasks (get_project).");
    await ctx.db.delete(block._id);
    await ctx.db.patch(p._id, { updatedAt: Date.now() });
    return { deleted: key };
  },
});

export const removeBriefLinks = internalMutation({
  args: { project: v.string(), urls: v.array(v.string()) },
  handler: async (ctx, { project: ref, urls }) => {
    const p = await resolveProject(ctx, ref);
    const drop = new Set(urls.map((u) => u.trim()));
    const list = (p.briefLinks ?? []).filter((l) => !drop.has(l.url));
    await ctx.db.patch(p._id, { briefLinks: list, updatedAt: Date.now() });
    return { removed: (p.briefLinks ?? []).length - list.length };
  },
});

// ---------- Review marks ----------

/**
 * Tick a mark off, or re-open it. convex/reviews.ts owns every other agent-facing review operation;
 * its `updateMark` needs a signed-in person, so resolving one by hand lives here.
 * `resolvedByRound` is cleared because only a new round can claim to have answered a mark.
 */
export const resolveMark = internalMutation({
  args: { mark: v.string(), resolved: v.optional(v.boolean()) },
  handler: async (ctx, { mark, resolved = true }) => {
    const id = ctx.db.normalizeId("reviewMarks", mark);
    const m = id ? await ctx.db.get(id) : null;
    if (!m) throw new ConvexError("Mark not found. Use a mark id from get_review.");
    await ctx.db.patch(m._id, { resolved, resolvedByRound: null });
    await ctx.db.patch(m.reviewId, { updatedAt: Date.now() });
    return { id: m._id, resolved };
  },
});

// ---------- Comments ----------

async function commentOf(ctx: QueryCtx, p: Doc<"projects">, commentId: string) {
  const id = ctx.db.normalizeId("comments", commentId);
  const c = id ? await ctx.db.get(id) : null;
  if (!c || c.projectId !== p._id) throw new ConvexError("Comment not found on this project. Use the id from get_project.");
  return c;
}

/** Put a comment on another line (by key or by part of its text), or on the whole project (neither given). */
export const moveComment = internalMutation({
  args: { project: v.string(), commentId: v.string(), toKey: v.optional(v.string()), lineContains: v.optional(v.string()) },
  handler: async (ctx, { project: ref, commentId, toKey, lineContains }) => {
    const p = await resolveProject(ctx, ref);
    const c = await commentOf(ctx, p, commentId);
    const lines = [
      ...(await linesOf(ctx, (await docOf(ctx, p._id, "main"))?._id)),
      ...(await linesOf(ctx, (await docOf(ctx, p._id, "tasks"))?._id)),
    ];
    let key: string | null = null;
    if (toKey) {
      if (!lines.some((l) => l.key === toKey)) throw new ConvexError(`No line with key ${toKey}`);
      key = toKey;
    } else if (lineContains) {
      const hit = lines.find((l) => l.text.toLowerCase().includes(lineContains.toLowerCase()));
      if (!hit) throw new ConvexError(`No line contains "${lineContains}"`);
      key = hit.key;
    }
    const history = c.keyHistory ?? [];
    await ctx.db.patch(c._id, {
      blockKey: key,
      quote: key ? (lines.find((l) => l.key === key)?.text ?? c.quote) : c.quote,
      keyHistory: c.blockKey && c.blockKey !== key ? [...history.filter((k) => k !== c.blockKey), c.blockKey].slice(-20) : history,
      updatedAt: Date.now(),
    });
    await queueAssetSync(ctx, p._id);
    return { id: c._id, lineKey: key };
  },
});

/** Change the text of a comment an agent wrote. People's comments can be moved but not rewritten. */
export const updateComment = internalMutation({
  args: { project: v.string(), commentId: v.string(), text: v.string() },
  handler: async (ctx, { project: ref, commentId, text }) => {
    const c = await commentOf(ctx, await resolveProject(ctx, ref), commentId);
    if (!c.agent) throw new ConvexError("That comment was written by a person. Leave a new comment (or move theirs) instead of rewriting it.");
    await ctx.db.patch(c._id, { text: text.slice(0, 10000), updatedAt: Date.now() });
    return { id: c._id };
  },
});

/** Delete a comment an agent wrote. */
export const deleteComment = internalMutation({
  args: { project: v.string(), commentId: v.string() },
  handler: async (ctx, { project: ref, commentId }) => {
    const c = await commentOf(ctx, await resolveProject(ctx, ref), commentId);
    if (!c.agent) throw new ConvexError("That comment was written by a person; only its author can delete it.");
    await ctx.db.delete(c._id);
    await queueAssetSync(ctx, c.projectId);
    return { deleted: c._id };
  },
});

// ---------- References (Mymind) ----------

/** Save references: one or many (e.g. an import of bookmarks). Links already saved aren't duplicated. */
export const addReferences = internalMutation({
  args: {
    references: v.array(v.object({ url: v.optional(v.string()), note: v.optional(v.string()), date: v.optional(v.string()) })),
    agentName: v.optional(v.string()),
  },
  handler: async (ctx, { references, agentName }) => {
    if (references.length > 200) throw new ConvexError("At most 200 references per call; send the rest in another call");
    const name = (agentName?.trim() || "Claude").slice(0, 60);
    let added = 0;
    let duplicates = 0;
    for (const i of references) {
      const r = await insertIdea(ctx, { url: i.url, note: i.note }, { name, agent: true }, parseDate(i.date));
      if (r.duplicate) duplicates++;
      else added++;
    }
    return { added, alreadySaved: duplicates };
  },
});

export const listReferences = internalQuery({
  args: { query: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { query, limit }) => {
    const n = Math.min(Math.max(limit ?? 50, 1), 500);
    const q = query?.trim().toLowerCase();
    const rows = q
      ? await ctx.db
          .query("ideas")
          .withSearchIndex("search", (s) => s.search("searchText", q))
          .take(n)
      : await ctx.db.query("ideas").withIndex("by_created").order("desc").take(n);
    return rows.map((i) => ({ kind: i.kind, url: i.url ?? i.fileUrl, note: i.note, added: new Date(i.createdAt).toISOString(), by: i.authorName }));
  },
});

// ---------- HTTP ----------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });

const errorOf = (e: unknown) => (e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.message : "Failed");

const UNAUTHORIZED = "Unauthorized. Send Authorization: Bearer <AGENT_API_KEY>.";

/** Wraps a handler with the API key check, JSON parsing and friendly errors. */
function route(handler: (ctx: Parameters<Parameters<typeof httpAction>[0]>[0], body: Record<string, unknown>, url: URL) => Promise<unknown>) {
  return httpAction(async (ctx, req) => {
    if (!authorized(req)) return json({ error: UNAUTHORIZED }, 401);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      const parsed = await req.json().catch(() => null);
      if (!parsed || typeof parsed !== "object") return json({ error: "Send a JSON body" }, 400);
      body = parsed as Record<string, unknown>;
    }
    try {
      return json(await handler(ctx, body, new URL(req.url)));
    } catch (e) {
      return json({ error: errorOf(e) }, 400);
    }
  });
}

// Body values arrive as unknown JSON; Convex validators check them again inside each function.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const httpListProjects = route((ctx, _b, url) =>
  ctx.runQuery(internal.agent.listProjects, {
    query: url.searchParams.get("q") ?? undefined,
    club: url.searchParams.get("club") ?? undefined,
    type: (url.searchParams.get("type") as "physical" | "digital" | null) ?? undefined,
  }),
);
export const httpGetProject = route((ctx, _b, url) => {
  const project = url.searchParams.get("project");
  if (!project) throw new ConvexError("Pass ?project=<id or share link>");
  return ctx.runQuery(internal.agent.project, { project });
});
export const httpCreateProject = route((ctx, b) => ctx.runMutation(internal.agent.createProject, b as any));
export const httpUpdateProject = route((ctx, b) => ctx.runMutation(internal.agent.updateProject, b as any));
export const httpSuggestEdit = route((ctx, b) => ctx.runMutation(internal.agent.suggestEdit, b as any));
export const httpAddTasks = route((ctx, b) => ctx.runMutation(internal.agent.addTasks, b as any));
export const httpUpdateTask = route((ctx, b) => ctx.runMutation(internal.agent.updateTask, b as any));
export const httpDeleteTask = route((ctx, b) => ctx.runMutation(internal.agent.deleteTask, b as any));
export const httpAddBriefLinks = route((ctx, b) => ctx.runMutation(internal.agent.addBriefLinks, b as any));
export const httpSetBrief = route((ctx, b) => ctx.runMutation(internal.agent.setBrief, b as any));
export const httpAddUpdate = route((ctx, b) => ctx.runMutation(internal.agent.addUpdate, b as any));
export const httpAddReferences = route((ctx, b) => ctx.runMutation(internal.agent.addReferences, b as any));
export const httpListReferences = route((ctx, _b, url) =>
  ctx.runQuery(internal.agent.listReferences, { query: url.searchParams.get("q") ?? undefined, limit: Number(url.searchParams.get("limit")) || undefined }),
);
export const httpListClubs = route((ctx) => ctx.runQuery(internal.clubs.listForAgent, {}));
export const httpGetClub = route((ctx, _b, url) => {
  const club = url.searchParams.get("club");
  if (!club) throw new ConvexError("Pass ?club=<id or name>");
  return ctx.runQuery(internal.clubs.getForAgent, { club });
});
export const httpCreateClub = route((ctx, b) => ctx.runMutation(internal.clubs.createForAgent, b as any));
export const httpUpdateClub = route((ctx, b) => ctx.runMutation(internal.clubs.updateForAgent, b as any));
export const httpListBoards = route((ctx, _b, url) => ctx.runQuery(internal.boards.listForAgent, { query: url.searchParams.get("q") ?? undefined }));
export const httpGetBoard = route((ctx, _b, url) => {
  const board = url.searchParams.get("board");
  if (!board) throw new ConvexError("Add ?board=<id>");
  return ctx.runQuery(internal.boards.getForAgent, { board, includeElements: url.searchParams.get("elements") === "1" });
});
export const httpCreateBoard = route((ctx, b) => ctx.runMutation(internal.boards.createForAgent, b as any));
export const httpAddToBoard = route((ctx, b) => ctx.runMutation(internal.boards.addForAgent, b as any));
export const httpEditBoard = route((ctx, b) => ctx.runMutation(internal.boards.editForAgent, b as any));
export const httpListReviews = route((ctx, _b, url) =>
  ctx.runQuery(internal.reviews.listForAgent, {
    status: (url.searchParams.get("status") as "inReview" | "changesRequested" | "approved" | "archived" | null) ?? undefined,
    changesRequested: url.searchParams.has("requested") ? url.searchParams.get("requested") !== "0" : undefined,
    project: url.searchParams.get("project") ?? undefined,
    club: url.searchParams.get("club") ?? undefined,
  }),
);
export const httpGetReview = route((ctx, _b, url) => ctx.runQuery(internal.reviews.getForAgent, { review: url.searchParams.get("review") ?? "" }));
export const httpStartReview = route((ctx, b) => ctx.runAction(internal.reviews.createForAgent, b as any));
export const httpAddReviewRound = route((ctx, b) => ctx.runAction(internal.reviews.addRoundForAgent, b as any));
export const httpMarkReview = route((ctx, b) => ctx.runAction(internal.reviews.markForAgent, b as any));
export const httpResolveMark = route((ctx, b) => ctx.runMutation(internal.agent.resolveMark, b as any));
export const httpReviewStatus = route((ctx, b) => ctx.runMutation(internal.reviews.setStatusForAgent, b as any));
export const httpApproveReview = route((ctx, b) =>
  ctx.runMutation(internal.reviews.setStatusForAgent, { ...(b as any), status: "approved" as const }),
);
export const httpPinBoard = route((ctx, b) => ctx.runMutation(internal.boards.setPinnedForAgent, b as any));
export const httpPinProject = route((ctx, b) => ctx.runMutation(internal.agent.setProjectPinned, b as any));
export const httpReplaceDocument = route((ctx, b) => ctx.runMutation(internal.agent.replaceDocument, b as any));
export const httpEditLines = route((ctx, b) => ctx.runMutation(internal.agent.editLines, b as any));
export const httpListVersions = route((ctx, _b, url) => {
  const project = url.searchParams.get("project");
  if (!project) throw new ConvexError("Pass ?project=<id or share link>");
  return ctx.runQuery(internal.agent.listVersions, { project });
});
export const httpRestoreVersion = route((ctx, b) => ctx.runMutation(internal.agent.restoreVersion, b as any));
export const httpRemoveBriefLinks = route((ctx, b) => ctx.runMutation(internal.agent.removeBriefLinks, b as any));
export const httpMoveComment = route((ctx, b) => ctx.runMutation(internal.agent.moveComment, b as any));
export const httpUpdateComment = route((ctx, b) => ctx.runMutation(internal.agent.updateComment, b as any));
export const httpDeleteComment = route((ctx, b) => ctx.runMutation(internal.agent.deleteComment, b as any));
export const httpComment = route(async (ctx, b) => ({
  id: await ctx.runMutation(internal.comments.addAgent, { ...(b as any), attachments: await resolveAttachments(ctx, b.attachments as any) }),
}));
export const httpAttach = route((ctx, b) => {
  if (typeof b.comment !== "string" || !Array.isArray(b.attachments)) throw new ConvexError("Send {comment, attachments: [...]}");
  return attachFiles(ctx, b.comment, b.attachments as any);
});
export const httpUploadUrl = route(async (ctx) => ({ uploadUrl: await ctx.runMutation(internal.agentFiles.uploadUrl, {}) }));
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * One-step upload: POST the raw file as the body (Content-Type = its type), up to 20 MB.
 * ?comment=<id> adds it to that comment; or ?project=<id or share link> (plus optional text, lineContains,
 * blockKey, agentName) posts a new comment with it. ?name= sets the file name.
 */
export const httpFile = httpAction(async (ctx, req) => {
  if (!authorized(req)) return json({ error: UNAUTHORIZED }, 401);
  const q = new URL(req.url).searchParams;
  try {
    const storageId = await storeBlob(ctx, await req.blob());
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
    const file = { storageId, name: q.get("name") ?? undefined, mime: type && type !== "application/octet-stream" ? type : undefined };
    const comment = q.get("comment");
    if (comment) return json(await attachFiles(ctx, comment, [file]));
    const project = q.get("project");
    if (!project) throw new ConvexError("Pass ?comment=<id> or ?project=<id or share link>");
    const id = await ctx.runMutation(internal.comments.addAgent, {
      project,
      text: q.get("text") ?? "",
      agentName: q.get("agentName") ?? undefined,
      blockKey: q.get("blockKey") ?? undefined,
      lineContains: q.get("lineContains") ?? undefined,
      attachments: await resolveAttachments(ctx, [file]),
    });
    return json({ id });
  } catch (e) {
    return json({ error: errorOf(e) }, 400);
  }
});

// ---------- The team's Todo list ----------

/** The Todo list's id, made if there isn't one yet */
export const todoId = internalMutation({
  args: {},
  handler: async (ctx) => ensureTodo(ctx, null),
});

/**
 * Adds items to the Todo list: at the end, or as sub-bullets under a line (under = its key). Each item can
 * carry its own sub-items (indent 1, 2… relative to where it's added). Comments on other lines stay put.
 */
export const addTodoItems = internalMutation({
  args: {
    items: v.array(v.object({ text: v.string(), indent: v.optional(v.number()), assignee: v.optional(v.string()), checked: v.optional(v.boolean()) })),
    under: v.optional(v.string()),
    agentName: v.optional(v.string()),
  },
  handler: async (ctx, { items, under, agentName }) => {
    const people = await teamOf(ctx);
    if (!items.length) throw new ConvexError("Give at least one item");
    if (items.length > 200) throw new ConvexError("At most 200 items at once");
    const todo = (await ctx.db.get(await ensureTodo(ctx, null)))!;
    let list = await currentLines(ctx, todo);
    // A fresh list is one empty bullet: replace it rather than adding below it
    if (list.length === 1 && !list[0].text.trim()) list = [];
    let at = list.length;
    let base = 0;
    if (under) {
      const i = list.findIndex((l) => l.key === under);
      if (i < 0) throw new ConvexError(`No line with key ${under}. get_todo lists the keys.`);
      base = (list[i].indent ?? 0) + 1;
      // After the line's own sub-items
      at = i + 1;
      while (at < list.length && (list[at].indent ?? 0) >= base) at++;
    }
    const added = items.map((it) => ({
      type: "todo" as const,
      text: it.text,
      checked: !!it.checked,
      indent: Math.min(4, base + Math.max(0, Math.round(it.indent ?? 0))),
      ...(it.assignee ? { assignee: personOf(people, it.assignee) } : {}),
    }));
    list.splice(at, 0, ...added);
    const res = await replaceMain(ctx, todo, list, agentName);
    return { todo: todo._id, url: projectUrl(todo._id), added: items.length, lines: res };
  },
});

/** Everyone who has signed up (the team), for assigning to-dos */
async function teamOf(ctx: QueryCtx) {
  return (await ctx.db.query("users").collect()).map((u) => ({ id: u._id, name: u.name?.trim() || u.email?.split("@")[0] || "", email: (u.email ?? "").toLowerCase() }));
}
/** A teammate by name, first name, email or id */
function personOf(people: Awaited<ReturnType<typeof teamOf>>, who: string) {
  const w = who.trim().toLowerCase();
  const hit =
    people.find((p) => p.id === who || p.email === w || p.name.toLowerCase() === w) ??
    people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === w.split(/\s+/)[0]).at(0);
  if (!hit) throw new ConvexError(`No one called "${who}" has joined Switchyards Studio. get_todo lists the team.`);
  return hit.id;
}

/** The team, for agents assigning to-dos */
export const team = internalQuery({
  args: {},
  handler: async (ctx) => (await teamOf(ctx)).map((p) => ({ id: p.id, name: p.name, email: p.email })),
});

/** Tick, untick, assign or reword one Todo item by its key (no new version; comments stay) */
export const updateTodoItem = internalMutation({
  args: { key: v.string(), checked: v.optional(v.boolean()), assignee: v.optional(v.union(v.string(), v.null())), text: v.optional(v.string()) },
  handler: async (ctx, { key, checked, assignee, text }) => {
    const todo = (await ctx.db.get(await ensureTodo(ctx, null)))!;
    const main = await docOf(ctx, todo._id, "main");
    const block = main
      ? await ctx.db
          .query("blocks")
          .withIndex("by_document_key", (q) => q.eq("documentId", main._id).eq("key", key))
          .unique()
      : null;
    if (!block) throw new ConvexError(`No Todo item with key ${key}. get_todo lists the keys.`);
    const patch: Partial<Doc<"blocks">> = {};
    if (checked !== undefined) Object.assign(patch, { checked, type: "todo" as const });
    if (text !== undefined) {
      if (text.length > MAX_TEXT) throw new ConvexError(`Items can be at most ${MAX_TEXT} characters`);
      patch.content = text;
    }
    if (assignee !== undefined) patch.assignee = assignee ? personOf(await teamOf(ctx), assignee) : undefined;
    // Bump the rev so an open editor sees this as someone else's change rather than writing over it
    patch.rev = (block.rev ?? 0) + 1;
    await ctx.db.patch(block._id, patch);
    const now = Date.now();
    await ctx.db.patch(main!._id, { updatedAt: now });
    await ctx.db.patch(todo._id, { updatedAt: now });
    return { key, checked: patch.checked ?? block.checked, assignee: (assignee !== undefined ? patch.assignee : block.assignee) ?? null, text: patch.content ?? block.content };
  },
});
