import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { I18nProvider } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingPage } from "./OnboardingPage";
import { FeedbackProvider } from "@/components/ui";
import { LocalDataProvider } from "@/hooks/localData";
import { SchedulePlanProvider } from "@/hooks/useSchedulePlans";
import type { DepartmentCatalog, Profile } from "@/domain/types";

const apiMocks = vi.hoisted(() => ({
  askCourseAssistant: vi.fn(),
  embedQuery: vi.fn(),
  getCatalog: vi.fn(),
  getClassGroups: vi.fn(),
  getCourses: vi.fn(),
  getCoursesByIds: vi.fn(),
  getDepartmentCatalog: vi.fn(),
  getEmbeddingBundle: vi.fn(),
  getFacets: vi.fn(),
  getFeatures: vi.fn(),
  lookupCourses: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
  clearPersonalData: vi.fn(),
  createBackup: vi.fn(),
  deleteRecord: vi.fn(),
  getAllRecords: vi.fn(),
  getRecord: vi.fn(),
  importBackup: vi.fn(),
  putRecord: vi.fn(),
  validateBackup: vi.fn(),
}));
vi.mock("@/data/api", () => apiMocks);
vi.mock("@/data/db", () => dbMocks);

const navigate = vi.fn();
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => navigate,
}));

function department(code: string, nameZh: string, departmentType: string, label = "") {
  return { code, department_type: departmentType, label, name_zh: nameZh };
}

/**
 * Two 學系 plus one 學位學程 in 日間部, so the ListBox has more than one section,
 * and one department in 進修部 that must never appear while 日間部 is selected.
 */
