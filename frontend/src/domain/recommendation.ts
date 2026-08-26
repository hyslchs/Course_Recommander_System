import { evaluateEligibility, courseConflicts, inferCourseStudyLevel, meetingsConflict, studyLevelsMatch } from "./eligibility";
import { sameDepartment } from "./department";
import { buildSearchIndex, scoreLexically, type LexicalMatch, type SearchIndex } from "./search";
import { matchesAdvancedCourseFilters, type AdvancedCourseFilters } from "./courseFilters";
import type {
  CompletedCourse,
  Course,
  Profile,
  Recommendation,
  RecommendationCategory,
  RecommendationCategoryFilters,
  HardConstraints,
  QueryAnalysis,
} from "./types";

export const recommendationCategoryLabels: Record<RecommendationCategory, string> = {
  home_required: "本系必修",
  home_elective: "本系選修",
  general_education: "通識課程",
  external_department: "外系課程",
};

const RRF_K = 60;
const RETRIEVAL_LIMIT = 200;
const DEFAULT_MMR_LAMBDA = 0.78;
const COURSE_FAMILY_SIMILARITY = 0.975;

export type TimeOfDayFilter = "all" | "daytime" | "evening" | "weekday_evening_or_saturday";
export interface FilterEvidenceLabels {
  relation?: Record<string, string>;
  teachingMethod?: Record<string, string>;
  assessment?: Record<string, string>;
}

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

function cosine(left: Float32Array, right: Float32Array): number {
  let numerator = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    numerator += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  return numerator / Math.max(Math.sqrt(leftMagnitude * rightMagnitude), 1e-12);
}

function normalizeFamilyText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-Hant")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function courseContentSignature(course: Course): string {
  return normalizeFamilyText([
    course.sections.objective,
    course.sections.weekly_progress,
    course.prerequisite,
  ].filter(Boolean).join("\n"));
}

function courseDepartmentSignature(course: Course): string {
  const value = [
    course.department_identity,
    course.official_department_name_zh,
    course.department_display,
    course.department,
  ].find((candidate) => Boolean(candidate?.trim()));
  return normalizeFamilyText(value);
}

function isGenericIndependentCourseTitle(course: Course): boolean {
  return /(專題|論文|獨立研究|個別研究|書報討論|實習)/.test(course.name_zh);
}

/**
 * Treat offerings as the same family only when the normalized title and credits
 * agree and there is additional evidence (same teacher, identical substantial
 * syllabus content, or the same department for a non-generic course title).
 * This avoids merging generic titles such as 「專題（一）」 across departments.
 */
export function sameCourseFamily(
  left: Course,
  right: Course,
  leftVector?: Float32Array,
  rightVector?: Float32Array,
): boolean {
  if (normalizeFamilyText(left.name_zh) !== normalizeFamilyText(right.name_zh)) return false;
  if (left.credits !== null && right.credits !== null && left.credits !== right.credits) return false;

  const leftTeacher = normalizeFamilyText(left.teacher);
  const rightTeacher = normalizeFamilyText(right.teacher);
  if (leftTeacher && leftTeacher === rightTeacher) return true;

  const leftContent = courseContentSignature(left);
  const rightContent = courseContentSignature(right);
  if (leftContent.length >= 80 && leftContent === rightContent) return true;

  const leftDepartment = courseDepartmentSignature(left);
  const rightDepartment = courseDepartmentSignature(right);
  const sameDepartmentIdentity = Boolean(leftDepartment && leftDepartment === rightDepartment);
  if (sameDepartmentIdentity && !isGenericIndependentCourseTitle(left)) return true;

  return Boolean(
    sameDepartmentIdentity
    && leftVector
    && rightVector
    && cosine(leftVector, rightVector) >= COURSE_FAMILY_SIMILARITY,
  );
}

function groupCourseFamilies<T extends { course: Course; vector: Float32Array }>(items: T[]): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.find((candidate) => sameCourseFamily(
      candidate[0].course,
      item.course,
      candidate[0].vector,
      item.vector,
    ));
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

