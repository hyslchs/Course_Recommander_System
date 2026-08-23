import { useCallback, useEffect, useState } from "react";
import { getAllRecords, type StoreName } from "@/data/db";

/** Subscribes a component to one IndexedDB store and to the `fju-local-data` invalidation event. */
export function useStore<T>(store: StoreName): [T[], () => Promise<void>] {
  const [rows, setRows] = useState<T[]>([]);
  const reload = useCallback(async () => setRows(await getAllRecords<T>(store)), [store]);
  useEffect(() => {
    void reload();
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail === store || detail === "all") void reload();
    };
    window.addEventListener("fju-local-data", listener);
    return () => window.removeEventListener("fju-local-data", listener);
  }, [reload, store]);
  return [rows, reload];
}
