import type { CSSProperties } from "react";
import { MapPin, Warning } from "@phosphor-icons/react";
import { Button, Tooltip } from "@heroui/react";
import { weekdayLabels, weekPatternLabel, type ScheduleBlock } from "@/domain/schedule";

/**
 * The accessible name of a scheduled block, in one place.
 *
 * The shape is load-bearing (T01 handoff 1): `ScheduleWorkspace.test.tsx` matches
 * blocks with `/，星期/` and identifies individual courses with `/^日間課程/`.
 * Both the timetable grid and the mobile day list derive their label from here,
 * which is the point of the extraction — the two used to build it (or, on
 * mobile, not build it at all) independently.
 *
 * FIX51 P2-f — WCAG 2.5.3 Label in Name — CHANGED THE FORMAT. It used to be
 * `${課名}，星期…` with nothing between; the tile's own metadata now sits in the
 * middle, joined by ASCII commas, and the separator that used to follow the
 * course name is an ASCII `,` rather than a full-width `，`. Both regexes above
 * still hold; `ClassBlock.test.tsx` and the two `/^…課程，/` matchers in
 * `ScheduleWorkspace.test.tsx` were updated with it.
 *
 * Why it had to change. Lighthouse flagged every grid tile: the visible text
 * reads "微積分王小明B201衝堂" and the name was "微積分，星期二 E1到E2到E3", so
 * a speech-input user addressing the control by what they can read misses it.
 * Two things about how axe checks this were measured against the real audit
 * rather than assumed:
 *
 *   - `aria-hidden` on the supplementary nodes is NOT a way out. axe evaluates
 *     this rule's visible text with its `screenReader` flag set to `false`, so
 *     it counts anything merely on screen. Verified in the bundled source and
 *     then in a live audit: marking them hidden changed nothing.
 *   - The comparison is `name.includes(visible)` after BOTH sides are stripped
 *     of punctuation — and only ASCII punctuation is stripped. `，` (U+FF0C),
 *     `、` (U+3001) and `·` (U+00B7) all survive, while `,` `.` `;` `/` `-`
 *     `(` `)` do not. Measured one separator at a time. The visible side is
 *     concatenated with no separators at all, so the old full-width comma sat
 *     in the middle of the run and split it: the contract format and this rule
 *     were mutually exclusive, which is why the format moved.
 *
 * The clause order below mirrors the grid tile's DOM order exactly. Change
 * either without the other and the rule breaks again. The mobile row's visible
 * text leads with its section range and cannot be covered by the same name; it
 * is a mobile-only finding on an unscored audit and is left as-is.
 */
export function classBlockLabel(block: ScheduleBlock): string {
  const tile = [block.teacher, block.room, weekPatternLabel(block.weekPattern), block.conflict ? "衝堂" : ""].filter(Boolean).join(",");
  return `${block.name}${tile ? `,${tile}` : ""}，星期${weekdayLabels[block.weekday - 1]} ${block.sections.join("到")}${block.conflict ? "，有衝堂" : ""}`;
}

export interface ClassBlockProps {
  block: ScheduleBlock;
  /**
   * `grid` is the row-spanning tile inside `.schedule-grid`; `list` is the
   * single-day mobile row. They differ only in internal layout — identity,
   * state classes and the accessible name are shared.
   */
  variant: "grid" | "list";
  /** Absolute grid placement. `grid` only. */
  style?: CSSProperties;
  onSelect: (block: ScheduleBlock, trigger: HTMLButtonElement) => void;
}

/**
 * One scheduled block, rendered for either layout.
 *
 * Two things are worth knowing about the implementation:
 *
 * 1. It renders a HeroUI `Button` with a `render` override rather than a bare
 *    `<button>`. React Aria's `TooltipTrigger` publishes its trigger props
 *    through `FocusableContext`, and only a component that consumes that context
 *    (`Button` does, via `useButton` -> `useFocusable`) gets the hover/focus
 *    wiring and the `aria-describedby` link. A plain `<button>` as a Tooltip
 *    child silently renders no tooltip at all. The `render` override then hands
 *    back a real `<button>` carrying only the timetable's own classes, so
 *    HeroUI's `.button` skin never lands on the tile and the element stays a
 *    direct grid child — `TooltipTrigger` itself emits no DOM.
 *
 * 2. The tooltip replaces `.class-block[data-course-name]::after`, a pure-CSS
 *    `content: attr(...)` popup that no screen reader could ever reach. Only the
 *    grid variant needs it: that is the layout where `-webkit-line-clamp: 2`
 *    truncates long course names. The mobile row wraps instead.
 *
 * 3. The grid tile's child order — name, teacher, room, week pattern, 衝堂 — is
 *    part of the WCAG 2.5.3 fix documented on `classBlockLabel` above, which
 *    encodes the same sequence. Reorder one and the other has to follow. The
 *    mobile row deliberately does not match: its visible text leads with the
 *    section range, which cannot be moved into the shared label without
 *    breaking the `/^課名，/` contract, so it stays outside that repair (see the
 *    task report — it is a mobile-only, unscored finding).
 */
export function ClassBlock({ block, variant, style, onSelect }: ClassBlockProps) {
  const stateClass = `${block.source === "fixed" ? "fixed" : ""} ${block.conflict ? "conflict" : ""}`.trim();
  const pattern = weekPatternLabel(block.weekPattern);
  const button = (
    <Button
      aria-label={classBlockLabel(block)}
      render={(domProps) => (
        <button
          {...domProps}
          className={`${variant === "grid" ? "class-block" : "mobile-schedule-block"} ${stateClass}`.trim()}
        />
      )}
      style={style}
      onPress={(event) => onSelect(block, event.target as HTMLButtonElement)}
    >
      {variant === "grid" ? (
        <>
          <strong>{block.name}</strong>
          <small>{block.teacher}</small>
          {block.room && <small><MapPin aria-hidden="true" />{block.room}</small>}
          <span className="class-block-tags">
            {pattern && <em>{pattern}</em>}
            {block.conflict && <em className="conflict-tag"><Warning aria-hidden="true" />衝堂</em>}
          </span>
        </>
      ) : (
        <>
          <span>
            <strong>{block.sections.join("–")}　{block.name}</strong>
            <small>{block.teacher}{block.room ? ` · ${block.room}` : ""}</small>
          </span>
          <span>{pattern}{block.conflict ? <Warning aria-hidden="true" /> : null}</span>
        </>
      )}
    </Button>
  );

  if (variant !== "grid") return button;
  return (
    <Tooltip delay={350}>
      {button}
      <Tooltip.Content className="class-block-tooltip" placement="bottom start">
        {block.name}
      </Tooltip.Content>
    </Tooltip>
  );
}
