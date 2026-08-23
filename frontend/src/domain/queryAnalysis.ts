import type {
  Course,
  HardConstraints,
  QueryAnalysis,
  QueryPart,
  QueryPartRole,
  StudyLevel,
  UnsupportedQueryItem,
} from "./types";

export const QUERY_ANALYSIS_VERSION = "deterministic-v1";
export const MAX_GOALS = 4;
export const MAX_CONTEXTS = 1;
export const MAX_EXCLUSIONS = 2;
export const MAX_EMBEDDING_TEXTS = 8;
export const WEAK_SPLIT_SIMILARITY = 0.86;

export interface RouteInfo {
  id: string;
  label: string;
  policy: "soft" | "attached_required" | string;
  utterance_count?: number;
}

export interface RouteBundle {
  routes: RouteInfo[];
  vectors: Float32Array;
  dimension: number;
  threshold?: number;
  margin?: number;
}

export interface AnalyzeOptions {
  segmentVectors?: Float32Array[];
  routeBundle?: RouteBundle;
  catalog?: Course[];
}

interface Segment { text: string; start: number; end: number; strong: boolean }

const strongDelimiter = /[+＋&＆/／;；\n]+/g;
const weakDelimiter = /(?:、|，|,|\s+和\s+|和|與|跟|以及|還有|也想|並且)/g;
const unsupportedRelationRules: Array<[string, RegExp, string]> = [
  ["ALTERNATIVE", /(?:或|或者|任一|任選|都可以)/, "目前不支援替代方案關係，已回到整句搜尋。"],
  ["CONDITIONAL", /(?:如果|若|假如|沒有.*就|否則)/, "目前不支援條件式查詢，已回到整句搜尋。"],
  ["SEQUENCE", /(?:先.+再|之後再|學完.+才)/, "目前不支援學習順序，已回到整句搜尋。"],
  ["WEIGHTED", /(?:最重要|其次|優先|主要.+次要|可有可無)/, "目前不支援權重指定，已回到整句搜尋。"],
];
const negationWords = /(?:不要|不想|排除|避免|不含|不能有|非)/;
const protectedNegation = /(?:不排斥|不限|不是只有|不一定要|沒有也可以|不介意)/;
const unavailableRules: Array<[string, RegExp, string]> = [
  ["subjective", /(?:甜課|涼課|好過|給分高|輕鬆|難度|報告少|考試少|不想報告|不要考試|熱門)/, "課程資料沒有可靠的難度、給分或負擔欄位。"],
  ["temporal", /(?:未來學期|下學期|暑修|明年|115-2|116-1)/, "目前資料只包含本學期課程。"],
  ["language", /(?:英文授課|全英|中文授課)/, "目前沒有可信的正式授課語言欄位。"],
  ["campus", /(?:校區|交通|近校門|方便到)/, "目前沒有可信的校區與交通欄位。"],
];

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/[Ａ-Ｚａ-ｚ]/g, (char) => char.toLowerCase()).replace(/\s+/g, " ").trim();
}

function stripLead(value: string): string {
  return value
    .replace(/^(?:我)?(?:想學|想了解|希望學|想要學|請推薦|幫我找|推薦|找)\s*/i, "")
    .replace(/^(?:有關|關於)\s*/, "")
    .trim();
}

function validSegment(value: string): boolean {
  const clean = value.replace(/[\s，,、+＋&＆/／;；。！？!?]/g, "");
  return [...clean].length >= 2 && [...clean].length <= 40;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let numerator = 0; let aa = 0; let bb = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) { numerator += a[index] * b[index]; aa += a[index] ** 2; bb += b[index] ** 2; }
  return numerator / Math.max(Math.sqrt(aa * bb), 1e-12);
}

function candidateSegments(value: string): Segment[] {
  const result: Segment[] = [];
  const strongParts = value.split(strongDelimiter);
  if (strongParts.length > 1) {
    let cursor = 0;
    for (const piece of strongParts) {
      const start = value.indexOf(piece, cursor);
      cursor = Math.max(start + piece.length, cursor + 1);
      const pieces = piece.split(weakDelimiter);
      for (const weakPiece of pieces) {
        const offset = piece.indexOf(weakPiece);
        if (validSegment(weakPiece)) result.push({ text: stripLead(weakPiece), start: start + Math.max(0, offset), end: start + Math.max(0, offset) + weakPiece.length, strong: true });
      }
    }
    return result;
  }
  const weakParts = value.split(weakDelimiter);
  if (weakParts.length <= 1) return [{ text: stripLead(value), start: 0, end: value.length, strong: false }];
  let cursor = 0;
  for (const piece of weakParts) {
    const start = value.indexOf(piece, cursor);
    cursor = Math.max(start + piece.length, cursor + 1);
    if (validSegment(piece)) result.push({ text: stripLead(piece), start, end: start + piece.length, strong: false });
  }
  return result.length ? result : [{ text: stripLead(value), start: 0, end: value.length, strong: false }];
}

