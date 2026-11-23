"use client";

import { useEffect, useState } from "react";

/** True on a phone-sized viewport (under 768px). False until the browser has answered, so the server render is the desktop one. */
export function useNarrowViewport(maxWidth = 767): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [maxWidth]);
  return narrow;
}
