import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider, Modal, useFeedback } from ".";

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>開啟詳細資料</button>
    <Modal open={open} title="課程詳細資料" onClose={() => setOpen(false)}>
      <button type="button">第一個動作</button>
      <button type="button">最後一個動作</button>
    </Modal>
  </>;
}

function FeedbackHarness({ undo }: { undo: () => void }) {
  const { notify } = useFeedback();
  return <button type="button" onClick={() => notify("已移除課程", "success", { label: "復原", onAction: undo })}>移除</button>;
}

describe("shared accessible UI", () => {
  it("traps focus, closes with Escape, and restores the trigger", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    const trigger = screen.getByRole("button", { name: "開啟詳細資料" });
    await user.click(trigger);
    const close = await screen.findByRole("button", { name: "關閉對話框" });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "最後一個動作" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // React Aria's FocusScope restores on the next animation frame rather than
    // synchronously in its cleanup, which is the one observable difference from
    // the hand-rolled trap this replaced. Same node, one frame later.
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("locks page scroll and takes the rest of the app out of the a11y tree", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />, { baseElement: document.body });
    const outside = screen.getByRole("button", { name: "開啟詳細資料" });
    const container = outside.parentElement as HTMLElement;
    await user.click(outside);
    await screen.findByRole("dialog");
    // React Aria locks the root element rather than `body`. It neutralises the
    // rest of the page one level higher than the old Modal did (`#root` in the
    // browser instead of `.app-shell`) and uses `inert` where the engine
    // supports it — jsdom does not, so it falls back to `aria-hidden` here.
    expect(document.documentElement).toHaveStyle({ overflow: "hidden" });
    expect(container.hasAttribute("inert") || container.getAttribute("aria-hidden") === "true").toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(container.hasAttribute("inert") || container.hasAttribute("aria-hidden")).toBe(false));
    expect(document.documentElement).not.toHaveStyle({ overflow: "hidden" });
  });

  it("offers a single non-blocking undo action", async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    render(<FeedbackProvider><FeedbackHarness undo={undo} /></FeedbackProvider>);
    await user.click(screen.getByRole("button", { name: "移除" }));
    expect(screen.getByRole("status")).toHaveTextContent("已移除課程");
    await user.click(screen.getByRole("button", { name: "復原" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
