import { useEffect, useState } from "react";
import { Heart } from "@phosphor-icons/react";
import { useFetchCoursesByIds } from "@/data/queries";
import { deleteRecord, putRecord } from "@/data/db";
import {
  courseConflicts,
  eligibilityStatusLabels,
  evaluateEligibility,
  formatCourseStudyLevelLabel,
  getEligibilityRules,
  inferAudienceDepartment,
  meetingsConflict,
} from "@/domain/eligibility";
import { classifyRecommendationCategory, recommendationCategoryLabels } from "@/domain/recommendation";
import { formatMeetings } from "@/domain/schedule";
import { useLocalRecords, useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { ConfirmDialog, useFeedback } from "@/components/ui";
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
  const eligibilityCautions = eligibility.blocked.some((rule) => rule.kind === "course_prerequisite")
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
  return (
    <article className="course-card">
      <div className="course-top">{rank && <span className="rank">#{rank}</span>}{selectedRecommendationCategory && <span className={"category-tag " + selectedRecommendationCategory}>{recommendationCategoryLabels[selectedRecommendationCategory]}</span>}<span className={"status " + eligibility.status}>{eligibility.blocked.some((rule) => rule.kind === "course_prerequisite") ? "有擋修條件" : eligibilityStatusLabels[eligibility.status]}</span><button type="button" className={"heart icon-button " + (favorite ? "active" : "")} onClick={() => void toggleFavorite()} disabled={pending === "favorite"} aria-busy={pending === "favorite"} aria-pressed={favorite} aria-label={favorite ? "取消收藏課程" : "收藏課程"}><Heart weight={favorite ? "fill" : "regular"} aria-hidden="true" /></button></div>
      <h2>{selectedCourse.name_zh}</h2><p className="muted">{selectedCourse.name_en}</p>
      <div className="meta"><span className="study-level-badge">{formatCourseStudyLevelLabel(selectedCourse)}</span><span>{selectedCourse.official_department_label ?? selectedCourse.department_display ?? inferAudienceDepartment(selectedCourse)}</span><span>{selectedCourse.teacher || "教師未定"}</span><span>{selectedCourse.credits} 學分</span><span>{selectedCourse.required_elective_name}</span></div>{selectedCourse.course_tags?.length ? <div className="official-course-tags" aria-label="官方課程標籤">{selectedCourse.course_tags.map((tag) => <span key={tag.code}>{tag.label_zh}</span>)}</div> : null}
      <p className="meeting">{formatMeetings(selectedCourse)}</p>
      {variants.length > 1 && <details className="course-variants"><summary>可選的班別／共同開課項目（{variants.length} 個）</summary><div className="variant-list">{variants.map((variant) => { const variantEligibility = evaluateEligibility(variant, profile, completedNames); return <button type="button" className={variant.course_id === selectedCourse.course_id ? "active" : ""} aria-pressed={variant.course_id === selectedCourse.course_id} onClick={() => setSelectedCourseId(variant.course_id)} key={variant.course_id}><strong>{variant.official_department_label ?? variant.department_display ?? inferAudienceDepartment(variant)}</strong><span>{variant.teacher || "教師未定"} · {formatMeetings(variant)}</span><small>{variantEligibility.blocked.some((rule) => rule.kind === "course_prerequisite") ? "有擋修條件" : eligibilityStatusLabels[variantEligibility.status]}</small></button>; })}</div></details>}
      {reasons?.length ? <div className="recommendation-reasons"><strong>為什麼推薦這堂？</strong><ul className="reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div> : null}
      {matchedFields?.length ? <p className="matched-fields">參考課綱：{matchedFields.map((field) => assistantFieldLabels[field] ?? field).join("、")}</p> : null}
      {courseCautions.length ? <div className="cautions" role="note"><strong>修課前請確認</strong><ul>{courseCautions.map((caution) => <li key={caution}>{caution}</li>)}</ul></div> : null}
      <details><summary>查看課綱與判斷依據</summary><div className="details"><h3>課程目標</h3><p>{selectedCourse.sections.objective || "未提供"}</p>{selectedCourse.prerequisite && <><h3>先備知識</h3><p>{selectedCourse.prerequisite}</p></>}{getEligibilityRules(selectedCourse).map((rule, index) => <div className="evidence" key={rule.kind + "-" + index}><strong>{rule.message}</strong><q>{rule.evidence}</q></div>)}<a href={selectedCourse.source_url} target="_blank" rel="noreferrer">開啟官方課綱</a></div></details>
      <div className="card-actions"><button type="button" onClick={() => void addSchedule()} disabled={scheduled || pending === "schedule"} aria-busy={pending === "schedule"}>{scheduled ? "已加入課表" : pending === "schedule" ? "加入中…" : "加入 " + (activePlan?.name ?? "我的課表")}</button><button type="button" onClick={() => void toggleCompleted()} disabled={pending === "completed"} aria-busy={pending === "completed"}>{pending === "completed" ? "更新中…" : isCompleted ? "取消已修" : "標記已修"}</button><button type="button" className="quiet" onClick={() => void dismiss()} disabled={pending === "dismiss"} aria-busy={pending === "dismiss"}>{pending === "dismiss" ? "處理中…" : "不感興趣"}</button></div>
      <ConfirmDialog open={Boolean(conflictRequest)} title="確認加入課表" description={<p>{conflictRequest?.message}</p>} confirmLabel="仍要加入" onCancel={() => setConflictRequest(undefined)} onConfirm={() => conflictRequest && commitSchedule(conflictRequest.plan)} busy={pending === "schedule"} />
    </article>
  );
}
