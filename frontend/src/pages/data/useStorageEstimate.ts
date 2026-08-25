import { useEffect, useState } from "react";

export interface StorageEstimateSnapshot {
  usage: number;
  quota: number;
  /** 0–100. `quota === 0` reports 0 rather than NaN. */
  percent: number;
}

/**
 * Browser storage headroom for the "your data lives on this device" card.
 *
 * `navigator.storage.estimate()` is the only measurement available to a page —
 * IndexedDB exposes no size of its own. It is absent in jsdom and in insecure
 * contexts, so the hook reports `undefined` there and the caller renders
 * nothing rather than a meter reading zero, which would be a lie.
 *
 * Re-measured on `fju-local-data` because import/clear are exactly the two
 * operations that move the number.
 */
export function useStorageEstimate(): StorageEstimateSnapshot | undefined {
  const [estimate, setEstimate] = useState<StorageEstimateSnapshot>();

  useEffect(() => {
    if (typeof navigator === "undefined" || typeof navigator.storage?.estimate !== "function") return undefined;
    let subscribed = true;
    const measure = async () => {
      try {
        const { quota = 0, usage = 0 } = await navigator.storage.estimate();
        if (!subscribed) return;
        setEstimate({ percent: quota > 0 ? (usage / quota) * 100 : 0, quota, usage });
      } catch {
        // A browser that refuses the estimate is the same case as one that has none.
        if (subscribed) setEstimate(undefined);
      }
    };
    void measure();
    window.addEventListener("fju-local-data", measure);
    return () => {
      subscribed = false;
      window.removeEventListener("fju-local-data", measure);
    };
  }, []);

  return estimate;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** `1536000` -> `"1.5 MB"`. Used for the meter's own output text. */
export function formatBytes(bytes: number): string {
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString("zh-Hant-TW", { maximumFractionDigits: value >= 10 || unit === 0 ? 0 : 1 })} ${UNITS[unit]}`;
}
