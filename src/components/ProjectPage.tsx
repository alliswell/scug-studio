"use client";

import { useMutation, useQuery } from "convex/react";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  groupComments,
  snippet,
  snapToLine,
  type CommentActions,
} from "@/lib/comments";
import { readText, setCaret } from "@/lib/caret";
import { fromServer, useDocSync, useLoadBlocks, type Clash, type SaveState, type ServerBlock } from "@/lib/sync";
import {
  reviewStatusOf,
  stageOf,
  typeLabel,
  type Attachment,
  type Block,
  type Comment,
  type ProjectType,
} from "@/lib/types";
import {
  emptyBlock,
  kindForFile,
  docToText,
  timeAgo,
  uid,
} from "@/lib/util";
import { uploadToUrl } from "@/lib/upload";
import { Lightbox } from "./Attachments";
import { CommentsPanel } from "./CommentsPanel";
import { DocEditor } from "./DocEditor";
import { DiffBlocks, computeDiff } from "./DiffView";
import { Brief } from "./Brief";
import { TaskList, taskProgress } from "./Instructions";
import { Updates } from "./Updates";
import { PageLayout, primaryButton } from "./PageLayout";
import { SharePopover } from "./SharePopover";
import { Tabs, type Tab } from "./Tabs";
import { ProjectDetails, ProjectTitle, type Meta } from "./ProjectMeta";
import {
  IconArrowLeft,
  IconCheck,
  IconCopy,
  IconHistory,
  IconPin,
  IconPlus,
} from "./icons";
import {
  ShowSidebarButton,
  useAppSidebar,
  useGoBack,
} from "./HomeSidebar";
import { useIsMobile } from "@/lib/useIsMobile";
import { Presentation } from "./Presentation";

type SetList = (fn: (prev: Block[]) => Block[]) => void;
type DocInfo = {
  _id: string;
  kind: string;
  editorName: string | null;
  updatedAt: number;
};

const PROJECT = "__project__";
/** For event handlers (the lint rule can't tell them from render code) */
const clockNow = () => Date.now();

/**
 * The two pipelines call the same two tabs by different names: a build-out has a plan and a punch
 * list, digital work has a design and a checklist. Nothing else about them differs.
 */
const TAB_WORDS: Record<ProjectType, { doc: string; tasks: string; addTask: string }> = {
  physical: { doc: "Plan", tasks: "Punch", addTask: "Add a punch item" },
  digital: { doc: "Design", tasks: "Checklist", addTask: "Add a checklist item" },
};

// A few uploads at once; the rest wait their turn.
const queue: (() => Promise<void>)[] = [];
let active = 0;
function enqueue(job: () => Promise<void>) {
  queue.push(job);
  const pump = () => {
    while (active < 3 && queue.length) {
      const next = queue.shift()!;
      active++;
      void next().finally(() => {
        active--;
        pump();
      });
    }
  };
  pump();
}