function isProtectedNegation(value: string): boolean {
  return protectedNegation.test(value);
}

function makePart(text: string, role: QueryPartRole, index: number, segment?: Segment): QueryPart {
  return { id: `${role.toLowerCase()}-${index + 1}`, text: text.trim(), role, sourceStart: segment?.start, sourceEnd: segment?.end };
}

function numberValue(value: string): number | undefined {
  const chinese: Record<string, number> = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 八: 8 };
  if (/^\d+$/.test(value)) return Number(value);
  return chinese[value];
}

function addUnique(target: number[] | undefined, values: number[]): number[] {
  return [...new Set([...(target ?? []), ...values])].sort((a, b) => a - b);
}

function parseConstraints(raw: string): { constraints: HardConstraints; parts: QueryPart[]; conflicts: string[] } {
  const constraints: HardConstraints = {};
  const parts: QueryPart[] = [];
  const conflicts: string[] = [];
  const weekdayNames: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  const weekdayMatches = [...raw.matchAll(/(不要|不含|排除|避免)?\s*(?:星期|週|周)([一二三四五六日天])|早八/g)];
  for (const match of weekdayMatches) {
    const day = match[0] === "早八" ? 1 : weekdayNames[match[2]];
    if (!day) continue;
    const excluded = Boolean(match[1]) || match[0] === "早八" && /(?:不要|不含|排除|避免)\s*早八/.test(raw);
    const key = excluded ? "excludedWeekdays" : "weekdays";
    constraints[key] = addUnique(constraints[key] as number[] | undefined, [day]);
    if (match[0] === "早八") constraints.sections = [...new Set([...(constraints.sections ?? []), "D1"])];
  }
  const creditMatches = [...raw.matchAll(/(不要|不含|排除|避免)?\s*(\d+|零|一|二|兩|三|四|五|六|八)\s*學分/g)];
  for (const match of creditMatches) {
    const value = numberValue(match[2]); if (value === undefined) continue;
    const excluded = Boolean(match[1]);
    const key = excluded ? "excludedCredits" : "credits";
    constraints[key] = addUnique(constraints[key] as number[] | undefined, [value]);
  }
  const sectionMatches = [...raw.matchAll(/(不要|不含|排除|避免)?\s*([DE](?:[0-8]|N)|早八)/gi)];
  for (const match of sectionMatches) {
    const section = match[2].toUpperCase() === "早八" ? "D1" : match[2].toUpperCase();
    const key = match[1] ? "excludedSections" : "sections";
    constraints[key] = [...new Set([...(constraints[key] ?? []), section])];
  }
  for (const match of raw.matchAll(/([DE])([0-8])\s*(?:-|–|~|至)\s*([DE])([0-8])/gi)) {
    if (match[1].toUpperCase() !== match[3].toUpperCase()) continue;
    const sections = Array.from({ length: Number(match[4]) - Number(match[2]) + 1 }, (_, index) => `${match[1].toUpperCase()}${Number(match[2]) + index}`);
    constraints.sections = [...new Set([...(constraints.sections ?? []), ...sections])];
  }
  const enumRules: Array<[keyof HardConstraints, keyof HardConstraints, RegExp, string]> = [
    ["requiredElective", "excludedRequiredElective", /必修|選修|通識|輔系/g, "required"],
    ["divisions", "excludedDivisions", /日間部|進修部|研究所|二年制/g, "division"],
  ];
  for (const [includeKey, excludeKey, pattern] of enumRules) {
    for (const match of raw.matchAll(pattern)) {
      const excluded = /(?:不要|不含|排除|避免)\s*$/.test(raw.slice(Math.max(0, match.index! - 4), match.index));
      const key = excluded ? excludeKey : includeKey;
      constraints[key] = [...new Set([...(constraints[key] ?? []), match[0]])] as never;
    }
  }
  const studyRules: Array<[StudyLevel, RegExp]> = [["undergraduate", /大學部/], ["master", /碩士班|研究所/], ["doctoral", /博士班/]];
  for (const [level, pattern] of studyRules) if (pattern.test(raw)) constraints.studyLevels = [...new Set([...(constraints.studyLevels ?? []), level])];

  const includeWeekdays = constraints.weekdays ?? [];
  const excludeWeekdays = constraints.excludedWeekdays ?? [];
  if (includeWeekdays.some((value) => excludeWeekdays.includes(value))) conflicts.push("同一星期同時包含與排除");
  const includeCredits = constraints.credits ?? [];
  const excludeCredits = constraints.excludedCredits ?? [];
  if (includeCredits.some((value) => excludeCredits.includes(value))) conflicts.push("同一學分同時包含與排除");
  for (const [key, values] of Object.entries(constraints)) {
    if (!Array.isArray(values) || !values.length) continue;
    const label = key.replace(/^excluded/, "排除");
    parts.push({ id: `constraint-${parts.length + 1}`, text: values.join("、"), role: "EXCLUSION", metadataConstraint: key as keyof HardConstraints, required: key.startsWith("excluded") });
    void label;
  }
  return { constraints, parts, conflicts };
}

