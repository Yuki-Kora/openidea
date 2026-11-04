import { invoke } from "@tauri-apps/api/core";
import type { BlameLine, LineHunk } from "@/bindings";

type Annotation = { change: string; user: string; time: string };
type Response = { lines: Annotation[]; hunks: LineHunk[] };

const uncommitted = (): BlameLine => ({ commit: "00000000", author: "", timeMs: 0, summary: "Uncommitted changes" });

/** Map #have annotations onto the exact buffer used for the diff. */
export function mapPerforceBlame(response: Response, text: string): BlameLine[] {
  const base = response.lines.map((line): BlameLine => {
    // p4 annotate reports the server's wall-clock time without a timezone.
    const match = /^(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(line.time);
    const timeMs = match ? new Date(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!).getTime() : 0;
    return { commit: `p4:${line.change}`, author: line.user, timeMs, summary: `Perforce changelist ${line.change} (${line.time} server time)` };
  });
  const mapped: BlameLine[] = [];
  let old = 0;
  for (const h of response.hunks) {
    if (h.oldStart < old || h.oldStart > base.length || h.start !== mapped.length + h.oldStart - old) throw new Error("Invalid Perforce annotation mapping");
    mapped.push(...base.slice(old, h.oldStart));
    for (let i = 0; i < h.lines; i++) mapped.push(uncommitted());
    old = h.oldStart + h.oldLines;
    if (old > base.length) throw new Error("Invalid Perforce annotation mapping");
  }
  mapped.push(...base.slice(old));
  const count = text.split("\n").length;
  if (mapped.length === count - 1 && text.endsWith("\n")) mapped.push(uncommitted());
  if (mapped.length !== count) throw new Error("Perforce annotation line count mismatch");
  return mapped;
}

export async function perforceBlame(path: string, text: string): Promise<BlameLine[]> {
  return mapPerforceBlame(await invoke<Response>("p4_blame", { path, text }), text);
}
