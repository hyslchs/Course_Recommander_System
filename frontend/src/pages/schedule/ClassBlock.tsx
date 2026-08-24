import type { CSSProperties } from "react";
import { MapPin, Warning } from "@phosphor-icons/react";
import { Button, Tooltip } from "@heroui/react";
import { weekdayLabels, weekPatternLabel, type ScheduleBlock } from "@/domain/schedule";

/**
 * The accessible name of a scheduled block, in one place.
 *
 * The shape is load-bearing (T01 handoff 1): `ScheduleWorkspace.test.tsx` matches
 * blocks with `/，星期/` and identifies individual courses with `/^日間課程，/`,
 * so the full-width comma has to stay immediately after the course name and the
 * weekday has to stay immediately after the comma. Both the timetable grid and
 * the mobile day list now derive their label from here, which is the point of
 * the extraction — the two used to build it (or, on mobile, not build it at all)
 * independently.
 */
export function classBlockLabel(block: ScheduleBlock): string {
  return `${block.name}，星期${weekdayLabels[block.weekday - 1]} ${block.sections.join("到")}${block.conflict ? "，有衝堂" : ""}`;
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
