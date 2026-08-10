import { evaluateEligibility, courseConflicts } from "./eligibility";
import type { CompletedCourse, Course, Profile, Recommendation, RecommendationCategory } from "./types";

export const recommendationCategoryLabels: Record<RecommendationCategory, string> = {
  home_required: "本系必修",
  home_elective: "本系選修",
  general_education: "通識課程",
  external_department: "外系課程",
};

const categoryOrder: RecommendationCategory[] = [
  "home_required",
  "home_elective",
  "general_education",
  "external_department",
];

export function classifyRecommendationCategory(course: Course, profile?: Profile): RecommendationCategory {
  const sameDepartment = Boolean(profile?.department && course.department === profile.department);
  if (sameDepartment && course.required_elective_name === "必修") return "home_required";
  if (sameDepartment && course.required_elective_name !== "通識") return "home_elective";
  if (course.required_elective_name === "通識") return "general_education";
  return "external_department";
}

const categoryReasons: Record<RecommendationCategory, string> = {
  home_required: "本系必修課程，建議優先納入修課規劃",
  home_elective: "由你的系所開設，可作為本系選修規劃",
  general_education: "通識課程，優先於外系課程推薦",
  external_department: "外系課程，列為跨領域探索選項",
};

const dot = (a: Float32Array, b: Float32Array): number => {
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result += a[index] * b[index];
  return result;
};

function vectorAt(vectors: Float32Array, row: number, dimension: number): Float32Array {
  return vectors.subarray(row * dimension, (row + 1) * dimension);
}

function averageVectors(rows: number[], vectors: Float32Array, dimension: number): Float32Array | undefined {
  if (!rows.length) return undefined;
  const result = new Float32Array(dimension);
  for (const row of rows) {
    const vector = vectorAt(vectors, row, dimension);
    for (let index = 0; index < dimension; index += 1) result[index] += vector[index];
  }
  let norm = 0;
  for (let index = 0; index < dimension; index += 1) norm += result[index] ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < dimension; index += 1) result[index] /= norm;
  return result;
}

export function rankCourses(input: {
  catalog: Course[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
  query?: Float32Array;
  queryText?: string;
  profile?: Profile;
  completed: CompletedCourse[];
  favoriteIds: string[];
  dismissedIds: string[];
  lockedCourses: Course[];
}): Recommendation[] {
  const rowById = new Map(input.courseIds.map((id, row) => [id, row]));
  const completedIds = new Set(input.completed.map((item) => item.courseId));
  const completedNames = new Set(input.completed.map((item) => item.courseName));
  const dismissed = new Set(input.dismissedIds);
  const favoriteRows = input.favoriteIds.flatMap((id) => (rowById.has(id) ? [rowById.get(id)!] : []));
  const continuingRows = input.completed
    .filter((item) => item.continueLearning && rowById.has(item.courseId))
    .map((item) => rowById.get(item.courseId)!);
  const favoriteVector = averageVectors(favoriteRows, input.vectors, input.dimension);
  const continuingVector = averageVectors(continuingRows, input.vectors, input.dimension);
  const signals = [
    input.query && { vector: input.query, weight: 0.6, reason: "符合你輸入的興趣主題" },
    favoriteVector && { vector: favoriteVector, weight: 0.25, reason: "與你收藏的課程內容相近" },
    continuingVector && { vector: continuingVector, weight: 0.15, reason: "可銜接你想繼續深入的已修課程" },
  ].filter(Boolean) as { vector: Float32Array; weight: number; reason: string }[];
  if (!signals.length) return [];
  const totalWeight = signals.reduce((sum, item) => sum + item.weight, 0);

  const candidates = input.catalog.flatMap((course) => {
    const row = rowById.get(course.course_id);
    if (row === undefined || completedIds.has(course.course_id) || dismissed.has(course.course_id)) return [];
    const eligibility = evaluateEligibility(course, input.profile, completedNames);
    if (eligibility.status === "blocked_confirmed") return [];
    if (courseConflicts(course, input.lockedCourses).conflict) return [];
    const category = classifyRecommendationCategory(course, input.profile);
    if (input.profile && !input.profile.allowCrossDepartment && category === "external_department") return [];

    const vector = vectorAt(input.vectors, row, input.dimension);
    const contributions = signals.map((signal, signalIndex) => {
      const semanticScore = dot(vector, signal.vector);
      const score = signalIndex === 0 && input.query && input.queryText
        ? 0.9 * semanticScore + 0.1 * lexicalTitleScore(input.queryText, course.name_zh)
        : semanticScore;
      return { ...signal, score };
    });
    let score = contributions.reduce((sum, signal) => sum + signal.score * signal.weight, 0) / totalWeight;
    const weekdayFit = Boolean(
      input.profile?.preferredWeekdays.length &&
        course.meetings.length &&
        course.meetings.every((meeting) => meeting.weekday && input.profile!.preferredWeekdays.includes(meeting.weekday)),
    );
    const gradeFit = Boolean(input.profile?.grade && course.grade === input.profile.grade);
    if (weekdayFit) score += 0.05;
    if (gradeFit) score += 0.04;
    if (eligibility.status === "needs_confirmation") score -= 0.05;

    const reasons = [categoryReasons[category], ...contributions
      .sort((a, b) => b.score * b.weight - a.score * a.weight)
      .slice(0, 2)
      .map((item) => item.reason)];
    if (gradeFit) reasons.push("符合你目前的年級");
    if (weekdayFit) reasons.push("符合你的偏好時段");
    if (eligibility.status === "needs_confirmation") reasons.push("存在待確認的選課條件，請展開查看原始依據");
    return [{ course, score, vector, eligibility: eligibility.status, category, reasons }];
  });

  const selected: typeof candidates = [];
  for (const category of categoryOrder) {
    const group = candidates
      .filter((candidate) => candidate.category === category)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    selected.push(...selectWithMmr(group, 20 - selected.length));
    if (selected.length >= 20) break;
  }
  return selected.map(({ vector: _vector, ...item }) => item);
}

function selectWithMmr<T extends { course: Course; score: number; vector: Float32Array }>(items: T[], limit: number): T[] {
  const pool = [...items];
  const selected: T[] = [];
  while (pool.length && selected.length < limit) {
    const selectedNames = new Set(selected.map((item) => item.course.name_zh));
    for (let index = pool.length - 1; index >= 0; index -= 1) {
      if (selectedNames.has(pool[index].course.name_zh)) pool.splice(index, 1);
    }
    if (!pool.length) break;
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < pool.length; index += 1) {
      const diversity = selected.length ? Math.max(...selected.map((item) => dot(pool[index].vector, item.vector))) : 0;
      const mmr = 0.8 * pool[index].score - 0.2 * diversity;
      if (mmr > bestScore) { bestIndex = index; bestScore = mmr; }
    }
    selected.push(pool.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function lexicalTitleScore(query: string, title: string): number {
  const bigrams = (value: string) => {
    const normalized = [...value.toLowerCase()].filter((character) => /[\p{L}\p{N}]/u.test(character)).join("");
    const result = new Set<string>();
    for (let index = 0; index < Math.max(1, normalized.length - 1); index += 1) {
      result.add(normalized.slice(index, index + 2));
    }
    return result;
  };
  const queryBigrams = bigrams(query);
  const titleBigrams = bigrams(title);
  let matches = 0;
  for (const value of titleBigrams) if (queryBigrams.has(value)) matches += 1;
  return matches / Math.max(1, titleBigrams.size);
}
