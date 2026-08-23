export { CourseCard } from "./CourseCard";
/**
 * Exported so the schedule slot dialog (T35) can reach the same
 * icon + text + colour treatment with the *short* label set instead of
 * re-deriving it. `EligibilityChip` takes `labels="short"` for exactly that.
 */
export { CategoryChip, EligibilityChip, eligibilityPresentation } from "./statusPresentation";
export type { EligibilityChipProps, EligibilityLabelSet, EligibilityPresentation } from "./statusPresentation";
