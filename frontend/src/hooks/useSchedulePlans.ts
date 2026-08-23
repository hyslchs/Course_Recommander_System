import { createContext, useContext } from "react";
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

export function useSchedulePlans(): SchedulePlanContextValue {
  return useContext(SchedulePlanContext);
}
