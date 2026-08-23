import { createContext, useContext } from "react";
import { recommendationCategoryLabels } from "@/domain/recommendation";
import type { ScheduleSlotRecommendationResult } from "@/domain/scheduleRecommendation";
import type { RecommendationCategory } from "@/domain/types";

export const scheduleRecommendationCategories = Object.keys(recommendationCategoryLabels) as RecommendationCategory[];

export interface SelectedScheduleSlot {
  weekday: number;
  section: string;
}

/**
 * Everything `SlotRecommendationDialog` needs. It used to be an 11-prop bag
 * threaded through `ScheduleWorkspace`'s JSX; the dialog now takes no props.
 */
export interface SlotRecommendationContextValue {
  slot?: SelectedScheduleSlot;
  result?: ScheduleSlotRecommendationResult;
  loading: boolean;
  error: string;
  addingCourseId: string;
  categoryFilters: RecommendationCategory[];
  close: () => void;
  retry: () => void;
  add: (courseId: string) => void;
  toggleCategory: (category: RecommendationCategory) => void;
  selectAllCategories: () => void;
}

export const SlotRecommendationContext = createContext<SlotRecommendationContextValue | null>(null);

export function useSlotRecommendation(): SlotRecommendationContextValue {
  const context = useContext(SlotRecommendationContext);
  if (!context) throw new Error("useSlotRecommendation 必須在 SlotRecommendationContext.Provider 之內使用");
  return context;
}
