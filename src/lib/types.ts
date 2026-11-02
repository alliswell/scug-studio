/** "board" embeds an Excalidraw board; its content is the board's id */
export type BlockType = "p" | "h1" | "bullet" | "number" | "todo" | "images" | "board";
export type BlockColor = "yellow" | "blue" | "green" | "red" | "rose";
export type AttachmentKind = "image" | "video" | "audio" | "file" | "link";

export type Attachment = {
  id: string;
  kind: AttachmentKind;
  url: string | null;
  storageId: string | null;
  name: string | null;
  mime: string | null;
  size: number | null;
  /** 0..1 while uploading; undefined once stored */
  progress?: number;
  error?: string;
};

/** A comment on the whole project (blockKey null) or on one line, with files and links beneath it. */
export type Comment = {
  id: string;
  blockKey: string | null;
  /** Lines it was on before an edit moved it (so earlier versions show it where it was) */
  keyHistory?: string[];
  quote: string | null;
  text: string;
  authorName: string | null;
  /** Posted by an AI agent */
  agent: boolean;
  /** Written by the person viewing */
  mine: boolean;
  attachments: Attachment[];
  createdAt: number;
  /** Stable key on this device: a comment you just added keeps the key it had before the server saved it */
  clientKey?: string;
};

export type Block = {
  id: string;
  type: BlockType;
  content: string;
  checked?: boolean;
  color?: BlockColor | null;
  textColor?: TextColor | null;
  /** An "images" block's pictures, side by side */
  images?: Attachment[];
  source_block_id?: string | null;
  /** List lines can nest: 0 (or missing) = top level, up to 4 */
  indent?: number;
  /** Who a to-do is assigned to (a user id) */
  assignee?: string | null;
};

// "red" is stored for the fourth color but shown as purple, per the design
export const BLOCK_COLORS: { value: BlockColor; label: string; bg: string }[] = [
  { value: "yellow", label: "Yellow", bg: "var(--block-yellow)" },
  { value: "blue", label: "Blue", bg: "var(--block-blue)" },
  { value: "green", label: "Green", bg: "var(--block-green)" },
  { value: "red", label: "Purple", bg: "var(--block-red)" },
  // Stored as "rose" because "red" was already taken by purple
  { value: "rose", label: "Red", bg: "var(--block-rose)" },
];

export type TextColor = "gray" | "red" | "orange" | "green" | "blue" | "purple";
export const TEXT_COLORS: { value: TextColor; label: string; hex: string }[] = [
  { value: "gray", label: "Gray", hex: "var(--text-gray)" },
  { value: "red", label: "Red", hex: "var(--text-red)" },
  { value: "orange", label: "Orange", hex: "var(--text-orange)" },
  { value: "green", label: "Green", hex: "var(--text-green)" },
  { value: "blue", label: "Blue", hex: "var(--text-blue)" },
  { value: "purple", label: "Purple", hex: "var(--text-purple)" },
];
export const textHex = (c: TextColor | null | undefined) => TEXT_COLORS.find((x) => x.value === c)?.hex;

export const colorBg = (c: BlockColor | null | undefined) => BLOCK_COLORS.find((x) => x.value === c)?.bg;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type ProjectType = "physical" | "digital";

export const PROJECT_TYPES: { value: ProjectType; label: string; hint: string }[] = [
  { value: "physical", label: "Physical", hint: "A build-out: space plan, furniture, install" },
  { value: "digital", label: "Digital", hint: "Brand, signage artwork, web, campaign" },
];

export const typeLabel = (t: string) => PROJECT_TYPES.find((x) => x.value === t)?.label ?? "Physical";

/**
 * A pipeline stage.
 *
 * `glyph` carries the meaning on its own — color is only ever a second channel, never the
 * only one. `hex` and `colorName` travel together so a color is always nameable in text.
 */
export type Stage = {
  value: string;
  label: string;
  /** Reads without color. Filled = further along. */
  glyph: string;
  hex: string;
  colorName: string;
  /** Dimmed on the board: not yet real work */
  quiet?: boolean;
  /** The column the board scrolls to on open: where work actually is */
  focus?: boolean;
  /** The last column: folded by default, drop here to finish */
  terminal?: boolean;
};

export type PhysicalStage = "concept" | "spacePlan" | "ffe" | "ordered" | "install" | "punch" | "open";
export type DigitalStage = "briefing" | "design" | "review" | "approved" | "shipped";
export type ProjectStage = PhysicalStage | DigitalStage;

/** Physical build-out, left to right on the board. */
export const PHYSICAL_STAGES: Stage[] = [
  { value: "concept", label: "Concept", glyph: "○", hex: "#6B7280", colorName: "Slate", quiet: true },
  { value: "spacePlan", label: "Space plan", glyph: "◐", hex: "#5C5FD6", colorName: "Indigo" },
  { value: "ffe", label: "FF&E spec", glyph: "◑", hex: "#C47F00", colorName: "Amber" },
  { value: "ordered", label: "Ordered", glyph: "◗", hex: "#0F9488", colorName: "Teal" },
  { value: "install", label: "Install", glyph: "◆", hex: "#3B6FD9", colorName: "Blue", focus: true },
  { value: "punch", label: "Punch", glyph: "◇", hex: "#E0662B", colorName: "Orange" },
  { value: "open", label: "Open", glyph: "●", hex: "#2F9E44", colorName: "Green", terminal: true },
];

