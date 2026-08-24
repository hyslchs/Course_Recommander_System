import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORE_NAMES, type BackupV1 } from "./db";

/**
 * jsdom ships no IndexedDB and the project deliberately carries no
 * `fake-indexeddb` dependency, so this is the smallest in-memory implementation
 * that satisfies exactly the surface `db.ts` touches: `open` with
 * `onupgradeneeded`/`onsuccess`, `transaction(store[, mode])`, and the
 * `put` / `get` / `getAll` / `delete` / `clear` requests plus the transaction's
 * `oncomplete`. Every callback fires on a later task, as a real implementation
 * does — that ordering is what the batching under test depends on.
 */
function installFakeIndexedDB(): Map<string, Map<string, { id: string }>> {
  const stores = new Map<string, Map<string, { id: string }>>();
  const later = (run: () => void) => setTimeout(run, 0);

  const request = <T>(compute: () => T) => {
    const handle: { onsuccess: (() => void) | null; onerror: (() => void) | null; result: T | undefined; error: null } =
      { error: null, onerror: null, onsuccess: null, result: undefined };
    later(() => { handle.result = compute(); handle.onsuccess?.(); });
    return handle;
  };

  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => stores.set(name, new Map()),
    transaction(names: string | string[]) {
      const transaction: { objectStore: (name: string) => unknown; oncomplete: (() => void) | null; onerror: (() => void) | null; error: null } = {
        error: null,
        objectStore: (name: string) => {
          const rows = stores.get(name) ?? new Map<string, { id: string }>();
          stores.set(name, rows);
          return {
            clear: () => rows.clear(),
            delete: (id: string) => rows.delete(id),
            get: (id: string) => request(() => rows.get(id)),
            getAll: () => request(() => [...rows.values()]),
            put: (value: { id: string }) => rows.set(value.id, value),
          };
        },
        oncomplete: null,
        onerror: null,
      };
      void names;
      later(() => transaction.oncomplete?.());
      return transaction;
    },
  };

  const open = () => {
    const handle: { onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded: (() => void) | null; result: typeof database; error: null } =
      { error: null, onerror: null, onsuccess: null, onupgradeneeded: null, result: database };
    later(() => { handle.onupgradeneeded?.(); handle.onsuccess?.(); });
    return handle;
  };

  (globalThis as unknown as { indexedDB: unknown }).indexedDB = { open };
  return stores;
}

function backupWith(counts: { completed: number; favorites: number; plans: number }): BackupV1 {
  return {
    data: {
      completedCourses: Array.from({ length: counts.completed }, (_, index) => ({
        addedAt: "now", continueLearning: false, courseId: `c${index}`, courseName: `課程 ${index}`, id: `c${index}`,
      })),
      dismissedCourses: [],
      favorites: Array.from({ length: counts.favorites }, (_, index) => ({ addedAt: "now", id: `f${index}` })),
      profile: [],
      recommendationPreferences: [],
      schedulePlans: Array.from({ length: counts.plans }, (_, index) => ({
        createdAt: "now", entries: [], id: `p${index}`, name: `方案 ${index}`, updatedAt: "now",
      })),
    },
    exportedAt: "2026-08-24T00:00:00.000Z",
    schema: "fju-course-recommender-backup",
    version: 1,
  };
}

describe("importBackup batching", () => {
  let stores: Map<string, Map<string, { id: string }>>;
  let listener: ReturnType<typeof vi.fn<(event: Event) => void>>;

  beforeEach(async () => {
    vi.resetModules();
    stores = installFakeIndexedDB();
    listener = vi.fn<(event: Event) => void>();
    window.addEventListener("fju-local-data", listener);
    return () => window.removeEventListener("fju-local-data", listener);
  });

  /**
   * The regression this pins: `importBackup` used to `await putRecord(...)` per
   * row, so every record dispatched its own `fju-local-data`. Each event makes
   * `LocalDataProvider` re-read a store and re-render the tree, so a 60-record
   * backup was 60 re-render passes mid-import.
   */
  it("dispatches one fju-local-data event for the whole backup, not one per record", async () => {
    const { importBackup } = await import("./db");
    const backup = backupWith({ completed: 40, favorites: 15, plans: 5 });
    const rowCount = 40 + 15 + 5;

    await importBackup(backup, false);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalledTimes(rowCount);
    expect((listener.mock.calls[0][0] as CustomEvent<string>).detail).toBe("all");
    // Batching must not lose rows: every record still landed in its store.
    expect(stores.get("completedCourses")?.size).toBe(40);
    expect(stores.get("favorites")?.size).toBe(15);
    expect(stores.get("schedulePlans")?.size).toBe(5);
  });

  it("still renames colliding schedule plans and still notifies only once", async () => {
    const { importBackup, putRecord } = await import("./db");
    await putRecord("schedulePlans", { createdAt: "now", entries: [], id: "p0", name: "原方案", updatedAt: "now" });
    listener.mockClear();

    await importBackup(backupWith({ completed: 3, favorites: 0, plans: 2 }), false);

    expect(listener).toHaveBeenCalledTimes(1);
    const plans = [...(stores.get("schedulePlans") ?? new Map()).values()] as { id: string; name?: string }[];
    // p0 collided so it was re-keyed and renamed; p1 was free and kept its id.
    expect(plans).toHaveLength(3);
    expect(plans.filter((plan) => plan.name?.endsWith("（匯入）"))).toHaveLength(1);
    expect(plans.find((plan) => plan.id === "p0")?.name).toBe("原方案");
  });

  it("skips the profile store unless the student opted in, and stays silent on an empty backup", async () => {
    const { importBackup } = await import("./db");
    const empty = backupWith({ completed: 0, favorites: 0, plans: 0 });
    empty.data.profile = [{ id: "current" }] as BackupV1["data"]["profile"];

    await importBackup(empty, false);
    expect(listener).not.toHaveBeenCalled();
    expect(stores.get("profile")?.size ?? 0).toBe(0);

    await importBackup(empty, true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(stores.get("profile")?.size).toBe(1);
  });

  it("putRecords writes a batch behind a single event", async () => {
    const { putRecords } = await import("./db");
    await putRecords("favorites", Array.from({ length: 12 }, (_, index) => ({ addedAt: "now", id: `f${index}` })));

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent<string>).detail).toBe("favorites");
    expect(stores.get("favorites")?.size).toBe(12);
  });

  it("exposes every personal store the backup covers", () => {
    for (const store of ["profile", "completedCourses", "favorites", "dismissedCourses", "schedulePlans", "recommendationPreferences"]) {
      expect(STORE_NAMES).toContain(store);
    }
  });
});
