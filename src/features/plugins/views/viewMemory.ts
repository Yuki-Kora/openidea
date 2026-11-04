/** Isolated, bounded storage for sandboxed web views. Never exposes IDE storage. */
const limits: Record<string, number> = { content: 64 * 1024 * 1024, state: 256 * 1024 };

export async function viewMemory(plugin: string, view: string, slot: unknown, value?: unknown): Promise<string | null> {
  if (typeof slot !== "string" || !Object.hasOwn(limits, slot)) throw new Error("invalid storage slot");
  if (value !== undefined && (typeof value !== "string" || value.length * 2 > limits[slot]!))
    throw new Error("stored data is too large or invalid");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("openidea-plugin-view-memory", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("views");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("storage is blocked"));
  });
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction("views", value === undefined ? "readonly" : "readwrite");
      const store = tx.objectStore("views");
      const key = JSON.stringify([plugin, view, slot]);
      const request = value === undefined ? store.get(key) : store.put(value, key);
      let result: string | null = null;
      request.onsuccess = () => { if (value === undefined && typeof request.result === "string") result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("storage transaction aborted"));
    });
  } finally { db.close(); }
}
