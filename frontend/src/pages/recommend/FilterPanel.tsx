import type { Key, ReactNode } from "react";
import {
  Accordion,
  Description,
  Disclosure,
  Label,
  Radio,
  RadioGroup,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { formatCreditFilterSummary, isHighCreditFilterSelected, toggleHighCreditFilter } from "@/domain/creditFilter";
import { recommendationCategoryLabels, type CourseLevelFilter, type PrerequisiteFilter } from "@/domain/recommendation";
import { weekdayLabels } from "@/domain/schedule";
import type { RecommendationCategory, RecommendationCategoryFilters } from "@/domain/types";
import type { RecommendFilters } from "./filterState";

export interface CourseTagOption {
  code: string;
  label_zh: string;
}

export interface FilterPanelProps {
  value: RecommendFilters;
  onChange: (next: RecommendFilters) => void;
  /** Credit values that the "4 學分以上" bucket stands for. */
  highCreditOptions: number[];
  /** Credit values that get a chip of their own. */
  individualCreditOptions: number[];
  courseTagOptions: CourseTagOption[];
  /** Name of the plan the 衝堂 switch checks against. */
  activePlanName?: string;
  /**
   * `sidebar` is the `lg`-and-up column: several groups may be open at once and
   * each control keeps its own 進階設定 `Disclosure`.
   *
   * `drawer` is the bottom sheet: one group at a time, and the two advanced
   * switches are flattened out of their controls into a single group-level
   * `Disclosure` (plan §5.2-6 — two nested levels of disclosure are not
   * navigable inside a sheet).
   */
  mode: "sidebar" | "drawer";
  /** Rendered under the weekday chips when the ranker would refuse to run. */
  weekdayError?: ReactNode;
}

/** `Set<Key>` -> the number/string array the filter state stores. */
function keysToNumbers(keys: Set<Key>): number[] {
  return [...keys].map(Number).filter((value) => Number.isFinite(value));
}
function keysToStrings(keys: Set<Key>): string[] {
  return [...keys].map(String);
}

const courseLevelChoices: [CourseLevelFilter, string][] = [
  ["all", "不限程度"],
  ["exclude_introductory", "排除入門"],
  ["introductory", "只要入門"],
  ["intermediate", "只要中階"],
  ["advanced", "只要進階"],
];

const prerequisiteChoices: [PrerequisiteFilter, string][] = [
  ["exclude_unmet", "隱藏我尚未完成先修條件的課程"],
  ["show_with_warning", "仍顯示，但提醒我尚未完成先修條件"],
];

/** Title + one-line current-state summary, used by every control in the panel. */
function ControlHeading({ title, summary }: { title: string; summary: string }) {
  return (
    <div className="filter-control-head">
      <strong>{title}</strong>
      <span>{summary}</span>
    </div>
  );
}

function GroupTrigger({ title, summary }: { title: string; summary: string }) {
  return (
    <Accordion.Trigger className="filter-accordion-trigger">
      <span className="filter-accordion-label">
        <b>{title}</b>
        <small>{summary}</small>
      </span>
      <Accordion.Indicator />
    </Accordion.Trigger>
  );
}

/**
 * The whole hard-filter form. One component, two shells: the `lg` sidebar
 * renders it directly and commits every change, the sub-`lg` drawer renders the
 * identical tree over a draft copy and commits on close. Sharing it is the
 * point — the drawer used to be the only way to reach half of these controls on
 * a phone, and a second copy would drift.
 */
export function FilterPanel({
  value,
  onChange,
  highCreditOptions,
  individualCreditOptions,
  courseTagOptions,
  activePlanName,
  mode,
  weekdayError,
}: FilterPanelProps) {
  const patch = (next: Partial<RecommendFilters>) => onChange({ ...value, ...next });
  const highCreditSelected = isHighCreditFilterSelected(value.creditFilters, highCreditOptions);
  const creditSummary = formatCreditFilterSummary(value.creditFilters, highCreditOptions);
  const flattenAdvanced = mode === "drawer";

  const weekdaySummary = value.showOtherWeekdays
    ? "不限星期"
    : `星期${value.preferredWeekdays.map((day) => weekdayLabels[day - 1]).join("、")}`;
  const eligibilityCount = [value.prerequisiteFilter === "exclude_unmet", value.courseLevelFilter !== "all"].filter(Boolean).length;
  const preferenceCount = value.categoryFilters.length + value.courseTagFilters.length;

  const unknownPrerequisiteSwitch = (
    <Switch
      className="filter-switch"
      isSelected={value.includeUnknownPrerequisite}
      onChange={(selected) => patch({ includeUnknownPrerequisite: selected })}
      size="sm"
    >
      <Switch.Content className="min-h-11 items-center">
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Label>也顯示無法自動判斷先修資格的課程</Label>
      </Switch.Content>
    </Switch>
  );
  const unknownCourseLevelSwitch = (
    <Switch
      className="filter-switch"
      isSelected={value.includeUnknownCourseLevel}
      onChange={(selected) => patch({ includeUnknownCourseLevel: selected })}
      size="sm"
    >
      <Switch.Content className="min-h-11 items-center">
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Label>另外顯示程度資料不明的課程</Label>
      </Switch.Content>
    </Switch>
  );

  return (
    <Accordion
      className="filter-accordion"
      allowsMultipleExpanded={mode === "sidebar"}
      defaultExpandedKeys={["schedule"]}
      variant="surface"
    >
      <Accordion.Item id="schedule">
        <Accordion.Heading>
          <GroupTrigger
            summary={`${weekdaySummary}${value.creditFilters.length > 0 ? ` · ${creditSummary}` : ""}`}
            title="上課安排"
          />
        </Accordion.Heading>
        <Accordion.Panel>
          <Accordion.Body className="filter-group-body">
            <div className="filter-control">
              <ControlHeading summary={value.showOtherWeekdays ? "目前不依星期排除" : "只顯示可上的星期"} title="上課星期" />
              <ToggleButtonGroup
                aria-label="偏好的上課星期"
                className="filter-chips"
                isDetached
                selectedKeys={value.preferredWeekdays.map(String)}
                selectionMode="multiple"
                onSelectionChange={(keys) => patch({ preferredWeekdays: keysToNumbers(keys).sort((a, b) => a - b) })}
              >
                {weekdayLabels.map((label, index) => (
                  <ToggleButton className="min-h-11" id={String(index + 1)} key={label}>
                    星期{label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              {weekdayError}
              <Switch
                className="filter-switch"
                isSelected={value.showOtherWeekdays}
                onChange={(selected) => patch({ showOtherWeekdays: selected })}
                size="sm"
              >
                <Switch.Content className="min-h-11 items-center">
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>暫時忽略星期限制</Label>
                </Switch.Content>
              </Switch>
            </div>

            <div className="filter-control">
              <ControlHeading summary={value.creditFilters.length ? `只顯示 ${creditSummary}` : "不限學分"} title="學分數" />
              <ToggleButtonGroup
                aria-label="學分數"
                className="filter-chips"
                isDetached
                selectedKeys={[...value.creditFilters.filter((credits) => !highCreditOptions.includes(credits)).map(String), ...(highCreditSelected ? ["high"] : [])]}
                selectionMode="multiple"
                onSelectionChange={(keys) => {
                  const wantsHigh = keys.has("high");
                  const picked = keysToNumbers(keys);
                  patch({ creditFilters: wantsHigh ? toggleHighCreditFilter(picked, highCreditOptions) : picked });
                }}
              >
                {individualCreditOptions.map((credits) => (
                  <ToggleButton className="min-h-11" id={String(credits)} key={credits}>
                    {credits} 學分
                  </ToggleButton>
                ))}
                {highCreditOptions.length > 0 && (
                  <ToggleButton className="min-h-11" id="high">
                    4 學分以上
                  </ToggleButton>
                )}
              </ToggleButtonGroup>
              <Description>不選就是不限學分。</Description>
            </div>

            <div className="filter-control">
              <ControlHeading
                summary={value.includeScheduleInfo ? `已納入「${activePlanName ?? "目前課表"}」` : "不檢查目前課表"}
                title="課表衝堂"
              />
              <Switch
                className="filter-switch"
                isSelected={value.includeScheduleInfo}
                onChange={(selected) => patch({ includeScheduleInfo: selected })}
                size="sm"
              >
                <Switch.Content className="min-h-11 items-center">
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>納入完整課表檢查衝堂</Label>
                </Switch.Content>
              </Switch>
            </div>
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item id="eligibility">
        <Accordion.Heading>
          <GroupTrigger
            summary={eligibilityCount ? `已套用 ${eligibilityCount} 項` : "不限修課資格"}
            title="修課資格"
          />
        </Accordion.Heading>
        <Accordion.Panel>
          <Accordion.Body className="filter-group-body">
            <div className="filter-control">
              <RadioGroup
                className="filter-radio-group"
                value={value.prerequisiteFilter}
                variant="secondary"
                onChange={(next) => patch({ prerequisiteFilter: next as PrerequisiteFilter })}
              >
                <Label>先修條件</Label>
                <Description>根據你的已修課程判斷。</Description>
                {prerequisiteChoices.map(([choice, label]) => (
                  <Radio key={choice} value={choice}>
                    <Radio.Content className="min-h-11">
                      <Radio.Control>
                        <Radio.Indicator />
                      </Radio.Control>
                      {label}
                    </Radio.Content>
                  </Radio>
                ))}
              </RadioGroup>
              {!flattenAdvanced && (
                <AdvancedDisclosure summary={value.includeUnknownPrerequisite ? "已包含資料不明課程" : "不含資料不明課程"}>
                  {unknownPrerequisiteSwitch}
                </AdvancedDisclosure>
              )}
            </div>

            <div className="filter-control">
              <RadioGroup
                className="filter-radio-group"
                value={value.courseLevelFilter}
                variant="secondary"
                onChange={(next) => patch({ courseLevelFilter: next as CourseLevelFilter })}
              >
                <Label>課程程度</Label>
                <Description>只依課名中的明確字樣保守判定。</Description>
                {courseLevelChoices.map(([choice, label]) => (
                  <Radio key={choice} value={choice}>
                    <Radio.Content className="min-h-11">
                      <Radio.Control>
                        <Radio.Indicator />
                      </Radio.Control>
                      {label}
                    </Radio.Content>
                  </Radio>
                ))}
              </RadioGroup>
              {!flattenAdvanced && value.courseLevelFilter !== "all" && (
                <AdvancedDisclosure summary={value.includeUnknownCourseLevel ? "已顯示程度不明課程" : "不顯示程度不明課程"}>
                  {unknownCourseLevelSwitch}
                </AdvancedDisclosure>
              )}
            </div>

            {flattenAdvanced && (
              <AdvancedDisclosure summary={`${value.includeUnknownPrerequisite || value.includeUnknownCourseLevel ? "已包含" : "不含"}資料不明的課程`}>
                {unknownPrerequisiteSwitch}
                {value.courseLevelFilter !== "all" && unknownCourseLevelSwitch}
              </AdvancedDisclosure>
            )}
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>

      <Accordion.Item id="preferences">
        <Accordion.Heading>
          <GroupTrigger
            summary={preferenceCount ? `已選 ${preferenceCount} 個分類／標籤` : "不限類別與官方標籤"}
            title="課程偏好"
          />
        </Accordion.Heading>
        <Accordion.Panel>
          <Accordion.Body className="filter-group-body">
            <div className="filter-control">
              <ControlHeading
                summary={value.categoryFilters.length ? `先保留已選的 ${value.categoryFilters.length} 類` : "全部課程"}
                title="課程類別"
              />
              <ToggleButtonGroup
                aria-label="課程類別"
                className="filter-chips"
                isDetached
                selectedKeys={value.categoryFilters}
                selectionMode="multiple"
                onSelectionChange={(keys) => patch({ categoryFilters: keysToStrings(keys) as RecommendationCategoryFilters })}
              >
                {Object.entries(recommendationCategoryLabels).map(([category, label]) => (
                  <ToggleButton className="min-h-11" id={category as RecommendationCategory} key={category}>
                    {label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <Description>不選就是全部課程。</Description>
            </div>

            <div className="filter-control">
              <ControlHeading
                summary={value.courseTagFilters.length ? "保留符合任一已選標籤的課程" : "不限官方標籤"}
                title="官方課程標籤"
              />
              <ToggleButtonGroup
                aria-label="官方課程標籤"
                className="filter-chips"
                isDetached
                selectedKeys={value.courseTagFilters}
                selectionMode="multiple"
                onSelectionChange={(keys) => patch({ courseTagFilters: keysToStrings(keys) })}
              >
                {courseTagOptions.map((tag) => (
                  <ToggleButton className="min-h-11" id={tag.code} key={tag.code}>
                    {tag.label_zh}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </div>
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

/**
 * The old `<details class="filter-advanced">` nested inside a `<details
 * class="filter-group">`. `Disclosure` gives the same affordance with a real
 * button, a focus ring and `aria-expanded` — which the bare `<summary>` inside
 * an already-collapsed `<summary>` never announced reliably.
 */
function AdvancedDisclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <Disclosure className="filter-advanced-disclosure">
      <Disclosure.Heading>
        <Disclosure.Trigger className="filter-advanced-trigger">
          進階設定
          <small>{summary}</small>
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="filter-advanced-body">{children}</Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
