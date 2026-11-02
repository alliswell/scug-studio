import type { ProjectType } from "@/lib/types";
import { typeLabel } from "@/lib/types";

/**
 * What kind of work this is, as a shape rather than a brand mark: a room with a doorway for a
 * build-out, a framed screen for digital work. Drawn in the current text colour so it reads the
 * same in both themes, and labelled, because the two never differ by colour alone.
 */
export function TypeIcon({ type, size = 18, className = "" }: { type: ProjectType; size?: number; className?: string }) {
  const label = typeLabel(type);
  if (type === "digital")
    return (
      <svg
        viewBox="0 0 16 16"
        width={size}
        height={size}
        role="img"
        aria-label={label}
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="1.75" y="2.75" width="12.5" height="9" rx="1.5" />
        <path d="M4.25 5.25h7.5M4.25 7.5h4.5M5.75 14h4.5M8 11.75V14" />
      </svg>
    );
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* A room in plan: walls, an interior partition, and a gap where the door swings */}
      <path d="M1.75 2.75h12.5v10.5H1.75z" />
      <path d="M7 2.75v4.5M7 10.75v2.5" />
      <path d="M14.25 6.5h-3.5" />
      <path d="M10.75 6.5a2.75 2.75 0 0 1-2.75 2.75" />
    </svg>
  );
}
