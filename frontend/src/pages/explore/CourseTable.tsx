import { useMemo, useState } from "react";
import { Skeleton, Table, type SortDescriptor } from "@heroui/react";
import { EligibilityChip } from "@/components/CourseCard";
import { inferAudienceDepartment } from "@/domain/eligibility";
import { formatMeetings, SCHEDULE_SECTIONS } from "@/domain/schedule";
import type { Course, EligibilityStatus } from "@/domain/types";

/** One catalogue row: the course plus the eligibility verdict computed for it. */
export interface CourseRow {
  course: Course;
  status: EligibilityStatus;
}

export type CourseColumnId =
  | "ava_no" | "name_zh" | "teacher" | "meeting" | "credits" | "department" | "eligibility";

interface ColumnSpec {
  id: CourseColumnId;
  label: string;
  /** Width and alignment. Widths are caps, not floors — the table still shrinks. */
  className: string;
}

/**
 * The seven comparison axes of plan T34, in reading order.
 *
 * `tabular-nums` on 課號 and 學分 is a **measured no-op kept for the future**,
 * not decoration: plan §4.4 picked Inter for real tabular figures, but Inter has
 * never been hosted or installed (`document.fonts` probe: a string set in
 * `"Inter"` renders identically to one set in a nonsense family, i.e. it falls
 * through to the generic). Latin therefore renders in Noto Sans TC, whose digits
 * already all advance 0.555em — measured 0–9 at 100px, every glyph 55.5px, with
 * and without the feature. Columns align today; the declaration is what keeps
 * them aligned if T41 ever does ship Inter. See the T41 note in the report.
 */
export const courseTableColumns: ColumnSpec[] = [
  { id: "ava_no", label: "課號", className: "w-28 tabular-nums" },
  { id: "name_zh", label: "課名", className: "min-w-52" },
  { id: "teacher", label: "教師", className: "w-28" },
  { id: "meeting", label: "時間", className: "w-56" },
  { id: "credits", label: "學分", className: "w-20 text-end tabular-nums" },
  { id: "department", label: "系所", className: "w-44" },
  { id: "eligibility", label: "資格", className: "w-36" },
];

const SECTION_ORDER = new Map<string, number>(SCHEDULE_SECTIONS.map((section, index) => [section, index]));

/**
 * Worst-first, so one descending click surfaces everything a student can
 * actually take. Not a colour ordering — it is the same severity ranking the
 * chip's icon channel encodes.
 */
const ELIGIBILITY_ORDER: Record<EligibilityStatus, number> = {
  eligible_confirmed: 0,
  no_known_restriction: 1,
  needs_confirmation: 2,
  blocked_confirmed: 3,
};

/** Earliest slot the course occupies, as a single sortable number. */
function meetingRank(course: Course): number {
  const unknownSection: number = SCHEDULE_SECTIONS.length;
  let best = Number.POSITIVE_INFINITY;
  for (const meeting of course.meetings) {
    // A meeting with no weekday is "time to be announced": rank it after 星期日
    // so it lands at the bottom of an ascending sort, not the top.
    const weekday = meeting.weekday ?? 9;
    let section = unknownSection;
    for (const value of meeting.sections) {
      section = Math.min(section, SECTION_ORDER.get(value) ?? unknownSection);
    }
    best = Math.min(best, weekday * 100 + section);
  }
  return best;
}

export function courseDepartmentLabel(course: Course): string {
  return course.official_department_label ?? course.department_display ?? inferAudienceDepartment(course);
}

function compare(left: CourseRow, right: CourseRow, column: CourseColumnId): number {
  switch (column) {
    case "credits": {
      // `null` credits are "not stated", not zero, so they sink to the bottom of
      // an ascending sort instead of pretending to be the cheapest course.
      const a = left.course.credits, b = right.course.credits;
      if (a === b) return 0;
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      return a - b;
    }
    case "meeting":
      return meetingRank(left.course) - meetingRank(right.course);
    case "eligibility":
      return ELIGIBILITY_ORDER[left.status] - ELIGIBILITY_ORDER[right.status];
    case "department":
      return courseDepartmentLabel(left.course).localeCompare(courseDepartmentLabel(right.course), "zh-Hant");
    case "ava_no":
      // `numeric` so 課號 9 sorts before 10 rather than after it.
      return left.course.ava_no.localeCompare(right.course.ava_no, "zh-Hant", { numeric: true });
    default:
      return String(left.course[column] ?? "").localeCompare(String(right.course[column] ?? ""), "zh-Hant");
  }
}

