import { useRef, useState } from "react";
import { Button, Card, Checkbox, Label, Meter, TextArea } from "@heroui/react";
import { useLookupCourses } from "@/data/queries";
import {
  clearPersonalData,
  createBackup,
  deleteRecord,
  importBackup,
  putRecord,
  putRecords,
  validateBackup,
} from "@/data/db";
import { useLocalRecords } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { ConfirmDialog, EmptyState, Modal, StateAlert, useFeedback } from "@/components/ui";
import { formatBytes, useStorageEstimate } from "./useStorageEstimate";
import type { CompletedCourse } from "@/domain/types";

/**
 * Storage pressure threshold. Above this the meter turns `warning` AND grows a
 * worded notice — colour alone is never the only channel (plan §4.3).
 */
const STORAGE_WARNING_PERCENT = 80;

/** Card titles render as `h3` by default; the page owns the only `<h1>` (plan R9). */
const asHeading2 = (props: React.JSX.IntrinsicElements["h2"]) => <h2 {...props} />;

export function DataPage() {
  const completed = useLocalRecords<CompletedCourse & { id: string }>("completedCourses");
  const favorites = useLocalRecords<{ id: string }>("favorites");
  const { plans } = useSchedulePlans();
  const lookup = useLookupCourses();
  const { notify } = useFeedback();
  const storage = useStorageEstimate();
  const [codes, setCodes] = useState("");
  const [busy, setBusy] = useState<"recognize" | "export" | "import" | "clear" | "">("");
  const [importPreview, setImportPreview] = useState<ReturnType<typeof validateBackup>>();
  const [overwriteProfile, setOverwriteProfile] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const codesRef = useRef<HTMLTextAreaElement>(null);
  const storageOverBudget = Boolean(storage && storage.percent >= STORAGE_WARNING_PERCENT);

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
    } catch (error) { notify("辨識課程失敗：" + (error as Error).message, "error"); }
    finally { setBusy(""); }
  };
  const exportData = async () => {
    if (busy) return;
    setBusy("export");
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
    try { await clearPersonalData(); notify("這台裝置上的個人資料已清除"); setClearOpen(false); }
    catch (error) { notify("清除失敗：" + (error as Error).message, "error"); }
    finally { setBusy(""); }
  };
  const removeCompleted = async (item: CompletedCourse & { id: string }) => {
    await deleteRecord("completedCourses", item.id);
    notify("已移除「" + item.courseName + "」", "success", { label: "復原", onAction: () => putRecord("completedCourses", item) });
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
            <Card.Title render={asHeading2}>本機資料摘要</Card.Title>
            <Card.Description>全部存在這台裝置的瀏覽器裡，不會上傳。</Card.Description>
          </Card.Header>
          <Card.Content className="flex flex-col gap-4">
            <dl className="data-stats">
              <div><dt>已修課程</dt><dd>{completed.length}</dd></div>
              <div><dt>收藏</dt><dd>{favorites.length}</dd></div>
              <div><dt>課表方案</dt><dd>{plans.length}</dd></div>
            </dl>
            {storage ? (
              <Meter
                className="data-storage-meter"
                color={storageOverBudget ? "warning" : "accent"}
                formatOptions={{ maximumFractionDigits: 1, style: "percent" }}
                value={storage.percent}
              >
                <Label>瀏覽器儲存空間</Label>
                <Meter.Output>{`${formatBytes(storage.usage)} / ${formatBytes(storage.quota)}`}</Meter.Output>
                <Meter.Track><Meter.Fill /></Meter.Track>
              </Meter>
            ) : null}
            {storageOverBudget ? (
              <StateAlert tone="warning" title="儲存空間快滿了">
                匯出一份備份後清除舊資料，才不會影響課表與收藏的儲存。
              </StateAlert>
            ) : null}
          </Card.Content>
          <Card.Footer className="flex flex-wrap gap-2">
            <Button
              className="min-h-11 w-full sm:w-auto"
              isDisabled={busy === "export"}
              isPending={busy === "export"}
              variant="secondary"
              onPress={() => void exportData()}
            >
              {busy === "export" ? "匯出中…" : "匯出 JSON 備份"}
            </Button>
            <Button
              className="min-h-11 w-full sm:w-auto"
              isDisabled={busy === "import"}
              isPending={busy === "import"}
              variant="secondary"
              onPress={() => fileRef.current?.click()}
            >
              {busy === "import" ? "讀取中…" : "匯入 JSON 備份"}
            </Button>
            <input ref={fileRef} hidden type="file" accept="application/json" onChange={(event) => event.target.files?.[0] && void readImport(event.target.files[0])} />
            {/* Irreversible: never wired straight to the handler (ux `Confirmation Dialogs`). */}
            <Button className="min-h-11 w-full sm:w-auto" variant="danger" onPress={() => setClearOpen(true)}>清除所有個人資料</Button>
          </Card.Footer>
        </Card>
      </div>

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
        {importPreview && <div className="dialog-content"><p>備份日期：{importPreview.exportedAt}</p><ul><li>已修：{importPreview.data.completedCourses.length}</li><li>收藏：{importPreview.data.favorites.length}</li><li>課表：{importPreview.data.schedulePlans.length}</li></ul>
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
      <ConfirmDialog open={clearOpen} title="清除所有個人資料？" description={<p>將清除這台裝置上的個人設定、已修課、收藏與課表。此操作無法復原。</p>} confirmLabel="清除所有資料" destructive busy={busy === "clear"} onCancel={() => setClearOpen(false)} onConfirm={clearAll} />
    </section>
  );
}
