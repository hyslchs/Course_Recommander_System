import { evaluateEligibility, courseConflicts } from "./eligibility";
import { sameDepartment } from "./department";
import { buildSearchIndex, scoreLexically, type LexicalMatch, type SearchIndex } from "./search";
import type {
  CompletedCourse,
  Course,
  Profile,
  Recommendation,
  RecommendationCategory,
  RecommendationCategoryFilters,
} from "./types";

export const recommendationCategoryLabels: Record<RecommendationCategory, string> = {
  home_required: "本系必修",
  home_elective: "本系選修",
  general_education: "通識課程",
  external_department: "外系課程",
};

const RRF_K = 60;
const RETRIEVAL_LIMIT = 200;

export function classifyRecommendationCategory(course: Course, profile?: Profile): RecommendationCategory {
  const isSameDepartment = sameDepartment(course, profile);
  if (isSameDepartment && course.required_elective_name === "必修") return "home_required";
  if (isSameDepartment && course.required_elective_name !== "通識") return "home_elective";
  if (course.required_elective_name === "通識") return "general_education";
  return "external_department";
}

export function reciprocalRankFusion(
  denseRankedIds: string[],
  sparseRankedIds: string[],
  k = RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>();
  const addRanks = (rankedIds: string[]) => {
    rankedIds.forEach((courseId, index) => {
      scores.set(courseId, (scores.get(courseId) ?? 0) + 1 / (k + index + 1));
    });
  };
  addRanks(denseRankedIds);
  addRanks(sparseRankedIds);
  return scores;
}

const dot = (a: Float32Array, b: Float32Array): number => {
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result += a[index] * b[index];
  return result;
};

function vectorAt(vectors: Float32Array, row: number, dimension: number): Float32Array {
  return vectors.subarray(row * dimension, (row + 1) * dimension);
}

function fieldLabel(field: string): string {
  return {
    title: "課名",
    objective: "課程目標",
    weekly_progress: "每週進度",
    prerequisite: "先修條件",
    materials: "教材",
    skills: "技能標籤",
  }[field] ?? field;
}

function queryReasons(
  queryText: string,
  lexical: LexicalMatch,
  denseRank: number | undefined,
  sparseRank: number | undefined,
): string[] {
  const reasons = [
    denseRank !== undefined && sparseRank !== undefined
      ? "同時符合語意與關鍵字檢索"
      : sparseRank !== undefined
        ? "符合關鍵字檢索"
        : "符合語意檢索",
  ];
  if (lexical.exactTitle) reasons.push(`課名精確符合「${queryText}」`);
  else if (lexical.matchedTerms.length) reasons.push("課名包含查詢關鍵詞");
  const matchedFields = lexical.matchedFields
    .filter((field) => field !== "title")
    .map(fieldLabel)
    .slice(0, 2);
  if (matchedFields.length) reasons.push(`課程資料命中：${[...new Set(matchedFields)].join("、")}`);
  return reasons;
}

export function rankCourses(input: {
  catalog: Course[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
  query?: Float32Array;
  queryText?: string;
  searchIndex?: SearchIndex;
  profile?: Profile;
  categoryFilters?: RecommendationCategoryFilters;
  creditFilters?: number[];
  completed: CompletedCourse[];
  dismissedIds: string[];
  scheduledCourses?: Course[];
  lockedCourses?: Course[];
  preferredWeekdays?: number[];
  includeNonPreferredWeekdays?: boolean;
}): Recommendation[] {
  if (!input.query) return [];
  const queryText = input.queryText?.trim() ?? "";
  const rowById = new Map(input.courseIds.map((id, row) => [id, row]));
  const searchIndex = input.searchIndex ?? buildSearchIndex(input.catalog);
  const completedIds = new Set(input.completed.map((item) => item.courseId));
  const completedNames = new Set(input.completed.map((item) => item.courseName));
  const dismissed = new Set(input.dismissedIds);
  const categoryFilters = input.categoryFilters ?? [];
  const creditFilters = input.creditFilters ?? [];
  const preferredWeekdays = input.preferredWeekdays ?? input.profile?.preferredWeekdays ?? [];
  const scheduledCourses = input.scheduledCourses ?? input.lockedCourses ?? [];

  const candidates = input.catalog.flatMap((course, order) => {
    const row = rowById.get(course.course_id);
    if (row === undefined || completedIds.has(course.course_id) || dismissed.has(course.course_id)) return [];
    const eligibility = evaluateEligibility(course, input.profile, completedNames);
    if (eligibility.status === "blocked_confirmed") return [];
    if (courseConflicts(course, scheduledCourses).conflict) return [];
    if (!input.includeNonPreferredWeekdays && preferredWeekdays.length > 0 && course.meetings.some(
      (meeting) => meeting.weekday !== null && !preferredWeekdays.includes(meeting.weekday),
    )) return [];
    if (creditFilters.length > 0 && (course.credits === null || !creditFilters.includes(course.credits))) return [];
    const category = classifyRecommendationCategory(course, input.profile);
    if (categoryFilters.length > 0 && !categoryFilters.includes(category)) return [];
    if (input.profile && !input.profile.allowCrossDepartment && category === "external_department") return [];
    const lexical = queryText
      ? scoreLexically(searchIndex, course, queryText)
      : { score: 0, titleMatch: 0, exactTitle: false, matchedTerms: [], matchedFields: [] };
    return [{
      course,
      order,
      vector: vectorAt(input.vectors, row, input.dimension),
      denseScore: dot(vectorAt(input.vectors, row, input.dimension), input.query!),
      lexical,
      eligibility: eligibility.status,
      category,
    }];
  });

  const denseRanked = [...candidates]
    .sort((a, b) => b.denseScore - a.denseScore || a.order - b.order)
    .slice(0, RETRIEVAL_LIMIT)
    .map((item) => item.course.course_id);
  const sparseRanked = [...candidates]
    .filter((item) => item.lexical.score > 0)
    .sort((a, b) => Number(b.lexical.exactTitle) - Number(a.lexical.exactTitle)
      || b.lexical.score - a.lexical.score
      || b.lexical.titleMatch - a.lexical.titleMatch
      || a.order - b.order)
    .slice(0, RETRIEVAL_LIMIT)
    .map((item) => item.course.course_id);
  const rrfScores = reciprocalRankFusion(denseRanked, sparseRanked);
  const denseRanks = new Map(denseRanked.map((courseId, index) => [courseId, index + 1]));
  const sparseRanks = new Map(sparseRanked.map((courseId, index) => [courseId, index + 1]));
  const ranked = candidates
    .filter((item) => rrfScores.has(item.course.course_id))
    .sort((a, b) => (rrfScores.get(b.course.course_id)! - rrfScores.get(a.course.course_id)!)
      || b.denseScore - a.denseScore
      || b.lexical.score - a.lexical.score
      || a.order - b.order);

  const selected: typeof ranked = [];
  const seenNames = new Set<string>();
  for (const item of ranked) {
    if (seenNames.has(item.course.name_zh)) continue;
    seenNames.add(item.course.name_zh);
    selected.push(item);
    if (selected.length === 20) break;
  }

  return selected.map((item) => ({
    course: item.course,
    score: rrfScores.get(item.course.course_id) ?? 0,
    eligibility: item.eligibility,
    category: item.category,
    reasons: [
      ...queryReasons(queryText, item.lexical, denseRanks.get(item.course.course_id), sparseRanks.get(item.course.course_id)),
      ...(item.eligibility === "needs_confirmation" ? ["存在待確認的選課條件，請展開查看原始依據"] : []),
    ],
  }));
}
