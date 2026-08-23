import { useRef, useState } from "react";
import { useLookupCourses } from "@/data/queries";
import {
  clearPersonalData,
  createBackup,
  deleteRecord,
  importBackup,
  putRecord,
  validateBackup,
} from "@/data/db";
import { useLocalRecords } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { ConfirmDialog, Modal, useFeedback } from "@/components/ui";
import type { CompletedCourse } from "@/domain/types";

export function DataPage() {
  const completed = useLocalRecords<CompletedCourse & { id: string }>("completedCourses");
  const favorites = useLocalRecords<{ id: string }>("favorites");
  const { plans } = useSchedulePlans();
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
      for (const course of result.items) await putRecord("completedCourses", { id: course.course_id, courseId: course.course_id, courseName: course.name_zh, continueLearning: false, addedAt: new Date().toISOString() });
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
    <section className="page">
      <div className="page-heading"><div><div className="eyebrow">你的資料由你掌控</div><h1>資料管理</h1></div></div>
      <div className="data-grid">
        <section className="card">
          <h2>批次加入已修課程</h2>
          <label htmlFor="completed-course-codes"><strong>課號或完整課名</strong></label>
          <p id="completed-course-helper">以空白、逗號或換行分隔，例如課號 D030201234 或完整課名。</p>
          <textarea ref={codesRef} id="completed-course-codes" aria-describedby="completed-course-helper" rows={6} value={codes} onChange={(event) => setCodes(event.target.value)} placeholder={"D030201234\n資料結構"} disabled={busy === "recognize"} />
          <button className="primary" type="button" onClick={() => void addCodes()} disabled={!codes.trim() || busy === "recognize"} aria-busy={busy === "recognize"}>{busy === "recognize" ? "辨識中…" : "辨識並加入"}</button>
        </section>
        <section className="card">
          <h2>本機資料摘要</h2>
          <div className="big-stats"><span><strong>{completed.length}</strong>已修課程</span><span><strong>{favorites.length}</strong>收藏</span><span><strong>{plans.length}</strong>課表方案</span></div>
          <button type="button" onClick={() => void exportData()} disabled={busy === "export"} aria-busy={busy === "export"}>{busy === "export" ? "匯出中…" : "匯出 JSON 備份"}</button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy === "import"} aria-busy={busy === "import"}>{busy === "import" ? "讀取中…" : "匯入 JSON 備份"}</button>
          <input ref={fileRef} hidden type="file" accept="application/json" onChange={(event) => event.target.files?.[0] && void readImport(event.target.files[0])}/>
          <button type="button" className="danger-button" onClick={() => setClearOpen(true)}>清除所有個人資料</button>
        </section>
      </div>
      <section className="card list-card">
        <h2>已修課程</h2>
        {!completed.length && <div className="inline-empty"><p>尚未加入已修課程。加入後可讓推薦避開重複修課。</p><button type="button" onClick={() => codesRef.current?.focus()}>前往批次加入</button></div>}
        {completed.map((item) => <div className="completed-row" key={item.id}><span className="completed-name">{item.courseName}</span><div className="completed-actions"><label className="check"><input type="checkbox" checked={item.continueLearning} onChange={() => void putRecord("completedCourses", { ...item, continueLearning: !item.continueLearning })}/>想繼續深入</label><button type="button" onClick={() => void removeCompleted(item)}>移除</button></div></div>)}
      </section>
      <Modal open={Boolean(importPreview)} title="確認匯入備份" onClose={() => setImportPreview(undefined)}>
        {importPreview && <div className="dialog-content"><p>備份日期：{importPreview.exportedAt}</p><ul><li>已修：{importPreview.data.completedCourses.length}</li><li>收藏：{importPreview.data.favorites.length}</li><li>課表：{importPreview.data.schedulePlans.length}</li></ul><label className="check"><input type="checkbox" checked={overwriteProfile} onChange={(event) => setOverwriteProfile(event.target.checked)} />用備份中的個人設定覆蓋目前設定</label></div>}
        <div className="dialog-actions"><button type="button" className="secondary" disabled={busy === "import"} onClick={() => setImportPreview(undefined)}>取消</button><button type="button" disabled={busy === "import"} aria-busy={busy === "import"} onClick={() => void confirmImport()}>{busy === "import" ? "匯入中…" : "匯入並合併"}</button></div>
      </Modal>
      <ConfirmDialog open={clearOpen} title="清除所有個人資料？" description={<p>將清除這台裝置上的個人設定、已修課、收藏與課表。此操作無法復原。</p>} confirmLabel="清除所有資料" destructive busy={busy === "clear"} onCancel={() => setClearOpen(false)} onConfirm={clearAll} />
    </section>
  );
}
