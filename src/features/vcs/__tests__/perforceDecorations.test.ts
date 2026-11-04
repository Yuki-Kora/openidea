import { afterEach, describe, expect, it } from "vitest";
import { getFileDecoration, setFileDecorations } from "@/workbench/contributions";
import { clearPerforceEditorStatus, setPerforceEditorStatus } from "../perforceDecorations";

describe("Perforce editor decorations", () => {
  const first = {};
  const second = {};
  afterEach(() => {
    clearPerforceEditorStatus(first);
    clearPerforceEditorStatus(second);
    setFileDecorations("vcs", new Map());
  });

  it("colours actual changes and clears inherited Git status for clean Perforce files", () => {
    const path = "/project/file.cs";
    setFileDecorations("vcs", new Map([[path, { color: "grey", faded: true }]]));
    setPerforceEditorStatus(first, path, false);
    expect(getFileDecoration(path)?.color).toBeUndefined();
    expect(getFileDecoration(path)?.faded).toBe(false);
    setPerforceEditorStatus(first, path, true);
    expect(getFileDecoration(path)?.color).toBe("var(--vcs-modified)");
    setPerforceEditorStatus(first, path, false);
    expect(getFileDecoration(path)?.color).toBeUndefined();
  });

  it("keeps a changed file marked while any open view reports changes", () => {
    const path = "/project/file.cs";
    setPerforceEditorStatus(first, path, true);
    setPerforceEditorStatus(second, path, false);
    expect(getFileDecoration(path)?.color).toBe("var(--vcs-modified)");
    clearPerforceEditorStatus(first);
    expect(getFileDecoration(path)?.color).toBeUndefined();
  });
});
