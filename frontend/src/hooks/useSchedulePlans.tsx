import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocalDataState, useLocalRecords } from "./localData";
import { putRecord } from "@/data/db";
import {
  ACTIVE_SCHEDULE_PREFERENCE_ID,
  resolveActiveSchedulePlan,
  type ActiveSchedulePreference,
} from "@/domain/scheduleUtils";
import type { SchedulePlan } from "@/domain/types";

export interface SchedulePlanContextValue {
  plans: SchedulePlan[];
  activePlan?: SchedulePlan;
  selectPlan: (planId: string) => Promise<void>;
}

export const SchedulePlanContext = createContext<SchedulePlanContextValue>({
  plans: [],
  selectPlan: async () => undefined,
});

/**
 * The single source of truth for plans (plan §6.3-2). Nothing passes `plans`,
 * `activePlan` or `selectPlan` down as props any more — the schedule page, the
 * workspace and every course card read them from here.
 */
export function SchedulePlanProvider({ children }: { children: ReactNode }) {
  const { writable } = useLocalDataState();
  const plans = useLocalRecords<SchedulePlan>("schedulePlans");
  const preferences = useLocalRecords<ActiveSchedulePreference>("recommendationPreferences");
  const activePreference = preferences.find((item) => item.id === ACTIVE_SCHEDULE_PREFERENCE_ID);
  const [volatilePlanId, setVolatilePlanId] = useState<string>();
  const activePlan = resolveActiveSchedulePlan(plans, writable ? activePreference?.planId : volatilePlanId ?? activePreference?.planId);
  const selectPlan = useCallback(async (planId: string) => {
    if (!writable) {
      setVolatilePlanId(planId);
      return;
    }
    await putRecord("recommendationPreferences", {
      id: ACTIVE_SCHEDULE_PREFERENCE_ID,
      planId,
      updatedAt: new Date().toISOString(),
    } satisfies ActiveSchedulePreference);
  }, [writable]);
  useEffect(() => {
    if (writable) setVolatilePlanId(undefined);
  }, [writable]);
  useEffect(() => {
    if (writable && activePlan && activePreference?.planId !== activePlan.id) {
      void selectPlan(activePlan.id).catch(() => undefined);
    }
  }, [activePlan, activePreference?.planId, selectPlan, writable]);

  const value = useMemo(() => ({ plans, activePlan, selectPlan }), [plans, activePlan, selectPlan]);
  return <SchedulePlanContext.Provider value={value}>{children}</SchedulePlanContext.Provider>;
}

export function useSchedulePlans(): SchedulePlanContextValue {
  return useContext(SchedulePlanContext);
}
