import { useMemo, useRef, useState } from "react";
import { Button, Card, Checkbox, Label, TextArea } from "@heroui/react";
import { useCoursesByIds, useLookupCourses } from "@/data/queries";
import {
  clearPersonalData,
  createBackup,
  deleteRecord,
  importBackup,
  putRecord,
  putRecords,
  validateBackup,
} from "@/data/db";
import { track } from "@/analytics/client";
import { useLocalRecords } from "@/hooks/localData";
import { ConfirmDialog, EmptyState, Modal, StateAlert, useFeedback } from "@/components/ui";
import type { CompletedCourse } from "@/domain/types";

/** Card titles render as `h3` by default; the page owns the only `<h1>` (plan R9). */
const asHeading2 = (props: React.JSX.IntrinsicElements["h2"]) => <h2 {...props} />;

export function DataPage() {
  const completed = useLocalRecords<CompletedCourse & { id: string }>("completedCourses");
  const favorites = useLocalRecords<{ id: string; addedAt: string }>("favorites");
  const dismissed = useLocalRecords<{ id: string; addedAt: string }>("dismissedCourses");
  const favoriteIds = useMemo(() => favorites.map((item) => item.id), [favorites]);
  const dismissedIds = useMemo(() => dismissed.map((item) => item.id), [dismissed]);
  const personalCourseIds = useMemo(
    () => [...new Set([...favoriteIds, ...dismissedIds])],
    [dismissedIds, favoriteIds],
  );
  const personalCoursesQuery = useCoursesByIds(personalCourseIds);
  const coursesById = useMemo(
    () => new Map((personalCoursesQuery.data ?? []).map((course) => [course.course_id, course])),
    [personalCoursesQuery.data],
  );
  const favoriteCourses = useMemo(
    () => favorites.map((favorite) => ({ favorite, course: coursesById.get(favorite.id) })),
    [coursesById, favorites],
  );
  const dismissedCourses = useMemo(
    () => dismissed.map((item) => ({ item, course: coursesById.get(item.id) })),
    [coursesById, dismissed],
  );
  const lookup = useLookupCourses();
  const { notify } = useFeedback();
  const [codes, setCodes] = useState("");
  const [busy, setBusy] = useState<"recognize" | "export" | "import" | "clear" | "">("");
  const [importPreview, setImportPreview] = useState<ReturnType<typeof validateBackup>>();
  const [overwriteProfile, setOverwriteProfile] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const codesRef = useRef<HTMLTextAreaElement>(null);

  const addCodes = async () => {
    if (!codes.trim() || busy) return;
    setBusy("recognize");
    try {
      const values = codes.split(/[\s,，;；]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
      const result = await lookup.mutateAsync(values);
      // One transaction, one `fju-local-data` event — see `putRecords`.
      await putRecords("completedCourses", result.items.map((course) => ({
        addedAt: new Date().toISOString(),
        continueLearning: false,
        courseId: course.course_id,
        courseName: course.name_zh,
        id: course.course_id,
      })));
      setCodes("");
      notify("已加入 " + result.items.length + " 門；" + result.unmatched_values.length + " 筆未找到");
    } catch (error) { track("error", { component: "data_management", error_code: "COURSE_LOOKUP_FAILED" }); notify("辨識課程失敗：" + (error as Error).message, "error"); }
    finally { setBusy(""); }
  };
  const exportData = async () => {
    if (busy) return;
    setBusy("export");
    track("feature_clicked", { feature: "export_backup" });
    try {
      const backup = await createBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "fju-course-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      anchor.click();
      URL.revokeObjectURL(url);
      notify("備份已匯出");
    } catch (error) { notify("匯出失敗：" + (error as Error).message, "error"); }
    finally { setBusy(""); }
  };
  const readImport = async (file: File) => {
    setBusy("import");
    track("feature_clicked", { feature: "import_backup" });
    try {
      setImportPreview(validateBackup(JSON.parse(await file.text())));
      setOverwriteProfile(false);
    } catch (error) {
      notify("無法匯入：" + (error as Error).message, "error");
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  const confirmImport = async () => {
    if (!importPreview) return;
    setBusy("import");
    try {
      await importBackup(importPreview, overwriteProfile);
      notify("匯入完成");
      setImportPreview(undefined);
    } catch (error) { notify("匯入失敗：" + (error as Error).message, "error"); }
    finally { setBusy(""); }
  };
  const clearAll = async () => {
    setBusy("clear");
    track("feature_clicked", { feature: "clear_local_data" });
    try { await clearPersonalData(); notify("這台裝置上的個人資料已清除"); setClearOpen(false); }
    catch (error) { notify("清除失敗：" + (error as Error).message, "error"); }
    finally { setBusy(""); }
  };
  const removeCompleted = async (item: CompletedCourse & { id: string }) => {
    await deleteRecord("completedCourses", item.id);
    notify("已移除「" + item.courseName + "」", "success", { label: "復原", onAction: () => putRecord("completedCourses", item) });
  };
  const removeFavorite = async (item: { id: string; addedAt: string }, courseName?: string) => {
    await deleteRecord("favorites", item.id);
    notify("已取消收藏「" + (courseName ?? item.id) + "」", "success", { label: "復原", onAction: () => putRecord("favorites", item) });
  };
  const restoreDismissed = async (item: { id: string; addedAt: string }, courseName?: string) => {
    await deleteRecord("dismissedCourses", item.id);
    notify("已恢復推薦「" + (courseName ?? item.id) + "」", "success", { label: "復原", onAction: () => putRecord("dismissedCourses", item) });
  };

  return (
    <section className="page" data-page="data">
      <div className="page-heading"><div><div className="eyebrow">你的資料由你掌控</div><h1>資料管理</h1></div></div>

      {/* Single column below `md`; the mobile acceptance width (375px) never sees two. */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="data-card">
          <Card.Header>
            <Card.Title render={asHeading2}>批次加入已修課程</Card.Title>
            <Card.Description id="completed-course-helper">以空白、逗號或換行分隔，例如課號 D030201234 或完整課名。</Card.Description>
            <p className="data-card-note">本系統僅包含 115-1 學年度之課程大綱資料，若您已修的課程未於 115-1 學年度開設，可能顯示查無此課程。</p>
          </Card.Header>
          <Card.Content className="flex flex-col gap-2">
            <Label htmlFor="completed-course-codes">課號或完整課名</Label>
            <TextArea
              ref={codesRef}
              aria-describedby="completed-course-helper"
              disabled={busy === "recognize"}
              fullWidth
              id="completed-course-codes"
              placeholder={"D030201234\n資料結構"}
              rows={6}
              value={codes}
              onChange={(event) => setCodes(event.target.value)}
            />
          </Card.Content>
          <Card.Footer>
            <Button
              className="min-h-11 w-full sm:w-auto"
              isDisabled={!codes.trim() || busy === "recognize"}
              isPending={busy === "recognize"}
              onPress={() => void addCodes()}
            >
              {busy === "recognize" ? "辨識中…" : "辨識並加入"}
            </Button>
          </Card.Footer>
        </Card>

        <Card className="data-card">
          <Card.Header>
            <Card.Title render={asHeading2}>備份與清除</Card.Title>
            <Card.Description>匯出或匯入個人資料備份，也可以清除這台裝置上的資料。</Card.Description>
            {/* The page that promises this data stays local should say where
                that promise is written down, and where to switch off the
                anonymous usage statistics.

                A plain `<a>`, not react-router's `Link`: this page is rendered
                bare (no `BrowserRouter`) by its own test suite, which is a
                deliberate property of this codebase — see `hooks/theme.tsx`. A
                `Link` throws there. The full reload it costs is paid at most
                once, on an informational link. */}
            <p className="data-card-note">
              這些資料只存在這台裝置。想知道系統蒐集哪些匿名使用統計，或要關閉統計，請看
              <a className="data-course-link" href="/privacy">資料蒐集說明</a>。
            </p>
          </Card.Header>
          <Card.Footer className="flex flex-wrap gap-2">
            <Button
              className="min-h-11 w-full sm:w-auto"
              isDisabled={busy === "export"}
              isPending={busy === "export"}
              variant="secondary"
              onPress={() => void exportData()}
            >
              {busy === "export" ? "匯出中…" : "匯出備份檔案"}
            </Button>
            <Button
              className="min-h-11 w-full sm:w-auto"
              isDisabled={busy === "import"}
              isPending={busy === "import"}
              variant="secondary"
              onPress={() => fileRef.current?.click()}
            >
              {busy === "import" ? "讀取中…" : "匯入備份檔案"}
            </Button>
            <input ref={fileRef} hidden type="file" accept="application/json" onChange={(event) => event.target.files?.[0] && void readImport(event.target.files[0])} />
            {/* Irreversible: never wired straight to the handler (ux `Confirmation Dialogs`). */}
            <Button className="min-h-11 w-full sm:w-auto" variant="danger" onPress={() => setClearOpen(true)}>清除所有個人資料</Button>
          </Card.Footer>
        </Card>
      </div>

      <Card className="data-card mt-4">
        <Card.Header>
          <Card.Title render={asHeading2}>收藏課程</Card.Title>
          <Card.Description>你點過愛心的課程會顯示在這裡。</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col">
          {favoriteIds.length > 0 && personalCoursesQuery.isPending ? <p role="status">正在載入收藏課程…</p> : null}
          {favoriteIds.length > 0 && personalCoursesQuery.error ? (
            <StateAlert tone="danger" title="無法載入收藏課程">
              {(personalCoursesQuery.error as Error).message}
            </StateAlert>
          ) : null}
          {!favoriteIds.length ? (
            <EmptyState
              body="在推薦或探索頁面點愛心，就能把課程收藏到這裡。"
              headingLevel={2}
              title="尚未收藏課程"
              variant="first-run"
            />
          ) : null}
          {!personalCoursesQuery.isPending && !personalCoursesQuery.error ? favoriteCourses.map(({ favorite, course }) => (
            <div className="favorite-row flex flex-col gap-2 border-b border-separator py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4" key={favorite.id}>
              <div className="favorite-course flex min-w-0 flex-1 flex-col gap-1">
                <strong>{course?.name_zh ?? "課程資料暫時無法取得"}</strong>
                <span className="favorite-meta">
                  {course
                    ? [course.department_display ?? course.department, course.teacher || "教師未定", course.credits === null ? null : `${course.credits} 學分`].filter(Boolean).join(" · ")
                    : `課程 ID：${favorite.id}`}
                </span>
              </div>
              <div className="favorite-actions flex flex-wrap items-center gap-2">
                {course?.source_url ? <a className="data-course-link" href={course.source_url} rel="noreferrer" target="_blank">查看官方課綱</a> : null}
                <Button className="min-h-11" variant="secondary" onPress={() => void removeFavorite(favorite, course?.name_zh)}>取消收藏</Button>
              </div>
            </div>
          )) : null}
        </Card.Content>
      </Card>

      <Card className="data-card mt-4">
        <Card.Header>
          <Card.Title render={asHeading2}>不感興趣的課程</Card.Title>
          <Card.Description>這些課程不會出現在個人化推薦中。</Card.Description>
        </Card.Header>
        <Card.Content className="flex flex-col">
          {dismissedIds.length > 0 && personalCoursesQuery.isPending ? <p role="status">正在載入不感興趣的課程…</p> : null}
          {dismissedIds.length > 0 && personalCoursesQuery.error ? (
            <StateAlert tone="danger" title="無法載入不感興趣的課程">
              {(personalCoursesQuery.error as Error).message}
            </StateAlert>
          ) : null}
          {!dismissedIds.length ? (
            <EmptyState
              body="在推薦頁面標記不感興趣後，課程會列在這裡。"
              headingLevel={2}
              title="沒有不感興趣的課程"
              variant="first-run"
            />
          ) : null}
          {!personalCoursesQuery.isPending && !personalCoursesQuery.error ? dismissedCourses.map(({ item, course }) => (
            <div className="dismissed-row flex flex-col gap-2 border-b border-separator py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4" key={item.id}>
              <div className="favorite-course flex min-w-0 flex-1 flex-col gap-1">
                <strong>{course?.name_zh ?? "課程資料暫時無法取得"}</strong>
                <span className="favorite-meta">
                  {course
                    ? [course.department_display ?? course.department, course.teacher || "教師未定", course.credits === null ? null : `${course.credits} 學分`].filter(Boolean).join(" · ")
                    : `課程 ID：${item.id}`}
                </span>
              </div>
              <div className="dismissed-actions flex flex-wrap items-center gap-2">
                {course?.source_url ? <a className="data-course-link" href={course.source_url} rel="noreferrer" target="_blank">查看官方課綱</a> : null}
                <Button className="min-h-11" variant="secondary" onPress={() => void restoreDismissed(item, course?.name_zh)}>恢復推薦</Button>
              </div>
            </div>
          )) : null}
        </Card.Content>
      </Card>

      <Card className="data-card mt-4">
        <Card.Header><Card.Title render={asHeading2}>已修課程</Card.Title></Card.Header>
        <Card.Content className="flex flex-col">
          {!completed.length ? (
            <EmptyState
              action="前往批次加入"
              body="加入後可讓推薦避開重複修課。"
              headingLevel={2}
              title="尚未加入已修課程"
              variant="first-run"
              onAction={() => codesRef.current?.focus()}
            />
          ) : null}
          {completed.map((item) => (
            <div className="completed-row flex flex-col gap-2 border-b border-separator py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4" key={item.id}>
              <span className="completed-name flex-1">{item.courseName}</span>
              <div className="completed-actions">
                <Checkbox
                  isSelected={item.continueLearning}
                  onChange={() => void putRecord("completedCourses", { ...item, continueLearning: !item.continueLearning })}
                >
                  <Checkbox.Content className="min-h-11">
                    <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                    想繼續深入
                  </Checkbox.Content>
                </Checkbox>
                <Button className="min-h-11" variant="secondary" onPress={() => void removeCompleted(item)}>移除</Button>
              </div>
            </div>
          ))}
        </Card.Content>
      </Card>

      <Modal open={Boolean(importPreview)} title="確認匯入備份" onClose={() => setImportPreview(undefined)}>
        {importPreview && <div className="dialog-content"><p>備份日期：{importPreview.exportedAt}</p><ul><li>已修：{importPreview.data.completedCourses.length}</li><li>收藏：{importPreview.data.favorites.length}</li><li>不感興趣：{importPreview.data.dismissedCourses.length}</li><li>課表：{importPreview.data.schedulePlans.length}</li></ul>
          <Checkbox isSelected={overwriteProfile} onChange={setOverwriteProfile}>
            <Checkbox.Content className="min-h-11">
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              用備份中的個人設定覆蓋目前設定
            </Checkbox.Content>
          </Checkbox>
        </div>}
        <div className="dialog-actions">
          <Button className="min-h-11" isDisabled={busy === "import"} variant="secondary" onPress={() => setImportPreview(undefined)}>取消</Button>
          <Button className="min-h-11" isDisabled={busy === "import"} isPending={busy === "import"} onPress={() => void confirmImport()}>{busy === "import" ? "匯入中…" : "匯入並合併"}</Button>
        </div>
      </Modal>
      <ConfirmDialog open={clearOpen} title="清除所有個人資料？" description={<p>將清除這台裝置上的個人設定、已修課、收藏、不感興趣的課程與課表。此操作無法復原。</p>} confirmLabel="清除所有資料" destructive busy={busy === "clear"} onCancel={() => setClearOpen(false)} onConfirm={clearAll} />
    </section>
  );
}