const catalog = {
  departments: [
    { division_code: "D", division_name_zh: "日間部", ...department("10", "圖書資訊學系", "department", "圖資") },
    { division_code: "D", division_name_zh: "日間部", ...department("52", "資訊工程學系", "department", "資工") },
    { division_code: "D", division_name_zh: "日間部", ...department("77", "全人教育學位學程", "degree_program") },
    { division_code: "C", division_name_zh: "進修部", ...department("91", "進修部企業管理學系", "department") },
  ],
  divisions: [
    { code: "D", name_zh: "日間部", departments: [department("10", "圖書資訊學系", "department")] },
    { code: "C", name_zh: "進修部", departments: [department("91", "進修部企業管理學系", "department")] },
  ],
  hy: 1151,
  schema_version: "1",
} as unknown as DepartmentCatalog;

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false, staleTime: Infinity } },
  });
  return render(
    <I18nProvider locale="zh-Hant-TW">
      <QueryClientProvider client={client}>
        <LocalDataProvider>
          <SchedulePlanProvider>
            <FeedbackProvider>
              <MemoryRouter><OnboardingPage /></MemoryRouter>
            </FeedbackProvider>
          </SchedulePlanProvider>
        </LocalDataProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

const departmentField = () => screen.getByRole("combobox", { name: /主修系所/ });

/** Focus the department input; `menuTrigger="focus"` opens the whole list. */
async function openDepartments(user: ReturnType<typeof userEvent.setup>) {
  await user.click(departmentField());
  return screen.findByRole("listbox", { name: /主修系所/ });
}

const optionNames = (list: HTMLElement) =>
  within(list).getAllByRole("option").map((option) => option.textContent ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getAllRecords.mockResolvedValue([]);
  dbMocks.putRecord.mockResolvedValue(undefined);
  apiMocks.getDepartmentCatalog.mockResolvedValue(catalog);
  apiMocks.getClassGroups.mockResolvedValue([]);
  apiMocks.getCatalog.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe("OnboardingPage — class group load failure", () => {
  /**
   * The defect this task exists to fix: `getClassGroups` rejecting used to be
   * routed into `setSaveError`, so the student saw 「儲存失敗：…」 for a request
   * they never triggered and a save that never happened.
   */
  it("reports a failed class group fetch as a load failure, not a save failure", async () => {
    const user = userEvent.setup();
    apiMocks.getClassGroups.mockRejectedValue(new Error("班別服務暫時無法使用"));

    renderPage();
    const list = await openDepartments(user);
    await user.click(within(list).getByRole("option", { name: /圖書資訊學系/ }));

    expect(await screen.findByText("無法載入班別選項")).toBeInTheDocument();
    expect(screen.getByText(/班別服務暫時無法使用/)).toBeInTheDocument();
    // The old wording. Its presence here is the bug.
    expect(screen.queryByText("儲存失敗")).not.toBeInTheDocument();
    expect(screen.queryByText(/儲存失敗/)).not.toBeInTheDocument();
    expect(dbMocks.putRecord).not.toHaveBeenCalled();
  });

  it("still lets the profile be saved while the class group list is unavailable", async () => {
    const user = userEvent.setup();
    apiMocks.getClassGroups.mockRejectedValue(new Error("班別服務暫時無法使用"));

    renderPage();
    const list = await openDepartments(user);
    await user.click(within(list).getByRole("option", { name: /圖書資訊學系/ }));
    await screen.findByText(/無法載入班別選項/);

    await user.click(screen.getByRole("button", { name: "儲存並前往推薦" }));
    await waitFor(() => expect(dbMocks.putRecord).toHaveBeenCalledWith("profile", expect.objectContaining({
      department: "圖書資訊學系",
      department_code: "10",
      id: "current",
    })));
  });
});

describe("OnboardingPage — department ComboBox", () => {
  it("groups options by unit type and scopes them to the chosen division", async () => {
    const user = userEvent.setup();
    renderPage();

    const list = await openDepartments(user);
    expect(within(list).getByRole("group", { name: "學系" })).toBeInTheDocument();
    expect(within(list).getByRole("group", { name: "學位學程" })).toBeInTheDocument();
    expect(optionNames(list).join(" ")).not.toContain("進修部企業管理學系");
  });

  /**
   * The filter is `filterDepartmentOptions` itself, so the alias/code behaviour
   * that `departmentOptions.test.ts` pins down has to show up here verbatim.
   */
  it.each([
    ["圖資", "圖書資訊學系"],
    ["資工", "資訊工程學系"],
    ["10", "圖書資訊學系"],
  ])("filters on %s down to %s", async (query, expected) => {
    const user = userEvent.setup();
    renderPage();

    const list = await openDepartments(user);
    await user.keyboard(query);
    await waitFor(() => expect(optionNames(list)).toHaveLength(1));
    expect(optionNames(list)[0]).toContain(expected);
  });

  it("is fully operable from the keyboard", async () => {
    const user = userEvent.setup();
    renderPage();

    // Focus opens the popover; ArrowDown moves into it; Enter commits.
    const list = await openDepartments(user);
    await user.keyboard("資工");
    await waitFor(() => expect(optionNames(list)).toHaveLength(1));
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => expect(departmentField()).toHaveValue("資訊工程學系（52）"));
    await waitFor(() => expect(screen.queryByRole("listbox", { name: /主修系所/ })).not.toBeInTheDocument());

    // Escape closes without changing the committed selection.
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("listbox", { name: /主修系所/ });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox", { name: /主修系所/ })).not.toBeInTheDocument());
    expect(departmentField()).toHaveValue("資訊工程學系（52）");
  });

  /**
   * The old implementation mirrored the selected option's text into
   * `departmentInput`, then had to un-mirror it through `departmentSearchTerm`
   * so re-opening the list did not show a single result. React Aria's
   * show-all-on-focus does that now — but only while the collection is
   * uncontrolled, which is why `items` is never passed.
   */
  it("shows the whole list again after re-focusing a committed selection", async () => {
    const user = userEvent.setup();
    renderPage();

    const list = await openDepartments(user);
    await user.click(within(list).getByRole("option", { name: /圖書資訊學系/ }));
    await waitFor(() => expect(departmentField()).toHaveValue("圖書資訊學系（10）"));

    await user.tab();
    const reopened = await openDepartments(user);
    await waitFor(() => expect(optionNames(reopened).length).toBeGreaterThan(1));
  });

  it("clears the department when the division changes", async () => {
    const user = userEvent.setup();
    renderPage();

    const list = await openDepartments(user);
    await user.click(within(list).getByRole("option", { name: /圖書資訊學系/ }));
    await waitFor(() => expect(departmentField()).toHaveValue("圖書資訊學系（10）"));

    await user.click(screen.getByRole("button", { name: /部別/ }));
    await user.click(await screen.findByRole("option", { name: "進修部" }));

    await waitFor(() => expect(departmentField()).toHaveValue(""));
    const reopened = await openDepartments(user);
    expect(optionNames(reopened).join(" ")).toContain("進修部企業管理學系");
  });
});

describe("OnboardingPage — saving", () => {
  it("writes the official identity fields resolved from the picked option", async () => {
    const user = userEvent.setup();
    apiMocks.getClassGroups.mockResolvedValue(["甲", "乙"]);

    renderPage();
    const list = await openDepartments(user);
    await user.click(within(list).getByRole("option", { name: /全人教育學位學程/ }));

    await user.click(await screen.findByRole("button", { name: /班別/ }));
    await user.click(await screen.findByRole("option", { name: "乙" }));
    await user.click(screen.getByRole("radio", { name: "3 年級" }));
    await user.click(screen.getByRole("button", { name: "儲存並前往推薦" }));

    await waitFor(() => expect(dbMocks.putRecord).toHaveBeenCalledWith("profile", expect.objectContaining({
      admissionYear: 115,
      classGroup: "乙",
      department: "全人教育學位學程",
      department_code: "77",
      department_identity: "D:77:degree_program",
      division: "日間部",
      division_code: "D",
      grade: 3,
      official_department_name_zh: "全人教育學位學程",
      official_department_type: "degree_program",
      studyLevel: "undergraduate",
    })));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/recommend"));
  });

  it("blocks submission and does not write anything when no department is picked", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("combobox", { name: /主修系所/ });

    await user.click(screen.getByRole("button", { name: "儲存並前往推薦" }));

    await waitFor(() => expect(departmentField()).toHaveAttribute("aria-invalid", "true"));
    expect(dbMocks.putRecord).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  /** A save failure is the only thing allowed to say 「儲存失敗」. */
  it("labels a putRecord rejection as a save failure", async () => {
    const user = userEvent.setup();
    dbMocks.putRecord.mockRejectedValue(new Error("IndexedDB 無法寫入"));

    renderPage();
    const list = await openDepartments(user);
    await user.click(within(list).getByRole("option", { name: /圖書資訊學系/ }));
    await user.click(screen.getByRole("button", { name: "儲存並前往推薦" }));

    expect(await screen.findByText("儲存失敗")).toBeInTheDocument();
    expect(screen.getByText(/IndexedDB 無法寫入/)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("seeds the picker from an already saved profile", async () => {
    const stored: Profile = {
      id: "current", division: "日間部", department: "資訊工程學系", classGroup: "",
      department_identity: "D:52:department", department_code: "52", division_code: "D",
      official_department_name_zh: "資訊工程學系", official_department_type: "department",
      grade: 2, admissionYear: 115, interests: "", preferredWeekdays: [1, 2, 3, 4, 5], updatedAt: "now",
    };
    dbMocks.getAllRecords.mockImplementation(async (store: string) => (store === "profile" ? [stored] : []));

    renderPage();
    await waitFor(() => expect(departmentField()).toHaveValue("資訊工程學系（52）"));
    expect(screen.getByRole("radio", { name: "2 年級" })).toBeChecked();
  });
});