function matchCatalogEntity(raw: string, catalog: Course[] | undefined, kind: "teacher" | "department"): string | undefined {
  if (!catalog) return undefined;
  if (kind === "teacher") {
    const values = [...new Set(catalog.map((course) => course.teacher).filter((value): value is string => Boolean(value && value.length >= 2)))];
    const matches = values.filter((value) => raw.includes(value));
    return matches.length === 1 ? matches[0] : undefined;
  }
  const identities = new Map<string, string>();
  for (const course of catalog) {
    const identity = course.department_identity;
    if (!identity) continue;
    for (const label of [course.official_department_name_zh, course.official_department_label, course.department_display]) if (label) identities.set(label, identity);
  }
  const matches = [...identities.entries()].filter(([label]) => raw.includes(label));
  return matches.length === 1 ? matches[0][1] : undefined;
}

function routeMatch(text: string, vector: Float32Array | undefined, routeBundle: RouteBundle | undefined): { route?: RouteInfo; score?: number; margin?: number } {
  const lexicalRoutes = routeBundle?.routes.filter((route) => routeToken(route.id).test(text)) ?? [];
  if (lexicalRoutes.length === 1) return { route: lexicalRoutes[0], score: 1, margin: 1 };
  if (!vector || !routeBundle?.vectors.length || !routeBundle.routes.length) return {};
  const scores = routeBundle.routes.map((_, index) => cosine(vector, routeBundle.vectors.subarray(index * routeBundle.dimension, (index + 1) * routeBundle.dimension)));
  const order = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
  const best = order[0]; const second = order[1]?.score ?? -1;
  if (!best || best.score < (routeBundle.threshold ?? 0.78) || best.score - second < (routeBundle.margin ?? 0.04)) return {};
  return { route: routeBundle.routes[best.index], score: best.score, margin: best.score - second };
}

function routeToken(routeId: string): RegExp {
  return {
    capstone: /畢業專題|專題製作|專題實作|畢業製作|專題/,
    internship: /實習/,
    hands_on: /實作|動手做|實務操作|工作坊/,
    beginner: /初學者|零基礎|入門|新手/,
    career_goal: /職涯|就業|轉職|找工作|工作/,
    research: /研究方法|學術研究|論文研究|做研究|研究/,
  }[routeId] ?? /$a/;
}

export function embeddingTextsForAnalysis(analysis: QueryAnalysis): string[] {
  return [analysis.rawQuery, ...analysis.goals, ...analysis.contexts, ...analysis.exclusions.filter((part) => !part.metadataConstraint)]
    .map((part) => typeof part === "string" ? part : part.text)
    .filter((text, index, values) => Boolean(text.trim()) && values.indexOf(text) === index);
}

