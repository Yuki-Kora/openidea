import { afterEach, expect, it, vi } from "vitest";
import { viewMemory } from "./viewMemory";

afterEach(() => vi.unstubAllGlobals());

it("isolates slots by plugin and view and rejects invalid or oversized writes", async () => {
  const values = new Map<string, string>();
  const db = {
    close() {},
    transaction() {
      const tx = {
        oncomplete: () => {}, onerror: () => {}, onabort: () => {},
        objectStore() {
          const request = (key: string, value?: string) => {
            const r = { result: undefined as string | undefined, onsuccess: () => {} };
            queueMicrotask(() => {
              if (value !== undefined) values.set(key, value);
              else r.result = values.get(key);
              r.onsuccess(); tx.oncomplete();
            });
            return r;
          };
          return { get: (key: string) => request(key), put: (value: string, key: string) => request(key, value) };
        },
      };
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", { open() {
    const request = { result: db, onsuccess: () => {}, onupgradeneeded: () => {}, onerror: () => {}, onblocked: () => {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  } });
  await viewMemory("p1", "v", "state", "one");
  expect(await viewMemory("p1", "v", "state")).toBe("one");
  expect(await viewMemory("p2", "v", "state")).toBeNull();
  expect(await viewMemory("p1", "other", "state")).toBeNull();
  expect(await viewMemory("p1", "v", "content")).toBeNull();
  await expect(viewMemory("p1", "v", "other", "x")).rejects.toThrow("invalid storage slot");
  await expect(viewMemory("p1", "v", "state", "x".repeat(131073))).rejects.toThrow("too large");
});
