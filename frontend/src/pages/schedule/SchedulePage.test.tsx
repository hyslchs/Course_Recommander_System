import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulePage } from "./SchedulePage";

const query = vi.hoisted(() => ({
  data: undefined as { course_id: string }[] | undefined,
  error: null as Error | null,
  isFetching: false,
  isPending: false,
  refetch: vi.fn(),
}));

vi.mock("@/data/queries", () => ({ useCoursesByIds: () => query }));
vi.mock("@/hooks/useSchedulePlans", () => ({
  useSchedulePlans: () => ({ activePlan: { entries: [{ courseId: "CS101" }] } }),
}));
vi.mock("./ScheduleWorkspace", () => ({
  ScheduleWorkspace: ({ loadWarning }: { loadWarning?: { message: string; retry: () => void } }) => (
    <section><h1>我的課表</h1>{loadWarning ? <><p>{loadWarning.message}</p><button onClick={loadWarning.retry}>重新載入課表</button></> : null}</section>
  ),
}));

describe("SchedulePage recovery", () => {
  beforeEach(() => {
    query.data = undefined;
    query.error = null;
    query.isFetching = false;
    query.isPending = false;
    query.refetch.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it("offers an in-place retry when the initial course load fails", async () => {
    const user = userEvent.setup();
    query.error = new Error("課程服務暫時無法使用");
    render(<SchedulePage />);

    expect(screen.getByRole("heading", { level: 1, name: "無法載入課表" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新載入課表" }));
    expect(query.refetch).toHaveBeenCalledOnce();
  });

  it("keeps cached courses visible when a refresh fails", async () => {
    const user = userEvent.setup();
    query.data = [{ course_id: "CS101" }];
    query.error = new Error("更新失敗");
    render(<SchedulePage />);

    expect(screen.getByRole("heading", { name: "我的課表" })).toBeInTheDocument();
    expect(screen.getByText("課表更新失敗，目前顯示上次取得的資料。")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新載入課表" }));
    expect(query.refetch).toHaveBeenCalledOnce();
  });
});
