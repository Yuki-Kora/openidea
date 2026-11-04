import { afterEach, expect, it } from "vitest";
import { getFileDecoration, setFileDecorations } from "@/workbench/contributions";
import { clearGitBufferStatus, setGitBufferStatus } from "../gitBufferDecorations";

const first = {}, second = {}, path = "/project/a.ts";
afterEach(() => { clearGitBufferStatus(first); clearGitBufferStatus(second); setFileDecorations("vcs", new Map()); });
it("marks unsaved Git changes and preserves the mark while another view is changed", () => {
  setGitBufferStatus(first, path, true);
  setGitBufferStatus(second, path, false);
  expect(getFileDecoration(path)?.color).toBe("var(--vcs-modified)");
  clearGitBufferStatus(first);
  expect(getFileDecoration(path)).toBeUndefined();
});
it("preserves Git status colors for added and conflicted files", () => {
  setFileDecorations("vcs", new Map([[path, { color: "green" }]]));
  setGitBufferStatus(first, path, true);
  expect(getFileDecoration(path)?.color).toBe("green");
});
