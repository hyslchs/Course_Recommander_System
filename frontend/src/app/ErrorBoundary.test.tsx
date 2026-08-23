import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom({ explode }: { explode: boolean }) {
  if (explode) throw new Error("測試用錯誤");
  return <h1>正常內容</h1>;
}

describe("route error boundary", () => {
  it("shows a recoverable fallback that still owns the route heading", async () => {
    const user = userEvent.setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(<ErrorBoundary><Boom explode /></ErrorBoundary>);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("這個頁面發生錯誤");
    expect(screen.getByText("測試用錯誤")).toBeInTheDocument();

    rerender(<ErrorBoundary><Boom explode={false} /></ErrorBoundary>);
    await user.click(screen.getByRole("button", { name: "重試這個頁面" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("正常內容");
    logged.mockRestore();
  });
});
