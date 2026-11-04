/** Project-specific provider selection. Auto never silently chooses between two providers. */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { call, commands, isTauri } from "./ipc";
import { useProject } from "./project";

export type VcsChoice = "auto" | "git" | "perforce" | "none";
export type VcsProvider = "git" | "perforce" | "none" | "ambiguous" | "detecting";
export const useProjectVcs = create<{ root: string | null; choice: VcsChoice; provider: VcsProvider }>(() => ({ root: null, choice: "auto", provider: "none" }));
const choices: VcsChoice[] = ["auto", "git", "perforce", "none"];
const storageKey = (root: string) => `openidea.projectVcs:${root}`;
let generation = 0;

function readChoice(root: string): VcsChoice {
  try { const value = localStorage.getItem(storageKey(root)); return choices.includes(value as VcsChoice) ? value as VcsChoice : "auto"; }
  catch { return "auto"; }
}

export function withinWorkspace(root: string, workspace: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const path = norm(root), base = norm(workspace);
  return !!base && (path === base || path.startsWith(`${base}/`));
}

async function update() {
  const project = useProject.getState().project;
  const ticket = ++generation;
  if (!project) { useProjectVcs.setState({ root: null, choice: "auto", provider: "none" }); return; }
  const choice = readChoice(project.root);
  if (choice !== "auto") { useProjectVcs.setState({ root: project.root, choice, provider: choice }); return; }
  useProjectVcs.setState({ root: project.root, choice, provider: "detecting" });
  const [git, p4] = await Promise.all([
    project.isGit ? Promise.resolve(true) : isTauri() ? call(commands.vcsRoots()).then((roots) => roots.length > 0, () => false) : Promise.resolve(false),
    isTauri() ? invoke<{ root: string }>("p4_info").then((info) => withinWorkspace(project.root, info.root), () => false) : Promise.resolve(false),
  ]);
  if (ticket !== generation || useProject.getState().project?.root !== project.root) return;
  useProjectVcs.setState({ provider: git && p4 ? "ambiguous" : git ? "git" : p4 ? "perforce" : "none" });
}

export function setProjectVcs(choice: VcsChoice) {
  const root = useProject.getState().project?.root;
  if (!root || !choices.includes(choice)) return;
  try { localStorage.setItem(storageKey(root), choice); } catch { return; }
  void update();
}

useProject.subscribe((s, previous) => { if (s.project !== previous.project) void update(); });
void update();
