export type EligibilityStatus =
  | "no_known_restriction"
  | "eligible_confirmed"
  | "blocked_confirmed"
  | "needs_confirmation";

export type StudyLevel = "undergraduate" | "master" | "doctoral" | "unknown";

export interface OfficialDepartment {
  division_code: string;
  division_name_zh: string;
  code: string;
  label: string;
  name_zh: string;
  department_type: string;
}

export interface OfficialDivision {
  code: string;
  label: string;
  name_zh: string;
  departments: Array<Omit<OfficialDepartment, "division_code" | "division_name_zh">>;
}

export interface DepartmentCatalog {
  schema_version: string;
  fetched_at?: string;
  hy: number;
  lcid?: number;
  divisions: OfficialDivision[];
  departments: OfficialDepartment[];
}

export interface EligibilityRule {
  kind: string;
  reason_code: string;
  message: string;
  source_field: string;
  evidence: string;
  value: Record<string, string | number | null>;
}

export interface Meeting {
  weekday: number | null;
  sections: string[];
  room: string | null;
  week_pattern: string | null;
}

export interface CourseTag {
  code: string;
  label_zh: string;
  label_en?: string;
  note_zh?: string;
  note_en?: string;
  display_order?: number | null;
}

export type RelationGroup = "literacy" | "core_knowledge" | "core_skills_attitudes" | "special_issues";

export interface CourseRelation {
  id: string;
  group: RelationGroup;
  label?: string;
  strength: "direct" | "indirect";
}

export interface WeightedCourseOption {
  id: string;
  label?: string;
  label_en?: string;
  percent: number;
}

export interface CourseInstructor {
  id: string;
  name_zh?: string;
  name_en?: string;
}

export interface Course {
  course_id: string;
  ava_no: string;
  name_zh: string;
  name_en: string;
  credits: number | null;
  required_elective_name: string;
  course_tags?: CourseTag[];
  academic_year: number;
  semester: number;
  department: string;
  audience_department?: string | null;
  raw_department: string;
  department_identity?: string | null;
  department_display?: string | null;
  division_code?: string | null;
  department_code?: string | null;
  official_department_name_zh?: string | null;
  official_department_label?: string | null;
  official_department_type?: string | null;
  department_match?: {
    status: "matched" | "ambiguous" | "unmatched";
    method: string;
    confidence: number;
    candidate_codes: Array<string | null>;
    candidate_details?: Array<{
      code: string | null;
      division_code?: string | null;
      label: string | null;
      name_zh: string | null;
      department_type: string;
    }>;
  } | null;
  study_level?: StudyLevel;
  audience_grade?: number | null;
  grade: number | null;
  class_group: string;
  division: string;
  teacher: string;
  teacher_en: string;
  instructors?: CourseInstructor[];
  teaching_language?: string | null;
  material_language?: string | null;
  relations?: CourseRelation[];
  teaching_methods?: WeightedCourseOption[];
  assessments?: WeightedCourseOption[];
  online_teaching?: { sync: boolean; async: boolean };
  meetings: Meeting[];
  sections: Record<string, string>;
  prerequisite: string;
  enrollment_note: string;
  eligibility_base_status: EligibilityStatus;
  eligibility_rules: EligibilityRule[];
  source_url: string;
}

export interface Profile {
  id: "current";
  division: string;
  department: string;
  classGroup?: string;
  department_identity?: string | null;
  division_code?: string | null;
  department_code?: string | null;
  official_department_name_zh?: string | null;
  official_department_type?: string | null;
  grade: number;
  studyLevel?: StudyLevel;
  admissionYear: number;
  interests: string;
  preferredWeekdays: number[];

  updatedAt: string;
}

export interface AIHistoryTurn {
  question: string;
  recommended_course_ids: string[];
}

export interface AIAskContext {
  division: string;
  department: string;
  department_identity?: string | null;
  grade?: number | null;
  study_level: StudyLevel;

  preferred_weekdays: number[];
  completed_course_ids: string[];
  schedule_course_ids: string[];
}

