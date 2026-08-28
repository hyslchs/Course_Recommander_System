import { useState } from "react";
import { CalendarCheck, CalendarPlus, Heart } from "@phosphor-icons/react";
import { Button, ToggleButton, Tooltip } from "@heroui/react";
import { useFetchCoursesByIds } from "@/data/queries";
import { deleteRecord, putRecord } from "@/data/db";
import { track } from "@/analytics/client";
import { courseConflicts, meetingsConflict } from "@/domain/eligibility";
import { useLocalDataState, useLocalRecords } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { ConfirmDialog, useFeedback } from "@/components/ui";
import type { Course, SchedulePlan } from "@/domain/types";

/**
 * The 操作 cell of a table row: add-to-schedule and favourite, the two actions a
 * `CourseCard` exposes that are *about the course itself* rather than about a
 * recommendation.
 *
 * Why only two of the card's four. 標記已修 and 不感興趣 are both judgements a
 * student makes after reading a course, and the table shows no syllabus, no
 * reasons and no cautions — offering them here would be asking for a verdict on
 * evidence the row does not carry. 不感興趣 additionally only means anything on
 * the recommendation feed, which this page is not. The 課名 link still reaches
 * the syllabus, and dropping below `lg` still reaches the full card.
 *
 * ⚠️ DRIFT RISK, stated rather than hidden: every line of state below is a
 * transcription of `components/CourseCard/CourseCard.tsx` (`toggleFavorite`,
 * `addSchedule`, `commitSchedule`). The right shape is one `useCourseActions`
 * hook imported by both, but this task is confined to `pages/explore/**` and
 * `CourseCard.tsx` is owned by a sibling change. The *domain* layer is genuinely
 * shared — `courseConflicts`, `meetingsConflict`, `putRecord`, `deleteRecord`,
 * `useSchedulePlans`, `useFetchCoursesByIds` are the same modules the card calls,
 * so the conflict rules and the storage shape cannot diverge. What can diverge is
 * the orchestration. Extracting the hook is the follow-up.
 */
