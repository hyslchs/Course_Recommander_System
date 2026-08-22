import type { Course, DepartmentCatalog } from "./types";

export interface DepartmentOption {
  key: string;
  value: string;
  identity: string | null;
  division: string;
  divisionCode: string | null;
  code: string | null;
  officialName: string | null;
  departmentType: string | null;
  aliases: string[];
}

const divisionNamesByCode: Record<string, string> = {
  C: "進修部",
  D: "日間部",
  G: "研究所",
  S: "外校",
  T: "二年制",
};

// This is the order shown by the official FJU outline search page. 「外校」
// exists in the API reference but has no selectable departments, so it is
// omitted from a student's home-division picker.
const officialDivisionOrder = ["日間部", "研究所", "進修部", "二年制"];

export function buildDivisionOptions(catalog: Course[], officialCatalog?: DepartmentCatalog): string[] {
  if (officialCatalog?.divisions?.length) {
    const available = new Set(
      officialCatalog.divisions
        .filter((division) => division.departments.length > 0)
        .map((division) => division.name_zh),
    );
    return officialDivisionOrder.filter((division) => available.has(division));
  }
  const available = new Set(catalog.map((item) => item.division).filter(Boolean));
  return officialDivisionOrder.filter((division) => available.has(division));
}

const departmentTypeLabels: Record<string, string> = {
  department: "學系",
  graduate_institute: "研究所",
  degree_program: "學位學程",
  program: "學程",
  credit_program: "學分學程",
  micro_program: "微學程",
  college: "學院／共同單位",
};

export const departmentTypeOrder = [
  "department",
  "graduate_institute",
  "degree_program",
  "program",
  "credit_program",
  "micro_program",
  "college",
  "unknown",
];

export function getDepartmentTypeLabel(type: string | null): string {
  return departmentTypeLabels[type ?? ""] ?? "其他單位";
}

/**
 * Returns the identity cues that users need when two departments have similar
 * names. Keep this next to the option model so every picker can present the
 * same division/degree/track wording before a profile is saved.
 */
export function getDepartmentContextLabel(option: DepartmentOption): string {
  const name = option.officialName ?? option.value;
  const track = /學士後/.test(name)
    ? "學士後"
    : /在職/.test(name)
      ? "在職"
      : /進修/.test(name)
        ? "進修"
        : /博士/.test(name)
          ? "一般博士班"
          : /碩士/.test(name)
            ? "一般碩士班"
            : "一般大學部";
  return [option.division, getDepartmentTypeLabel(option.departmentType), track]
    .filter(Boolean)
    .join(" · ");
}

function isPrimaryStudentUnit(type: string | null | undefined, name: string): boolean {
  if (["department", "graduate_institute", "degree_program"].includes(type ?? "")) return true;
  // The official catalog leaves a few real cohorts untyped (for example,
  // 國際菁英學士班 and 碩士在職專班). Keep those, but not general-course units.
  return !type && /(學士班|碩士班|博士班|專班)$/.test(name);
}

function divisionName(code: string | null | undefined, fallback: string): string {
  return (code && divisionNamesByCode[code.toUpperCase()]) || fallback;
}