export interface AIRecommendation {
  course: Course;
  reason: string;
  cautions: string[];
  matched_fields: string[];
}

export interface AIAnswer {
  request_id: string;
  answer: string;
  recommendations: AIRecommendation[];
  follow_up_suggestions: string[];
  limitations: string[];
}

export interface CompletedCourse {
  courseId: string;
  courseName: string;
  continueLearning: boolean;
  addedAt: string;
}

export interface FixedScheduleEntry {
  id: string;
  name: string;
  teacher?: string;
  meetings: Meeting[];
  locked: boolean;
  source?: string;
}

export interface ScheduleEntry {
  courseId: string;
  locked: boolean;
  meetingsOverride?: Meeting[];
}
export interface SchedulePlan {
  id: string;
  name: string;
  entries: ScheduleEntry[];
  fixedEntries?: FixedScheduleEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactManifest {
  artifact_version: string;
  catalog_schema_version?: string;
  academic_year: number;
  semester: number;
  generated_at?: string;
  model_name: string;
  model_revision: string;
  dimension: number;
  course_count: number;
  analysis_version?: string;
  route_count?: number;
  files?: Record<string, { sha256: string; bytes: number }> | Array<{ filename: string; sha256: string; bytes: number }>;
}

export interface EmbeddingIndex {
  artifact_version: string;
  dimension: number;
  dtype: "float32-le";
  course_ids: string[];
}

export type RecommendationCategory =
  | "home_required"
  | "home_elective"
  | "general_education"
  | "external_department";

export type RecommendationCategoryFilter = RecommendationCategory;
export type RecommendationCategoryFilters = RecommendationCategory[];

export interface Recommendation {
  course: CourseSummary;
  /** Other sections or cross-listed offerings that belong to the same course family. */
  alternatives?: CourseSummary[];
  score: number;
  eligibility: EligibilityStatus;
  category: RecommendationCategory;
  reasons: string[];
}

export type QueryRelation = "SINGLE" | "COVERAGE" | "INTERSECTION" | "FILTER_ONLY" | "FALLBACK";
export type QueryPartRole = "GOAL" | "CONTEXT" | "EXCLUSION";

export interface HardConstraints {
  weekdays?: number[];
  credits?: number[];
  sections?: string[];
  requiredElective?: string[];
  divisions?: string[];
  studyLevels?: StudyLevel[];
  departmentIdentity?: string;
  teacher?: string;
  excludedWeekdays?: number[];
  excludedCredits?: number[];
  excludedSections?: string[];
  excludedRequiredElective?: string[];
  excludedDivisions?: string[];
  excludedStudyLevels?: StudyLevel[];
  excludedDepartmentIdentity?: string;
  excludedTeacher?: string;
}

export interface QueryPart {
  id: string;
  text: string;
  role: QueryPartRole;
  routeId?: string;
  routeLabel?: string;
  routePolicy?: string;
  routeScore?: number;
  required?: boolean;
  metadataConstraint?: keyof HardConstraints;
  sourceStart?: number;
  sourceEnd?: number;
}

export interface UnsupportedQueryItem {
  kind: string;
  text: string;
  message: string;
}

export interface QueryAnalysis {
  rawQuery: string;
  normalizedQuery: string;
  relation: QueryRelation;
  goals: QueryPart[];
  contexts: QueryPart[];
  exclusions: QueryPart[];
  hardConstraints: HardConstraints;
  unsupportedRelations: UnsupportedQueryItem[];
  unsupportedConditions: UnsupportedQueryItem[];
  confidence: number;
  fallbackReason?: string;
  warnings: string[];
}

/**
 * The first-run recommendation payload. Verbose syllabus text is deliberately
 * absent; it is fetched from `/api/v1/courses/:id` when a card is expanded.
 */
export type CourseSummary = Omit<Course, "sections" | "enrollment_note"> & {
  family_signature?: string;
};

export type CourseDetail = Pick<Course, "course_id" | "sections" | "enrollment_note">;