/**
 * Sorts a *page* of rows. Exported so the ordering rules are unit-testable
 * without a DOM.
 *
 * KNOWN LIMITATION, deliberate and surfaced in the UI: `/api/v1/courses` sorts
 * server-side but has no direction parameter (`web.py:203` allows five keys,
 * always ascending), so a globally-correct descending page cannot be requested.
 * Rather than mix a global ascending order with a page-local reversal — which
 * silently lies about which 25 rows you are looking at — both directions are
 * page-local and the table says so. Two of the seven columns (時間, 資格) are
 * client-derived and could never have been sorted server-side anyway.
 */
export function sortCourseRows(rows: CourseRow[], descriptor: SortDescriptor | undefined): CourseRow[] {
  if (!descriptor?.column) return rows;
  const column = descriptor.column as CourseColumnId;
  const sign = descriptor.direction === "descending" ? -1 : 1;
  // `sort` is stable, so equal keys keep the server's 課名 ordering.
  return [...rows].sort((left, right) => compare(left, right, column) * sign);
}

/**
 * `text-foreground`, not HeroUI's `text-muted`, and the reason is measured.
 *
 * `.table__column` ships as `text-muted` on `bg-surface-secondary`. The legacy
 * unlayered `:root` still shadows `--muted` with #667069 (T30 handoff #3), which
 * lands at **4.47:1** on the light header — 0.03 under AA, and Lighthouse's axe
 * run failed the page on exactly these four spans. In fju-dark it is worse:
 * `--muted` does not flip either, so the same text measured **2.99:1** on the
 * dark header. `--foreground` does flip, and gives 17.76:1 light / 14.49:1 dark.
 *
 * This is not a workaround for a token that T41 will fix. A sortable column
 * header is a *control* — it takes focus, it takes Enter, it changes the whole
 * result order — and de-emphasising a control below body text was the wrong
 * default for this table regardless of what `--muted` resolves to. Choosing the
 * semantic token that fits also means nothing here has to be unpicked later.
 *
 * The size overrides are not optional either: HeroUI ships `.table__column` at
 * 12px and `.table__cell` at 14px, both under plan §4.4's 15px floor for CJK
 * content text. `py-3` lifts the header row to a measured 47px — a sortable
 * `<th>` IS the control in React Aria, there is no nested button to size.
 */
const HEADER_CLASS = "py-3 text-[0.9375rem] text-foreground";
const CELL_CLASS = "text-[0.9375rem]";

/**
 * `min-w` on the `<table>` rather than on the wrapper: `Table.ScrollContainer`
 * only scrolls what overflows it, and the seven columns need ~880px before the
 * 課名 column starts wrapping to three lines. The table is mounted only at `lg`
 * and above, so in practice the container is wider than this and nothing
 * scrolls; the value is a floor for the 1024–1100px band, not a design width.
 */
const TABLE_MIN_WIDTH = "min-w-[55rem]";

