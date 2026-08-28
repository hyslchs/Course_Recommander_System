import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDataProvider, useLocalDataReady, useLocalDataState, useProfile } from "./localData";

const dbMocks = vi.hoisted(() => ({
  getAllRecords: vi.fn(),
  recoverPersonalDataStorage: vi.fn(),
}));
vi.mock("@/data/db", () => dbMocks);

function Probe() {
  const state = useLocalDataState();
  const profile = useProfile();
  return <div>
    <span data-testid="status">{state.status}</span>
    <span data-testid="ready">{String(useLocalDataReady())}</span>
    <span data-testid="profile">{profile?.department ?? "none"}</span>
    <span data-testid="writable">{String(state.writable)}</span>
    <button onClick={() => void state.retry()}>重試</button>
  </div>;
}

describe("LocalDataProvider storage states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.recoverPersonalDataStorage.mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it("does not turn an initial read failure into an empty ready snapshot", async () => {
    dbMocks.getAllRecords.mockRejectedValue(new Error("IndexedDB blocked"));
    render(<LocalDataProvider><Probe /></LocalDataProvider>);

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unavailable"));
    expect(screen.getByTestId("ready")).toHaveTextContent("false");
    expect(screen.getByTestId("writable")).toHaveTextContent("false");
  });

  it("recovers and republishes the stored profile after retry", async () => {
    const user = userEvent.setup();
    dbMocks.getAllRecords.mockRejectedValueOnce(new Error("IndexedDB blocked"));
    render(<LocalDataProvider><Probe /></LocalDataProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("unavailable"));
    dbMocks.getAllRecords.mockImplementation(async (store: string) => store === "profile" ? [{ id: "current", department: "資訊工程學系" }] : []);

    await user.click(screen.getByRole("button", { name: "重試" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("profile")).toHaveTextContent("資訊工程學系");
    expect(dbMocks.recoverPersonalDataStorage).toHaveBeenCalledOnce();
  });

  it("keeps the last good snapshot and becomes read-only after a later reload failure", async () => {
    dbMocks.getAllRecords.mockImplementation(async (store: string) => store === "profile" ? [{ id: "current", department: "圖書資訊學系" }] : []);
    render(<LocalDataProvider><Probe /></LocalDataProvider>);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    dbMocks.getAllRecords.mockRejectedValue(new Error("讀取失敗"));

    window.dispatchEvent(new CustomEvent("fju-local-data", { detail: "all" }));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("degraded"));
    expect(screen.getByTestId("profile")).toHaveTextContent("圖書資訊學系");
    expect(screen.getByTestId("writable")).toHaveTextContent("false");
  });
});
