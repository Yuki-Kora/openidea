import { setFileDecorations, type FileDecoration } from "@/workbench/contributions";

// A file may be open in more than one editor. Keep each view's result separate
// so closing one view cannot remove the decoration of another.
const views = new Map<object, { path: string; changed: boolean }>();

function publish() {
  const paths = new Map<string, boolean>();
  for (const { path, changed } of views.values()) paths.set(path, (paths.get(path) ?? false) || changed);
  const decorations = new Map<string, FileDecoration>();
  for (const [path, changed] of paths) {
    decorations.set(path, {
      color: changed ? "var(--vcs-modified)" : undefined,
      faded: false,
      tooltip: changed ? "Modified in Perforce" : "Unchanged in Perforce",
    });
  }
  setFileDecorations("perforce", decorations);
}

export function setPerforceEditorStatus(owner: object, path: string, changed: boolean) {
  views.set(owner, { path, changed });
  publish();
}

export function clearPerforceEditorStatus(owner: object) {
  if (views.delete(owner)) publish();
}
