"use client";

/**
 * Page-wide file intake for the vault: dragging files anywhere over the
 * window raises a full-page drop overlay (the whole page is the target —
 * not just the upload zone card), and pasting files/screenshots from the
 * clipboard feeds the same queue. Window-level listeners, mounted only
 * while `/documents` is on screen.
 *
 * Details that matter:
 * - Only FILE drags react (`dataTransfer.types` includes `"Files"`) — text
 *   selections and in-page drags never raise the overlay.
 * - `dragenter`/`dragleave` fire per element; a depth counter tells "left
 *   the window" apart from "moved between children".
 * - `dragover` must be prevented while a file drag is over the window or
 *   the browser navigates to the dropped file on a miss.
 * - Escape dismisses the overlay (the OS drag itself cannot be cancelled
 *   from the page; a subsequent drop then falls through to the browser
 *   default outside the page contract).
 * - Paste only intercepts when the clipboard actually carries files, so
 *   pasting text into the search input stays untouched.
 */
import { useEffect, useRef, useState } from "react";

/**
 * @param onFiles Where dropped or pasted files go. Omitted inside somebody
 *   else's record: uploading is not a delegated verb, so the listeners are
 *   never attached and the drop overlay never appears. Offering the overlay
 *   and swallowing the file would be worse than the browser's own behaviour.
 */
export function usePageFileDrop(onFiles?: (files: File[]) => void): {
  dropActive: boolean;
} {
  const [dropActive, setDropActive] = useState(false);
  const depthRef = useRef(0);
  const onFilesRef = useRef(onFiles);
  const enabled = onFiles != null;

  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    if (!enabled) return;
    const isFileDrag = (event: DragEvent) =>
      event.dataTransfer?.types?.includes("Files") ?? false;

    const onDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depthRef.current += 1;
      setDropActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      // Without this the browser handles the drop itself (navigates away).
      event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDropActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depthRef.current = 0;
      setDropActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFilesRef.current?.(files);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || depthRef.current === 0) return;
      depthRef.current = 0;
      setDropActive(false);
    };
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      onFilesRef.current?.(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
    };
  }, [enabled]);

  return { dropActive };
}
