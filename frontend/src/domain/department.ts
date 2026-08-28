import type { CourseSummary, Profile } from "./types";

export type DepartmentType = "department" | "program" | "degree_program" | "credit_program" | "micro_program" | "college" | "graduate_institute";

const GRADE_SUFFIX = /[一二三四五六七1-7](?:年級|[甲乙丙丁戊己庚辛壬癸愛智仁勇忠孝信義和平]+)?$/;
const DEPARTMENT_SUFFIXES = [
  "博士學位學程",
  "碩士學位學程",
  "學士學位學程",
  "學位學程",
  "研究所",
  "碩士班",
  "博士班",
  "在職專班",
  "學系",
  "學院",
  "學程",
  "系所",
  "系",
  "所",
  "班",
];

export function departmentType(value: string | null | undefined): DepartmentType | null {
  const text = value ?? "";
  if (text.includes("微學程")) return "micro_program";
  if (text.includes("學分學程")) return "credit_program";
  if (text.includes("學位學程")) return "degree_program";
  if (text.includes("學程")) return "program";
  if (text.includes("學院")) return "college";
  if (text.includes("研究所")) return "graduate_institute";
  if (text.includes("學系") || text.endsWith("系")) return "department";
  return null;
}

export function normalizeDepartmentLabel(value: string | null | undefined): string {
  let normalized = (value ?? "").normalize("NFKC").replace(/[\s\-‐‑‒–—_·・/\\（）()、，,。．.:：；;]/g, "");
  normalized = normalized.replace(GRADE_SUFFIX, "");
  normalized = normalized.replace(/(?:博士|碩士|碩職|碩|博)(?:班)?$/, "");
  let changed = true;
  while (changed && normalized) {
    changed = false;
    if (normalized.endsWith("化學系") || normalized.endsWith("數學系")) {
      normalized = normalized.slice(0, -1);
      changed = true;
      continue;
    }
    for (const suffix of DEPARTMENT_SUFFIXES) {
      if (normalized.endsWith(suffix)) {
        normalized = normalized.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return normalized;
}

export function departmentNamesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftType = departmentType(left);
  const rightType = departmentType(right);
  if (leftType && rightType && leftType !== rightType) return false;
  const leftForm = normalizeDepartmentLabel(left);
  const rightForm = normalizeDepartmentLabel(right);
  if (!leftForm || !rightForm) return false;
  if (leftForm === rightForm) return true;
  const [shorter, longer] = [leftForm, rightForm].sort((a, b) => a.length - b.length);
  if (shorter.length < 2) return false;
  let position = 0;
  for (const character of longer) {
    if (shorter[position] === character) position += 1;
  }
  return position === shorter.length;
}

export function sameDepartment(course: CourseSummary, profile?: Profile): boolean {
  if (!profile?.department) return false;
  if (course.department_match?.status === "ambiguous") return false;
  if (course.department_identity && profile.department_identity
    && course.department_identity !== profile.department_identity) return false;
  if (course.department_code && profile.department_code) {
    const courseCode = String(course.department_code).trim().toUpperCase();
    const profileCode = String(profile.department_code).trim().toUpperCase();
    if (courseCode !== profileCode) return false;
  }
  if (course.division_code && profile.division_code
    && course.division_code !== profile.division_code) return false;
  if (course.official_department_type && profile.official_department_type
    && course.official_department_type !== profile.official_department_type) return false;
  const courseLabels = [
    course.department,
    course.audience_department,
    course.official_department_name_zh,
    course.raw_department,
  ];
  const profileLabels = [profile.department, profile.official_department_name_zh];
  return courseLabels.some((courseLabel) => profileLabels.some((profileLabel) => departmentNamesMatch(courseLabel, profileLabel)));
}
