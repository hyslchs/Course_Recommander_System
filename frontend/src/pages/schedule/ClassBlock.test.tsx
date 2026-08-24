import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClassBlock, classBlockLabel } from "./ClassBlock";
import type { ScheduleBlock } from "@/domain/schedule";

const block: ScheduleBlock = {
  id: "b1",
  source: "course",
  sourceId: "c1",
  name: "資料結構與演算法設計實務",
  teacher: "王小明",
  weekday: 1,
  sections: ["D2", "D3"],
  startSection: "D2",
  endSection: "D3",
  room: "SF123",
  weekPattern: "A",
  meetingIndex: 0,
  lane: 0,
  laneCount: 1,
  conflict: false,
};

describe("ClassBlock", () => {
  /**
   * T01 handoff 1. `ScheduleWorkspace.test.tsx` finds blocks with `/，星期/` and
   * individual courses with `/^日間課程，/`; both break if the comma or the
   * weekday move. Pinned here so a future edit to the shared component fails
   * against an explicit contract rather than against two opaque regexes.
   */
  it("keeps the `課名，星期…` accessible-name contract", () => {
    expect(classBlockLabel(block)).toBe("資料結構與演算法設計實務，星期一 D2到D3");
    expect(classBlockLabel({ ...block, conflict: true })).toBe("資料結構與演算法設計實務，星期一 D2到D3，有衝堂");
    expect(classBlockLabel(block)).toMatch(/，星期/);
  });

  it("gives both layouts the same accessible name", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<ClassBlock block={block} variant="grid" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: classBlockLabel(block) })).toBeInTheDocument();
    rerender(<ClassBlock block={block} variant="list" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: classBlockLabel(block) })).toBeInTheDocument();
  });

  /**
   * The replacement for `.class-block[data-course-name]::after`. A CSS
   * `content: attr()` popup is not in the accessibility tree at all; this
   * asserts the two things that makes it a real tooltip — a `tooltip` role and
   * the `aria-describedby` link back to the trigger.
   */
  it("describes the truncated grid tile with a real tooltip", async () => {
    const user = userEvent.setup();
    render(<ClassBlock block={block} variant="grid" onSelect={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: classBlockLabel(block) });
    expect(trigger).not.toHaveAttribute("aria-describedby");
    // React Aria only treats a hover as real once the global interaction
    // modality is `pointer`, which is set by `pointermove` — and `user.hover()`
    // fires `pointerover`/`pointerenter` *before* its `pointermove`. A move
    // somewhere else first primes the modality, exactly as a real cursor would.
    await user.pointer({ target: document.body, coords: { x: 1, y: 1 } });
    await user.hover(trigger);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(block.name);
    await waitFor(() => expect(trigger).toHaveAttribute("aria-describedby", tooltip.id));
  });

  it("does not attach a tooltip to the mobile row, which wraps instead of truncating", async () => {
    const user = userEvent.setup();
    render(<ClassBlock block={block} variant="list" onSelect={vi.fn()} />);
    await user.hover(screen.getByRole("button", { name: classBlockLabel(block) }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
