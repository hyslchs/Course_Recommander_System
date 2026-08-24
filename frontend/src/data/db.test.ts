import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORE_NAMES, type BackupV1 } from "./db";

/**
 * jsdom ships no IndexedDB and the project deliberately carries no
 * `fake-indexeddb` dependency, so this is the smallest in-memory implementation
 * that satisfies exactly the surface `db.ts` touches: `open` with
 * `onupgradeneeded`/`onsuccess`, `transaction(stores[, mode])`, and the
 * `put` / `get` / `getAll` / `delete` / `clear` requests plus the transaction's
 * `oncomplete` / `onerror` / `onabort` / `abort()`. Every callback fires on a
 * later task, as a real implementation does — that ordering is what the
 * batching under test depends on.
 *
 * Writes are buffered and applied only when the transaction commits, so an
 * aborted transaction leaves nothing behind. That is what a real IndexedDB
 * transaction guarantees, and it is what lets the atomicity test tell "one
 * transaction across every store" apart from "one transaction per store".
 *
 * Pass `failWritesTo` to make every `put` into that store abort its
 * transaction, simulating a mid-import failure such as a quota error.
 */
function installFakeIndexedDB(failWritesTo?: string): Map<string, Map<string, { id: string }>> {
  const stores = new Map<string, Map<string, { id: string }>>();
  const later = (run: () => void) => setTimeout(run, 0);
  const rowsOf = (name: string) => {
    const rows = stores.get(name) ?? new Map<string, { id: string }>();
    stores.set(name, rows);
    return rows;
  };

  const request = <T>(compute: () => T) => {
    const handle: { onsuccess: (() => void) | null; onerror: (() => void) | null; result: T | undefined; error: null } =
      { error: null, onerror: null, onsuccess: null, result: undefined };
    later(() => { handle.result = compute(); handle.onsuccess?.(); });
    return handle;
  };

  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => stores.set(name, new Map()),
    transaction(names: string | string[], mode?: string) {
      const scope = Array.isArray(names) ? names : [names];
      const pending: (() => void)[] = [];
      let aborted = false;
      const transaction: {
        abort: () => void;
        objectStore: (name: string) => unknown;
        oncomplete: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        error: Error | null;
      } = {
        abort: () => { aborted = true; },
        error: null,
        objectStore: (name: string) => {
          if (!scope.includes(name)) throw new Error(`store ${name} is outside this transaction's scope`);
          const rows = rowsOf(name);
          return {
            clear: () => pending.push(() => rows.clear()),
            delete: (id: string) => pending.push(() => rows.delete(id)),
            get: (id: string) => request(() => rows.get(id)),
            getAll: () => request(() => [...rows.values()]),
            put: (value: { id: string }) => {
              if (name === failWritesTo) {
                aborted = true;
                transaction.error = new Error(`寫入 ${name} 失敗`);
              }
              pending.push(() => rows.set(value.id, value));
            },
          };
        },
        onabort: null,
        oncomplete: null,
        onerror: null,
      };
      void mode;
      later(() => {
        if (aborted) {
          transaction.onerror?.();
          transaction.onabort?.();
          return;
        }
        for (const apply of pending) apply();
        transaction.oncomplete?.();
      });
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

  /**
   * The collision check used to look only at rows already in IndexedDB, so two
   * previously-unseen plans sharing an id inside one backup both passed it and
   * the second `put` silently replaced the first — one row stored, one plan
   * gone. Ids claimed earlier in the same import count as taken.
   */
  it("keeps both plans when one backup carries two rows sharing an id", async () => {
    const { importBackup } = await import("./db");
    const backup = backupWith({ completed: 0, favorites: 0, plans: 2 });
    backup.data.schedulePlans[0] = { ...backup.data.schedulePlans[0], id: "dup", name: "早八方案" };
    backup.data.schedulePlans[1] = { ...backup.data.schedulePlans[1], id: "dup", name: "晚起方案" };

    await importBackup(backup, false);

    const plans = [...(stores.get("schedulePlans") ?? new Map()).values()] as { id: string; name?: string }[];
    expect(plans).toHaveLength(2);
    expect(plans.find((plan) => plan.id === "dup")?.name).toBe("早八方案");
    expect(plans.map((plan) => plan.name)).toContain("晚起方案（匯入）");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  /**
   * The import used to open one transaction per store and only announce itself
   * after the last one, so a failure partway through left earlier stores
   * committed and every subscriber unaware — the UI kept rendering data the
   * database no longer held. All stores now share one transaction.
   */
  it("rolls the whole import back and still notifies when a store fails mid-import", async () => {
    const failing = installFakeIndexedDB("favorites");
    const { importBackup } = await import("./db");

    await expect(importBackup(backupWith({ completed: 4, favorites: 2, plans: 3 }), false)).rejects.toThrow();

    // `completedCourses` is prepared before `favorites`: with a transaction per
    // store it would already have committed, leaving a half-imported database.
    expect(failing.get("completedCourses")?.size ?? 0).toBe(0);
    expect(failing.get("favorites")?.size ?? 0).toBe(0);
    expect(failing.get("schedulePlans")?.size ?? 0).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent<string>).detail).toBe("all");
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

  /**
   * `putRecords` takes no per-row decision, so the in-batch blindness that hit
   * `importBackup` cannot happen here: its only caller keys completed courses by
   * course id, where two rows sharing an id *are* the same course and the last
   * one winning is the wanted result — same as re-adding the code twice.
   */
  it("putRecords collapses rows that share an id, keeping the last one", async () => {
    const { putRecords } = await import("./db");
    await putRecords("completedCourses", [
      { addedAt: "now", id: "cs101", courseName: "第一次" },
      { addedAt: "later", id: "cs101", courseName: "第二次" },
    ]);

    const rows = [...(stores.get("completedCourses") ?? new Map()).values()] as { courseName?: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].courseName).toBe("第二次");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("exposes every personal store the backup covers", () => {
    for (const store of ["profile", "completedCourses", "favorites", "dismissedCourses", "schedulePlans", "recommendationPreferences"]) {
      expect(STORE_NAMES).toContain(store);
    }
  });
});