function eligibilityPriority(status: Recommendation["eligibility"]): number {
  return {
    eligible_confirmed: 0,
    no_known_restriction: 1,
    needs_confirmation: 2,
    blocked_confirmed: 3,
  }[status];
}

function selectWithMmr<T extends { relevance: number; vector: Float32Array; originalRank: number }>(
  candidates: T[],
  limit: number,
  lambda = DEFAULT_MMR_LAMBDA,
  seed: T[] = [],
): T[] {
  const remaining = [...candidates];
  const selectedForSimilarity = [...seed];
  const output: T[] = [];
  while (remaining.length && output.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const redundancy = selectedForSimilarity.length
        ? Math.max(...selectedForSimilarity.map((item) => Math.max(0, cosine(candidate.vector, item.vector))))
        : 0;
      const score = lambda * candidate.relevance - (1 - lambda) * redundancy;
      const incumbent = remaining[bestIndex];
      if (score > bestScore || (score === bestScore && candidate.originalRank < incumbent.originalRank)) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const next = remaining.splice(bestIndex, 1)[0];
    output.push(next);
    selectedForSimilarity.push(next);
  }
  return output;
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
  const topic = queryText ? `「${queryText}」` : "你搜尋的主題";
  const reasons = [`這堂課和${topic}相關`];
  if (lexical.exactTitle) reasons.push(`課名就是你搜尋的${topic}`);
  else if (lexical.matchedTerms.length) reasons.push(`課名包含${topic}這個關鍵字`);
  const matchedFields = lexical.matchedFields
    .filter((field) => field !== "title")
    .map(fieldLabel)
    .slice(0, 2);
  if (matchedFields.length) reasons.push(`課綱的「${[...new Set(matchedFields)].join("、")}」也提到這個主題`);
  return reasons;
}

function advancedFilterReasons(
  course: Course,
  filters?: AdvancedCourseFilters,
  labels: FilterEvidenceLabels = {},
): string[] {
  if (!filters) return [];
  const reasons: string[] = [];
  if (filters.classTime.mode === "sections") {
    const selected = new Set(filters.classTime.sections);
    const matched = [...new Set(course.meetings.flatMap((meeting) => meeting.sections).filter((section) => selected.has(section)))];
    if (matched.length) reasons.push(`包含 ${matched.join("、")}`);
  }
  const matchedWeighted = (
    rows: Course["teaching_methods"] | Course["assessments"],
    selectedIds: string[],
    criterion: AdvancedCourseFilters["teachingMethodCriterion"],
  ) => {
    const available = rows ?? [];
    const maximum = available.length ? Math.max(...available.map((item) => item.percent)) : 0;
    return available
      .filter((item) => selectedIds.includes(item.id)
        && (criterion.mode === "minimum" ? item.percent >= criterion.minPercent : item.percent === maximum))
      .sort((left, right) => right.percent - left.percent);
  };
  const method = matchedWeighted(course.teaching_methods, filters.teachingMethodIds, filters.teachingMethodCriterion)[0];
  if (method) reasons.push(`${labels.teachingMethod?.[method.id] ?? method.label ?? method.id} ${method.percent}%`);
  const assessment = matchedWeighted(course.assessments, filters.assessmentMethodIds, filters.assessmentMethodCriterion)[0];
  if (assessment) reasons.push(`${labels.assessment?.[assessment.id] ?? assessment.label ?? assessment.id} ${assessment.percent}%`);
  if (filters.assessmentStyle !== "all") reasons.push({
    no_exams: "無考試評量",
    exam: "考試為主要評量",
    writing: "作業寫作為主要評量",
    presentation: "發表合作為主要評量",
    practical: "實作展演為主要評量",
    participation: "課堂參與為主要評量",
  }[filters.assessmentStyle]);
  if (filters.onlineTeaching.mode === "has_online") {
    const online = course.online_teaching;
    if (online?.sync && online.async) reasons.push("同步與非同步線上教學");
    else if (online?.sync) reasons.push("含同步線上教學");
    else if (online?.async) reasons.push("含非同步線上教學");
  } else if (filters.onlineTeaching.mode === "physical_only") reasons.push("純實體授課");
  if (filters.teachingLanguages.length && course.teaching_language) reasons.push(`授課語言：${course.teaching_language}`);
  if (filters.materialLanguages.length && course.material_language) reasons.push(`教材語言：${course.material_language}`);
  const selectedRelations = new Set([
    ...filters.relations.literacy,
    ...filters.relations.coreCompetencies,
    ...filters.relations.specialIssues,
  ]);
  const relation = (course.relations ?? []).find((item) => selectedRelations.has(item.id)
    && (filters.relations.includeIndirect || item.strength === "direct"));
  if (relation) reasons.push(`關聯：${labels.relation?.[relation.id] ?? relation.label ?? relation.id}`);
  return reasons.slice(0, 4);
}