export function ProjectPage({ id }: { id: string }) {
  const data = useQuery(api.projects.get, { id });
  /** A Journal entry: the same editor, without the project parts */
  const journal = data?.project.kind === "journal";
  /** The team's Todo list: one bulleted list, nothing else */
  const todo = data?.project.kind === "todo";
  const todoRef = useRef(false);
  useEffect(() => {
    todoRef.current = todo;
  }, [todo]);
  const team = useQuery(api.users.list, todo ? {} : "skip");
  const projects = useQuery(api.projects.list, todo ? {} : "skip");
  const comments = useQuery(
    api.comments.list,
    data?.project ? { projectId: data.project._id } : "skip",
  );
  /** The comment being added shows straight away, before the server has saved it */
  const pendingKey = useRef<string | null>(null);
  const pendingAt = useRef(0);
  const addCommentM = useMutation(api.comments.add).withOptimisticUpdate((store, args) => {
    const list = store.getQuery(api.comments.list, { projectId: args.projectId });
    if (!list || !pendingKey.current) return;
    store.setQuery(api.comments.list, { projectId: args.projectId }, [
      ...list,
      { id: pendingKey.current as Id<"comments">, blockKey: args.blockKey, keyHistory: [], quote: null, text: "", authorName: null, agent: false, mine: true, attachments: [], createdAt: pendingAt.current },
    ]);
  });
  /** Saved comment id → the key it had while it was being added */
  const aliases = useRef(new Map<string, string>());
  const updateCommentM = useMutation(api.comments.update);
  const removeCommentM = useMutation(api.comments.remove);
  const moveCommentM = useMutation(api.comments.moveToLine);
  /** A comment being put onto a line: the next line clicked gets it */
  const [placing, setPlacing] = useState<string | null>(null);
  const attachM = useMutation(api.comments.attach);
  const detachM = useMutation(api.comments.detach);
  const loadBlocks = useLoadBlocks();
  const updateProject = useMutation(api.projects.update);
  const generateUploadUrl = useMutation(api.docs.generateUploadUrl);
  const fileUrl = useMutation(api.docs.fileUrl);
  const promote = useMutation(api.docs.promote);
  const removeDoc = useMutation(api.docs.remove);

  const [meta, setMeta] = useState<Meta | null>(null);
  useDocumentTitle(meta ? meta.title || "Untitled project" : null);
  const [mainId, setMainId] = useState<string | null>(null);
  const [tasksId, setTasksId] = useState<string | null>(null);
  const [mainBlocks, setMainBlocks] = useState<Block[] | null>(null);
  const [taskBlocks, setTaskBlocks] = useState<Block[] | null>(null);
  const [version, setVersion] = useState<{
    doc: DocInfo;
    blocks: Block[];
  } | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // Presentation mode lives in the address (?present), so it stays on through reloads and when you come back to the tab
  const [presenting, setPresentingState] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("present"))
      setPresentingState(true);
  }, []);
  const setPresenting = (on: boolean) => {
    setPresentingState(on);
    const params = new URLSearchParams(window.location.search);
    if (on) params.set("present", "1");
    else params.delete("present");
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
  };

  const setPinnedM = useMutation(api.projects.setPinned);
  const backTo = journal ? "/?view=journal" : todo ? "/?view=home" : "/";
  const goBack = useGoBack(backTo);
  const mobile = useIsMobile();
  const side = useAppSidebar();
  const clubOptions = useQuery(api.clubs.list, journal || todo ? "skip" : {})?.map((c) => ({
    id: c._id as string,
    name: c.name,
    status: c.status as string,
  }));
  /** Comments open in the side panel: a line's key, PROJECT for the whole project, or none */
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusComment, setFocusComment] = useState<string | null>(null);
  const [uploading, setUploading] = useState<Record<string, Attachment[]>>({});
  const createdHere = useRef(new Set<string>());
  const [lightbox, setLightbox] = useState<string | null>(null);
  const mainSync = useDocSync(mainId, mainBlocks);
  const tasksSync = useDocSync(tasksId, taskBlocks);
  const metaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMeta = useRef<Partial<Meta>>({});
  const [metaState, setMetaState] = useState<SaveState>("idle");

  const setMain: SetList = useCallback(
    (fn) => setMainBlocks((p) => (p ? fn(p) : p)),
    [],
  );
  const setTasks: SetList = useCallback(
    (fn) => setTaskBlocks((p) => (p ? fn(p) : p)),
    [],
  );

  const docs = (data?.documents ?? []) as DocInfo[];
  const serverMain = docs.find((d) => d.kind === "main")?._id ?? null;
  const serverTasks = docs.find((d) => d.kind === "tasks")?._id ?? null;

  useEffect(() => {
    if (data?.project && !meta)
      setMeta({
        title: data.project.title,
        targetDate: data.project.targetDate,
        type: data.project.type,
        stage: data.project.stage,
        clubId: data.project.clubId ?? null,
        brief: data.project.brief,
        briefLinks: data.project.briefLinks,
      });
  }, [data?.project, meta]);

  // The document is read live, not once. The first read seeds the editor; every read after it is
  // merged in, so a teammate's lines turn up while you are working instead of only on reload.
  const mainRows = useQuery(api.docs.blocks, serverMain ? { documentId: serverMain as Id<"documents"> } : "skip") as ServerBlock[] | undefined;
  const taskRows = useQuery(api.docs.blocks, serverTasks ? { documentId: serverTasks as Id<"documents"> } : "skip") as ServerBlock[] | undefined;

  useEffect(() => {
    if (!serverMain || !mainRows) return;
    if (serverMain !== mainId) {
      mainSync.seed(serverMain, mainRows.map(fromServer), new Map(mainRows.map((r) => [r.id, r.rev])));
      // The Todo list is all checkboxes (lines written as bullets or text become to-dos; this saves)
      const list = mainRows.length ? mainRows.map(fromServer) : [emptyBlock()];
      setMainBlocks(todoRef.current ? list.map((x) => (x.type === "bullet" || x.type === "number" || x.type === "p" ? { ...x, type: "todo" as const } : x)) : list);
      setMainId(serverMain);
      setVersion(null);
      setOpenId(null);
      return;
    }
    const merged = mainSync.mergeServer(mainRows);
    if (merged) setMainBlocks(merged.length ? merged : [emptyBlock()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverMain, mainRows, mainId]);

  useEffect(() => {
    if (!serverTasks || !taskRows) return;
    if (serverTasks !== tasksId) {
      tasksSync.seed(serverTasks, taskRows.map(fromServer), new Map(taskRows.map((r) => [r.id, r.rev])));
      setTaskBlocks(taskRows.length ? taskRows.map(fromServer) : [{ ...emptyBlock(), type: "todo" }]);
      setTasksId(serverTasks);
      return;
    }
    const merged = tasksSync.mergeServer(taskRows);
    if (merged) setTaskBlocks(merged.length ? merged : [{ ...emptyBlock(), type: "todo" }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverTasks, taskRows, tasksId]);

  useEffect(() => {
    const busy = Object.values(uploading).some((list) =>
      list.some((a) => !a.error),
    );
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const changeMeta = (patch: Partial<Meta>) => {
    setMeta((m) => (m ? { ...m, ...patch } : m));
    pendingMeta.current = { ...pendingMeta.current, ...patch };
    if (metaTimer.current) clearTimeout(metaTimer.current);
    metaTimer.current = setTimeout(async () => {
      const p = pendingMeta.current;
      pendingMeta.current = {};
      setMetaState("saving");
      try {
        await updateProject({
          id: id as Id<"projects">,
          ...p,
          clubId: p.clubId as Id<"clubs"> | null | undefined,
        });
        setMetaState("saved");
      } catch {
        setMetaState("error");
      }
    }, 500);
  };

  const patchUpload = (
    commentId: string,
    attId: string,
    patch: Partial<Attachment> | null,
  ) =>
    setUploading((u) => {
      const list = (u[commentId] ?? [])
        .map((a) => (a.id === attId ? (patch ? { ...a, ...patch } : null) : a))
        .filter((a): a is Attachment => !!a);
      const next = { ...u, [commentId]: list };
      if (!list.length) delete next[commentId];
      return next;
    });

  const actions: CommentActions = {
    add: async (blockKey) => {
      // Show and focus the box right away; it keeps its key once the server has it
      const temp = `pending-${uid()}`;
      pendingKey.current = temp;
      pendingAt.current = clockNow();
      setFocusComment(temp);
      const cid = await addCommentM({
        projectId: id as Id<"projects">,
        blockKey,
        text: "",
      });
      pendingKey.current = null;
      aliases.current.set(cid, temp);
      createdHere.current.add(cid);
      return cid;
    },
    update: (cid, text) =>
      void (cid.startsWith("pending-") || updateCommentM({ id: cid as Id<"comments">, text })),
    remove: (cid) => void (cid.startsWith("pending-") || removeCommentM({ id: cid as Id<"comments"> })),
    addLink: (cid, url) =>
      void attachM({
        id: cid as Id<"comments">,
        attachment: {
          id: uid(),
          kind: "link",
          url,
          storageId: null,
          name: null,
          mime: null,
          size: null,
        },
      }),
    removeAttachment: (cid, attId) => {
      if (uploading[cid]?.some((a) => a.id === attId))
        patchUpload(cid, attId, null);
      else void detachM({ id: cid as Id<"comments">, attachmentId: attId });
    },
    attach: (cid, attachment) =>
      void attachM({
        id: cid as Id<"comments">,
        attachment: {
          id: attachment.id,
          kind: attachment.kind,
          url: attachment.url,
          storageId: null,
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.size,
        },
      }),
    addFiles: (cid, files) => {
      for (const file of files) {
        const att: Attachment = {
          id: uid(),
          kind: kindForFile(file),
          url: null,
          storageId: null,
          name: file.name,
          mime: file.type || null,
          size: file.size,
          progress: 0,
        };
        setUploading((u) => ({ ...u, [cid]: [...(u[cid] ?? []), att] }));
        enqueue(async () => {
          let last = 0;
          try {
            const uploadUrl = await generateUploadUrl();
            const storageId = await uploadToUrl(uploadUrl, file, (f) => {
              if (f - last >= 0.01 || f === 1) {
                last = f;
                patchUpload(cid, att.id, { progress: f });
              }
            });
            const url = await fileUrl({
              storageId: storageId as Id<"_storage">,
            });
            await attachM({
              id: cid as Id<"comments">,
              attachment: {
                id: att.id,
                kind: att.kind,
                url,
                storageId: storageId as Id<"_storage">,
                name: att.name,
                mime: att.mime,
                size: att.size,
              },
            });
            patchUpload(cid, att.id, null);
          } catch (e) {
            patchUpload(cid, att.id, {
              error: e instanceof Error ? e.message : "Upload failed",
            });
          }
        });
      }
    },
  };

  /** Dropping files on a line starts a new comment there holding the files, ready for a note about them. */
  const dropFiles = async (blockKey: string, files: File[]) => {
    setOpenId(blockKey);
    snapToLine(blockKey);
    const cid = await actions.add(blockKey);
    actions.addFiles?.(cid, files);
  };

  // Comments you started but left empty get cleaned up after the panel closes
  const commentsRef = useRef<Comment[]>([]);
  commentsRef.current = (comments ?? []) as Comment[];
  const uploadingRef = useRef(uploading);
  uploadingRef.current = uploading;
  const openRef = useRef<string | null>(null);
  openRef.current = openId;
  // Only comments started before leaving that place, and never ones on the place that's open now
  // (otherwise a comment just started on the next line could vanish while you type)
  const sweepEmpty = () => {
    const candidates = new Set(createdHere.current);
    setTimeout(() => {
      for (const c of commentsRef.current) {
        if (
          !candidates.has(c.id) ||
          (c.blockKey ?? PROJECT) === openRef.current ||
          !createdHere.current.has(c.id) ||
          c.text.trim() ||
          c.attachments.length ||
          uploadingRef.current[c.id]
        )
          continue;
        createdHere.current.delete(c.id);
        void removeCommentM({ id: c.id as Id<"comments"> });
      }
    }, 1500);
  };

  const openComments = (key: string, opts?: { newComment?: boolean }) => {
    if (openId && openId !== key) sweepEmpty();
    setOpenId(key);
    setFocusComment(null);
    if (key !== PROJECT) snapToLine(key);
    if (opts?.newComment) void actions.add(key === PROJECT ? null : key);
  };

  const closeComments = () => {
    setOpenId(null);
    setFocusComment(null);
    sweepEmpty();
  };

  useEffect(() => {
    if (!placing) return;
    const pick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-placing-bar]")) return;
      const row = target.closest("[data-row-id]") as HTMLElement | null;
      e.preventDefault();
      e.stopPropagation();
      if (!row?.dataset.rowId) return;
      const key = row.dataset.rowId;
      const cid = placing;
      setPlacing(null);
      void (async () => {
        await Promise.all([mainSync.flush(), tasksSync.flush()]);
        await moveCommentM({ id: cid as Id<"comments">, blockKey: key });
        setOpenId(key);
        snapToLine(key);
      })();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPlacing(null);
    // Capture, so the click picks the line instead of starting to type in it
    window.addEventListener("mousedown", pick, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", pick, true);
      window.removeEventListener("keydown", esc);
    };
  }, [placing, mainSync, tasksSync, moveCommentM]);

  /** Puts the caret at the end of a line in the document or the task list */
  const focusLineEnd = (key: string) => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-row-id="${CSS.escape(key)}"] .editable`,
      );
      if (el) setCaret(el, readText(el).length);
    });
  };

  /** ⌘Enter from a comment: a new line under the commented one, as if Enter was pressed at its end */
  const continueBelow = (key: string) => {
    const add = (list: Block[]) => {
      const i = list.findIndex((b) => b.id === key);
      if (i < 0) return null;
      const cur = list[i];
      const listy =
        cur.type === "bullet" || cur.type === "number" || cur.type === "todo";
      const nb: Block = {
        id: uid(),
        type: listy ? cur.type : "p",
        content: "",
        color: cur.color ?? null,
      } as Block;
      return {
        next: [...list.slice(0, i + 1), nb, ...list.slice(i + 1)],
        id: nb.id,
      };
    };
    const inMain = mainBlocks?.some((b) => b.id === key);
    const target = inMain ? mainBlocks : taskBlocks;
    const res = target ? add(target) : null;
    if (!res) return;
    if (inMain) setMain(() => res.next);
    else setTasks(() => res.next);
    closeComments();
    // Wait for the new line to render, then type in it
    setTimeout(() => focusLineEnd(res.id), 30);
  };

  const openVersion = async (doc: DocInfo) => {
    setVersionsOpen(false);
    setOpenId(null);
    await mainSync.flush();
    const blocks = await loadBlocks(doc._id);
    setVersion({ doc, blocks });
    window.scrollTo({ top: 0 });
  };

  if (data === null)
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-[14px] text-(--c-t-737373)">
        This project doesn&apos;t exist anymore.
        <Link href="/" className="font-medium text-(--c-t-2358d8)">
          Back to projects
        </Link>
      </div>
    );
  if (!data || !meta || !mainBlocks || !taskBlocks)
    return <div className="min-h-screen bg-(--c-b-ffffff)" />;

  const words = TAB_WORDS[meta.type] ?? TAB_WORDS.physical;
  const edited = docs
    .filter((d) => d.kind === "edited")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const archived = docs
    .filter((d) => d.kind === "archived")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  // Lines this person and somebody else both changed. Ours stayed in the document and theirs was
  // refused by the server, so the words still exist on both sides and the choice is made here.
  const allClashes = [
    ...mainSync.clashes.map((c) => ({ c, where: "main" as const })),
    ...tasksSync.clashes.map((c) => ({ c, where: "tasks" as const })),
  ];
  const resolveClash = (key: string, where: "main" | "tasks", winner: "mine" | "theirs") => {
    const sync = where === "main" ? mainSync : tasksSync;
    const set = where === "main" ? setMainBlocks : setTaskBlocks;
    const theirs = sync.resolve(key, winner);
    if (winner !== "theirs") return;
    set((prev) => (!prev ? prev : theirs ? prev.map((b) => (b.id === key ? theirs : b)) : prev.filter((b) => b.id !== key)));
  };

  const states = [mainSync.state, tasksSync.state, metaState];
  const saveLabel = states.includes("error")
    ? "Offline, retrying…"
    : states.includes("saving")
      ? "Saving…"
      : "";

  // Comments live on lines by key; an edited version's lines point back to the originals
  const keyOf = (b: Block) => (version ? (b.source_block_id ?? b.id) : b.id);
  const allComments: Comment[] = ((comments ?? []) as Comment[]).map((c) => {
    const withKey = aliases.current.has(c.id) ? { ...c, clientKey: aliases.current.get(c.id) } : c.id.startsWith("pending-") ? { ...c, clientKey: c.id } : c;
    return uploading[c.id]
      ? { ...withKey, attachments: [...c.attachments, ...uploading[c.id]] }
      : withKey;
  });
  const { counts: countsByKey, project: projectComments } = groupComments(
    allComments,
    [...taskBlocks, ...mainBlocks],
  );
  // An earlier version shows each comment where it was then: its current line if that line is in the version,
  // otherwise the most recent line it used to be on
  const archivedKeys =
    version?.doc.kind === "archived"
      ? new Set(version.blocks.map((b) => b.id))
      : null;
  const placeOf = (c: Comment) => {
    if (!archivedKeys || !c.blockKey || archivedKeys.has(c.blockKey))
      return c.blockKey;
    return (
      [...(c.keyHistory ?? [])].reverse().find((k) => archivedKeys.has(k)) ??
      c.blockKey
    );
  };
  const archivedCounts: Record<string, number> = {};
  if (archivedKeys)
    for (const c of allComments) {
      const k = placeOf(c);
      if (k) archivedCounts[k] = (archivedCounts[k] ?? 0) + 1;
    }
  const countsFor = (blocks: Block[]) =>
    Object.fromEntries(
      blocks.map((b) => [
        b.id,
        (archivedKeys ? archivedCounts : countsByKey)[keyOf(b)] ?? 0,
      ]),
    );
  const shownBlocks = version ? version.blocks : [...taskBlocks, ...mainBlocks];
  const openBlock =
    openId && openId !== PROJECT
      ? shownBlocks.find((b) => b.id === openId)
      : undefined;
  const openKey = openBlock ? keyOf(openBlock) : null;

  // The side panel only shows while comments are open
  const panel =
    openId === PROJECT ? (
      <CommentsPanel
        key={PROJECT}
        blockKey={null}
        title="Comments on this project"
        comments={projectComments}
        onPlace={version ? undefined : (cid) => setPlacing(cid)}
        actions={actions}
        canWrite
        canDeleteOthers
        focusId={focusComment}
        onClose={closeComments}
        hideClose
        onOpenImage={setLightbox}
      />
    ) : openBlock && openKey ? (
      <CommentsPanel
        key={openKey}
        blockKey={openKey}
        title="Comments"
        quote={snippet(openBlock.content)}
        onNextLine={version ? undefined : () => continueBelow(openBlock.id)}
        onBackToLine={version ? undefined : () => focusLineEnd(openBlock.id)}
        comments={allComments.filter((c) => placeOf(c) === openKey)}
        actions={actions}
        canWrite
        canDeleteOthers
        focusId={focusComment}
        onClose={() => openComments(PROJECT)}
        onOpenImage={setLightbox}
      />
    ) : undefined;

  // The main document: the edited copy's diff while a version is open, otherwise the live editor
  const mainDoc: ReactNode = version ? (
    <div className="mt-2">
      {version.doc.kind === "edited" ? (
        <DiffBlocks
          original={mainBlocks}
          edited={version.blocks}
          activeId={openId}
          commentCounts={countsFor(version.blocks)}
          onOpenComments={(b) => openComments(b)}
        />
      ) : (
        <DocEditor
          blocks={version.blocks}
          setBlocks={() => {}}
          readOnly
          activeId={openId}
          commentCounts={countsFor(version.blocks)}
          onOpenComments={(b) => openComments(b)}
        />
      )}
    </div>
  ) : (
    <div data-doc className="mt-2">
      <DocEditor
        blocks={mainBlocks}
        setBlocks={setMain}
        docTitle={meta.title}
        canUpload
        canComment
        onFiles={(b, files) => void dropFiles(b, files)}
        activeId={openId}
        commentCounts={countsFor(mainBlocks)}
        onOpenComments={openComments}
        listOnly={todo}
        people={todo ? (team ?? []) : undefined}
        mentions={todo ? (projects ?? []).map((p) => ({ id: p._id, title: p.title, type: p.type })) : undefined}
        placeholder={todo ? "Add a to-do…" : undefined}
      />
    </div>
  );

  // The tabs are data: the same five every time, named for the pipeline the project is running.
  const tabs: Tab[] = [
    {
      id: "brief",
      label: "Brief",
      content: (
        <div className="flex flex-col gap-5 pt-1">
          <ProjectDetails
            meta={meta}
            onChange={changeMeta}
            readOnly={!!version}
            clubs={clubOptions}
            share={
              <SharePopover
                projectId={id}
                shareSlug={data.project.shareSlug}
                passcode={data.project.editPasscode}
                getText={() => docToText(meta.title, mainBlocks)}
              />
            }
          />
          <Brief
            value={meta.brief ?? ""}
            onChange={(brief) => changeMeta({ brief })}
            links={meta.briefLinks ?? []}
            onLinksChange={(briefLinks) => changeMeta({ briefLinks })}
            readOnly={!!version}
          />
        </div>
      ),
    },
    { id: "doc", label: words.doc, content: mainDoc },
    { id: "visuals", label: "Visuals", content: <ProjectReviews projectId={id} /> },
    {
      id: "tasks",
      label: words.tasks,
      badge: taskProgress(taskBlocks),
      content: (
        <TaskList
          blocks={taskBlocks}
          setBlocks={setTasks}
          readOnly={!!version}
          canUpload
          onFiles={(b, files) => void dropFiles(b, files)}
          activeId={openId}
          commentCounts={countsFor(taskBlocks)}
          onOpenComments={openComments}
          label={words.tasks}
          addLabel={words.addTask}
        />
      ),
    },
    { id: "log", label: "Log", content: <Updates projectId={id} readOnly={!!version} /> },
  ];

  return (
    <>
      <PageLayout
        navOpen={side.shown}
        left={
          <>
            {(!side.shown || side.mobile) && (
              <ShowSidebarButton
                onClick={() => side.toggle(true)}
                className="mr-0.5"
              />
            )}
            <Link
              href={backTo}
              // Back to wherever you came from (the Projects page in the view you left it, Home, a board…)
              onClick={goBack}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[14px] text-(--c-t-6b6b6b) no-underline hover:bg-(--c-b-f4f4f4)"
            >
              <IconArrowLeft />
              {/* Phones: just the arrow, so the top bar fits next to the sidebar button */}
              <span className="max-sm:hidden">{journal ? "Journal" : todo ? "Home" : "Projects"}</span>
            </Link>
          </>
        }
        right={
          saveLabel && (
            <span
              className={`mr-1 text-[13px] ${states.includes("error") ? "text-(--c-t-b42318)" : "text-(--c-t-9a9a9a)"}`}
            >
              {saveLabel}
            </span>
          )
        }
        onOpenPanel={() => openComments(PROJECT)}
        onClosePanel={closeComments}
        tools={
          <>
            {!todo && <button
              type="button"
              onClick={() =>
                void setPinnedM({
                  id: id as Id<"projects">,
                  pinned: !data.project.pinnedAt,
                })
              }
              aria-pressed={!!data.project.pinnedAt}
              aria-label={data.project.pinnedAt ? "Unpin" : "Pin"}
              title={
                data.project.pinnedAt
                  ? "Unpin from the sidebar and the top of Projects"
                  : "Pin to the sidebar and the top of Projects"
              }
              className={`flex h-9 w-9 items-center justify-center rounded-lg hover:bg-(--c-b-ececea) ${data.project.pinnedAt ? "text-(--c-t-2358d8)" : "text-(--c-t-6b6b6b) hover:text-(--c-t-1b1b1b)"}`}
            >
              <IconPin size={17} filled={!!data.project.pinnedAt} />
            </button>}
            <button
              type="button"
              onClick={() => setPresenting(true)}
              aria-label="Present"
              title="Present: full screen, hover lines to show their notes"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-(--c-t-6b6b6b) hover:bg-(--c-b-ececea) hover:text-(--c-t-1b1b1b)"
            >
              <PresentIcon />
            </button>
            <CopyForAgent
              text={() => {
                const origin = window.location.origin;
                const stage = stageOf(meta.stage, meta.type);
                const details = [
                  `Type: ${typeLabel(meta.type)}`,
                  `Stage: ${stage.label} (${stage.glyph})`,
                  `Club: ${data.club?.name ?? "Network (no club)"}`,
                  meta.targetDate ? `${meta.type === "digital" ? "Ship date" : "Open date"}: ${meta.targetDate}` : null,
                ].filter(Boolean);
                return [
                  `Switchyards Studio project: ${meta.title || "Untitled"}`,
                  `Project id: ${id}`,
                  `Open in Switchyards Studio: ${origin}/p/${id}`,
                  `Share link: ${origin}/s/${data.project.shareSlug}`,
                  `Project, comments and every attached file (no sign-in): ${origin}/s/${data.project.shareSlug}/agent (JSON, or ?format=md)`,
                  `Download all attached files: curl -fsSL '${origin}/s/${data.project.shareSlug}/agent?format=sh' | sh`,
                  details.join(" · "),
                  "",
                  `To read or change this project, connect to the Switchyards Studio agent API with your key — as an MCP server, or over plain HTTP under /agent. Call read_guide first, then get_project with the project id above. You can edit the document line by line (edit_lines / replace_document), comment on any line, tick off ${words.tasks.toLowerCase()} items, add to the Log and file review rounds. Every document edit saves the previous version, so nothing is lost.`,
                ].join("\n");
              }}
            />
            <SharePopover
              icon
              align={mobile ? "right" : "left"}
              projectId={id}
              shareSlug={data.project.shareSlug}
              passcode={data.project.editPasscode}
              getText={() => docToText(meta.title, mainBlocks)}
            />
            {(edited.length > 0 || archived.length > 0) && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setVersionsOpen(!versionsOpen)}
                  aria-expanded={versionsOpen}
                  aria-label={
                    edited.length === 0
                      ? "Versions"
                      : edited.length === 1
                        ? "Versions: 1 edited version"
                        : `Versions: ${edited.length} edited versions`
                  }
                  title={
                    edited.length === 0
                      ? "Versions"
                      : edited.length === 1
                        ? "1 edited version to review"
                        : `${edited.length} edited versions to review`
                  }
                  className={`relative flex h-9 w-9 items-center justify-center rounded-lg ${
                    versionsOpen
                      ? "bg-(--c-b-e6e6e3) text-(--c-t-1b1b1b)"
                      : edited.length
                        ? "text-(--c-t-b42318) hover:bg-(--c-b-fbdcd8)"
                        : "text-(--c-t-6b6b6b) hover:bg-(--c-b-ececea) hover:text-(--c-t-1b1b1b)"
                  }`}
                >
                  <IconHistory size={18} />
                  {edited.length > 0 && (
                    <span className="absolute right-1 top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-(--c-b-d92d20) px-1 text-[10px] font-semibold leading-none text-white">
                      {edited.length}
                    </span>
                  )}
                </button>
                {versionsOpen && (
                  <div
                    className={`absolute ${mobile ? "right-0" : "left-0"} top-11 z-40 w-72 rounded-xl border border-(--c-l-ebebeb) bg-(--c-b-ffffff) p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.10)]`}
                  >
                    {edited.map((d) => (
                      <button
                        key={d._id}
                        type="button"
                        onClick={() => openVersion(d)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-(--c-b-f4f4f4)"
                      >
                        <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-(--c-b-d92d20)" />
                        <span className="min-w-0">
                          <span className="block text-[14px] text-(--c-t-1b1b1b)">
                            Edited version by {d.editorName || "someone"}
                          </span>
                          <span className="block text-[12px] text-(--c-t-737373)">
                            {timeAgo(new Date(d.updatedAt).toISOString())}
                          </span>
                        </span>
                      </button>
                    ))}
                    {archived.length > 0 && (
                      <>
                        {edited.length > 0 && (
                          <div className="mx-1 my-1.5 h-px bg-(--c-b-ebebeb)" />
                        )}
                        <div className="px-2 pb-1 pt-1.5 text-[12px] text-(--c-t-737373)">
                          Earlier versions
                        </div>
                        {archived.map((d) => (
                          <button
                            key={d._id}
                            type="button"
                            onClick={() => openVersion(d)}
                            className="block w-full rounded-md px-2 py-1.5 text-left text-[14px] text-(--c-t-1b1b1b) hover:bg-(--c-b-f4f4f4)"
                          >
                            Replaced{" "}
                            {new Date(d.updatedAt).toLocaleDateString(
                              undefined,
                              { month: "short", day: "numeric" },
                            )}
                            ,{" "}
                            {new Date(d.updatedAt).toLocaleTimeString(
                              undefined,
                              { hour: "numeric", minute: "2-digit" },
                            )}
                            {d.editorName && (
                              <span className="text-(--c-t-737373)">
                                {" "}
                                · by {d.editorName}
                              </span>
                            )}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        }
        banner={
          version && (
            <VersionBar
              version={version}
              original={mainBlocks}
              onBack={() => {
                setVersion(null);
                setOpenId(null);
              }}
              onUse={async () => {
                await mainSync.flush();
                await promote({
                  documentId: version.doc._id as Id<"documents">,
                });
              }}
              onDiscard={async () => {
                const label =
                  version.doc.kind === "edited"
                    ? "this edited version"
                    : "this earlier version";
                if (!confirm(`Delete ${label}? This can't be undone.`)) return;
                await removeDoc({
                  documentId: version.doc._id as Id<"documents">,
                });
                setVersion(null);
                setOpenId(null);
              }}
            />
          )
        }
        panel={panel}
        focusMode={!!openId && openId !== PROJECT}
      >
        <ProjectTitle
          title={meta.title}
          onChange={(title) => changeMeta({ title })}
          readOnly={!!version || todo}
          onEnter={() =>
            document
              .querySelector<HTMLElement>("[data-doc] .editable")
              ?.focus()
          }
        />
        {/* Above the tabs on purpose: a line someone else changed matters whichever tab you are on */}
        <ClashBar clashes={allClashes} onResolve={resolveClash} />
        {/* Journal entries and the Todo list are just the writing: no tabs, no details */}
        {journal || todo ? (
          mainDoc
        ) : (
          // The fold flag is per pipeline: a physical project and a digital one have different tabs,
          // so one flag for both would fold a set the person never chose to fold.
          <Tabs collapsible storageKey={`project-${meta.type}`} tabs={tabs} />
        )}
      </PageLayout>
      {presenting && (
        <Presentation
          title={meta.title}
          blocks={mainBlocks}
          comments={allComments}
          onClose={() => setPresenting(false)}
        />
      )}
      {placing && (
        <div
          data-placing-bar
          className="fixed inset-x-0 top-3 z-[70] flex justify-center px-4"
        >
          <div className="flex items-center gap-3 rounded-full bg-(--c-b-1b1b1b) py-2 pl-4 pr-2 text-[14px] text-(--c-on-ink) shadow-[0_8px_24px_rgba(0,0,0,0.2)]">
            Click the line to put this comment on
            <button
              type="button"
              onClick={() => setPlacing(null)}
              className="h-7 rounded-full bg-white/15 px-3 text-[13px] hover:bg-white/25"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <Lightbox url={lightbox} onClose={() => setLightbox(null)} />
    </>
  );
}

