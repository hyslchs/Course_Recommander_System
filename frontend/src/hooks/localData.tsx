import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getAllRecords,
  recoverPersonalDataStorage,
  type PersonalStorageErrorDetail,
} from "@/data/db";
import type { Profile } from "@/domain/types";

/**
 * The personal IndexedDB stores mirrored into React state. `catalogCache` is
 * excluded on purpose: it holds multi-megabyte artifacts that `api.ts` reads by
 * content-addressed key, and nothing renders from it.
 */
export const LOCAL_DATA_STORES = [
  "profile",
  "completedCourses",
  "favorites",
  "dismissedCourses",
  "schedulePlans",
  "recommendationPreferences",
] as const;

export type LocalDataStore = (typeof LOCAL_DATA_STORES)[number];
export type LocalDataSnapshot = Record<LocalDataStore, unknown[]>;
const PERSONAL_STORAGE_ERROR_EVENT = "fju-personal-storage-error";

function emptySnapshot(): LocalDataSnapshot {
  return Object.fromEntries(LOCAL_DATA_STORES.map((store) => [store, []])) as unknown as LocalDataSnapshot;
}

const LocalDataContext = createContext<LocalDataSnapshot>(emptySnapshot());
export const ProfileContext = createContext<Profile | undefined>(undefined);

export type LocalDataStatus = "loading" | "ready" | "degraded" | "unavailable";

export interface LocalDataError {
  operation: "read" | "write";
  message: string;
}

export interface LocalDataState {
  status: LocalDataStatus;
  writable: boolean;
  retrying: boolean;
  error?: LocalDataError;
  retry: () => Promise<void>;
}

const LocalDataStateContext = createContext<LocalDataState>({
  status: "ready",
  writable: true,
  retrying: false,
  retry: async () => undefined,
});

function storageMessage(operation: "read" | "write", hasSnapshot: boolean): string {
  if (!hasSnapshot) return "目前無法讀取這台裝置的個人資料，尚未確認資料是否存在。";
  return operation === "write"
    ? "目前無法儲存變更。已保留上次成功載入的資料，系統暫時為唯讀。"
    : "目前無法重新讀取個人資料。畫面保留上次成功載入的內容，系統暫時為唯讀。";
}

/**
 * One subscription per store for the whole app (plan §6.3-1).
 *
 * Before this, every `CourseCard` ran its own `getAllRecords` for
 * `completedCourses` and `favorites`, so 25 results meant 25 reads of each store
 * on mount and 25 more on every `fju-local-data` event. Now the provider reads
 * each store once and re-reads only the store the event names.
 */
export function LocalDataProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [status, setStatus] = useState<LocalDataStatus>("loading");
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const [error, setError] = useState<LocalDataError>();
  const mounted = useRef(true);
  const hasSnapshot = useRef(false);

  const readStores = useCallback(async (stores: readonly LocalDataStore[]) => {
    const results = await Promise.all(stores.map((store) => getAllRecords<unknown>(store)));
    if (!mounted.current) return;
    setSnapshot((current) => {
      const next = { ...current };
      stores.forEach((store, index) => { next[store] = results[index]; });
      return next;
    });
  }, []);

  const fail = useCallback((operation: "read" | "write", cause: unknown) => {
    console.error("無法存取個人 IndexedDB 資料", cause);
    if (!mounted.current) return;
    const available = hasSnapshot.current;
    setStatus(available ? "degraded" : "unavailable");
    setError({ operation, message: storageMessage(operation, available) });
  }, []);

  const retry = useCallback(async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      await recoverPersonalDataStorage();
      await readStores(LOCAL_DATA_STORES);
      if (!mounted.current) return;
      hasSnapshot.current = true;
      setStatus("ready");
      setError(undefined);
    } catch (cause) {
      fail(error?.operation ?? "read", cause);
    } finally {
      retryingRef.current = false;
      if (mounted.current) setRetrying(false);
    }
  }, [error?.operation, fail, readStores]);

  useEffect(() => {
    mounted.current = true;
    void readStores(LOCAL_DATA_STORES).then(() => {
      if (!mounted.current) return;
      hasSnapshot.current = true;
      setStatus("ready");
    }).catch((cause) => fail("read", cause));
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      const stores = detail === "all"
        ? LOCAL_DATA_STORES
        : (LOCAL_DATA_STORES as readonly string[]).includes(detail) ? [detail as LocalDataStore] : [];
      if (stores.length) void readStores(stores).catch((cause) => fail("read", cause));
    };
    const storageErrorListener = (event: Event) => {
      const detail = (event as CustomEvent<PersonalStorageErrorDetail>).detail;
      fail(detail.operation, detail.error);
    };
    window.addEventListener("fju-local-data", listener);
    window.addEventListener(PERSONAL_STORAGE_ERROR_EVENT, storageErrorListener);
    return () => {
      mounted.current = false;
      window.removeEventListener("fju-local-data", listener);
      window.removeEventListener(PERSONAL_STORAGE_ERROR_EVENT, storageErrorListener);
    };
  }, [fail, readStores]);

  const profile = useMemo(
    () => (snapshot.profile as Profile[]).find((item) => item.id === "current"),
    [snapshot.profile],
  );

  const state = useMemo<LocalDataState>(() => ({
    status,
    writable: status === "ready",
    retrying,
    error,
    retry,
  }), [error, retry, retrying, status]);

  return (
    <LocalDataContext.Provider value={snapshot}>
      <LocalDataStateContext.Provider value={state}>
        <ProfileContext.Provider value={profile}>{children}</ProfileContext.Provider>
      </LocalDataStateContext.Provider>
    </LocalDataContext.Provider>
  );
}

/** Rows of one personal store, kept in sync by `LocalDataProvider`. */
export function useLocalRecords<T>(store: LocalDataStore): T[] {
  return useContext(LocalDataContext)[store] as T[];
}

/** The single saved profile, or `undefined` before onboarding. */
export function useProfile(): Profile | undefined {
  return useContext(ProfileContext);
}

/** Whether the first read of personal data has completed. */
export function useLocalDataReady(): boolean {
  const { status } = useContext(LocalDataStateContext);
  return status === "ready" || status === "degraded";
}

export function useLocalDataState(): LocalDataState {
  return useContext(LocalDataStateContext);
}
