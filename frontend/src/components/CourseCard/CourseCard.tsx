import { useEffect, useState } from "react";
import { Heart } from "@phosphor-icons/react";
import { Alert, Button, Card, Chip, Disclosure, Radio, RadioGroup, ToggleButton, Tooltip } from "@heroui/react";
import { useFetchCoursesByIds } from "@/data/queries";
import { deleteRecord, putRecord } from "@/data/db";
import {
  courseConflicts,
  evaluateEligibility,
  formatCourseStudyLevelLabel,
  getEligibilityRules,
  inferAudienceDepartment,
  meetingsConflict,
} from "@/domain/eligibility";
import { classifyRecommendationCategory } from "@/domain/recommendation";
import { formatMeetings } from "@/domain/schedule";
import { useLocalRecords, useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { ConfirmDialog, useFeedback } from "@/components/ui";
import { CategoryChip, EligibilityChip } from "./statusPresentation";
import type { CompletedCourse, Course, Recommendation, SchedulePlan } from "@/domain/types";

/** Syllabus field names the assistant may cite, as shown on a recommendation card. */
const assistantFieldLabels: Record<string, string> = {
  title: "課名／課號",
  skills: "技能與學習成果",
  objective: "課程目標",
  weekly_progress: "每週進度",
  prerequisite: "先修／加選備註",
  materials: "教材",
  history: "最近對話課程",
};

/**
 * A blocking prerequisite is a *reason* for `blocked_confirmed`, not a fifth
 * status, so it only replaces the wording — `EligibilityChip` still draws the
 * Prohibit glyph and the danger colour from the status itself.
 */
const PREREQUISITE_LABEL = "有擋修條件";

export function CourseCard({ course, alternatives, rank, reasons, cautions, matchedFields, recommendationCategory }: { course: Course; alternatives?: Course[]; rank?: number; reasons?: string[]; cautions?: string[]; matchedFields?: string[]; recommendationCategory?: Recommendation["category"] }) {
  // Context, not props: 25 cards used to mean 25 IndexedDB reads of each store
  // and a three-level `profile` prop drill (plan §6.3-1 and §6.3-2).
  const completed = useLocalRecords<CompletedCourse & { id: string }>("completedCourses");
  const favorites = useLocalRecords<{ id: string }>("favorites");
  const profile = useProfile();
  const { activePlan, selectPlan } = useSchedulePlans();
  const fetchCoursesByIds = useFetchCoursesByIds();
  const { notify } = useFeedback();
  const [pending, setPending] = useState<"favorite" | "completed" | "schedule" | "dismiss" | "">("");
  const [conflictRequest, setConflictRequest] = useState<{ plan: SchedulePlan; message: string }>();
  const variants = [course, ...(alternatives ?? [])].filter((item, index, values) => values.findIndex((candidate) => candidate.course_id === item.course_id) === index);
  const [selectedCourseId, setSelectedCourseId] = useState(course.course_id);
  useEffect(() => setSelectedCourseId(course.course_id), [course.course_id]);
  const selectedCourse = variants.find((item) => item.course_id === selectedCourseId) ?? course;
  const selectedRecommendationCategory = recommendationCategory ? classifyRecommendationCategory(selectedCourse, profile) : undefined;
  const completedNames = new Set(completed.map((item) => item.courseName));
  const eligibility = evaluateEligibility(selectedCourse, profile, completedNames);
  const hasPrerequisiteBlock = eligibility.blocked.some((rule) => rule.kind === "course_prerequisite");
  const eligibilityCautions = hasPrerequisiteBlock
    ? ["本課程設有先修條件，請確認你是否已修畢。"]
    : eligibility.status === "blocked_confirmed"
      ? ["目前可能不符合修課資格，請展開查看規定。"]
      : eligibility.status === "needs_confirmation"
        ? ["修課資格尚未能確認，建議先查看課綱或選課系統。"]
        : [];
  const courseCautions = [...new Set([...eligibilityCautions, ...(cautions ?? [])])];
  const favorite = favorites.some((item) => item.id === selectedCourse.course_id);
  const isCompleted = completed.some((item) => item.id === selectedCourse.course_id);
  const scheduled = Boolean(activePlan?.entries.some((item) => item.courseId === selectedCourse.course_id));

  const toggleFavorite = async () => {
    if (pending) return;
    setPending("favorite");
    try {
      if (favorite) await deleteRecord("favorites", selectedCourse.course_id);
      else await putRecord("favorites", { id: selectedCourse.course_id, addedAt: new Date().toISOString() });
    } catch (error) { notify("收藏操作失敗：" + (error as Error).message, "error"); }
    finally { setPending(""); }
  };
  const toggleCompleted = async () => {
    if (pending) return;
    setPending("completed");
    try {
      if (isCompleted) await deleteRecord("completedCourses", selectedCourse.course_id);
      else await putRecord("completedCourses", { id: selectedCourse.course_id, courseId: selectedCourse.course_id, courseName: selectedCourse.name_zh, continueLearning: false, addedAt: new Date().toISOString() });
    } catch (error) { notify("更新已修狀態失敗：" + (error as Error).message, "error"); }
    finally { setPending(""); }
  };
  const dismiss = async () => {
    if (pending) return;
    setPending("dismiss");
    const id = selectedCourse.course_id;
    try {
      const addedAt = new Date().toISOString();
      await putRecord("dismissedCourses", { id, addedAt });
      notify("已從推薦中排除此課程", "success", { label: "復原", onAction: () => deleteRecord("dismissedCourses", id) });
    } catch (error) { notify("無法更新推薦偏好：" + (error as Error).message, "error"); }
    finally { setPending(""); }
  };
  const commitSchedule = async (plan: SchedulePlan) => {
    setPending("schedule");
    try {
      await putRecord("schedulePlans", { ...plan, entries: [...plan.entries, { courseId: selectedCourse.course_id, locked: false }], updatedAt: new Date().toISOString() });
      if (!activePlan) await selectPlan(plan.id);
      notify("已加入「" + plan.name + "」");
    } catch (error) { notify("加入課表失敗：" + (error as Error).message, "error"); }
    finally { setPending(""); setConflictRequest(undefined); }
  };
  const addSchedule = async () => {
    if (pending || scheduled) return;
    let plan = activePlan;
    if (!plan) plan = { id: crypto.randomUUID(), name: "我的課表", entries: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    let scheduledCourses: Course[];
    try {
      scheduledCourses = await fetchCoursesByIds(plan.entries.map((entry) => entry.courseId));
    } catch (error) {
      notify("無法檢查目前課表：" + (error as Error).message, "error");
      return;
    }
    const courseConflict = courseConflicts(selectedCourse, scheduledCourses);
    const fixedConflict = meetingsConflict(selectedCourse.meetings, (plan.fixedEntries ?? []).flatMap((entry) => entry.meetings));
    if (courseConflict.conflict || fixedConflict.conflict) {
      setConflictRequest({ plan, message: "這門課與目前課表衝堂。仍要加入嗎？" }); return;
    }
    if (courseConflict.uncertain || fixedConflict.uncertain) {
      setConflictRequest({ plan, message: "週次資料不完整，可能衝堂。仍要加入嗎？" }); return;
    }
    await commitSchedule(plan);
  };
  const favoriteLabel = favorite ? "取消收藏課程" : "收藏課程";
  return (
    <Card className="course-card" render={(props) => <article {...props} />} variant="default">
      <Card.Header className="course-card-header">
        <div className="course-top">
          {rank && <span className="rank">#{rank}</span>}
          {selectedRecommendationCategory && <CategoryChip category={selectedRecommendationCategory} />}
          <EligibilityChip overrideLabel={hasPrerequisiteBlock ? PREREQUISITE_LABEL : undefined} status={eligibility.status} />
          {/* Icon-only control, so the name lives in `aria-label` and the Tooltip
              is the sighted-pointer mirror of it — not a substitute (§4.3). The
              delays are passed explicitly rather than read from
              `--tooltip-delay`, which resolves to "" under jsdom. */}
          <Tooltip closeDelay={300} delay={700}>
            <ToggleButton aria-label={favoriteLabel} className="heart min-h-11 min-w-11" isIconOnly isSelected={favorite} onChange={() => void toggleFavorite()} variant="ghost">
              <Heart aria-hidden="true" weight={favorite ? "fill" : "regular"} />
            </ToggleButton>
            <Tooltip.Content className="course-card-tooltip">{favoriteLabel}</Tooltip.Content>
          </Tooltip>
        </div>
        <Card.Title render={(props) => <h2 {...props} />}>{selectedCourse.name_zh}</Card.Title>
        <Card.Description>{selectedCourse.name_en}</Card.Description>
      </Card.Header>
      <Card.Content>
        <div className="meta">
          <span className="study-level-badge">{formatCourseStudyLevelLabel(selectedCourse)}</span>
          <span>{selectedCourse.official_department_label ?? selectedCourse.department_display ?? inferAudienceDepartment(selectedCourse)}</span>
          <span>{selectedCourse.teacher || "教師未定"}</span>
          <span>{selectedCourse.credits} 學分</span>
          <span>{selectedCourse.required_elective_name}</span>
        </div>
        {selectedCourse.course_tags?.length ? <div aria-label="官方課程標籤" className="official-course-tags">{selectedCourse.course_tags.map((tag) => <Chip key={tag.code} color="accent" variant="soft">{tag.label_zh}</Chip>)}</div> : null}
        <p className="meeting">{formatMeetings(selectedCourse)}</p>
        {variants.length > 1 && (
          <Disclosure className="course-variants">
            <Disclosure.Heading>
              <Disclosure.Trigger className="course-disclosure-trigger">
                可選的班別／共同開課項目（{variants.length} 個）
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              {/* Was five `aria-pressed` buttons — a set of toggles that were in
                  truth mutually exclusive, with no group semantics and no arrow-key
                  navigation. A radio group says "pick exactly one" in the a11y tree
                  and gets roving tabindex for free. */}
              <RadioGroup aria-label="選擇班別／共同開課項目" className="variant-list" onChange={setSelectedCourseId} value={selectedCourse.course_id} variant="secondary">
                {variants.map((variant) => {
                  const variantEligibility = evaluateEligibility(variant, profile, completedNames);
                  const variantPrerequisite = variantEligibility.blocked.some((rule) => rule.kind === "course_prerequisite");
                  return (
                    <Radio key={variant.course_id} value={variant.course_id}>
                      <Radio.Content>
                        <Radio.Control><Radio.Indicator /></Radio.Control>
                        <span className="variant-option">
                          <strong>{variant.official_department_label ?? variant.department_display ?? inferAudienceDepartment(variant)}</strong>
                          <span>{variant.teacher || "教師未定"} · {formatMeetings(variant)}</span>
                          <EligibilityChip overrideLabel={variantPrerequisite ? PREREQUISITE_LABEL : undefined} status={variantEligibility.status} />
                        </span>
                      </Radio.Content>
                    </Radio>
                  );
                })}
              </RadioGroup>
            </Disclosure.Content>
          </Disclosure>
        )}
        {reasons?.length ? <div className="recommendation-reasons"><strong>為什麼推薦這堂？</strong><ul className="reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div> : null}
        {matchedFields?.length ? <p className="matched-fields">參考課綱：{matchedFields.map((field) => assistantFieldLabels[field] ?? field).join("、")}</p> : null}
        {/* Was a `role="note"` div coloured amber. `Alert status="warning"` adds
            the indicator glyph, so the severity is not colour-only. `role="status"`
            keeps it polite: nothing here is an error the student caused. */}
        {courseCautions.length ? (
          <Alert className="cautions" role="status" status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>修課前請確認</Alert.Title>
              {/* Explicit type argument: `render` alone does not drive the
                  element generic, which defaults to "span" and then fights the
                  `<ul>` ref type. */}
              <Alert.Description<"ul"> render={(props) => <ul {...props} />}>{courseCautions.map((caution) => <li key={caution}>{caution}</li>)}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        <Disclosure className="course-details">
          <Disclosure.Heading>
            <Disclosure.Trigger className="course-disclosure-trigger">
              查看課綱與判斷依據
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <div className="details">
              {/* h4, not h3: `Disclosure.Heading` is itself the h3 under the card's h2. */}
              <h4>課程目標</h4>
              <p>{selectedCourse.sections.objective || "未提供"}</p>
              {selectedCourse.prerequisite && <><h4>先備知識</h4><p>{selectedCourse.prerequisite}</p></>}
              {getEligibilityRules(selectedCourse).map((rule, index) => <div className="evidence" key={rule.kind + "-" + index}><strong>{rule.message}</strong><q>{rule.evidence}</q></div>)}
              <a href={selectedCourse.source_url} rel="noreferrer" target="_blank">開啟官方課綱</a>
            </div>
          </Disclosure.Content>
        </Disclosure>
      </Card.Content>
      {/* `isPending` rather than `disabled`: React Aria keeps the button focusable
          and announces the state change, where `disabled` drops it out of the tab
          order mid-interaction. `min-h-11` restores the 44px touch target §5.3
          asks for — HeroUI's `md` button is 40px, and 36px from `md:` up. */}
      <Card.Footer className="card-actions">
        <Button className="min-h-11" isDisabled={scheduled} isPending={pending === "schedule"} onPress={() => void addSchedule()}>
          {scheduled ? "已加入課表" : pending === "schedule" ? "加入中…" : "加入 " + (activePlan?.name ?? "我的課表")}
        </Button>
        <Button className="min-h-11" isPending={pending === "completed"} onPress={() => void toggleCompleted()} variant="secondary">
          {pending === "completed" ? "更新中…" : isCompleted ? "取消已修" : "標記已修"}
        </Button>
        <Button className="quiet min-h-11" isPending={pending === "dismiss"} onPress={() => void dismiss()} variant="ghost">
          {pending === "dismiss" ? "處理中…" : "不感興趣"}
        </Button>
      </Card.Footer>
      <ConfirmDialog busy={pending === "schedule"} confirmLabel="仍要加入" description={<p>{conflictRequest?.message}</p>} onCancel={() => setConflictRequest(undefined)} onConfirm={() => conflictRequest && commitSchedule(conflictRequest.plan)} open={Boolean(conflictRequest)} title="確認加入課表" />
    </Card>
  );
}
