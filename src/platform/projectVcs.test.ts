import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "./project";
import { setProjectVcs, useProjectVcs, withinWorkspace } from "./projectVcs";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), roots: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./ipc", async (original) => ({
  ...await original<typeof import("./ipc")>(),
  isTauri: () => true,
  call: (promise: Promise<unknown>) => promise,
  commands: { vcsRoots: mocks.roots },
}));

async function settle() { await vi.waitFor(() => expect(useProjectVcs.getState().provider).not.toBe("detecting")); }
const project = (root: string, isGit: boolean) => ({ root, isGit } as never);

describe("project VCS selection", () => {
  beforeEach(() => {
    useProject.setState({ project: null });
    localStorage.clear();
    mocks.invoke.mockReset();
    mocks.roots.mockReset().mockResolvedValue([]);
  });
  it("detects ambiguity and persists manual choices by project", async () => {
    mocks.invoke.mockResolvedValue({ root: "C:/workspace" });
    useProject.setState({ project: project("C:/workspace/project", true) });
    await settle();
    expect(useProjectVcs.getState().provider).toBe("ambiguous");
    setProjectVcs("perforce");
    expect(useProjectVcs.getState().provider).toBe("perforce");
    useProject.setState({ project: project("C:/other", false) });
    await settle();
    expect(useProjectVcs.getState().provider).toBe("none");
    useProject.setState({ project: project("C:/workspace/project", true) });
    expect(useProjectVcs.getState()).toMatchObject({ choice: "perforce", provider: "perforce" });
  });
  it("ignores detection results after a manual override", async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockReturnValue(new Promise((r) => { resolve = r; }));
    useProject.setState({ project: project("C:/workspace/project", true) });
    expect(useProjectVcs.getState().provider).toBe("detecting");
    setProjectVcs("none");
    resolve({ root: "C:/workspace" });
    await Promise.resolve(); await Promise.resolve();
    expect(useProjectVcs.getState().provider).toBe("none");
  });
  it("checks workspace boundaries rather than string prefixes", () => {
    expect(withinWorkspace("C:\\workspace\\project", "c:/workspace")).toBe(true);
    expect(withinWorkspace("C:/workspace-other", "C:/workspace")).toBe(false);
  });
});