/** Digital work, left to right on the board. */
export const DIGITAL_STAGES: Stage[] = [
  { value: "briefing", label: "Brief", glyph: "○", hex: "#6B7280", colorName: "Slate", quiet: true },
  { value: "design", label: "Design", glyph: "◐", hex: "#5C5FD6", colorName: "Indigo", focus: true },
  { value: "review", label: "Review", glyph: "◑", hex: "#C47F00", colorName: "Amber" },
  { value: "approved", label: "Approved", glyph: "◆", hex: "#3B6FD9", colorName: "Blue" },
  { value: "shipped", label: "Shipped", glyph: "●", hex: "#2F9E44", colorName: "Green", terminal: true },
];

export const PIPELINES: Record<ProjectType, Stage[]> = { physical: PHYSICAL_STAGES, digital: DIGITAL_STAGES };

/** The stages a project of this type may be in. Anything unknown reads as physical. */
export const stagesFor = (type: string): Stage[] => PIPELINES[type as ProjectType] ?? PHYSICAL_STAGES;

/** Every stage across both pipelines, for views that mix types. */
export const ALL_STAGES: Stage[] = [...PHYSICAL_STAGES, ...DIGITAL_STAGES];

/**
 * The stage record for a value. Pass the project's type when you know it — the two pipelines
 * share no stage values, so a lookup across both is unambiguous and is the honest fallback
 * for mixed views. Returns the type's first stage if the value belongs to neither.
 */
export const stageOf = (value: string, type?: string): Stage =>
  ALL_STAGES.find((s) => s.value === value) ?? stagesFor(type ?? "physical")[0];

/** Which pipeline a stage belongs to. */
export const typeOfStage = (value: string): ProjectType | null =>
  PHYSICAL_STAGES.some((s) => s.value === value) ? "physical" : DIGITAL_STAGES.some((s) => s.value === value) ? "digital" : null;

/** Does this stage belong to this type's pipeline? */
export const stageFits = (type: string, stage: string) => stagesFor(type).some((s) => s.value === stage);

/** The stage a new project of this type starts in. */
export const firstStage = (type: string) => stagesFor(type)[0].value;

/** How far along, 0–1. Used for the thin progress rule on a project row. */
export const stageProgress = (type: string, stage: string) => {
  const list = stagesFor(type);
  const i = list.findIndex((s) => s.value === stage);
  return i < 0 ? 0 : list.length < 2 ? 1 : i / (list.length - 1);
};

// ---------------------------------------------------------------------------
// Clubs
// ---------------------------------------------------------------------------

export type ClubStatus = "prospect" | "signed" | "design" | "construction" | "open" | "closed";

export const CLUB_STATUSES: { value: ClubStatus; label: string; glyph: string; hex: string; colorName: string }[] = [
  { value: "prospect", label: "Prospect", glyph: "○", hex: "#6B7280", colorName: "Slate" },
  { value: "signed", label: "Signed", glyph: "◐", hex: "#5C5FD6", colorName: "Indigo" },
  { value: "design", label: "In design", glyph: "◑", hex: "#C47F00", colorName: "Amber" },
  { value: "construction", label: "Construction", glyph: "◆", hex: "#3B6FD9", colorName: "Blue" },
  { value: "open", label: "Open", glyph: "●", hex: "#2F9E44", colorName: "Green" },
  { value: "closed", label: "Closed", glyph: "◌", hex: "#8A8A8A", colorName: "Gray" },
];

export const clubStatusOf = (s: string) => CLUB_STATUSES.find((x) => x.value === s) ?? CLUB_STATUSES[0];

// ---------------------------------------------------------------------------
// Review rounds
// ---------------------------------------------------------------------------

export type ReviewStatus = "inReview" | "changesRequested" | "approved" | "archived";

export const REVIEW_STATUSES: { value: ReviewStatus; label: string; glyph: string; hex: string; colorName: string }[] = [
  { value: "inReview", label: "In review", glyph: "◐", hex: "#5C5FD6", colorName: "Indigo" },
  { value: "changesRequested", label: "Changes requested", glyph: "◇", hex: "#E0662B", colorName: "Orange" },
  { value: "approved", label: "Approved", glyph: "●", hex: "#2F9E44", colorName: "Green" },
  { value: "archived", label: "Dropped", glyph: "◌", hex: "#8A8A8A", colorName: "Gray" },
];

export const reviewStatusOf = (s: string) => REVIEW_STATUSES.find((x) => x.value === s) ?? REVIEW_STATUSES[0];

/**
 * What a mark on a sheet is about. Each kind has its own glyph, so a plan full of marks
 * reads correctly in greyscale, in print, and to anyone who doesn't separate these hues.
 */
export type MarkKind = "fix" | "question" | "note" | "approve";

export const MARK_KINDS: { value: MarkKind; label: string; glyph: string; hex: string; colorName: string }[] = [
  { value: "fix", label: "Must fix", glyph: "✕", hex: "#D92D20", colorName: "Red" },
  { value: "question", label: "Question", glyph: "?", hex: "#C47F00", colorName: "Amber" },
  { value: "note", label: "Note", glyph: "•", hex: "#3B6FD9", colorName: "Blue" },
  { value: "approve", label: "Looks right", glyph: "✓", hex: "#2F9E44", colorName: "Green" },
];

export const markKindOf = (k: string | null | undefined) => MARK_KINDS.find((x) => x.value === k) ?? MARK_KINDS[2];

/** What a review round will accept as a sheet. */
export const REVIEW_FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,image/avif,image/svg+xml,application/pdf";

export const isReviewSheet = (mime: string | null | undefined) =>
  !!mime && (mime.startsWith("image/") || mime === "application/pdf");

export const isPdfSheet = (mime: string | null | undefined) => mime === "application/pdf";
