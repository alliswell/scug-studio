"use client";

import { useEffect, useRef } from "react";

/** The browser tab says what's open (a project's or board's name, or the page); null leaves the tab as it is */
export function useDocumentTitle(title: string | null | undefined) {
  const set = useRef(false);
  useEffect(() => {
    if (title === null || title === undefined) return;
    document.title = title.trim() || "Switchyards Studio";
    set.current = true;
  }, [title]);
  useEffect(
    () => () => {
      if (set.current) document.title = "Switchyards Studio";
    },
    [],
  );
}
