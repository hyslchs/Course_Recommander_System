import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getAllRecords } from "@/data/db";
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

function emptySnapshot(): LocalDataSnapshot {
  return Object.fromEntries(LOCAL_DATA_STORES.map((store) => [store, []])) as unknown as LocalDataSnapshot;
}

const LocalDataContext = createContext<LocalDataSnapshot>(emptySnapshot());
export const ProfileContext = createContext<Profile | undefined>(undefined);

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

  useEffect(() => {
    let subscribed = true;
    const reload = async (stores: readonly LocalDataStore[]) => {
      const results = await Promise.all(stores.map((store) => getAllRecords<unknown>(store)));
      if (!subscribed) return;
      setSnapshot((current) => {
        const next = { ...current };
        stores.forEach((store, index) => { next[store] = results[index]; });
        return next;
      });
    };
    void reload(LOCAL_DATA_STORES);
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail === "all") void reload(LOCAL_DATA_STORES);
      else if ((LOCAL_DATA_STORES as readonly string[]).includes(detail)) void reload([detail as LocalDataStore]);
    };
    window.addEventListener("fju-local-data", listener);
    return () => {
      subscribed = false;
      window.removeEventListener("fju-local-data", listener);
    };
  }, []);

  const profile = useMemo(
    () => (snapshot.profile as Profile[]).find((item) => item.id === "current"),
    [snapshot.profile],
  );

  return (
    <LocalDataContext.Provider value={snapshot}>
      <ProfileContext.Provider value={profile}>{children}</ProfileContext.Provider>
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
