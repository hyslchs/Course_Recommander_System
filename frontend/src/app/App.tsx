import { useCallback, useEffect } from "react";
import { AppShell } from "./AppShell";
import { AppRoutes } from "./routes";
import { SchedulePlanContext } from "@/hooks/useSchedulePlans";
import { useStore } from "@/hooks/useStore";
import { putRecord } from "@/data/db";
import {
  ACTIVE_SCHEDULE_PREFERENCE_ID,
  resolveActiveSchedulePlan,
  type ActiveSchedulePreference,
} from "@/domain/scheduleUtils";
import type { Profile, SchedulePlan } from "@/domain/types";

function App() {
  const [profiles] = useStore<Profile>("profile");
  const profile = profiles.find((item) => item.id === "current");
  const [plans] = useStore<SchedulePlan>("schedulePlans");
  const [schedulePreferences] = useStore<ActiveSchedulePreference>("recommendationPreferences");
  const activePreference = schedulePreferences.find((item) => item.id === ACTIVE_SCHEDULE_PREFERENCE_ID);
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

  return (
    <SchedulePlanContext.Provider value={{ plans, activePlan, selectPlan }}>
      <AppShell profile={profile}>
        <AppRoutes profile={profile} plans={plans} activePlan={activePlan} selectPlan={selectPlan} />
      </AppShell>
    </SchedulePlanContext.Provider>
  );
}

export default App;
