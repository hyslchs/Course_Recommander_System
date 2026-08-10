export type EligibilityStatus =
  | "no_known_restriction"
  | "eligible_confirmed"
  | "blocked_confirmed"
  | "needs_confirmation";

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

export interface Course {
  course_id: string;
  ava_no: string;
  name_zh: string;
  name_en: string;
  credits: number | null;
  required_elective_name: string;
  academic_year: number;
  semester: number;
  department: string;
  raw_department: string;
  grade: number | null;
  class_group: string;
  division: string;
  teacher: string;
  teacher_en: string;
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
  grade: number;
  admissionYear: number;
  interests: string;
  preferredWeekdays: number[];
  targetCredits: number;
  allowCrossDepartment: boolean;
  updatedAt: string;
}

export interface CompletedCourse {
  courseId: string;
  courseName: string;
  continueLearning: boolean;
  addedAt: string;
}

export interface ScheduleEntry { courseId: string; locked: boolean }
export interface SchedulePlan {
  id: string;
  name: string;
  entries: ScheduleEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactManifest {
  artifact_version: string;
  academic_year: number;
  semester: number;
  model_name: string;
  model_revision: string;
  dimension: number;
  course_count: number;
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

export interface Recommendation {
  course: Course;
  score: number;
  eligibility: EligibilityStatus;
  category: RecommendationCategory;
  reasons: string[];
}
