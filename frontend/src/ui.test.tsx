import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider, Modal, useFeedback } from "./ui";

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
    expect(trigger).toHaveFocus();
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
