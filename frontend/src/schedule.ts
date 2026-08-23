import type { Course, FixedScheduleEntry, Meeting } from "./types";

export const SCHEDULE_SECTIONS = [
  "D0", "D1", "D2", "D3", "D4", "DN", "D5", "D6", "D7", "D8",
  "E0", "E1", "E2", "E3", "E4",
] as const;

export const CORE_SCHEDULE_SECTIONS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"] as const;
export const EXTENDED_SCHEDULE_SECTIONS = ["D0", "DN", "E0", "E1", "E2", "E3", "E4"] as const;

const SECTION_INDEX = new Map<string, number>(SCHEDULE_SECTIONS.map((section, index) => [section, index]));
const SECTION_NUMBER_PATTERN = /^([A-Z]+)(\d+)$/;

/** Sections a student may type by hand, e.g. "D5,D6" or "DN". */
const MANUAL_SECTION_PATTERN = /^(?:D(?:N|[0-8])|E[0-4])$/;
const MANUAL_SECTION_SEPARATOR = /[,\s、，；;]+/;

/** Weekday labels indexed by `weekday - 1`, matching the 1..7 weekday numbering used by `Meeting`. */
export const weekdayLabels = ["一", "二", "三", "四", "五", "六", "日"];

export type ScheduleBlockSource = "course" | "fixed";

export interface ScheduleBlock {
  id: string;
  source: ScheduleBlockSource;
  sourceId: string;
  name: string;
  teacher: string;
  weekday: number;
  sections: string[];
  startSection: string;
  endSection: string;
  room: string | null;
  weekPattern: string | null;
  meetingIndex: number;
  lane: number;
  laneCount: number;
  conflict: boolean;
}

function normalizeSection(section: string): string {
  return section.trim().toUpperCase();
}

function sectionSortKey(section: string): { prefix: string; order: number } {
  const normalized = normalizeSection(section);
  const canonicalIndex = SECTION_INDEX.get(normalized);
  if (canonicalIndex !== undefined) return { prefix: "", order: canonicalIndex };

  const match = SECTION_NUMBER_PATTERN.exec(normalized);
  if (match) return { prefix: match[1], order: Number(match[2]) };
  return { prefix: normalized, order: Number.POSITIVE_INFINITY };
}

export function compareSections(left: string, right: string): number {
  const leftKey = sectionSortKey(left);
  const rightKey = sectionSortKey(right);
  return leftKey.prefix.localeCompare(rightKey.prefix) || leftKey.order - rightKey.order || left.localeCompare(right, "zh-Hant");
}

export function sortSections(sections: string[]): string[] {
  return [...sections].sort(compareSections);
}

export function isCanonicalSection(section: string): boolean {
  return SECTION_INDEX.has(normalizeSection(section));
}

export function isScheduledMeeting(meeting: Meeting): boolean {
  return Boolean(
    meeting.weekday
    && meeting.weekday >= 1
    && meeting.weekday <= 7
    && meeting.sections.some(isCanonicalSection),
  );
}

export function hasUnscheduledMeeting(item: { meetings: Meeting[] }): boolean {
  return item.meetings.length === 0 || item.meetings.some((meeting) => !isScheduledMeeting(meeting));
}

function splitContiguousSections(sections: string[]): string[][] {
  const canonical = [...new Set(sections.map(normalizeSection).filter(isCanonicalSection))]
    .sort((left, right) => (SECTION_INDEX.get(left) ?? 0) - (SECTION_INDEX.get(right) ?? 0));
  const groups: string[][] = [];
  for (const section of canonical) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (!current || previous === undefined || (SECTION_INDEX.get(section) ?? 0) !== (SECTION_INDEX.get(previous) ?? 0) + 1) {
      groups.push([section]);
    } else {
      current.push(section);
    }
  }
  return groups;
}

function patternsOverlap(left: string | null, right: string | null): boolean {
  const patternLeft = left?.toUpperCase();
  const patternRight = right?.toUpperCase();
  if (!patternLeft || !patternRight) return true;
  return patternLeft === "A" || patternRight === "A" || patternLeft === patternRight;
}

