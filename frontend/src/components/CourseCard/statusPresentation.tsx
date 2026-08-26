import { CheckCircle, Info, Prohibit, Question, type Icon } from "@phosphor-icons/react";
import { Chip } from "@heroui/react";
import { eligibilityStatusLabels, eligibilityStatusShortLabels } from "@/domain/eligibility";
import { recommendationCategoryLabels } from "@/domain/recommendation";
import type { EligibilityStatus, RecommendationCategory } from "@/domain/types";

/**
 * The visual half of plan §4.3's triple channel (icon + text + colour).
 *
 * Colour alone never carries the status: every chip below renders a Phosphor
 * glyph *and* the wording, so the meaning survives greyscale, colour-blindness
 * and a screen reader that ignores CSS entirely.
 *
 * `no_known_restriction` is deliberately absent from §4.3's table because it is
 * not a judgement — it is the absence of one. It therefore gets the *neutral*
 * chip (`default`, i.e. `--default-soft`), not a semantic colour, so a course we
 * simply could not evaluate never reads as "you are cleared to take this".
 */
export interface EligibilityPresentation {
  /** HeroUI `Chip` colour. `default` is neutral, not semantic. */
  color: "success" | "warning" | "danger" | "default";
  Icon: Icon;
  /** Pinned in the DOM as `data-eligibility-icon` so tests can assert the icon channel. */
  iconName: string;
}

export const eligibilityPresentation: Record<EligibilityStatus, EligibilityPresentation> = {
  eligible_confirmed: { Icon: CheckCircle, color: "success", iconName: "CheckCircle" },
  needs_confirmation: { Icon: Question, color: "warning", iconName: "Question" },
  blocked_confirmed: { Icon: Prohibit, color: "danger", iconName: "Prohibit" },
  no_known_restriction: { Icon: Info, color: "default", iconName: "Info" },
};

/**
 * Which of the two wordings to render. They are NOT interchangeable and must not
 * be merged: all four enum values differ (see the comment on
 * `eligibilityStatusLabels`). `long` is the explanatory copy on course cards,
 * `short` the dense tag inside the schedule slot dialog. Exposing the choice here
 * is what lets both label sets reach the same icon+text+colour treatment without
 * either page hand-rolling its own.
 */
export type EligibilityLabelSet = "long" | "short";

const LABEL_SETS: Record<EligibilityLabelSet, Record<EligibilityStatus, string>> = {
  long: eligibilityStatusLabels,
  short: eligibilityStatusShortLabels,
};

export interface EligibilityChipProps {
  status: EligibilityStatus;
  /** Omit the chip when evaluation found no meaningful restriction. */
  hideWhenNoKnown?: boolean;
  /** @default "long" */
  labels?: EligibilityLabelSet;
  /**
   * Replaces the wording only — the icon and colour still come from `status`, so
   * the triple channel holds. Used for the "有擋修條件" special case, which is a
   * more specific reason for a `blocked_confirmed` verdict, not a fifth status.
   */
  overrideLabel?: string;
  className?: string;
}

/**
 * `data-eligibility` rather than a runtime-composed `className` (plan R3).
 * `` `status ${status}` `` was invisible to static analysis, so a CSS purge could
 * delete `.status.blocked_confirmed` without a single build warning. An attribute
 * whose *selector* is written out literally in the stylesheet cannot be purged by
 * accident, and it is also what the render test asserts on.
 */
export function EligibilityChip({ status, labels = "long", overrideLabel, className, hideWhenNoKnown = false }: EligibilityChipProps) {
  if (hideWhenNoKnown && status === "no_known_restriction") return null;
  const { Icon, color, iconName } = eligibilityPresentation[status];
  return (
    <Chip className={["eligibility-chip", className].filter(Boolean).join(" ")} color={color} data-eligibility={status} variant="soft">
      <Icon aria-hidden="true" data-eligibility-icon={iconName} weight="fill" />
      <Chip.Label>{overrideLabel ?? LABEL_SETS[labels][status]}</Chip.Label>
    </Chip>
  );
}

/**
 * Course category. Plan §4.3 forbids reusing the semantic palette here — a
 * "本系必修" chip painted green would compete with "條件已符合" for the same
 * meaning. So the chip itself is neutral and the category is carried by a 4px
 * leading bar drawn from the separate `--category-*` scale.
 *
 * The bar is a CSS `::before` keyed off `data-category`, for the same R3 reason
 * as above: four literal attribute selectors in the stylesheet, nothing composed
 * at build time.
 */
export function CategoryChip({ category, className }: { category: RecommendationCategory; className?: string }) {
  return (
    <Chip className={["category-chip", className].filter(Boolean).join(" ")} color="default" data-category={category} variant="soft">
      <Chip.Label>{recommendationCategoryLabels[category]}</Chip.Label>
    </Chip>
  );
}
