import type { CompletedCourse, Profile, SchedulePlan } from "@/domain/types";

export const DB_NAME = "fju-course-recommender";
export const DB_VERSION = 1;
export const STORE_NAMES = [
  "profile",
  "completedCourses",
  "favorites",
  "dismissedCourses",
  "schedulePlans",
  "recommendationPreferences",
  "catalogCache",
] as const;
export type StoreName = (typeof STORE_NAMES)[number];

let databasePromise: Promise<IDBDatabase> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        for (const name of STORE_NAMES) {
          if (!request.result.objectStoreNames.contains(name)) {
            request.result.createObjectStore(name, { keyPath: "id" });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return databasePromise;
}

export async function getRecord<T>(store: StoreName, id: string): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllRecords<T>(store: StoreName): Promise<T[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The one place `fju-local-data` is dispatched. `LocalDataProvider` re-reads the
 * named store (or every store for `"all"`) on each event, so an event is a
 * whole-app re-render: fire one per user-visible operation, never one per row.
 */
function notifyLocalDataChanged(detail: StoreName | "all"): void {
  window.dispatchEvent(new CustomEvent("fju-local-data", { detail }));
}

/** Writes rows in a single transaction without announcing them. */
async function writeRecords<T extends object>(store: StoreName, values: readonly T[]): Promise<void> {
  if (!values.length) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    const objectStore = transaction.objectStore(store);
    for (const value of values) objectStore.put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function putRecord<T extends object>(store: StoreName, value: T): Promise<void> {
  await writeRecords(store, [value]);
  notifyLocalDataChanged(store);
}

/**
 * Batch form of `putRecord`: one transaction, one `fju-local-data` event for the
 * whole batch. Use it wherever a loop would otherwise call `putRecord` per row.
 */
export async function putRecords<T extends object>(store: StoreName, values: readonly T[]): Promise<void> {
  if (!values.length) return;
  await writeRecords(store, values);
  notifyLocalDataChanged(store);
}

export async function deleteRecord(store: StoreName, id: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    transaction.objectStore(store).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  notifyLocalDataChanged(store);
}

export async function clearPersonalData(): Promise<void> {
  const db = await openDatabase();
  await Promise.all(
    STORE_NAMES.filter((name) => name !== "catalogCache").map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(name, "readwrite");
          transaction.objectStore(name).clear();
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        }),
    ),
  );
  notifyLocalDataChanged("all");
}

export interface BackupV1 {
  schema: "fju-course-recommender-backup";
  version: 1;
  exportedAt: string;
  data: {
    profile: Profile[];
    completedCourses: (CompletedCourse & { id: string })[];
    favorites: { id: string; addedAt: string }[];
    dismissedCourses: { id: string; addedAt: string }[];
    schedulePlans: SchedulePlan[];
    recommendationPreferences: Record<string, unknown>[];
  };
}

export async function createBackup(): Promise<BackupV1> {
  return {
    schema: "fju-course-recommender-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      profile: await getAllRecords("profile"),
      completedCourses: await getAllRecords("completedCourses"),
      favorites: await getAllRecords("favorites"),
      dismissedCourses: await getAllRecords("dismissedCourses"),
      schedulePlans: await getAllRecords("schedulePlans"),
      recommendationPreferences: await getAllRecords("recommendationPreferences"),
    },
  };
}

export function validateBackup(value: unknown): BackupV1 {
  if (!value || typeof value !== "object") throw new Error("備份不是有效的 JSON 物件");
  const backup = value as Partial<BackupV1>;
  if (backup.schema !== "fju-course-recommender-backup" || backup.version !== 1 || !backup.data) {
    throw new Error("不支援的備份格式或版本");
  }
  for (const key of ["profile", "completedCourses", "favorites", "dismissedCourses", "schedulePlans", "recommendationPreferences"] as const) {
    if (!Array.isArray(backup.data[key])) throw new Error(`備份缺少 ${key}`);
  }
  return backup as BackupV1;
}

/**
 * This used to call `putRecord` per row, so a backup with N records dispatched N
 * `fju-local-data` events — N full re-reads of the store plus N re-renders of
 * every component under `LocalDataProvider`, mid-import. Rows are now resolved
 * first, written one transaction per store, and announced exactly once with
 * `"all"` at the end. Callers see the same final state, and the UI sees a single
 * update instead of a storm.
 */
export async function importBackup(backup: BackupV1, overwriteProfile: boolean): Promise<void> {
  const batches: [StoreName, { id: string }[]][] = [];
  for (const [store, rows] of Object.entries(backup.data) as [StoreName, { id: string }[]][]) {
    if (store === "profile" && !overwriteProfile) continue;
    const prepared: { id: string }[] = [];
    for (const original of rows) {
      let row = original;
      if (store === "schedulePlans" && (await getRecord(store, row.id))) {
        row = {
          ...row,
          id: `${row.id}-import-${crypto.randomUUID().slice(0, 8)}`,
          name: `${(row as SchedulePlan).name}（匯入）`,
        } as { id: string };
      }
      prepared.push(row);
    }
    if (prepared.length) batches.push([store, prepared]);
  }
  for (const [store, rows] of batches) await writeRecords(store, rows);
  if (batches.length) notifyLocalDataChanged("all");
}
