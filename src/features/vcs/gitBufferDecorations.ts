import { setFileDecorations, type FileDecoration } from "@/workbench/contributions";

const views = new Map<object, { path: string; changed: boolean }>();
function publish() {
  const decorations = new Map<string, FileDecoration>();
  for (const { path, changed } of views.values()) {
    if (changed) decorations.set(path, { color: "var(--vcs-modified)", tooltip: "Modified in Git" });
  }
  setFileDecorations("gitBuffer", decorations);
}
export function setGitBufferStatus(owner: object, path: string, changed: boolean) {
  views.set(owner, { path, changed });
  publish();
}
export function clearGitBufferStatus(owner: object) {
  if (views.delete(owner)) publish();
}
