import { departmentNamesMatch, sameDepartment } from "./department";
import { inferProfileStudyLevel } from "./eligibility";
import type { Course, Profile } from "./types";

/**
 * The 115-1 catalog does not give the shared all-university courses the same
 * official department identity as a regular department course.  Their
 * department labels are the short labels used by the course system, such as
 * `資工系人哲`, `CT-理工學院`, and `FT-大二英文`.
 */
const SHARED_COLLEGE_CODES: Record<string, ReadonlySet<string>> = {
  文學院: new Set(["01", "02", "03", "10", "1N"]),
  外語學院: new Set(["20", "22", "23", "24", "25", "26"]),
  民生學院: new Set(["46", "48", "57", "58", "69", "85", "86"]),
  法律學院: new Set(["66", "67"]),
  社科院: new Set(["63", "64", "65"]),
  理工學院: new Set(["1B", "1I", "1R", "30", "31", "33", "51", "54", "55", "56", "76", "89", "99"]),
  傳播學院: new Set(["11", "12", "13"]),
  管理學院: new Set(["0E", "0F", "71", "74"]),
  醫學院: new Set(["39", "91", "92", "94", "95", "96", "98", "0W"]),
  藝術學院: new Set(["80", "81", "82"]),
  教運學院: new Set(["0V", "16", "17", "18"]),
};

const DEPARTMENT_CORE_SUFFIXES = ["人哲", "入門", "專倫", "體育"];

/**
 * Some department-scoped core rows omit their grade in the university
 * catalog.  Keep the academic-year rule here rather than mutating the raw
 * catalog, so a future crawl cannot turn these into all-grade courses.
 */
const DEPARTMENT_CORE_GRADES: Record<string, number> = {
  大學入門: 1,
  人生哲學: 2,
};

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function coreDepartmentBase(value: string | null | undefined): string {
  let result = (value ?? "").trim();
  for (const suffix of DEPARTMENT_CORE_SUFFIXES) {
    if (result.endsWith(suffix)) return result.slice(0, -suffix.length);
  }
  return result;
}

function isDepartmentCoreLabel(course: Course): boolean {
  return DEPARTMENT_CORE_SUFFIXES.some((suffix) => (course.department || course.raw_department || "").endsWith(suffix));
}

function profileDepartmentAliases(profile: Profile, catalog: Course[]): string[] {
  const aliases = [profile.department, profile.official_department_name_zh];
  for (const course of catalog) {
    if (sameDepartment(course, profile)) aliases.push(course.department, course.audience_department);
  }
  return [...new Set(aliases.filter((value): value is string => Boolean(value)))];
}

function matchesDepartmentCore(course: Course, profile: Profile, catalog: Course[]): boolean {
  if (!isDepartmentCoreLabel(course)) return false;
  const base = coreDepartmentBase(course.department || course.raw_department);
  if (!base) return false;
  return profileDepartmentAliases(profile, catalog).some((alias) => departmentNamesMatch(base, alias));
}

function matchesSharedCollege(course: Course, profile: Profile): boolean {
  const label = course.department || course.raw_department || "";
  const separator = label.indexOf("-");
  if (separator !== 2) return false;
  const group = label.slice(3);
  if (group === "進修部") return profile.division === "進修部";
  if (group === "不分院") return true;
  const code = normalized(profile.department_code);
  return Boolean(code && SHARED_COLLEGE_CODES[group]?.has(code));
}

function matchesSharedRequiredCourse(course: Course, profile: Profile): boolean {
  const label = course.department || course.raw_department || "";
  if (!label.includes("-")) return false;
  if (label.startsWith("IT-") || label.startsWith("LT-") || label.startsWith("ET-")) {
    return inferProfileStudyLevel(profile) === "undergraduate"
      && ((label.startsWith("IT-") && profile.grade === 1)
        || label.startsWith("LT-")
        || label.startsWith("ET-"));
  }
  if (label.startsWith("AT-") || label.startsWith("ATP2-")) {
    return inferProfileStudyLevel(profile) === "undergraduate"
      && (label.startsWith("ATP2-")
        ? profile.grade === 2
        : course.name_zh.includes("大一") ? profile.grade === 1 : profile.grade === 1 || profile.grade === 2);
  }
  if (!matchesSharedCollege(course, profile)) return false;

  if (label.startsWith("CT-")) {
    // The official 115-1 table places the 4-credit Chinese requirement in
    // the first year (the catalog contains one 2-credit semester course).
    return profile.grade === 1 && course.name_zh.includes("國文");
  }

  if (!label.startsWith("FT-") || course.name_zh.includes("非英文")) return false;
  if (label === "FT-大二英文") return profile.grade === 2;
  // Placement level is not stored in Profile.  Keep one first-year English
  // offering eligible; selectRequiredCourses() collapses parallel sections.
  return profile.grade === 1 && course.name_zh.startsWith("外國語文(");
}

function isDeferredLanguageCourse(course: Course): boolean {
  const label = course.department || course.raw_department || "";
  return label.startsWith("CT-") || label.startsWith("FT-");
}

function matchesAcademicYear(course: Course, profile: Profile): boolean {
  const configuredGrade = DEPARTMENT_CORE_GRADES[course.name_zh];
  if (configuredGrade !== undefined && isDepartmentCoreLabel(course)) {
    return configuredGrade === profile.grade;
  }
  return course.grade == null || course.grade === profile.grade;
}

function matchesClassGroup(course: Course, profile: Profile): boolean {
  if (!course.class_group) return true;
  return Boolean(profile.classGroup && course.class_group === profile.classGroup);
}

function candidateIsRequired(course: Course, profile: Profile, catalog: Course[]): boolean {
  if (course.required_elective_name !== "必修") return false;
  // Chinese and foreign-language classes are assigned by placement or waiver;
  // they must be added manually after the university publishes the result.
  if (isDeferredLanguageCourse(course)) return false;
  if (course.division !== profile.division || !matchesAcademicYear(course, profile)) return false;
  if (!matchesClassGroup(course, profile)) return false;
  if (sameDepartment(course, profile)) return true;
  if (matchesDepartmentCore(course, profile, catalog)) return true;
  return matchesSharedRequiredCourse(course, profile);
}

function requirementKey(course: Course): string {
  const department = course.department || course.raw_department || "";
  if (department.startsWith("CT-") || department.startsWith("FT-")) {
    return `${department}|${course.name_zh}`;
  }
  return `${department}|${course.name_zh}|${course.grade ?? "core"}|${course.class_group || ""}`;
}

/** Return the class groups currently present for the selected department. */
export function getClassGroupOptions(catalog: Course[], profile: Profile): string[] {
  return [...new Set(
    catalog
      .filter((course) => course.division === profile.division && sameDepartment(course, profile))
      .map((course) => course.class_group)
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right, "zh-Hant"));
}

/**
 * Return one course per required course/section family.  The catalog often
 * contains parallel sections for the same requirement; adding every row would
 * incorrectly put several alternatives into the timetable.
 */
export function selectRequiredCourses(catalog: Course[], profile: Profile): Course[] {
  const candidates = catalog
    .filter((course) => candidateIsRequired(course, profile, catalog))
    .sort((left, right) => left.course_id.localeCompare(right.course_id));
  const selected = new Map<string, Course>();
  for (const course of candidates) {
    const key = requirementKey(course);
    if (!selected.has(key)) selected.set(key, course);
  }
  return [...selected.values()];
}