function rankSingleCourses(input: {
  catalog: Course[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
  query?: Float32Array;
  queryText?: string;
  searchIndex?: SearchIndex;
  profile?: Profile;
  categoryFilters?: RecommendationCategoryFilters;
  courseTagFilters?: string[];
  creditFilters?: number[];
  completed: CompletedCourse[];
  dismissedIds: string[];
  scheduledCourses?: Course[];
  scheduledMeetings?: Course["meetings"];
  lockedCourses?: Course[];
  preferredWeekdays?: number[];
  includeNonPreferredWeekdays?: boolean;
  timeOfDayFilter?: TimeOfDayFilter;
  advancedFilters?: AdvancedCourseFilters;
  filterEvidenceLabels?: FilterEvidenceLabels;
  includeUnknownSchedule?: boolean;
  studyLevelFilter?: Profile["studyLevel"];
  includeUnknownStudyLevel?: boolean;
  hardConstraints?: HardConstraints;
  queryAnalysis?: QueryAnalysis;
  intentVectors?: Record<string, Float32Array>;
  selectionLimit?: number;
  diversityLambda?: number;
  onCandidateCount?: (count: number) => void;
  diagnosticsOnly?: boolean;
}): Recommendation[] {
  if (!input.query) return [];
  const queryText = input.queryText?.trim() ?? "";
  const rowById = new Map(input.courseIds.map((id, row) => [id, row]));
  const searchIndex = input.searchIndex ?? buildSearchIndex(input.catalog);
  const completedIds = new Set(input.completed.map((item) => item.courseId));
  const completedNames = new Set(input.completed.map((item) => item.courseName));
  const dismissed = new Set(input.dismissedIds);
  const categoryFilters = input.categoryFilters ?? [];
  const courseTagFilters = new Set(input.courseTagFilters ?? []);
  const creditFilters = input.creditFilters ?? [];
  const preferredWeekdays = input.preferredWeekdays ?? input.profile?.preferredWeekdays ?? [];
  const scheduledCourses = input.scheduledCourses ?? input.lockedCourses ?? [];

  const candidates = input.catalog.flatMap((course, order) => {
    const row = rowById.get(course.course_id);
    if (row === undefined || completedIds.has(course.course_id) || dismissed.has(course.course_id)) return [];
    const eligibility = evaluateEligibility(course, input.profile, completedNames);
    const hasUnresolvedCoursePrerequisite = eligibility.blocked.some(
      (rule) => rule.kind === "course_prerequisite",
    );
    if (eligibility.status === "blocked_confirmed" && !hasUnresolvedCoursePrerequisite) return [];
    if (input.studyLevelFilter && input.studyLevelFilter !== "unknown") {
      const courseStudyLevel = inferCourseStudyLevel(course);
      if (courseStudyLevel === "unknown" && input.includeUnknownStudyLevel !== true) return [];
      if (courseStudyLevel !== "unknown" && !studyLevelsMatch(input.studyLevelFilter, courseStudyLevel)) return [];
    }
    if (courseConflicts(course, scheduledCourses).conflict) return [];
    if (input.scheduledMeetings && meetingsConflict(course.meetings, input.scheduledMeetings).conflict) return [];
    const broadTime = input.advancedFilters?.classTime.mode === "broad"
      ? input.advancedFilters.classTime.value
      : input.advancedFilters?.classTime.mode === "sections" ? "all" : input.timeOfDayFilter ?? "all";
    if (!matchesTimeOfDayFilter(course, broadTime, input.includeUnknownSchedule)) return [];
    if (input.advancedFilters && !matchesAdvancedCourseFilters(course, input.advancedFilters)) return [];
    const knownMeetings = course.meetings.filter((meeting) => meeting.weekday !== null);
    if (!input.includeNonPreferredWeekdays && preferredWeekdays.length > 0) {
      if (!knownMeetings.length && input.includeUnknownSchedule !== true) return [];
      if (knownMeetings.some((meeting) => !preferredWeekdays.includes(meeting.weekday!))) return [];
    }
    if (creditFilters.length > 0 && (course.credits === null || !creditFilters.includes(course.credits))) return [];
    if (courseTagFilters.size > 0 && !(course.course_tags ?? []).some((tag) => courseTagFilters.has(tag.code))) return [];
    if (input.hardConstraints && !matchesHardConstraints(course, input.hardConstraints)) return [];
    const category = classifyRecommendationCategory(course, input.profile);
    if (categoryFilters.length > 0 && !categoryFilters.includes(category)) return [];

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
  input.onCandidateCount?.(candidates.length);
  if (input.diagnosticsOnly) return [];

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

  const families = groupCourseFamilies(ranked).map((members) => {
    const orderedMembers = [...members].sort((left, right) => (
      eligibilityPriority(left.eligibility) - eligibilityPriority(right.eligibility)
      || Number(!sameDepartment(left.course, input.profile)) - Number(!sameDepartment(right.course, input.profile))
      || ranked.indexOf(left) - ranked.indexOf(right)
    ));
    const representative = orderedMembers[0];
    const bestRankedMember = members[0];
    const score = Math.max(...members.map((item) => rrfScores.get(item.course.course_id) ?? 0));
    return {
      representative,
      alternatives: orderedMembers.slice(1).map((item) => item.course),
      score,
      relevance: normalizedRrf(score),
      vector: bestRankedMember.vector,
      originalRank: ranked.indexOf(bestRankedMember),
    };
  });
  const selected = selectWithMmr(
    families,
    input.selectionLimit ?? 20,
    input.diversityLambda,
  );

  return selected.map((family) => {
    const item = family.representative;
    return {
      course: item.course,
      alternatives: family.alternatives,
      score: family.score,
      eligibility: item.eligibility,
      category: item.category,
      reasons: [
        ...advancedFilterReasons(item.course, input.advancedFilters, input.filterEvidenceLabels),
        ...queryReasons(queryText, item.lexical, denseRanks.get(item.course.course_id), sparseRanks.get(item.course.course_id)),
      ],
    };
  });
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
  courseTagFilters?: string[];
  creditFilters?: number[];
  completed: CompletedCourse[];
  dismissedIds: string[];
  scheduledCourses?: Course[];
  scheduledMeetings?: Course["meetings"];
  lockedCourses?: Course[];
  preferredWeekdays?: number[];
  includeNonPreferredWeekdays?: boolean;
  timeOfDayFilter?: TimeOfDayFilter;
  advancedFilters?: AdvancedCourseFilters;
  filterEvidenceLabels?: FilterEvidenceLabels;
  includeUnknownSchedule?: boolean;
  studyLevelFilter?: Profile["studyLevel"];
  includeUnknownStudyLevel?: boolean;
  queryAnalysis?: QueryAnalysis;
  intentVectors?: Record<string, Float32Array>;
  hardConstraints?: HardConstraints;
  diversityLambda?: number;
}): Recommendation[] {
  const analysis = input.queryAnalysis;
  if (!analysis || analysis.relation === "FALLBACK") {
    return rankSingleCourses(input);
  }
  if (analysis.relation === "SINGLE") {
    const hasSemanticExclusion = analysis.exclusions.some((part) => !part.metadataConstraint);
    if (hasSemanticExclusion) return rankCompoundCourses({ ...input, queryAnalysis: analysis });
    const hasExclusion = analysis.exclusions.length > 0;
    const queryText = (analysis.unsupportedConditions.length || hasExclusion) && analysis.goals.length
      ? analysis.goals.map((part) => part.text).join(" ")
      : input.queryText;
    return rankSingleCourses({ ...input, queryText });
  }
  return rankCompoundCourses({ ...input, queryAnalysis: analysis });
}

export function rankCoursesWithDiagnostics(
  input: Parameters<typeof rankCourses>[0],
): { recommendations: Recommendation[]; candidateCount: number } {
  let candidateCount = 0;
  const recommendations = rankCourses({
    ...input,
    onCandidateCount: (count: number) => { candidateCount = count; },
  } as Parameters<typeof rankCourses>[0]);
  return { recommendations, candidateCount };
}

export function countCourseCandidates(input: Parameters<typeof rankCourses>[0]): number {
  let candidateCount = 0;
  rankSingleCourses({
    ...input,
    queryAnalysis: undefined,
    diagnosticsOnly: true,
    onCandidateCount: (count: number) => { candidateCount = count; },
  });
  return candidateCount;
}

function matchesHardConstraints(course: Course, constraints: HardConstraints): boolean {
  const meetings = course.meetings ?? [];
  const inferredStudyLevel = inferCourseStudyLevel(course);
  if (constraints.weekdays?.length && !meetings.some((meeting) => meeting.weekday !== null && constraints.weekdays!.includes(meeting.weekday))) return false;
  if (constraints.excludedWeekdays?.length && meetings.some((meeting) => meeting.weekday !== null && constraints.excludedWeekdays!.includes(meeting.weekday))) return false;
  if (constraints.credits?.length && (course.credits === null || !constraints.credits.includes(course.credits))) return false;
  if (constraints.excludedCredits?.length && course.credits !== null && constraints.excludedCredits.includes(course.credits)) return false;
  if (constraints.sections?.length && !meetings.some((meeting) => meeting.sections.some((section) => constraints.sections!.includes(section)))) return false;
  if (constraints.excludedSections?.length && meetings.some((meeting) => meeting.sections.some((section) => constraints.excludedSections!.includes(section)))) return false;
  if (constraints.requiredElective?.length && !constraints.requiredElective.includes(course.required_elective_name)) return false;
  if (constraints.excludedRequiredElective?.length && constraints.excludedRequiredElective.includes(course.required_elective_name)) return false;
  if (constraints.divisions?.length && !constraints.divisions.includes(course.division)) return false;
  if (constraints.excludedDivisions?.length && constraints.excludedDivisions.includes(course.division)) return false;
  if (constraints.studyLevels?.length && !constraints.studyLevels.includes(inferredStudyLevel)) return false;
  if (constraints.excludedStudyLevels?.length && constraints.excludedStudyLevels.includes(inferredStudyLevel)) return false;
  if (constraints.departmentIdentity && course.department_identity !== constraints.departmentIdentity) return false;
  if (constraints.excludedDepartmentIdentity && course.department_identity === constraints.excludedDepartmentIdentity) return false;
  if (constraints.teacher && course.teacher !== constraints.teacher) return false;
  if (constraints.excludedTeacher && course.teacher === constraints.excludedTeacher) return false;
  return true;
}

function normalizedRrf(score: number): number {
  return score / (2 / (RRF_K + 1));
}

function rankCompoundCourses(input: Parameters<typeof rankSingleCourses>[0] & { queryAnalysis: QueryAnalysis; intentVectors?: Record<string, Float32Array> }): Recommendation[] {
  const analysis = input.queryAnalysis;
  const positiveQueryText = [...analysis.goals, ...analysis.contexts].map((part) => part.text).join(" ").trim() || analysis.rawQuery;
  const base = rankSingleCourses({ ...input, queryText: positiveQueryText, queryAnalysis: undefined });
  const index = input.searchIndex ?? buildSearchIndex(input.catalog);
  const vectorsById = new Map(input.courseIds.map((id, row) => [id, vectorAt(input.vectors, row, input.dimension)]));
  const baseById = new Map(base.map((item) => [item.course.course_id, item]));
  const goalResults = analysis.goals.map((goal) => {
    const query = input.intentVectors?.[goal.id] ?? input.query;
    if (!query) return { goal, results: [] as Recommendation[] };
    return {
      goal,
      results: rankSingleCourses({ ...input, query, queryText: goal.text, queryAnalysis: undefined, selectionLimit: 30 }),
    };
  });
  const contextResults = analysis.contexts.map((context) => {
    const query = input.intentVectors?.[context.id];
    return query ? rankSingleCourses({ ...input, query, queryText: context.text, queryAnalysis: undefined, selectionLimit: 30 }) : [];
  });
  const goalMaps = goalResults.map(({ results }) => new Map(results.map((item, index) => [item.course.course_id, { item, rank: index + 1 }])));
  const contextMaps = contextResults.map((results) => new Map(results.map((item, index) => [item.course.course_id, { item, rank: index + 1 }])));
  const exclusionVectors = analysis.exclusions.filter((part) => !part.metadataConstraint).map((part) => input.intentVectors?.[part.id]).filter((value): value is Float32Array => Boolean(value));
  const exclusionText = analysis.exclusions.filter((part) => !part.metadataConstraint).map((part) => part.text).join(" ");
  const candidates = new Set<string>([
    ...base.map((item) => item.course.course_id),
    ...goalResults.flatMap(({ results }) => results.map((item) => item.course.course_id)),
    ...contextResults.flatMap((results) => results.map((item) => item.course.course_id)),
  ]);
  const scored = [...candidates].map((courseId) => {
    const course = input.catalog.find((item) => item.course_id === courseId)!;
    const baseItem = baseById.get(courseId);
    const goalScores = goalMaps.map((map) => {
      const match = map.get(courseId);
      return match ? normalizedRrf(match.item.score) : 0;
    });
    const contextScores = contextMaps.map((map) => {
      const match = map.get(courseId);
      return match ? normalizedRrf(match.item.score) : 0;
    });
    const baseScore = baseItem ? normalizedRrf(baseItem.score) : 0;
    const exclusionMean = exclusionVectors.length && vectorsById.has(courseId)
      ? exclusionVectors.reduce((sum, vector) => sum + Math.max(0, dot(vectorsById.get(courseId)!, vector)), 0) / exclusionVectors.length
      : exclusionText && index ? Math.min(1, scoreLexically(index, course, exclusionText).score) : 0;
    const softContextMean = contextScores.length ? contextScores.reduce((sum, value) => sum + value, 0) / contextScores.length : 0;
    const goalMean = goalScores.length ? goalScores.reduce((sum, value) => sum + value, 0) / goalScores.length : 0;
    const qualified = (map: Map<string, { item: Recommendation; rank: number }>, queryText: string): boolean => {
      const match = map.get(courseId);
      if (!match) return false;
      const lexical = scoreLexically(index, course, queryText);
      const lexicalQualified = lexical.exactTitle || lexical.titleMatch >= 0.30 || lexical.score >= 0.18;
      const denseQualified = match.rank <= 30 && (vectorsById.has(courseId) && input.intentVectors?.[analysis.goals.find((goal) => goal.text === queryText)?.id ?? ""]
        ? dot(vectorsById.get(courseId)!, input.intentVectors?.[analysis.goals.find((goal) => goal.text === queryText)?.id ?? ""]!) >= 0.45
        : true);
      return lexicalQualified || denseQualified;
    };
    const qualifiedGoals = goalMaps.map((map, index) => qualified(map, analysis.goals[index]?.text ?? ""));
    const requiredContexts = analysis.contexts.filter((context) => context.required).map((context, index) => qualified(contextMaps[index] ?? new Map(), context.text));
    const allAspects = [...qualifiedGoals, ...requiredContexts];
    const intersectionScore = allAspects.length ? 0.60 * Math.min(...allAspects.map((value, index) => value ? 1 : (index < goalScores.length ? goalScores[index] : contextScores[index - goalScores.length] ?? 0))) + 0.40 * ([...goalScores, ...contextScores].reduce((sum, value) => sum + value, 0) / Math.max(1, goalScores.length + contextScores.length)) : 0;
    const score = analysis.relation === "FILTER_ONLY"
      ? baseScore - 0.25 * exclusionMean
      : analysis.relation === "INTERSECTION"
      ? 0.35 * baseScore + 0.65 * intersectionScore + 0.10 * softContextMean - 0.25 * exclusionMean
      : 0.45 * baseScore + 0.45 * goalMean + 0.10 * softContextMean - 0.25 * exclusionMean;
    return {
      course,
      score,
      baseItem,
      goalScores,
      qualifiedGoals,
      intersectionScore,
      allAspects,
      vector: vectorsById.get(courseId)!,
    };
  }).filter((item) => item.baseItem || item.goalScores.some((value) => value > 0));
  scored.sort((left, right) => right.score - left.score || left.course.name_zh.localeCompare(right.course.name_zh, "zh-Hant"));

  const families = groupCourseFamilies(scored).map((members, originalRank) => {
    const representative = members[0];
    const alternatives = [
      ...members.slice(1).map((item) => item.course),
      ...members.flatMap((item) => item.baseItem?.alternatives ?? []),
    ].filter((course, index, values) => (
      course.course_id !== representative.course.course_id
      && values.findIndex((candidate) => candidate.course_id === course.course_id) === index
    ));
    return {
      ...representative,
      alternatives,
      relevance: Math.max(0, Math.min(1, representative.score)),
      originalRank,
    };
  });

  const coverageSelected: typeof families = [];
  if (analysis.relation === "COVERAGE") {
    for (let goalIndex = 0; goalIndex < goalMaps.length; goalIndex += 1) {
      const candidate = families.find((item) => (
        item.qualifiedGoals[goalIndex]
        && !coverageSelected.some((selected) => selected.course.course_id === item.course.course_id)
      ));
      if (candidate) coverageSelected.push(candidate);
    }
  }
  const remaining = families.filter((item) => !coverageSelected.includes(item));
  const selected = [
    ...coverageSelected,
    ...selectWithMmr(
      remaining,
      Math.max(0, 20 - coverageSelected.length),
      input.diversityLambda,
      coverageSelected,
    ),
  ];
  const hasJointMatch = analysis.relation === "INTERSECTION" && selected.some((item) => item.allAspects.length > 0 && item.allAspects.every(Boolean));
  return selected.slice(0, 20).map((item) => {
    const reasons = [...(item.baseItem?.reasons ?? ["這堂課符合你部分的需求"])];
    if (analysis.relation === "COVERAGE") reasons.push(`符合你的 ${item.qualifiedGoals.filter(Boolean).length}/${analysis.goals.length} 項需求`);
    if (analysis.relation === "INTERSECTION" && item.allAspects.every(Boolean)) reasons.push("同時符合你設定的條件");
    if (analysis.relation === "INTERSECTION" && !hasJointMatch) reasons.unshift("目前還沒有單一課程能符合所有條件；這堂先符合部分需求");
    return {
      course: item.course,
      alternatives: item.alternatives,
      score: item.score,
      eligibility: item.baseItem?.eligibility ?? "no_known_restriction",
      category: item.baseItem?.category ?? classifyRecommendationCategory(item.course, input.profile),
      reasons,
    };
  });
}

export function matchesTimeOfDayFilter(
  course: Pick<Course, "meetings">,
  timeOfDayFilter: TimeOfDayFilter,
  includeUnknownSchedule?: boolean,
): boolean {
  const meetings = course.meetings ?? [];
  const hasUnknownSchedule = meetings.length === 0 || meetings.some(
    (meeting) => meeting.weekday === null || meeting.sections.length === 0,
  );
  if (hasUnknownSchedule && includeUnknownSchedule === false) return false;
  if (timeOfDayFilter === "all") return true;

  const knownMeetings = meetings.filter((meeting) => meeting.weekday !== null);
  const sections = knownMeetings.flatMap((meeting) => meeting.sections);
  if (!sections.length && includeUnknownSchedule !== true) return false;
  if (timeOfDayFilter === "weekday_evening_or_saturday") {
    return !knownMeetings.some((meeting) => (
      meeting.weekday !== 6
      && meeting.sections.some((section) => !section.toUpperCase().startsWith("E"))
    ));
  }

  const expectedPrefix = timeOfDayFilter === "evening" ? "E" : "D";
  return !sections.some((section) => !section.toUpperCase().startsWith(expectedPrefix));
}