/**
 * The Visuals tab: this project's review rounds, in brief. The full surface — sheets, marks,
 * rounds — is the Reviews app, so every row links through to it rather than repeating it here.
 */
function ProjectReviews({ projectId }: { projectId: string }) {
  const reviews = useQuery(api.reviews.list, { projectId: projectId as Id<"projects"> });
  const start = `/?view=reviews&project=${projectId}`;

  if (reviews === undefined) return <div className="h-10" />;
  return (
    <div className="pt-1">
      {reviews.length === 0 ? (
        <p className="m-0 py-2 text-[14px] text-(--c-t-9a9a9a)">
          No visuals under review yet. Renders, floor plans, elevations and finish boards go here.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {reviews.map((r) => {
            const s = reviewStatusOf(r.status);
            return (
              <li key={r._id} className="border-b border-(--c-l-f0f0f0) last:border-0">
                <Link
                  href={`/?view=reviews&review=${r._id}`}
                  className="flex items-center gap-3 py-2.5 no-underline"
                >
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-(--c-t-1b1b1b)">
                    {r.title || "Untitled"}
                  </span>
                  <span className="shrink-0 text-[12px] tabular-nums text-(--c-t-9a9a9a)">
                    {r.roundCount === 1 ? "1 round" : `${r.roundCount} rounds`}
                  </span>
                  {r.openMarks > 0 && (
                    <span className="shrink-0 rounded bg-(--c-b-fdf3cf) px-1.5 py-px text-[12px] text-(--c-t-7a5b00)">
                      {r.openMarks === 1 ? "1 open mark" : `${r.openMarks} open marks`}
                    </span>
                  )}
                  {/* Glyph and word together: the colour is never the only thing that says where this stands */}
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-(--c-t-6b6b6b)">
                    <span aria-hidden="true" className="leading-none" style={{ color: s.hex }}>
                      {s.glyph}
                    </span>
                    {s.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Link
        href={start}
        className="mt-2 inline-flex h-[30px] items-center gap-2 text-[14px] text-(--c-t-737373) no-underline hover:text-(--c-t-1b1b1b)"
      >
        <IconPlus />
        Start a review round
      </Link>
    </div>
  );
}

/** Copies a short note to hand an AI agent: which project this is and how to reach it. */
function CopyForAgent({ text }: { text: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text());
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          window.prompt("Copy this for your agent:", text());
        }
      }}
      aria-label="Copy details for an AI agent"
      title="Copy details for an AI agent"
      className={`inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg px-2 text-[13px] ${copied ? "text-(--c-t-15803d)" : "text-(--c-t-6b6b6b) hover:bg-(--c-b-ececea) hover:text-(--c-t-1b1b1b)"}`}
    >
      {copied ? <IconCheck size={17} /> : <IconCopy size={17} />}
      {copied && <span>Copied</span>}
    </button>
  );
}

function VersionBar({
  version,
  original,
  onBack,
  onUse,
  onDiscard,
}: {
  version: { doc: DocInfo; blocks: Block[] };
  original: Block[];
  onBack: () => void;
  onUse: () => Promise<void>;
  onDiscard: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const isEdit = version.doc.kind === "edited";
  const s = isEdit ? computeDiff(original, version.blocks).summary : null;
  const parts = s
    ? [
        s.changed && `${s.changed} changed`,
        s.added && `${s.added} added`,
        s.removed && `${s.removed} removed`,
      ].filter(Boolean)
    : [];
  return (
    <div
      className={`border-y ${isEdit ? "border-(--c-l-f6d5d1) bg-(--c-b-fef6f5)" : "border-(--c-l-ebebeb) bg-(--c-b-fafafa)"}`}
    >
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-5 py-2.5 text-[14px] sm:px-10">
        <div className={isEdit ? "text-(--c-t-b42318)" : "text-(--c-t-6b6b6b)"}>
          {isEdit ? (
            <>
              <span className="font-medium">Edited version</span> by{" "}
              {version.doc.editorName || "someone"},{" "}
              {timeAgo(new Date(version.doc.updatedAt).toISOString())}
              {parts.length > 0 ? (
                <span className="text-(--c-t-d92d20)">
                  {" "}
                  · {parts.join(", ")} · changes underlined and struck through
                </span>
              ) : (
                <span> · no changes yet</span>
              )}
            </>
          ) : (
            <>
              <span className="font-medium">Earlier version</span>, replaced{" "}
              {new Date(version.doc.updatedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
              {version.doc.editorName && ` by ${version.doc.editorName}`}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="h-9 rounded-lg px-3 text-[14px] text-(--c-t-6b6b6b) hover:bg-(--c-b-ffffff)"
          >
            Back to current
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="h-9 rounded-lg px-3 text-[14px] text-(--c-t-6b6b6b) hover:bg-(--c-b-ffffff) hover:text-(--c-t-b42318)"
          >
            {isEdit ? "Discard edits" : "Delete"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              const msg = isEdit
                ? "Use this edited version? Your current version is kept under Earlier versions."
                : "Restore this version? Your current version is kept under Earlier versions.";
              if (!confirm(msg)) return;
              setBusy(true);
              try {
                await onUse();
              } finally {
                setBusy(false);
              }
            }}
            className={primaryButton}
          >
            {isEdit ? "Use this version" : "Restore this version"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PresentIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="3.5" width="15" height="10" rx="2" />
      <path d="M8.5 6.6v4.3l3.6-2.15-3.6-2.15ZM7 16.5h6M10 13.5v3" />
    </svg>
  );
}

/**
 * Lines this person and somebody else both changed at once.
 *
 * Theirs never landed on top of yours — the server refused the write — so both versions still
 * exist and this is where you pick. It sits above the tabs because a line going stale matters
 * whichever tab you happen to be on. The wording carries the meaning on its own; the colour only
 * repeats it.
 */
function ClashBar({
  clashes,
  onResolve,
}: {
  clashes: { c: Clash; where: "main" | "tasks" }[];
  onResolve: (key: string, where: "main" | "tasks", winner: "mine" | "theirs") => void;
}) {
  if (!clashes.length) return null;
  const btn =
    "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] font-medium ring-1 ring-(--c-l-e3e3e0) text-(--c-t-4a4a4a) hover:text-(--c-t-1b1b1b) hover:ring-(--c-l-c9c9c6)";
  return (
    <div role="status" className="mt-4 rounded-lg bg-(--c-b-fef6f5) px-3.5 py-3 ring-1 ring-(--c-l-f6d5d1)">
      <p className="m-0 text-[13.5px] font-semibold text-(--c-t-b42318)">
        {clashes.length === 1 ? "Someone else changed a line you were editing" : `Someone else changed ${clashes.length} lines you were editing`}
      </p>
      <p className="m-0 mt-0.5 text-[12.5px] text-(--c-t-6b6b6b)">
        Yours is what you see in the document. Nothing was overwritten — pick which version to keep.
      </p>
      <ul className="m-0 mt-2.5 list-none space-y-1.5 p-0">
        {clashes.map(({ c, where }) => (
          <li key={`${where}:${c.key}`} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] text-(--c-t-4a4a4a)">
              {c.theirs ? (
                <>
                  <span className="text-(--c-t-8a8a8a)">Theirs: </span>
                  {c.theirs.content.trim() || "(blank line)"}
                </>
              ) : (
                "They deleted this line"
              )}
              {where === "tasks" && <span className="text-(--c-t-8a8a8a)"> · on the task list</span>}
            </span>
            <button type="button" className={btn} onClick={() => onResolve(c.key, where, "theirs")}>
              {c.theirs ? "Use theirs" : "Delete it"}
            </button>
            <button type="button" className={btn} onClick={() => onResolve(c.key, where, "mine")}>
              Keep mine
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
