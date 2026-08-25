import { courseConflicts, evaluateEligibility, meetingsConflict } from "./eligibility";
import { classifyRecommendationCategory, sameCourseFamily } from "./recommendation";
import type { CompletedCourse, Course, EligibilityStatus, Meeting, Profile, RecommendationCategory } from "./types";

const DEFAULT_CLUSTER_SIMILARITY = 0.72;
const DEFAULT_MAX_CLUSTERS = 3;
const RRF_K = 60;
const DEFAULT_MMR_LAMBDA = 0.78;

interface VectorCourse {
  course: Course;
  vector: Float32Array;
  weight: number;
  order: number;
}

interface InterestCluster {
  members: VectorCourse[];
  weightedSum: Float32Array;
  centroid: Float32Array;
  weight: number;
  order: number;
}

interface RankedCandidate {
  course: Course;
  vector: Float32Array;
  eligibility: EligibilityStatus;
  category: RecommendationCategory;
  score: number;
  relevance: number;
  originalRank: number;
  bestCluster: InterestCluster;
}

export interface ScheduleSlotRecommendation {
  course: Course;
  alternatives: Course[];
  eligibility: EligibilityStatus;
  category: RecommendationCategory;
  score: number;
  reasons: string[];
  basisCourses: Course[];
}

export interface ScheduleSlotRecommendationResult {
  recommendations: ScheduleSlotRecommendation[];
  basisCourseCount: number;
  interestClusterCount: number;
  candidateCount: number;
  lowConfidence: boolean;
  requiredOnly: boolean;
}

export interface RankScheduleSlotCoursesInput {
  catalog: Course[];
  courseIds: string[];
  vectors: Float32Array;
  dimension: number;
  scheduledCourses: Course[];
  fixedMeetings?: Meeting[];
  weekday: number;
  section: string;
  profile?: Profile;
  completed?: CompletedCourse[];
  dismissedIds?: string[];
  categoryFilters?: RecommendationCategory[];
  limit?: number;
  clusterSimilarity?: number;
  maxClusters?: number;
  diversityLambda?: number;
}

function vectorAt(vectors: Float32Array, row: number, dimension: number): Float32Array {
  return vectors.subarray(row * dimension, (row + 1) * dimension);
}

function dot(left: Float32Array, right: Float32Array): number {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += left[index] * right[index];
  return total;
}

function normalized(vector: Float32Array): Float32Array {
  let magnitudeSquared = 0;
  for (const value of vector) magnitudeSquared += value ** 2;
  const magnitude = Math.max(Math.sqrt(magnitudeSquared), 1e-12);
  return Float32Array.from(vector, (value) => value / magnitude);
}

function addWeighted(target: Float32Array, vector: Float32Array, weight: number): void {
  const length = Math.min(target.length, vector.length);
  for (let index = 0; index < length; index += 1) target[index] += vector[index] * weight;
}

function interestWeight(course: Course): number {
  return course.required_elective_name === "必修" ? 0.3 : 1;
}

function makeCluster(item: VectorCourse, dimension: number): InterestCluster {
  const weightedSum = new Float32Array(dimension);
  addWeighted(weightedSum, item.vector, item.weight);
  return { members: [item], weightedSum, centroid: normalized(weightedSum), weight: item.weight, order: item.order };
}

function mergeClusters(left: InterestCluster, right: InterestCluster): InterestCluster {
  const weightedSum = new Float32Array(left.weightedSum.length);
  addWeighted(weightedSum, left.weightedSum, 1);
  addWeighted(weightedSum, right.weightedSum, 1);
  return {
    members: [...left.members, ...right.members].sort((a, b) => a.order - b.order),
    weightedSum,
    centroid: normalized(weightedSum),
    weight: left.weight + right.weight,
    order: Math.min(left.order, right.order),
  };
}

function buildInterestClusters(
  items: VectorCourse[],
  dimension: number,
  similarityThreshold: number,
  maxClusters: number,
): InterestCluster[] {
  const clusters = items.map((item) => makeCluster(item, dimension));
  while (clusters.length > 1) {
    let bestLeft = -1;
    let bestRight = -1;
    let bestSimilarity = Number.NEGATIVE_INFINITY;
    for (let left = 0; left < clusters.length; left += 1) {
      for (let right = left + 1; right < clusters.length; right += 1) {
        const similarity = dot(clusters[left].centroid, clusters[right].centroid);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestLeft = left;
          bestRight = right;
        }
      }
    }
    if (bestLeft < 0 || (clusters.length <= maxClusters && bestSimilarity < similarityThreshold)) break;
    const merged = mergeClusters(clusters[bestLeft], clusters[bestRight]);
    clusters.splice(bestRight, 1);
    clusters.splice(bestLeft, 1, merged);
  }
  return clusters.sort((left, right) => right.weight - left.weight || left.order - right.order);
}