export function CourseTable({ rows }: { rows: CourseRow[] }) {
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>();
  const sorted = useMemo(() => sortCourseRows(rows, sortDescriptor), [rows, sortDescriptor]);
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content
          aria-label="課程查詢結果"
          className={TABLE_MIN_WIDTH}
          sortDescriptor={sortDescriptor}
          onSortChange={setSortDescriptor}
        >
          <Table.Header>
            {courseTableColumns.map((column) => (
              <Table.Column
                allowsSorting
                className={`${HEADER_CLASS} ${column.className}`}
                id={column.id}
                isRowHeader={column.id === "name_zh"}
                key={column.id}
              >
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>
                    {column.label}
                  </Table.SortableColumnHeader>
                )}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body>
            {sorted.map(({ course, status }) => (
              <Table.Row id={course.course_id} key={course.course_id}>
                <Table.Cell className={CELL_CLASS}>{course.ava_no}</Table.Cell>
                <Table.Cell className={CELL_CLASS}>
                  {/*
                    There is no course-detail route, so the syllabus is the only
                    place left to go from a table row. `text-link` rather than the
                    legacy `a{color:inherit}`, which would have made it invisible
                    as a link; the underline keeps it from being colour-only.
                  */}
                  {/* `leading-6` is not decoration: `.table__cell` inherits a
                      1.4 line-height, which made this link a 21px-high target,
                      3px under WCAG 2.5.8's 24px floor. It only ever renders at
                      `lg`+ (a pointer context), so 24 rather than 44 is the bar
                      that applies — but it has to clear it. */}
                  <a
                    className="inline-block font-medium leading-6 text-link underline underline-offset-2"
                    href={course.source_url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {course.name_zh}
                  </a>
                  {course.name_en ? <span className="block text-[0.8125rem] text-muted">{course.name_en}</span> : null}
                </Table.Cell>
                <Table.Cell className={CELL_CLASS}>{course.teacher || "教師未定"}</Table.Cell>
                <Table.Cell className={CELL_CLASS}>{formatMeetings(course)}</Table.Cell>
                <Table.Cell className={`${CELL_CLASS} text-end tabular-nums`}>{course.credits ?? "—"}</Table.Cell>
                <Table.Cell className={CELL_CLASS}>{courseDepartmentLabel(course)}</Table.Cell>
                <Table.Cell className={CELL_CLASS}>
                  <EligibilityChip labels="short" status={status} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}

/**
 * A skeleton whose rows are the same box as real rows, so the results landing
 * moves nothing — which is the whole point of it existing. A hand-measured
 * `h-[3.25rem]` placeholder would drift the first time HeroUI changes
 * `.table__cell`'s padding; carrying HeroUI's own BEM classes cannot.
 *
 * Deliberately *not* built from `<Table>`. React Aria's table is a real grid
 * widget: it demands an `isRowHeader` column, puts `tabindex="0"` on the
 * `<table>` and manages roving focus over the rows. A grid of eight empty rows
 * is noise a screen-reader user has to walk past, and it cannot be
 * `aria-hidden` while it is still focusable. Plain markup plus the same
 * stylesheet gives the identical box with none of the widget, so one
 * `aria-hidden` on the table is both honest and safe, and the `role="status"`
 * wrapper carries the only thing worth announcing.
 */
export function CourseTableSkeleton({ count = 8, label }: { count?: number; label: string }) {
  return (
    <div aria-label={label} role="status">
      <div className="table-root table-root--primary">
        <div className="table__scroll-container">
          <table aria-hidden="true" className={`table__content ${TABLE_MIN_WIDTH}`}>
            <thead className="table__header">
              <tr>
                {courseTableColumns.map((column) => (
                  <th className={`table__column ${HEADER_CLASS} ${column.className}`} key={column.id} scope="col">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="table__body">
              {Array.from({ length: count }, (_, index) => (
                <tr className="table__row" key={index}>
                  {courseTableColumns.map((column) => (
                    <td className={`table__cell ${CELL_CLASS}`} key={column.id}>
                      {/*
                        課名 is the tallest cell in every real row — a 15px link
                        line plus the 13px English title under it — so it is what
                        sets the row height, and it gets two bones sized to those
                        two line boxes. Measured at 1440px: skeleton rows 72px
                        against real rows of 70/71/73/91 (median 73), header
                        47px in both. The remaining spread is courses with two
                        meeting lines in 時間, which no fixed placeholder can
                        predict.
                      */}
                      <Skeleton className={`w-full rounded ${column.id === "name_zh" ? "h-6" : "h-5"}`} />
                      {column.id === "name_zh"
                        ? <Skeleton className="mt-1 h-5 w-3/5 rounded" />
                        : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