export function buildDepartmentOptions(catalog: Course[], officialCatalog?: DepartmentCatalog): DepartmentOption[] {
  const byKey = new Map<string, DepartmentOption>();
  const addOption = (option: DepartmentOption) => {
    const existing = byKey.get(option.key);
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...option.aliases].filter(Boolean))];
    } else {
      byKey.set(option.key, option);
    }
  };
  const hasOfficialCatalog = Boolean(officialCatalog?.departments?.length);
  const addCatalogOption = (option: DepartmentOption) => {
    if (!hasOfficialCatalog || byKey.has(option.key)) addOption(option);
  };

  // When available, this official dropdown artifact is authoritative. Course
  // rows are used only to enrich aliases; they must not invent profile options
  // that do not exist in the university's department query response.
  for (const item of officialCatalog?.departments ?? []) {
    const departmentType = item.department_type || null;
    if (!isPrimaryStudentUnit(departmentType, item.name_zh)) continue;
    const divisionCode = item.division_code?.toUpperCase() || null;
    const key = `${divisionCode ?? item.division_name_zh}:`+
      `${item.code}:${departmentType ?? "unknown"}`;
    addOption({
      key,
      value: item.name_zh,
      identity: `${divisionCode ?? item.division_name_zh}:${item.code}:${departmentType ?? "unknown"}`,
      division: divisionName(divisionCode, item.division_name_zh),
      divisionCode,
      code: item.code,
      officialName: item.name_zh,
      departmentType,
      aliases: [item.label].filter(Boolean),
    });
  }

  for (const item of catalog) {
    const officialName = item.official_department_name_zh ?? item.department;
    if ((item.department_code || item.official_department_name_zh)
      && isPrimaryStudentUnit(item.official_department_type, officialName)) {
      const divisionCode = item.division_code ?? null;
      addCatalogOption({
        key: item.department_identity ?? `${divisionCode ?? item.division ?? "unknown"}:${item.department_code ?? item.official_department_label ?? item.official_department_name_zh ?? item.department}:${item.official_department_type ?? "unknown"}`,
        value: officialName,
        identity: item.department_identity ?? null,
        division: divisionName(divisionCode, item.division),
        divisionCode,
        code: item.department_code ?? null,
        officialName: item.official_department_name_zh ?? null,
        departmentType: item.official_department_type ?? null,
        aliases: [item.department, item.raw_department, item.audience_department ?? ""].filter(Boolean),
      });
    }

    for (const candidate of item.department_match?.candidate_details ?? []) {
      const candidateDivisionCode = candidate.division_code ?? item.division_code ?? null;
      const name = candidate.name_zh ?? item.department;
      if (!isPrimaryStudentUnit(candidate.department_type, name)) continue;
      addCatalogOption({
        key: `${candidateDivisionCode ?? item.division ?? "unknown"}:${candidate.code ?? candidate.label ?? name}:${candidate.department_type ?? "unknown"}`,
        value: name,
        identity: candidate.code ? `${candidateDivisionCode ?? item.division_code ?? item.division ?? "unknown"}:${candidate.code}:${candidate.department_type || "unknown"}` : null,
        division: divisionName(candidateDivisionCode, item.division),
        divisionCode: candidateDivisionCode,
        code: candidate.code,
        officialName: candidate.name_zh,
        departmentType: candidate.department_type,
        aliases: [item.department, item.raw_department, item.audience_department ?? ""].filter(Boolean),
      });
    }

  }

  return [...byKey.values()].sort((left, right) => {
    const typeDifference = departmentTypeOrder.indexOf(left.departmentType ?? "unknown")
      - departmentTypeOrder.indexOf(right.departmentType ?? "unknown");
    if (typeDifference) return typeDifference;
    return (left.officialName ?? left.value).localeCompare(right.officialName ?? right.value, "zh-Hant");
  });
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase("zh-Hant").replace(/[\s\-_]/g, "");
}

const specialTrackPattern = /(學士後|在職|進修|專班)/;

function departmentSearchRank(option: DepartmentOption, query: string): [number, number, string] {
  const normalizedQuery = normalizeSearchText(query);
  const names = [option.officialName, option.value].filter(Boolean).map((value) => normalizeSearchText(value as string));
  const code = option.code ? normalizeSearchText(option.code) : "";
  const exactCode = Boolean(code && code === normalizedQuery);
  const exactName = names.some((name) => name === normalizedQuery);
  const prefixName = names.some((name) => name.startsWith(normalizedQuery));
  const matchedName = names.some((name) => name.includes(normalizedQuery));
  const matchRank = exactCode || exactName ? 0 : prefixName ? 1 : matchedName ? 2 : 3;

  // If the user did not explicitly ask for a special track, keep the ordinary
  // department or regular degree ahead of an in-service/post-baccalaureate
  // variant when both match the same broad query (for example, "護理學系"
  // or "資訊工程"). An explicit query such as "在職" or "學士後" cancels
  // this preference because it is a deliberate user choice.
  const queryRequestsSpecialTrack = specialTrackPattern.test(normalizedQuery);
  const isSpecialTrack = specialTrackPattern.test(names.join(" "));
  const specialTrackRank = !queryRequestsSpecialTrack && isSpecialTrack ? 1 : 0;
  return [matchRank, specialTrackRank, (option.officialName ?? option.value).toLocaleLowerCase("zh-Hant")];
}

export function filterDepartmentOptions(
  options: DepartmentOption[],
  division: string,
  query: string,
): DepartmentOption[] {
  const tokens = query.trim().split(/\s+/).map(normalizeSearchText).filter(Boolean);
  const visible = options.filter((option) => {
    if (division && option.division !== division) return false;
    if (!tokens.length) return true;
    const searchable = normalizeSearchText([
      option.code,
      option.officialName,
      option.value,
      ...option.aliases,
      getDepartmentTypeLabel(option.departmentType),
    ].filter(Boolean).join(" "));
    return tokens.every((token) => searchable.includes(token));
  });

  if (!tokens.length) return visible;
  return visible.sort((left, right) => {
    const leftRank = departmentSearchRank(left, query);
    const rightRank = departmentSearchRank(right, query);
    return leftRank[0] - rightRank[0]
      || leftRank[1] - rightRank[1]
      || leftRank[2].localeCompare(rightRank[2], "zh-Hant");
  });
}
