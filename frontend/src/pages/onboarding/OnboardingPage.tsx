import { useCallback, useMemo, useState, type FormEvent, type Key } from "react";
import { useNavigate } from "react-router";
import {
  Button,
  ComboBox,
  Description,
  FieldError,
  Fieldset,
  Form,
  Header,
  Input,
  Label,
  ListBox,
  Radio,
  RadioGroup,
  Select,
  Switch,
} from "@heroui/react";
import { getCatalog } from "@/data/api";
import { useClassGroups, useDepartmentCatalog } from "@/data/queries";
import { getAllRecords, putRecord } from "@/data/db";
import { courseConflicts, inferProfileStudyLevel, meetingsConflict } from "@/domain/eligibility";
import {
  buildDepartmentOptions,
  buildDivisionOptions,
  departmentTypeOrder,
  filterDepartmentOptions,
  getDepartmentContextLabel,
  getDepartmentTypeLabel,
  type DepartmentOption,
} from "@/domain/departmentOptions";
import { getFixedScheduleEntries, MENTOR_TIME_ENTRY_ID } from "@/domain/fixedSchedule";
import { defaultPreferredWeekdays } from "@/domain/profileDefaults";
import { selectRequiredCourses } from "@/domain/requiredCourses";
import { coursesInPlan } from "@/domain/scheduleUtils";
import { useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { StateAlert, useFeedback } from "@/components/ui";
import type { CompletedCourse, Course, Profile } from "@/domain/types";

/** The only semester this build ships data for. Was written out four times. */
const ADMISSION_YEAR = 115;
const GRADES = [1, 2, 3, 4];

/**
 * The fields this page actually edits — nothing else. The previous version kept
 * a full `Profile` clone in state and rebuilt it from `profile` in two separate
 * ten-line object literals (initial state + a sync effect) plus a third at save
 * time, so any new profile field had to be added in three places or it silently
 * dropped. Everything outside this shape is either carried over from the stored
 * profile untouched or derived once in `toProfile`.
 */
interface Draft {
  division: string;
  /** `DepartmentOption.key`. The ComboBox is the single owner of this value. */
  departmentKey: string | null;
  classGroup: string;
  grade: number;
}

const BLANK_PROFILE: Profile = {
  id: "current",
  division: "日間部",
  department: "",
  classGroup: "",
  grade: 1,
  admissionYear: ADMISSION_YEAR,
  interests: "",
  preferredWeekdays: defaultPreferredWeekdays,
  studyLevel: "undergraduate",
  updatedAt: "",
};

/** What the input shows once an option is chosen, and what the filter matches on. */
function departmentTextValue(option: DepartmentOption): string {
  return `${option.officialName ?? option.value}${option.code ? `（${option.code}）` : ""}`;
}

function departmentDetail(option: DepartmentOption): string {
  return [option.code, getDepartmentContextLabel(option)].filter(Boolean).join(" · ");
}

/**
 * Fuzzy-matches a previously stored profile back onto a catalog option. Only
 * needed to seed the picker: once a student chooses from the list the profile
 * carries `department_identity` / `department_code`, and every later read is an
 * exact key lookup.
 */
function matchStoredDepartment(options: DepartmentOption[], value: Profile): DepartmentOption | undefined {
  return options.find((item) => {
    const sameDivision = item.division === value.division
      && (!value.division_code || item.divisionCode === value.division_code);
    return sameDivision && (
      (value.department_identity && item.identity === value.department_identity)
      || (!value.department_identity && value.department_code && item.code === value.department_code)
      || (value.official_department_name_zh && item.officialName === value.official_department_name_zh)
      || (!value.department_code && !value.official_department_name_zh && item.value === value.department
        && options.filter((candidate) => candidate.division === value.division && candidate.value === value.department).length === 1)
    );
  });
}

/** The one place a `Profile` is assembled. */
function toProfile(stored: Profile | undefined, draft: Draft, department: DepartmentOption | undefined): Profile {
  return {
    ...(stored ?? BLANK_PROFILE),
    admissionYear: ADMISSION_YEAR,
    division: draft.division,
    grade: draft.grade,
    classGroup: draft.classGroup,
    department: department?.value ?? "",
    department_code: department?.code ?? null,
    department_identity: department?.identity ?? null,
    division_code: department?.divisionCode ?? null,
    official_department_name_zh: department?.officialName ?? null,
    official_department_type: department?.departmentType ?? null,
    studyLevel: inferProfileStudyLevel({ division: draft.division }),
    updatedAt: new Date().toISOString(),
  };
}

export function OnboardingPage() {
  const profile = useProfile();
  const navigate = useNavigate();
  const { notify } = useFeedback();
  const { plans, activePlan, selectPlan } = useSchedulePlans();

  const departmentCatalogQuery = useDepartmentCatalog();
  const departmentCatalog = departmentCatalogQuery.data;
  const departmentCatalogError = departmentCatalogQuery.error ? (departmentCatalogQuery.error as Error).message : "";
  const divisions = useMemo(() => buildDivisionOptions([], departmentCatalog), [departmentCatalog]);
  const departmentOptions = useMemo(() => buildDepartmentOptions([], departmentCatalog), [departmentCatalog]);

  /**
   * Only the fields the student has actually touched. Merging them over a
   * derived baseline means the profile and the department catalog can finish
   * loading in any order without a sync effect, and without clobbering an edit
   * that landed first — which is what the old `useEffect([profile, options])`
   * did every time either dependency changed.
   */
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const baseline = useMemo<Draft>(() => {
    const source = profile ?? BLANK_PROFILE;
    return {
      classGroup: source.classGroup ?? "",
      departmentKey: profile ? matchStoredDepartment(departmentOptions, profile)?.key ?? null : null,
      // A profile saved before the official divisions existed can hold something
      // like 「資訊學院」, which is a college and not a division. Nothing in the
      // catalog is scoped to it, so the department list came back empty and the
      // page was a dead end. Fall back to the first real division instead of
      // rendering a control whose value is not one of its own options.
      division: !divisions.length || divisions.includes(source.division) ? source.division : divisions[0],
      grade: source.grade,
    };
  }, [profile, departmentOptions, divisions]);
  const draft: Draft = { ...baseline, ...edits };
  const update = (patch: Partial<Draft>) => setEdits((current) => ({ ...current, ...patch }));

  const selectedDepartment = departmentOptions.find((option) => option.key === draft.departmentKey);

  const [autoAddRequiredCourses, setAutoAddRequiredCourses] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const divisionDepartments = useMemo(
    () => filterDepartmentOptions(departmentOptions, draft.division, ""),
    [departmentOptions, draft.division],
  );
  const departmentSections = useMemo(() => departmentTypeOrder
    .map((type) => ({ options: divisionDepartments.filter((option) => (option.departmentType ?? "unknown") === type), type }))
    .filter((section) => section.options.length), [divisionDepartments]);

  /**
   * `defaultFilter` is per-item and gets the item's `textValue`, so the domain
   * helper is applied to a one-element list rather than reimplemented here. That
   * keeps a single definition of "does this query match this department" —
   * NFKC-ish normalisation, whitespace tokenising, and a haystack of code +
   * official name + display name + aliases + type label — which is exactly what
   * `departmentOptions.test.ts` pins down.
   *
   * A `textValue` can in principle be shared by two options (same name, same
   * code, different unit type), hence the many-to-one map and `.some`.
   */
  const optionsByTextValue = useMemo(() => {
    const map = new Map<string, DepartmentOption[]>();
    for (const option of divisionDepartments) {
      const text = departmentTextValue(option);
      map.set(text, [...(map.get(text) ?? []), option]);
    }
    return map;
  }, [divisionDepartments]);
  const departmentFilter = useCallback((text: string, inputValue: string) => (
    (optionsByTextValue.get(text) ?? []).some(
      (option) => filterDepartmentOptions([option], option.division, inputValue).length === 1,
    )
  ), [optionsByTextValue]);

  const classGroupsQuery = useClassGroups(selectedDepartment ? {
    department: selectedDepartment.identity ?? selectedDepartment.value,
    division: draft.division,
    grade: draft.grade,
  } : null);
  const classGroupOptions = selectedDepartment ? (classGroupsQuery.data ?? []) : [];
  // This used to be piped into `setSaveError`, so a failed *fetch* of the class
  // group list was reported to the student as 「儲存失敗：…」 even though nothing
  // had been saved and the Save button had never been pressed. It is a load
  // failure, it is recoverable, and it does not block saving: class group is
  // optional whenever the list is unavailable.
  const classGroupError = classGroupsQuery.error ? (classGroupsQuery.error as Error).message : "";

  const selectDivision = (division: string) => {
    // A department key only means anything inside its own division.
    update({ classGroup: "", departmentKey: null, division });
  };

  const selectDepartment = (key: Key | null) => {
    update({ classGroup: "", departmentKey: key === null ? null : String(key) });
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // `validationBehavior="native"` has already blocked submission and moved
    // focus to the offending field if anything is missing; this is belt-and-braces.
    if (!selectedDepartment) return;
    setSaving(true);
    setSaveError("");
    try {
      const savedProfile = toProfile(profile, draft, selectedDepartment);
      await putRecord("profile", savedProfile);
      if (autoAddRequiredCourses) {
        const catalog = await getCatalog();
        const requiredCourses = selectRequiredCourses(catalog, savedProfile);
        const completed = await getAllRecords<CompletedCourse & { id: string }>("completedCourses");
        const completedIds = new Set(completed.map((item) => item.courseId));
        const existingPlan = activePlan ?? plans[0];
        const now = new Date().toISOString();
        const plan = existingPlan ?? {
          id: crypto.randomUUID(),
          name: "我的課表",
          entries: [],
          createdAt: now,
          updatedAt: now,
        };
        const existingIds = new Set(plan.entries.map((item) => item.courseId));
        const scheduled = coursesInPlan(catalog, plan);
        const existingFixedEntries = plan.fixedEntries ?? [];
        const applicableFixedEntries = getFixedScheduleEntries(savedProfile);
        const applicableFixedIds = new Set(applicableFixedEntries.map((entry) => entry.id));
        const retainedFixedEntries = existingFixedEntries.filter((entry) => (
          entry.id !== MENTOR_TIME_ENTRY_ID || applicableFixedIds.has(entry.id)
        ));
        const fixedAdditions = applicableFixedEntries.filter((entry) => (
          !retainedFixedEntries.some((existing) => existing.id === entry.id)
        ));
        const nextFixedEntries = [...retainedFixedEntries, ...fixedAdditions];
        const fixedMeetings = nextFixedEntries.flatMap((entry) => entry.meetings);
        const additions: Course[] = [];
        for (const course of requiredCourses) {
          if (existingIds.has(course.course_id) || completedIds.has(course.course_id)) continue;
          const courseConflict = courseConflicts(course, [...scheduled, ...additions]);
          const fixedConflict = meetingsConflict(course.meetings, fixedMeetings);
          if (courseConflict.conflict || fixedConflict.conflict) continue;
          additions.push(course);
        }
        if (additions.length || fixedAdditions.length || nextFixedEntries.length !== existingFixedEntries.length) {
          await putRecord("schedulePlans", {
            ...plan,
            entries: [...plan.entries, ...additions.map((course) => ({ courseId: course.course_id, locked: false }))],
            fixedEntries: nextFixedEntries,
            updatedAt: now,
          });
          if (!existingPlan) await selectPlan(plan.id);
        }
        const skipped = requiredCourses.length - additions.length;
        const summaryParts = [
          additions.length ? `已將 ${additions.length} 門符合條件的必修課加入「${plan.name}」` : "",
          fixedAdditions.length ? `已將 ${fixedAdditions.length} 個固定時段加入課表` : "",
        ].filter(Boolean);
        const summary = summaryParts.length ? `${summaryParts.join("；")}。` : "目前沒有可直接加入課表的必修課或固定時段。";
        const detail = skipped > 0 ? ` ${skipped} 門課因已在課表、已修、或與現有課表衝堂而略過。` : "";
        notify(summary + detail + " 共同必修中的英文／國文課程仍請依校方分發結果確認。");
      }
      navigate("/recommend");
    } catch (error) {
      setSaveError((error as Error).message || "無法儲存個人設定，請稍後重試。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="narrow-page" data-page="onboarding">
      {/*
        Not `.eyebrow`: that legacy class is 12.5px with `letter-spacing:.13em`
        and a hard-coded green, all three of which plan §4.4 rules out for a CJK
        line (15px floor, zero tracking, colour reserved for state).
      */}
      <p className="text-[0.9375rem] font-semibold text-muted">只存在這台裝置</p>
      <h1>先設定你的基本資料</h1>
      <p className="lead">一般推薦所需的系級與修課紀錄只保存在這個瀏覽器，不會建立帳號。</p>

      {departmentCatalogError
        ? <StateAlert title="無法載入系所選項" tone="danger">{departmentCatalogError}</StateAlert>
        : null}
      {!departmentCatalog && !departmentCatalogError
        ? <StateAlert tone="info">正在載入系所選項…</StateAlert>
        : null}

      {/*
        The card box lives on the <form>, not on the <fieldset>. Two reasons:
        a bordered fieldset makes the browser notch its border around the
        <legend>, and — more decisively — the `:where(fieldset){border:revert}`
        half of T30's preflight-revert shim is UNLAYERED, so it outranks every
        Tailwind utility a <fieldset> could carry, whatever the specificity.
      */}
      <Form
        aria-busy={saving}
        className="mt-8 w-full rounded-(--radius) border border-border-strong bg-surface p-5 sm:p-6"
        validationBehavior="native"
        onSubmit={save}
      >
        <Fieldset disabled={saving}>
          {/* Chrome takes <legend> out of the fieldset's flex flow, so `.fieldset`'s
              own `gap-6` never applies to it. */}
          <Fieldset.Legend className="mb-5">學籍資料</Fieldset.Legend>
          {/*
            One column at every width. A two-column grid looked tempting at
            `md`, but the department picker and the year radios both need the
            full row, so the short controls ended up alone on their own rows
            with a hole beside them. `.narrow-page` caps the well at 850px, so
            a single column is never over-long.
          */}
          <Fieldset.Group className="grid grid-cols-1 gap-5 space-y-0">

            <Select
              fullWidth
              isRequired
              name="division"
              placeholder="請選擇部別"
              selectedKey={draft.division}
              onSelectionChange={(key) => selectDivision(String(key))}
            >
              <Label>部別</Label>
              <Select.Trigger className="min-h-11">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox aria-label="部別">
                  {divisions.map((division) => (
                    <ListBox.Item key={division} id={division} textValue={division}>
                      {division}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
              <Description>部別與系所選項依輔大官方課程大綱查詢系統。</Description>
            </Select>

            {/*
              A true ARIA combobox — an editable input plus a listbox — not the
              select-with-a-search-field that HeroUI calls `Autocomplete`.
              Students type 「圖資」 /「資工」 /「10」 straight into the field.
              `items` is deliberately NOT passed: React Aria disables both
              `defaultFilter` and its show-all-on-focus behaviour when the
              collection is controlled (`useComboBoxState` lines 103 and 129),
              and show-all-on-focus is precisely what removes the old
              `departmentInput` / `departmentSearchTerm` mirror-and-unmirror pair.
            */}
            <ComboBox
              allowsCustomValue={false}
              allowsEmptyCollection
              defaultFilter={departmentFilter}
              formValue="key"
              fullWidth
              isRequired
              menuTrigger="focus"
              name="department"
              selectedKey={draft.departmentKey}
              onSelectionChange={selectDepartment}
            >
              <Label>主修系所／學位學程</Label>
              <ComboBox.InputGroup>
                {/*
                  The old copy promised 「例如：圖資、資工、10」. Measured against
                  the real 115 catalog, 圖資 and 資工 both return zero: this page
                  calls `buildDepartmentOptions([], catalog)` with no course rows,
                  so the only alias an option carries is the catalog's own
                  `label` (「10-圖書資訊學系」), and `filterDepartmentOptions`
                  matches contiguous substrings — 圖資 skips 書, 資工 skips 訊.
                  That was equally untrue before this migration; the filter is
                  reused verbatim, so only the promise is corrected here.
                */}
                <Input className="min-h-11" placeholder="輸入系名或代碼，例如：資訊、護理、10" />
                <ComboBox.Trigger />
              </ComboBox.InputGroup>
              {/*
                React Aria writes `max-height` inline from the space it measures,
                re-measuring on `visualViewport` resize and clamping to
                `visualViewport.height` (useOverlayPosition:90,163). That is what
                keeps the list clear of a soft keyboard — the keyboard shrinks the
                visual viewport only, since index.html sets no
                `interactive-widget=resizes-content`. The class here is just a
                ceiling so the list never eats the whole screen when there is room.

                KNOWN ISSUE (not the keyboard path, and not fixed here): at layout
                viewport heights below roughly 420px — a landscape phone or a very
                short window — opening the popover makes React Aria scroll the
                focused option into the viewport, which nudges the *document* ~3px,
                and its own `useCloseOnScroll` (active because a ComboBox popover is
                `isNonModal`) reads that as a dismiss and closes it immediately.
                `containerPadding` does not avoid it; it needs an upstream fix.
              */}
              <ComboBox.Popover className="max-h-[min(60svh,22rem)]">
                <ListBox
                  aria-label="主修系所／學位學程"
                  renderEmptyState={() => (
                    <p className="px-3 py-4 text-sm text-muted">找不到符合的主修系所。</p>
                  )}
                >
                  {departmentSections.map((section) => (
                    <ListBox.Section key={section.type}>
                      <Header>{getDepartmentTypeLabel(section.type)}</Header>
                      {section.options.map((option) => (
                        <ListBox.Item key={option.key} id={option.key} textValue={departmentTextValue(option)}>
                          <div className="flex min-w-0 flex-col">
                            <Label>{option.officialName ?? option.value}</Label>
                            <Description>{departmentDetail(option)}</Description>
                          </div>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox.Section>
                  ))}
                </ListBox>
              </ComboBox.Popover>
              <Description>
                {selectedDepartment
                  // The name is already in the input, so this line carries only
                  // what the input cannot: division, unit type and — the one that
                  // actually catches mistakes — the 一般／在職／學士後 track.
                  ? `代碼 ${departmentDetail(selectedDepartment)}。儲存前請確認這是正確的部別及一般／在職／學士後身分。`
                  : "點開清單，或輸入正式名稱的任一段或系所代碼搜尋；只列出正式主修單位。"}
              </Description>
              <FieldError>請從清單中選擇一個正式的主修系所。</FieldError>
            </ComboBox>

            <Select
              fullWidth
              isRequired={classGroupOptions.length > 0}
              name="classGroup"
              placeholder={classGroupOptions.length ? "請選擇班別" : "不分班／未指定"}
              selectedKey={draft.classGroup || null}
              onSelectionChange={(key) => update({ classGroup: key === null ? "" : String(key) })}
            >
              <Label>班別</Label>
              <Select.Trigger className="min-h-11">
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox aria-label="班別">
                  {classGroupOptions.map((value) => (
                    <ListBox.Item key={value} id={value} textValue={value}>
                      {value}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
              <Description>
                {classGroupError
                  ? "班別選項暫時無法載入，可以先略過。"
                  : selectedDepartment && classGroupsQuery.isPending
                    ? "正在載入班別選項…"
                    : classGroupOptions.length
                      ? "有分班課程時，只會自動帶入選定班別。"
                      : "目前課程資料沒有偵測到甲、乙等班別。"}
              </Description>
              <FieldError>請選擇班別。</FieldError>
            </Select>

            <RadioGroup
              name="grade"
              orientation="horizontal"
              value={String(draft.grade)}
              onChange={(value) => update({ grade: Number(value) })}
            >
              {/* `orientation="horizontal"` makes `.radio-group` a wrapping flex
                  row, and the Label is just another item in it — so at 375px the
                  four radios wrapped *around* the label. `w-full` gives it its
                  own line and lines this field up with the other four. */}
              <Label className="w-full">年級</Label>
              {GRADES.map((grade) => (
                <Radio key={grade} value={String(grade)}>
                  <Radio.Content className="min-h-11">
                    <Radio.Control>
                      <Radio.Indicator />
                    </Radio.Control>
                    {grade} 年級
                  </Radio.Content>
                </Radio>
              ))}
            </RadioGroup>

            {/*
              `.switch` is a column and `.switch > [data-slot="description"]`
              carries the `calc(2.5rem + 0.75rem)` inline-start pad that lines the
              help text up under the label. So Control and Label belong together
              inside Switch.Content, and Description has to stay a *direct* child
              of Switch — the docs' Usage and Anatomy snippets disagree about
              this; the stylesheet is the tie-breaker.
            */}
            <Switch
              isSelected={autoAddRequiredCourses}
              name="autoAddRequiredCourses"
              onChange={setAutoAddRequiredCourses}
            >
              {/* The pressable row is only as tall as its text — 24px once the
                  label stops wrapping, which happens from ~768px up. §5.3 wants
                  44px, so it is pinned here rather than left to the copy length. */}
              <Switch.Content className="min-h-11 items-center">
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Label>儲存後自動將本系／共同必修加入「{activePlan?.name ?? "我的課表"}」</Label>
              </Switch.Content>
              <Description>
                只會加入目前 {ADMISSION_YEAR}-1 課程資料中符合部別、年級與班別的課程；英文、國文等共同課程仍須依學校分發或免修結果確認。
              </Description>
            </Switch>

            {/*
              A failed class-group fetch is a *load* failure. It used to be
              rendered by the 「儲存失敗」 alert below, which was simply untrue.
            */}
            {classGroupError
              ? (
                <StateAlert title="無法載入班別選項" tone="warning">
                  {classGroupError} 可以先不選班別直接儲存，之後回到這一頁再補上。
                </StateAlert>
              )
              : null}

            {saveError
              ? <StateAlert title="儲存失敗" tone="danger">{saveError}</StateAlert>
              : null}
          </Fieldset.Group>

          <Fieldset.Actions>
            <Button className="w-full min-h-11 sm:w-auto" isPending={saving} type="submit">
              {saving ? "儲存中…" : "儲存並前往推薦"}
            </Button>
          </Fieldset.Actions>
        </Fieldset>
      </Form>
    </section>
  );
}