function blocksOverlap(left: ScheduleBlock, right: ScheduleBlock): boolean {
  if (left.weekday !== right.weekday || !patternsOverlap(left.weekPattern, right.weekPattern)) return false;
  const leftStart = SECTION_INDEX.get(left.startSection) ?? -1;
  const leftEnd = SECTION_INDEX.get(left.endSection) ?? -1;
  const rightStart = SECTION_INDEX.get(right.startSection) ?? -1;
  const rightEnd = SECTION_INDEX.get(right.endSection) ?? -1;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function mergeAdjacentBlocks(blocks: ScheduleBlock[]): ScheduleBlock[] {
  const ordered = [...blocks].sort((left, right) => (
    left.source.localeCompare(right.source)
    || left.sourceId.localeCompare(right.sourceId)
    || left.weekday - right.weekday
    || (left.room ?? "").localeCompare(right.room ?? "")
    || (left.weekPattern ?? "").localeCompare(right.weekPattern ?? "")
    || (SECTION_INDEX.get(left.startSection) ?? 0) - (SECTION_INDEX.get(right.startSection) ?? 0)
  ));
  const merged: ScheduleBlock[] = [];
  for (const block of ordered) {
    const previous = merged.at(-1);
    const adjacent = previous
      && previous.source === block.source
      && previous.sourceId === block.sourceId
      && previous.weekday === block.weekday
      && previous.room === block.room
      && previous.weekPattern === block.weekPattern
      && (SECTION_INDEX.get(block.startSection) ?? 0) === (SECTION_INDEX.get(previous.endSection) ?? 0) + 1;
    if (adjacent) {
      previous.sections.push(...block.sections);
      previous.endSection = block.endSection;
      previous.id = `${previous.id}+${block.id}`;
    } else {
      merged.push({ ...block, sections: [...block.sections] });
    }
  }
  return merged;
}

function assignLanes(blocks: ScheduleBlock[]): ScheduleBlock[] {
  const byWeekday = new Map<number, ScheduleBlock[]>();
  for (const block of blocks) {
    const dayBlocks = byWeekday.get(block.weekday) ?? [];
    dayBlocks.push(block);
    byWeekday.set(block.weekday, dayBlocks);
  }

  for (const dayBlocks of byWeekday.values()) {
    dayBlocks.sort((left, right) => (
      (SECTION_INDEX.get(left.startSection) ?? 0) - (SECTION_INDEX.get(right.startSection) ?? 0)
      || (SECTION_INDEX.get(right.endSection) ?? 0) - (SECTION_INDEX.get(left.endSection) ?? 0)
      || left.id.localeCompare(right.id)
    ));
    const lanes: ScheduleBlock[][] = [];
    for (const block of dayBlocks) {
      const lane = lanes.findIndex((laneBlocks) => laneBlocks.every((placed) => !blocksOverlap(block, placed)));
      block.lane = lane === -1 ? lanes.length : lane;
      if (!lanes[block.lane]) lanes[block.lane] = [];
      lanes[block.lane].push(block);
    }
    for (const block of dayBlocks) {
      const overlapping = dayBlocks.filter((candidate) => blocksOverlap(block, candidate));
      block.laneCount = Math.max(1, ...overlapping.map((candidate) => candidate.lane + 1));
      block.conflict = overlapping.some((candidate) => candidate.id !== block.id && candidate.sourceId !== block.sourceId);
    }
  }
  return blocks;
}

export function buildScheduleBlocks(courses: Course[], fixedEntries: FixedScheduleEntry[]): ScheduleBlock[] {
  const blocks: ScheduleBlock[] = [];
  const addMeeting = (
    source: ScheduleBlockSource,
    sourceId: string,
    name: string,
    teacher: string,
    meeting: Meeting,
    meetingIndex: number,
  ) => {
    if (!meeting.weekday || meeting.weekday < 1 || meeting.weekday > 7) return;
    for (const [groupIndex, sections] of splitContiguousSections(meeting.sections).entries()) {
      blocks.push({
        id: `${source}-${sourceId}-${meetingIndex}-${groupIndex}`,
        source,
        sourceId,
        name,
        teacher,
        weekday: meeting.weekday,
        sections,
        startSection: sections[0],
        endSection: sections.at(-1) ?? sections[0],
        room: meeting.room,
        weekPattern: meeting.week_pattern,
        meetingIndex,
        lane: 0,
        laneCount: 1,
        conflict: false,
      });
    }
  };

  for (const course of courses) {
    course.meetings.forEach((meeting, meetingIndex) => addMeeting(
      "course",
      course.course_id,
      course.name_zh,
      course.teacher || "教師未定",
      meeting,
      meetingIndex,
    ));
  }
  for (const entry of fixedEntries) {
    entry.meetings.forEach((meeting, meetingIndex) => addMeeting(
      "fixed",
      entry.id,
      entry.name,
      entry.teacher ?? "固定時段",
      meeting,
      meetingIndex,
    ));
  }
  return assignLanes(mergeAdjacentBlocks(blocks));
}

/** Human label for the alternating-week marker; empty when the course runs every week or is unknown. */
export function weekPatternLabel(pattern: string | null): string {
  if (pattern?.toUpperCase() === "S") return "單週";
  if (pattern?.toUpperCase() === "D") return "雙週";
  return "";
}

/** One-line summary of every meeting time, used in lists, dialogs and option labels. */
export function formatMeetings(item: { meetings: Meeting[] }): string {
  if (!item.meetings.length) return "時間未定";
  return item.meetings.map((meeting) => {
    const day = meeting.weekday && meeting.weekday >= 1 && meeting.weekday <= 7
      ? `星期${weekdayLabels[meeting.weekday - 1]}` : "星期未定";
    const sections = meeting.sections.length ? meeting.sections.join("、") : "節次未定";
    const details = [meeting.room, weekPatternLabel(meeting.week_pattern)].filter(Boolean).join(" · ");
    return `${day} ${sections}${details ? ` ${details}` : ""}`;
  }).join("；");
}

/** Parse a hand typed section list into unique canonical sections, dropping anything unrecognised. */
export function parseManualSections(value: string): string[] {
  return [...new Set(
    value
      .toUpperCase()
      .split(MANUAL_SECTION_SEPARATOR)
      .map((section) => section.trim())
      .filter((section) => MANUAL_SECTION_PATTERN.test(section)),
  )];
}

/** Placeholder block for a course with no usable meeting time, so it can reuse the block detail dialog. */
export function unplacedBlock(course: Course): ScheduleBlock {
  return { id: `unplaced-${course.course_id}`, source: "course", sourceId: course.course_id, name: course.name_zh, teacher: course.teacher || "教師未定", weekday: 1, sections: [], startSection: "D1", endSection: "D1", room: null, weekPattern: null, meetingIndex: 0, lane: 0, laneCount: 1, conflict: false };
}

export function sectionGridSpan(block: ScheduleBlock, visibleSections: readonly string[]): { start: number; span: number } | null {
  const included = block.sections.filter((section) => visibleSections.includes(section));
  if (!included.length) return null;
  const start = visibleSections.indexOf(included[0]);
  const end = visibleSections.indexOf(included.at(-1) ?? included[0]);
  if (start === -1 || end === -1) return null;
  return { start, span: end - start + 1 };
}