export function CourseRowActions({ course }: { course: Course }) {
  const favorites = useLocalRecords<{ id: string }>("favorites");
  const { writable } = useLocalDataState();
  const { activePlan, selectPlan } = useSchedulePlans();
  const fetchCoursesByIds = useFetchCoursesByIds();
  const { notify } = useFeedback();
  const [pending, setPending] = useState<"favorite" | "schedule" | "">("");
  const [conflictRequest, setConflictRequest] = useState<{ plan: SchedulePlan; message: string }>();

  const favorite = favorites.some((item) => item.id === course.course_id);
  const scheduled = Boolean(activePlan?.entries.some((item) => item.courseId === course.course_id));

  const toggleFavorite = async () => {
    if (pending || !writable) return;
    setPending("favorite");
    track("feature_clicked", { feature: "toggle_favorite" });
    try {
      if (favorite) await deleteRecord("favorites", course.course_id);
      else await putRecord("favorites", { id: course.course_id, addedAt: new Date().toISOString() });
    } catch (error) { notify("收藏操作失敗：" + (error as Error).message, "error"); }
    finally { setPending(""); }
  };

  const commitSchedule = async (plan: SchedulePlan) => {
    if (!writable) return;
    setPending("schedule");
    try {
      await putRecord("schedulePlans", {
        ...plan,
        entries: [...plan.entries, { courseId: course.course_id, locked: false }],
        updatedAt: new Date().toISOString(),
      });
      if (!activePlan) await selectPlan(plan.id);
      // No interaction id: 探索課程 is a catalogue browse, not a recommendation
      // run, so this add is a course-level fact and nothing more.
      track("course_added", { course_id: course.course_id, source: "search" });
      notify("已加入「" + plan.name + "」");
    } catch (error) {
      track("error", { component: "schedule", error_code: "SCHEDULE_WRITE_FAILED" });
      notify("加入課表失敗：" + (error as Error).message, "error");
    }
    finally { setPending(""); setConflictRequest(undefined); }
  };

  const addSchedule = async () => {
    if (pending || scheduled || !writable) return;
    let plan = activePlan;
    if (!plan) plan = { id: crypto.randomUUID(), name: "我的課表", entries: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    let scheduledCourses: Course[];
    try {
      scheduledCourses = await fetchCoursesByIds(plan.entries.map((entry) => entry.courseId));
    } catch (error) {
      notify("無法檢查目前課表：" + (error as Error).message, "error");
      return;
    }
    const courseConflict = courseConflicts(course, scheduledCourses);
    const fixedConflict = meetingsConflict(course.meetings, (plan.fixedEntries ?? []).flatMap((entry) => entry.meetings));
    if (courseConflict.conflict || fixedConflict.conflict) {
      track("schedule_conflict", { conflict_count: 1, action: "course_added" });
      setConflictRequest({ plan, message: "這門課與目前課表衝堂。仍要加入嗎？" }); return;
    }
    if (courseConflict.uncertain || fixedConflict.uncertain) {
      track("schedule_conflict", { conflict_count: 1, action: "course_added" });
      setConflictRequest({ plan, message: "週次資料不完整，可能衝堂。仍要加入嗎？" }); return;
    }
    await commitSchedule(plan);
  };

  /*
    Both controls are icon-only, so the accessible name lives in `aria-label` and
    the `Tooltip` is the sighted-pointer mirror of that same string — never a
    substitute for it. Same delays as the card, passed explicitly because
    `--tooltip-delay` resolves to "" under jsdom.

    Every label names the *course*, not just the verb. A screen-reader user
    tabbing the 操作 column would otherwise hear 「收藏課程」 twenty-five times
    with nothing to tell the rows apart; React Aria announces the row when focus
    enters it, but not again as focus moves between cells of that row.
  */
  const favoriteLabel = (favorite ? "取消收藏" : "收藏") + course.name_zh;
  const scheduleLabel = scheduled ? "已加入課表：" + course.name_zh : "將" + course.name_zh + "加入" + (activePlan?.name ?? "我的課表");

  return (
    /*
      36px, not the 44px the cards use. WCAG 2.5.5 (AAA, 44px) applies to touch;
      the binding criterion for a control that only ever renders at `lg` — a
      pointer context — is 2.5.8 Target Size (Minimum), which is 24px. The same
      reasoning already governs the 課名 link two cells to the left. 36 clears
      that with room while keeping a row the height of its text, and `gap-2` is
      the 8px separation adjacent targets need.
    */
    <div className="flex items-center gap-2">
      <Tooltip closeDelay={300} delay={700}>
        <Button
          aria-label={scheduleLabel}
          className="min-h-9 min-w-9"
          isDisabled={scheduled || !writable}
          isIconOnly
          isPending={pending === "schedule"}
          size="sm"
          variant="secondary"
          onPress={() => void addSchedule()}
        >
          {scheduled ? <CalendarCheck aria-hidden="true" weight="fill" /> : <CalendarPlus aria-hidden="true" />}
        </Button>
        <Tooltip.Content>{scheduleLabel}</Tooltip.Content>
      </Tooltip>
      <Tooltip closeDelay={300} delay={700}>
        <ToggleButton
          aria-label={favoriteLabel}
          className="min-h-9 min-w-9"
          isDisabled={!writable}
          isIconOnly
          isSelected={favorite}
          size="sm"
          variant="ghost"
          onChange={() => void toggleFavorite()}
        >
          <Heart aria-hidden="true" weight={favorite ? "fill" : "regular"} />
        </ToggleButton>
        <Tooltip.Content>{favoriteLabel}</Tooltip.Content>
      </Tooltip>
      <ConfirmDialog
        busy={pending === "schedule"}
        confirmLabel="仍要加入"
        description={<p>{conflictRequest?.message}</p>}
        onCancel={() => { track("schedule_conflict_action", { action: "cancel_add" }); setConflictRequest(undefined); }}
        onConfirm={() => {
          track("schedule_conflict_action", { action: "keep_conflict" });
          if (conflictRequest) void commitSchedule(conflictRequest.plan);
        }}
        open={Boolean(conflictRequest)}
        title="確認加入課表"
      />
    </div>
  );
}