function coversSlot(course: Course, weekday: number, section: string): boolean {
  return course.meetings.some((meeting) => meeting.weekday === weekday && meeting.sections.includes(section));
}

function eligibilityPriority(status: EligibilityStatus): number {
  return { eligible_confirmed: 0, no_known_restriction: 1, needs_confirmation: 2, blocked_confirmed: 3 }[status];
}

function categoryPriority(category: RecommendationCategory): number {
  return { home_required: 0, home_elective: 0, general_education: 1, external_department: 2 }[category];
}

function groupFamilies(candidates: RankedCandidate[]): Array<RankedCandidate & { alternatives: Course[] }> {
  const groups: RankedCandidate[][] = [];
  for (const candidate of candidates) {
    const group = groups.find((members) => sameCourseFamily(members[0].course, candidate.course, members[0].vector, candidate.vector));
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  return groups.map((members) => {
    const ordered = [...members].sort((left, right) => (
      eligibilityPriority(left.eligibility) - eligibilityPriority(right.eligibility)
      || categoryPriority(left.category) - categoryPriority(right.category)
      || right.score - left.score
      || left.originalRank - right.originalRank
    ));
    return { ...ordered[0], alternatives: ordered.slice(1).map((item) => item.course) };
  });
}

function selectWithMmr<T extends RankedCandidate>(candidates: T[], limit: number, lambda: number): T[] {
  const remaining = [...candidates];
  const selected: T[] = [];
  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const redundancy = selected.length ? Math.max(...selected.map((item) => Math.max(0, dot(candidate.vector, item.vector)))) : 0;
      const mmr = lambda * candidate.relevance - (1 - lambda) * redundancy;
      const incumbent = remaining[bestIndex];
      if (mmr > bestScore || (mmr === bestScore && candidate.originalRank < incumbent.originalRank)) {
        bestScore = mmr;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function weekdayLabel(weekday: number): string {
  return ["一", "二", "三", "四", "五", "六", "日"][weekday - 1] ?? String(weekday);
}

function emptyResult(input: RankScheduleSlotCoursesInput, basisCourseCount = 0): ScheduleSlotRecommendationResult {
  return {
    recommendations: [],
    basisCourseCount,
    interestClusterCount: 0,
    candidateCount: 0,
    lowConfidence: true,
    requiredOnly: input.scheduledCourses.length > 0 && input.scheduledCourses.every((course) => course.required_elective_name === "必修"),
  };
}

/** Rank courses for one empty slot using interests inferred from the current schedule. */
export function rankScheduleSlotCourses(input: RankScheduleSlotCoursesInput): ScheduleSlotRecommendationResult {
  if (input.dimension <= 0 || input.vectors.length !== input.courseIds.length * input.dimension) return emptyResult(input);
  const rowById = new Map(input.courseIds.map((courseId, row) => [courseId, row]));
  const vectorFor = (courseId: string): Float32Array | undefined => {
    const row = rowById.get(courseId);
    return row === undefined ? undefined : vectorAt(input.vectors, row, input.dimension);
  };
  const basis = input.scheduledCourses.flatMap((course, order) => {
    const vector = vectorFor(course.course_id);
    return vector ? [{ course, vector, weight: interestWeight(course), order }] : [];
  });
  if (!basis.length) return emptyResult(input);

  const clusters = buildInterestClusters(basis, input.dimension, input.clusterSimilarity ?? DEFAULT_CLUSTER_SIMILARITY, Math.max(1, input.maxClusters ?? DEFAULT_MAX_CLUSTERS));
  const scheduledIds = new Set(input.scheduledCourses.map((course) => course.course_id));
  const completed = input.completed ?? [];
  const completedIds = new Set(completed.map((course) => course.courseId));
  const completedNames = new Set(completed.map((course) => course.courseName));
  const dismissedIds = new Set(input.dismissedIds ?? []);
  const fixedMeetings = input.fixedMeetings ?? [];

  const candidates = input.catalog.flatMap((course, order) => {
    const vector = vectorFor(course.course_id);
    if (!vector || scheduledIds.has(course.course_id) || completedIds.has(course.course_id) || dismissedIds.has(course.course_id)) return [];
    if (!coversSlot(course, input.weekday, input.section)) return [];
    const category = classifyRecommendationCategory(course, input.profile);
    if (input.categoryFilters !== undefined && !input.categoryFilters.includes(category)) return [];
    const eligibility = evaluateEligibility(course, input.profile, completedNames);
    if (eligibility.status === "blocked_confirmed") return [];
    const courseConflict = courseConflicts(course, input.scheduledCourses);
    const fixedConflict = meetingsConflict(course.meetings, fixedMeetings);
    if (courseConflict.conflict || courseConflict.uncertain || fixedConflict.conflict || fixedConflict.uncertain) return [];
    if (input.scheduledCourses.some((scheduled) => sameCourseFamily(course, scheduled, vector, vectorFor(scheduled.course_id)))) return [];
    return [{ course, vector, eligibility: eligibility.status, category, order }];
  });

  if (!candidates.length) {
    return { ...emptyResult(input, basis.length), interestClusterCount: clusters.length, requiredOnly: basis.every((item) => item.course.required_elective_name === "必修") };
  }

  const totalClusterWeight = clusters.reduce((sum, cluster) => sum + cluster.weight, 0);
  const scoreById = new Map<string, number>();
  const bestClusterById = new Map<string, InterestCluster>();
  const bestSimilarityById = new Map<string, number>();
  for (const cluster of clusters) {
    const ranked = [...candidates].sort((left, right) => dot(right.vector, cluster.centroid) - dot(left.vector, cluster.centroid) || left.order - right.order);
    const clusterShare = cluster.weight / Math.max(totalClusterWeight, 1e-12);
    ranked.forEach((candidate, rank) => {
      const courseId = candidate.course.course_id;
      scoreById.set(courseId, (scoreById.get(courseId) ?? 0) + clusterShare / (RRF_K + rank + 1));
      const similarity = dot(candidate.vector, cluster.centroid);
      if (similarity > (bestSimilarityById.get(courseId) ?? Number.NEGATIVE_INFINITY)) {
        bestSimilarityById.set(courseId, similarity);
        bestClusterById.set(courseId, cluster);
      }
    });
  }

  const ordered = candidates
    .map((candidate) => ({ ...candidate, score: scoreById.get(candidate.course.course_id) ?? 0, bestCluster: bestClusterById.get(candidate.course.course_id) ?? clusters[0] }))
    .sort((left, right) => right.score - left.score || left.order - right.order);
  const maxScore = Math.max(...ordered.map((candidate) => candidate.score), 1e-12);
  const ranked: RankedCandidate[] = ordered.map((candidate, originalRank) => ({ ...candidate, relevance: candidate.score / maxScore, originalRank }));
  const selected = selectWithMmr(groupFamilies(ranked), input.limit ?? 8, input.diversityLambda ?? DEFAULT_MMR_LAMBDA);
  const slotReason = `符合星期${weekdayLabel(input.weekday)} ${input.section}，且完整上課時間不與目前課表衝堂`;

  return {
    recommendations: selected.map((candidate) => {
      const basisCourses = [...candidate.bestCluster.members]
        .sort((left, right) => dot(candidate.vector, right.vector) - dot(candidate.vector, left.vector) || left.order - right.order)
        .slice(0, 2)
        .map((item) => item.course);
      const basisNames = basisCourses.map((course) => `〈${course.name_zh}〉`).join("、");
      return {
        course: candidate.course,
        alternatives: candidate.alternatives,
        eligibility: candidate.eligibility,
        category: candidate.category,
        score: candidate.score,
        reasons: [slotReason, `課程內容接近你課表中的${basisNames}`, ...(candidate.eligibility === "needs_confirmation" ? ["部分修課資格仍需向開課單位確認"] : [])],
        basisCourses,
      };
    }),
    basisCourseCount: basis.length,
    interestClusterCount: clusters.length,
    candidateCount: candidates.length,
    lowConfidence: basis.length < 2 || basis.every((item) => item.course.required_elective_name === "必修"),
    requiredOnly: basis.every((item) => item.course.required_elective_name === "必修"),
  };
}
