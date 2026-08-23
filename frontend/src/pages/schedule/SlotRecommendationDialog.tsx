import { Check, Plus, Sparkle, Warning } from "@phosphor-icons/react";
import { eligibilityStatusShortLabels } from "@/domain/eligibility";
import { recommendationCategoryLabels } from "@/domain/recommendation";
import { formatMeetings, weekdayLabels } from "@/domain/schedule";
import { Modal } from "@/components/ui";
import { scheduleRecommendationCategories, useSlotRecommendation } from "./SlotRecommendationContext";

export function SlotRecommendationDialog() {
  const {
    slot,
    result,
    loading,
    error,
    addingCourseId,
    categoryFilters,
    close,
    retry,
    add,
    toggleCategory,
    selectAllCategories,
  } = useSlotRecommendation();
  const slotLabel = slot ? `星期${weekdayLabels[slot.weekday - 1]} ${slot.section}` : "空白時段";
  return <Modal open={Boolean(slot)} title={`${slotLabel} 的課程推薦`} onClose={close} className="schedule-dialog slot-recommendation-dialog">
    <div className="slot-recommendation-intro">
      <span className="eyebrow"><Sparkle aria-hidden="true" />依目前課表推測</span>
      <p>只推薦完整上課時間能排入課表的課程。課表內容留在此裝置，不會送出作為查詢。</p>
    </div>
    <fieldset className="slot-category-filters" disabled={loading}>
      <legend>顯示哪些課程</legend>
      <div className="slot-category-filter-heading"><span>可複選課程分類</span><button type="button" disabled={loading || categoryFilters.length === scheduleRecommendationCategories.length} onClick={selectAllCategories}>全選</button></div>
      <div className="slot-category-filter-options">{scheduleRecommendationCategories.map((category) => {
        const selected = categoryFilters.includes(category);
        return <button type="button" key={category} className={`slot-category-filter ${category} ${selected ? "selected" : ""}`} aria-pressed={selected} onClick={() => toggleCategory(category)}>{selected && <Check aria-hidden="true" />}{recommendationCategoryLabels[category]}</button>;
      })}</div>
    </fieldset>
    {loading && <div className="slot-recommendation-state" role="status"><strong>正在比對課表興趣…</strong><span>同時檢查完整時段、修課資格與重複課程。</span></div>}
    {!loading && error && <div className="notice danger" role="alert"><strong>無法產生推薦</strong><span>{error}</span><button type="button" onClick={retry}>重試</button></div>}
    {!loading && !error && categoryFilters.length === 0 && <div className="slot-recommendation-state"><strong>尚未選擇課程分類</strong><span>請至少選擇一種分類，或使用「全選」恢復全部結果。</span><button type="button" onClick={selectAllCategories}>顯示全部分類</button></div>}
    {!loading && !error && categoryFilters.length > 0 && result?.basisCourseCount === 0 && <div className="slot-recommendation-state"><strong>目前沒有足夠的課程推測興趣</strong><span>先在這個方案加入至少一門有課程向量的課，再點選空白時段。</span></div>}
    {!loading && !error && categoryFilters.length > 0 && result && result.basisCourseCount > 0 && <>
      <div className="slot-recommendation-summary" role="status">
        <span><strong>{result.basisCourseCount}</strong> 門課作為依據</span>
        <span><strong>{result.interestClusterCount}</strong> 個興趣方向</span>
        <span><strong>{result.candidateCount}</strong> 門通過排課檢查</span>
      </div>
      {result.lowConfidence && <p className="slot-confidence-note"><Warning aria-hidden="true" />{result.requiredOnly ? "目前課表只有必修課，興趣推測的參考性較低。" : "目前作為興趣依據的課程較少，推薦結果僅供探索。"}</p>}
      {!result.recommendations.length ? <div className="slot-recommendation-state"><strong>這個時段暫時沒有合適課程</strong><span>候選課程可能有其他節次衝堂、資格不符，或已經在課表與已修清單中。</span></div> : <div className="slot-recommendation-list">
        {result.recommendations.map((recommendation, index) => <article key={recommendation.course.course_id}>
          <div className="slot-recommendation-rank" aria-label={`推薦順位 ${index + 1}`}>{index + 1}</div>
          <div className="slot-recommendation-content">
            <div className="slot-recommendation-heading"><div><h3>{recommendation.course.name_zh}</h3><p>{recommendation.course.name_en}</p></div><div className="slot-recommendation-tags"><span className={`category-tag ${recommendation.category}`}>{recommendationCategoryLabels[recommendation.category]}</span><span className={`status ${recommendation.eligibility}`}>{eligibilityStatusShortLabels[recommendation.eligibility]}</span></div></div>
            <div className="slot-recommendation-meta"><span>{recommendation.course.credits === null ? "學分未定" : `${recommendation.course.credits} 學分`}</span><span>{recommendation.course.teacher || "教師未定"}</span><span>{recommendation.course.required_elective_name || "類別未定"}</span></div>
            <p className="meeting">{formatMeetings(recommendation.course)}</p>
            <ul className="reasons">{recommendation.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            {recommendation.alternatives.length > 0 && <p className="muted">另有 {recommendation.alternatives.length} 個符合時段的班別／共同開課項目</p>}
            <div className="slot-recommendation-actions"><a href={recommendation.course.source_url} target="_blank" rel="noreferrer">查看官方課綱</a><button type="button" className="primary" disabled={Boolean(addingCourseId)} aria-busy={addingCourseId === recommendation.course.course_id} onClick={() => add(recommendation.course.course_id)}><Plus aria-hidden="true" />{addingCourseId === recommendation.course.course_id ? "加入中…" : "加入課表"}</button></div>
          </div>
        </article>)}
      </div>}
    </>}
  </Modal>;
}
