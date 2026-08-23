import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useLocalRecords } from "./localData";
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
  const plans = useLocalRecords<SchedulePlan>("schedulePlans");
  const preferences = useLocalRecords<ActiveSchedulePreference>("recommendationPreferences");
  const activePreference = preferences.find((item) => item.id === ACTIVE_SCHEDULE_PREFERENCE_ID);
  const activePlan = resolveActiveSchedulePlan(plans, activePreference?.planId);
  const selectPlan = useCallback(async (planId: string) => {
    await putRecord("recommendationPreferences", {
      id: ACTIVE_SCHEDULE_PREFERENCE_ID,
      planId,
      updatedAt: new Date().toISOString(),
    } satisfies ActiveSchedulePreference);
  }, []);
  useEffect(() => {
    if (activePlan && activePreference?.planId !== activePlan.id) void selectPlan(activePlan.id);
  }, [activePlan, activePreference?.planId, selectPlan]);

  const value = useMemo(() => ({ plans, activePlan, selectPlan }), [plans, activePlan, selectPlan]);
  return <SchedulePlanContext.Provider value={value}>{children}</SchedulePlanContext.Provider>;
}

export function useSchedulePlans(): SchedulePlanContextValue {
  return useContext(SchedulePlanContext);
}
