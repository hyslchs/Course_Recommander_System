import type { Course } from "./types";

export type SearchField = "title" | "objective" | "weekly_progress" | "prerequisite" | "materials" | "skills";

const searchFields: SearchField[] = [
  "title",
  "objective",
  "weekly_progress",
  "prerequisite",
  "materials",
  "skills",
];

const fieldWeights: Record<SearchField, number> = {
  title: 3.2,
  objective: 1.8,
  weekly_progress: 1.3,
  prerequisite: 1.0,
  materials: 0.9,
  skills: 0.8,
};

const k1 = 1.2;
const b = 0.75;

interface IndexedField {
  length: number;
  counts: Map<string, number>;
}

interface IndexedDocument {
  fields: Record<SearchField, IndexedField>;
  titleText: string;
}

export interface SearchIndex {
  documents: Map<string, IndexedDocument>;
  documentFrequency: Map<string, number>;
  averageFieldLength: Record<SearchField, number>;
  documentCount: number;
}

export interface LexicalMatch {
  score: number;
  titleMatch: number;
  exactTitle: boolean;
  matchedTerms: string[];
  matchedFields: SearchField[];
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  const tokens: string[] = [];
  tokens.push(...(normalized.match(/[a-z0-9]+(?:[+#.-][a-z0-9]+)*/g) ?? []));

  const hanRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  for (const run of hanRuns) {
    const characters = [...run];
    tokens.push(...characters);
    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.push(`${characters[index]}${characters[index + 1]}`);
    }
  }

  for (const word of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!tokens.includes(word)) tokens.push(word);
  }
  return tokens.filter(Boolean);
}

function fieldText(course: Course, field: SearchField): string {
  if (field === "title") return `${course.name_zh} ${course.name_en}`;
  if (field === "prerequisite") return `${course.prerequisite} ${course.sections.prerequisite ?? ""}`;
  return course.sections[field] ?? "";
}

function indexField(value: string): IndexedField {
  const counts = new Map<string, number>();
  for (const token of tokenize(value)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return { length: [...counts.values()].reduce((sum, count) => sum + count, 0), counts };
}

export function buildSearchIndex(catalog: Course[]): SearchIndex {
  const documents = new Map<string, IndexedDocument>();
  const documentFrequency = new Map<string, number>();
  const fieldLengths: Record<SearchField, number[]> = {
    title: [],
    objective: [],
    weekly_progress: [],
    prerequisite: [],
    materials: [],
    skills: [],
  };

  for (const course of catalog) {
    const fields = Object.fromEntries(
      searchFields.map((field) => [field, indexField(fieldText(course, field))]),
    ) as Record<SearchField, IndexedField>;
    documents.set(course.course_id, { fields, titleText: normalizeText(fieldText(course, "title")) });
    for (const field of searchFields) {
      const indexed = fields[field];
      fieldLengths[field].push(indexed.length);
      for (const token of indexed.counts.keys()) {
        const key = `${field}:${token}`;
        documentFrequency.set(key, (documentFrequency.get(key) ?? 0) + 1);
      }
    }
  }

  const averageFieldLength = Object.fromEntries(
    searchFields.map((field) => {
      const lengths = fieldLengths[field];
      return [field, lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lengths.length)];
    }),
  ) as Record<SearchField, number>;

  return { documents, documentFrequency, averageFieldLength, documentCount: catalog.length };
}

function inverseDocumentFrequency(index: SearchIndex, field: SearchField, token: string): number {
  const documentFrequency = index.documentFrequency.get(`${field}:${token}`) ?? 0;
  if (!documentFrequency) return 0;
  return Math.log(1 + (index.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function bm25Field(index: SearchIndex, field: SearchField, document: IndexedField, queryTokens: string[]): number {
  const averageLength = index.averageFieldLength[field] || 1;
  return queryTokens.reduce((sum, token) => {
    const termFrequency = document.counts.get(token) ?? 0;
    if (!termFrequency) return sum;
    const idf = inverseDocumentFrequency(index, field, token);
    const denominator = termFrequency + k1 * (1 - b + b * document.length / averageLength);
    return sum + idf * (termFrequency * (k1 + 1)) / Math.max(denominator, 1e-6);
  }, 0);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreLexically(index: SearchIndex, course: Course, query: string): LexicalMatch {
  const queryTokens = [...new Set(tokenize(query))];
  if (!queryTokens.length) return { score: 0, titleMatch: 0, exactTitle: false, matchedTerms: [], matchedFields: [] };
  const document = index.documents.get(course.course_id);
  if (!document) return { score: 0, titleMatch: 0, exactTitle: false, matchedTerms: [], matchedFields: [] };

  const normalizedQuery = normalizeText(query).replace(/\s+/g, "");
  const titleText = document.titleText.replace(/\s+/g, "");
  const exactTitle = titleText.includes(normalizedQuery);
  const titleTokens = document.fields.title.counts;
  const matchedTerms = queryTokens.filter((token) => titleTokens.has(token));
  const matchedFields = searchFields.filter((field) => queryTokens.some((token) => document.fields[field].counts.has(token)));
  const titleCoverage = matchedTerms.length / queryTokens.length;
  const titleMatch = exactTitle ? 1 : titleCoverage;
  const rawScore = searchFields.reduce(
    (sum, field) => sum + fieldWeights[field] * bm25Field(index, field, document.fields[field], queryTokens),
    0,
  );
  const bodyScore = 1 - Math.exp(-rawScore / 8);
  return {
    score: clamp(0.55 * bodyScore + 0.45 * titleMatch),
    titleMatch,
    exactTitle,
    matchedTerms,
    matchedFields,
  };
}