export function analyzeQuery(rawQuery: string, options: AnalyzeOptions = {}): QueryAnalysis {
  const raw = rawQuery.trim();
  const normalizedQuery = normalize(raw);
  const unsupportedRelations: UnsupportedQueryItem[] = [];
  const unsupportedConditions: UnsupportedQueryItem[] = [];
  for (const [kind, pattern, message] of unsupportedRelationRules) if (pattern.test(normalizedQuery)) unsupportedRelations.push({ kind, text: normalizedQuery, message });
  for (const [kind, pattern, message] of unavailableRules) if (pattern.test(normalizedQuery)) unsupportedConditions.push({ kind, text: normalizedQuery, message });
  const constraintResult = parseConstraints(normalizedQuery);
  const segments = candidateSegments(normalizedQuery);
  let semanticSegments = segments;
  if (segments.length > 1 && !segments.some((segment) => segment.strong) && options.segmentVectors?.length === segments.length) {
    const accepted: Segment[] = [segments[0]];
    for (let index = 1; index < segments.length; index += 1) {
      const similarity = cosine(options.segmentVectors[0], options.segmentVectors[index]);
      if (similarity < WEAK_SPLIT_SIMILARITY) accepted.push(segments[index]);
    }
    semanticSegments = accepted.length > 1 ? accepted : [{ text: stripLead(normalizedQuery), start: 0, end: normalizedQuery.length, strong: false }];
  }

  const goals: QueryPart[] = [];
  const contexts: QueryPart[] = [];
  let contextOverflow = false;
  const exclusions: QueryPart[] = [...constraintResult.parts];
  const exclusionPattern = /(?:不要|不想|排除|避免|不含|不能有|非)\s*([^+＋&＆/／;；\n，,。]+)/g;
  let positiveText = normalizedQuery;
  for (const match of normalizedQuery.matchAll(exclusionPattern)) {
    if (isProtectedNegation(match[0])) continue;
    const text = match[1]
      .replace(/(?:星期|週|周)[一二三四五六日天]/g, "")
      .replace(/(?:\d+|零|一|二|兩|三|四|五|六|八)\s*學分/g, "")
      .replace(/[DE](?:[0-8]|N)/gi, "")
      .replace(/^[\s的與和跟]+|[\s的與和跟]+$/g, "")
      .trim();
    if (validSegment(text) && !/^(?:必修|選修|通識|輔系|日間部|進修部|研究所|二年制|大學部|碩士班|博士班)$/.test(text)) exclusions.push(makePart(stripLead(text), "EXCLUSION", exclusions.length));
    positiveText = positiveText.replace(match[0], " ");
  }
  const segmentTexts = semanticSegments.map((segment) => segment.text).filter(Boolean);
  for (const [index, segment] of semanticSegments.entries()) {
    let candidate = stripLead(segment.text);
    candidate = candidate
      .replace(/(?:不要|不含|排除|避免)?\s*(?:星期|週|周)[一二三四五六日天]/g, "")
      .replace(/(?:不要|不含|排除|避免)?\s*(?:\d+|零|一|二|兩|三|四|五|六|八)\s*學分/g, "")
      .replace(/(?:不要|不含|排除|避免)?\s*[DE](?:[0-8]|N)/gi, "")
      .replace(/^(?:只要|想要|需要|且|和|與|跟|的)+/g, "")
      .replace(/(?:課程|課)$/g, "")
      .trim();
    if (unavailableRules.some(([, pattern]) => pattern.test(candidate))) {
      candidate = stripLead(candidate.split(/(?:但|可是|同時要|而且要)/)[0]);
    }
    if (unavailableRules.some(([, pattern]) => pattern.test(candidate)) && /^(?:甜課|涼課|好過|給分高|輕鬆|難度|報告少|考試少|下學期|未來學期|暑修|英文授課|全英|校區|交通)/.test(candidate)) continue;
    if (!candidate || (negationWords.test(candidate) && !isProtectedNegation(candidate))) continue;
    if (/^(?:星期|週|周|早八|\d+\s*學分|必修|選修|通識|輔系|日間部|進修部|研究所|大學部|碩士班|博士班)/.test(candidate)) continue;
    const vector = options.segmentVectors?.[index];
    const matched = routeMatch(candidate, vector, options.routeBundle);
    if (matched.route) {
      if (contexts.length >= MAX_CONTEXTS) contextOverflow = true;
      const tokenMatch = candidate.match(routeToken(matched.route.id));
      const remainder = tokenMatch ? candidate.replace(tokenMatch[0], " ").replace(/^(?:做|想學|我想學|希望學)\s*/, "").replace(/^[\s的之與和以及跟]+|[\s的之與和以及跟]+$/g, "").trim() : "";
      const contextText = tokenMatch?.[0] ?? candidate;
      if (contexts.length < MAX_CONTEXTS) contexts.push({ ...makePart(contextText, "CONTEXT", contexts.length, segment), routeId: matched.route.id, routeLabel: matched.route.label, routePolicy: matched.route.policy, routeScore: matched.score, required: matched.route.policy === "attached_required" });
      for (const goalText of remainder.split(weakDelimiter).map((value) => stripLead(value)).filter((value) => validSegment(value))) {
        if (goals.length >= MAX_GOALS) break;
        goals.push(makePart(goalText, "GOAL", goals.length, segment));
      }
      continue;
    }
    if (candidate.length >= 2) goals.push(makePart(candidate, "GOAL", goals.length, segment));
  }
  if (!goals.length && !contexts.length && positiveText.trim() && !constraintResult.parts.length) goals.push(makePart(stripLead(positiveText), "GOAL", 0));

  const teacher = matchCatalogEntity(normalizedQuery, options.catalog, "teacher");
  const departmentIdentity = matchCatalogEntity(normalizedQuery, options.catalog, "department");
  if (teacher) constraintResult.constraints.teacher = teacher;
  if (departmentIdentity) constraintResult.constraints.departmentIdentity = departmentIdentity;
  if (teacher) exclusions.push({ id: `constraint-${exclusions.length + 1}`, text: teacher, role: "EXCLUSION", metadataConstraint: "teacher" });
  if (departmentIdentity) exclusions.push({ id: `constraint-${exclusions.length + 1}`, text: departmentIdentity, role: "EXCLUSION", metadataConstraint: "departmentIdentity" });

  const requiredContext = contexts.some((context) => context.required);
  let relation: QueryAnalysis["relation"] = "SINGLE";
  let fallbackReason: string | undefined;
  if (unsupportedRelations.length) { relation = "FALLBACK"; fallbackReason = "查詢包含目前不支援的關係"; }
  else if (unsupportedConditions.length && !goals.length) { relation = "FALLBACK"; fallbackReason = "查詢條件目前沒有可靠資料可回答"; }
  else if (constraintResult.conflicts.length) { relation = "FALLBACK"; fallbackReason = constraintResult.conflicts.join("；"); }
  else if (goals.length > MAX_GOALS || contexts.length > MAX_CONTEXTS || contextOverflow || exclusions.filter((part) => !part.metadataConstraint).length > MAX_EXCLUSIONS) { relation = "FALLBACK"; fallbackReason = "需求片段超過第一版支援上限"; }
  else if (!goals.length && Object.keys(constraintResult.constraints).length) relation = "FILTER_ONLY";
  else if (goals.length === 1 && !requiredContext) relation = "SINGLE";
  else if (requiredContext || /(?:同一門|同時包含|兼具|結合|同時符合)/.test(normalizedQuery)) relation = "INTERSECTION";
  else if (goals.length >= 2) relation = "COVERAGE";
  else if (!goals.length) { relation = "FALLBACK"; fallbackReason = "找不到可辨識的學習目標"; }

  const warnings = [...unsupportedRelations.map((item) => item.message), ...unsupportedConditions.map((item) => item.message)];
  if (fallbackReason) warnings.push(`${fallbackReason}，保留原始整句搜尋。`);
  if (unsupportedConditions.length && goals.length) warnings.push("部分條件沒有可靠欄位，未套用該條件；仍依可辨識目標搜尋。");
  const allParts = [...goals, ...contexts, ...exclusions];
  const embeddingCount = new Set([normalizedQuery, ...allParts.map((part) => part.text)]).size;
  if (embeddingCount > MAX_EMBEDDING_TEXTS && relation !== "FALLBACK") { relation = "FALLBACK"; fallbackReason = "查詢向量數量超過 8 個上限"; warnings.push("需求過多，未靜默截斷。保留原始整句搜尋。"); }
  const confidence = relation === "FALLBACK" ? 0.2 : relation === "SINGLE" ? 0.95 : 0.82;
  return {
    rawQuery: raw,
    normalizedQuery,
    relation,
    goals,
    contexts,
    exclusions,
    hardConstraints: constraintResult.constraints,
    unsupportedRelations,
    unsupportedConditions,
    confidence,
    fallbackReason,
    warnings,
  };
}
