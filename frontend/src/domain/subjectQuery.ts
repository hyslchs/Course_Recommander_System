export type DetectedFilterKind =
  | "profile"
  | "schedule"
  | "credit"
  | "study_level"
  | "prerequisite"
  | "course_scope"
  | "exclusion";

export interface DetectedFilterPhrase {
  kind: DetectedFilterKind;
  text: string;
}

export interface SanitizedSubjectQuery {
  rawQuery: string;
  subjectQuery: string;
  detectedFilterPhrases: DetectedFilterPhrase[];
}

const filterPatterns: Array<{ kind: DetectedFilterKind; pattern: RegExp }> = [
  {
    kind: "profile",
    pattern: /(?:我是|身為)\s*[^，,；;。\n]{1,30}?(?:學生|[一二三四五六七1-7]\s*年級)(?:學生)?/g,
  },
  {
    kind: "exclusion",
    pattern: /(?:不要|不想要?|避免|排除|不含|不能有|別(?:再)?推薦)\s*[^，,；;。\n]+/g,
  },
  {
    kind: "schedule",
    pattern: /(?:只能|只可|僅能|限於|希望)?\s*(?:上|安排|選)?\s*(?:(?:平日|週末|周末|星期[一二三四五六日天]|週[一二三四五六日天]|周[一二三四五六日天])(?:白天|日間|晚間|晚上|夜間|早上|上午|下午)?(?:\s*(?:或|、|和|與)\s*)?)+(?:上課|的課)?/g,
  },
  {
    kind: "schedule",
    pattern: /(?:只能|只可|僅能|限於|希望)?\s*(?:上|安排|選)?\s*(?:白天|日間|晚間|晚上|夜間)(?:上課|的課)?/g,
  },
  {
    kind: "schedule",
    pattern: /(?:不要|避免|排除)?\s*(?:和|與)?\s*(?:目前)?課表衝堂|不要衝堂|避免衝堂/g,
  },
  {
    kind: "credit",
    pattern: /(?:只要|限定|限|希望)?\s*(?:零|一|二|兩|三|四|五|六|七|八|\d+)\s*學分(?:的課(?:程)?)?/g,
  },
  {
    kind: "study_level",
    pattern: /(?:只要|僅限|限|適合)?\s*(?:大學部|碩士班|研究所|博士班|進修部|日間部)(?:學生|課程|的課)?/g,
  },
  {
    kind: "prerequisite",
    pattern: /(?:沒有|無|免|不需要|無需|無須)\s*(?:高階)?先修(?:課程|要求|條件)?|(?:只要|優先)?\s*無先修(?:課程|要求|條件)?/g,
  },
  {
    kind: "course_scope",
    pattern: /(?:只要|僅限|限|優先)?\s*(?:本系|外系|跨系|通識|必修|選修)(?:課程|的課)?/g,
  },
];

function cleanSubjectText(value: string): string {
  return value
    .replace(/(^|[，,；;。]\s*)(?:我)?(?:想|希望|打算)(?:要)?(?:從零開始)?(?:學|了解|修|找)\s*/g, "$1")
    .replace(/(^|[，,；;。]\s*)(?:也|並且|而且|同時)\s*/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*([，,；;。])\s*/g, "$1")
    .replace(/[，,；;。]{2,}/g, "、")
    .replace(/,/g, "，")
    .replace(/;/g, "；")
    .replace(/^[\s，,、；;。與和]+|[\s，,、；;。與和]+$/g, "")
    .trim();
}

export function sanitizeSubjectQuery(rawQuery: string): SanitizedSubjectQuery {
  const normalized = rawQuery.normalize("NFKC").trim();
  const detectedFilterPhrases: DetectedFilterPhrase[] = [];
  let subjectQuery = normalized;

  for (const { kind, pattern } of filterPatterns) {
    subjectQuery = subjectQuery.replace(pattern, (matched) => {
      const text = matched.trim();
      if (text) detectedFilterPhrases.push({ kind, text });
      return " ";
    });
  }

  const unique = detectedFilterPhrases.filter(
    (item, index, values) => values.findIndex((candidate) => candidate.kind === item.kind && candidate.text === item.text) === index,
  );

  return {
    rawQuery: normalized,
    subjectQuery: cleanSubjectText(subjectQuery),
    detectedFilterPhrases: unique,
  };
}

export const detectedFilterLabels: Record<DetectedFilterKind, string> = {
  profile: "個人身分",
  schedule: "上課時間",
  credit: "學分",
  study_level: "學制／部別",
  prerequisite: "先修條件",
  course_scope: "課程範圍",
  exclusion: "排除描述",
};
