"use client";

import type { Block } from "@/lib/types";
import { uid } from "@/lib/util";
import { DocEditor } from "./DocEditor";
import { IconPlus } from "./icons";

/** "2/5" (done/total) for the tab label, or "" when nothing is on the list yet. */
export function taskProgress(blocks: Block[]) {
  const todos = blocks.filter((b) => b.type === "todo" && b.content.trim());
  return todos.length ? `${todos.filter((b) => b.checked).length}/${todos.length}` : "";
}

/**
 * The project's to-do list, shown in a tab above the document: a punch list on a build-out,
 * a checklist on digital work. Same list either way — only the words change.
 */
export function TaskList({
  blocks,
  setBlocks,
  readOnly,
  canUpload,
  onFiles,
  activeId,
  onOpenComments,
  commentCounts,
  label,
  addLabel,
}: {
  blocks: Block[];
  setBlocks: (fn: (prev: Block[]) => Block[]) => void;
  readOnly?: boolean;
  canUpload?: boolean;
  onFiles?: (blockId: string, files: File[]) => void;
  activeId?: string | null;
  onOpenComments?: (id: string, opts?: { newComment?: boolean }) => void;
  commentCounts?: Record<string, number>;
  /** What this list is called on this project ("Punch list", "Checklist") */
  label: string;
  /** The placeholder and the add button ("Add a punch item") */
  addLabel: string;
}) {
  return (
    <section aria-label={label}>
      <div className="pl-0.5">
        <DocEditor
          blocks={blocks}
          setBlocks={setBlocks}
          readOnly={readOnly}
          canUpload={canUpload}
          onFiles={onFiles}
          variant="compact"
          canToggleTodos={!readOnly}
          activeId={activeId}
          onOpenComments={onOpenComments}
          canComment={!readOnly}
          commentCounts={commentCounts}
          placeholder={addLabel}
          footer={
            !readOnly && (
              <button
                type="button"
                onClick={() =>
                  setBlocks((prev) => {
                    const last = prev[prev.length - 1];
                    if (last && !last.content.trim() && last.type === "todo") return prev;
                    return [...prev, { id: uid(), type: "todo", content: "" }];
                  })
                }
                className="mt-0.5 inline-flex h-[30px] items-center gap-2 text-[14px] text-(--c-t-737373) hover:text-(--c-t-1b1b1b)"
              >
                <IconPlus />
                <span>{addLabel}</span>
              </button>
            )
          }
        />
      </div>
    </section>
  );
}
