import { describe, expect, it } from "vitest";
import { mapPerforceBlame } from "./perforceBlame";

const lines = [
  { change: "12", user: "alice", time: "2026/07/01 14:50:23" },
  { change: "15", user: "bob", time: "2026/07/02 16:23:25" },
  { change: "16", user: "carol", time: "2026/07/03 12:00:00" },
];

describe("Perforce blame mapping", () => {
  it("maps changed lines as uncommitted and preserves unchanged authors", () => {
    const mapped = mapPerforceBlame({ lines, hunks: [{ kind: "modified", start: 1, lines: 1, oldStart: 1, oldLines: 1, oldText: "old\n" }] }, "a\nnew\nc\n");
    expect(mapped.map((l) => l.commit)).toEqual(["p4:12", "00000000", "p4:16", "00000000"]);
    expect(mapped[0]?.author).toBe("alice");
  });

  it("maps insertions and deletions without assigning wrong authors", () => {
    const mapped = mapPerforceBlame({ lines, hunks: [
      { kind: "added", start: 1, lines: 1, oldStart: 1, oldLines: 0, oldText: "" },
      { kind: "deleted", start: 3, lines: 0, oldStart: 2, oldLines: 1, oldText: "c\n" },
    ] }, "a\nnew\nb");
    expect(mapped.map((l) => l.commit)).toEqual(["p4:12", "00000000", "p4:15"]);
  });

  it("rejects inconsistent annotation offsets", () => {
    expect(() => mapPerforceBlame({ lines, hunks: [{ kind: "deleted", start: 2, lines: 0, oldStart: 1, oldLines: 1, oldText: "" }] }, "a\nc")).toThrow();
  });
});
