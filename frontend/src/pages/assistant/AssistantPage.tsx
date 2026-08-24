import { FormEvent, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router";
import { Info } from "@phosphor-icons/react";
import { useAskCourseAssistant, useFeatures } from "@/data/queries";
import { putRecord } from "@/data/db";
import { inferProfileStudyLevel } from "@/domain/eligibility";
import { useLocalRecords, useProfile } from "@/hooks/localData";
import { useSchedulePlans } from "@/hooks/useSchedulePlans";
import { CourseCard } from "@/components/CourseCard";
import { EmptyState, StateAlert } from "@/components/ui";
import { Button, Card, Label, TextArea } from "@heroui/react";
import type { AIAnswer, AIHistoryTurn, CompletedCourse } from "@/domain/types";

type AssistantTurn = { question: string; answer: AIAnswer };

/** `Card.Title` is an `h3`; the hero owns the route's only `<h1>` (plan R9). */
const asHeading2 = (props: React.JSX.IntrinsicElements["h2"]) => <h2 {...props} />;

export function AssistantPage() {
  const profile = useProfile();
  const completed = useLocalRecords<CompletedCourse & { id: string }>("completedCourses");
  const { activePlan } = useSchedulePlans();
  const preferences = useLocalRecords<Record<string, unknown>>("recommendationPreferences");
  const consent = preferences.find((item) => item.id === "ai-assistant-consent-v1");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const assistant = useAskCourseAssistant();
  const loading = assistant.isPending;
  const error = assistant.error ? ((assistant.error as Error).message || "AI 小幫手暫時無法回應，請稍後再試。") : "";
  const [loadingPhase, setLoadingPhase] = useState(0);
  const [lastFailedQuestion, setLastFailedQuestion] = useState("");
  const featuresQuery = useFeatures();
  // `null` until the flag is known; a failed probe means "not configured", as before.
  const enabled = featuresQuery.isPending ? null : featuresQuery.data?.ai_assistant_enabled !== false && !featuresQuery.isError;
  const maxChars = featuresQuery.data?.ai_max_question_chars ?? 500;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [completionAnnouncement, setCompletionAnnouncement] = useState("");
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const phases = ["正在搜尋相關課綱", "正在檢查修課條件", "正在整理推薦理由"];
  const examples = [
    "想學 Python 實作，避開星期三",
    "推薦適合資工二年級的機器學習課",
    "有哪些兩學分且沒有先修要求的課？",
  ];

  useEffect(() => {
    if (!loading) return undefined;
    const timer = window.setInterval(() => setLoadingPhase((current) => (current + 1) % phases.length), 1600);
    return () => window.clearInterval(timer);
  }, [loading, phases.length]);

  const ask = async (event?: FormEvent, questionOverride?: string) => {
    event?.preventDefault();
    const cleaned = (questionOverride ?? question).trim();
    if (!cleaned || loading) return;
    if (!profile) return;
    if (!consent) return;
    setLoadingPhase(0); setLastFailedQuestion(""); setCopied(false); setCompletionAnnouncement("");
    try {
      const response = await assistant.mutateAsync({
        question: cleaned,
        history: turns.slice(-2).map<AIHistoryTurn>((turn) => ({
          question: turn.question,
          recommended_course_ids: turn.answer.recommendations.map((item) => item.course.course_id),
        })),
        context: {
          division: profile.division,
          department: profile.department,
          department_identity: profile.department_identity,
          grade: profile.grade,
          study_level: inferProfileStudyLevel(profile),

          preferred_weekdays: profile.preferredWeekdays,
          completed_course_ids: completed.map((item) => item.courseId),
          schedule_course_ids: activePlan?.entries.map((item) => item.courseId) ?? [],
        },
      });
      setTurns((current) => [...current, { question: cleaned, answer: response }].slice(-6));
      setQuestion("");
      setCompletionAnnouncement(response.recommendations.length
        ? `已完成回答，並附上 ${response.recommendations.length} 門推薦課程。`
        : "已完成回答。");
    } catch {
      // `assistant.error` already carries the message; only the retry target is local state.
      setLastFailedQuestion(cleaned);
    }
  };

  const agree = async () => {
    await putRecord("recommendationPreferences", {
      id: "ai-assistant-consent-v1",
      acceptedAt: new Date().toISOString(),
      version: 1,
    });
  };
  const copyLatest = async () => {
    const latest = turns.at(-1)?.answer.answer;
    if (!latest) return;
    setCopyError("");
    try {
      if (!navigator.clipboard) throw new Error("這個瀏覽器不支援剪貼簿");
      await navigator.clipboard.writeText(latest);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (caught) {
      setCopyError("複製失敗：" + (caught as Error).message);
    }
  };
  const retry = () => {
    const retryQuestion = lastFailedQuestion || turns.at(-1)?.question;
    if (!retryQuestion) return;
    void ask(undefined, retryQuestion);
  };

  if (!profile) return <EmptyState action="開始設定" body="設定系所與年級後，AI 才能避開不適合你的課程。" href="/onboarding" title="先完成個人設定" variant="missing-prerequisite" />;
  return (
    <section className="page assistant-page" data-page="assistant">
      <div className="hero assistant-hero"><div><div className="eyebrow">RAG 課程問答</div><h1>跟課程資料聊聊</h1><p>我會從目前課程目錄與課綱找資料，再說明推薦理由與選課注意事項。</p></div><div className="privacy-pill">● 不使用向量查詢</div></div>
      {!consent ? <Card className="assistant-consent">
        <Card.Header><Card.Title render={asHeading2}>使用前先確認資料範圍</Card.Title></Card.Header>
        <Card.Content>
          <p>這個功能會把你的問題、學制／系級、偏好星期，以及已修與課表中的課程 ID 傳到伺服器和 OpenAI 產生回答；資料會離開本機，並受 OpenAI API 資料控制政策約束。</p>
          <p>不會傳送姓名、帳號、收藏、完整 IndexedDB 或 API key；資料只用於這次課程問答。</p>
        </Card.Content>
        <Card.Footer><Button className="min-h-11" onPress={() => void agree()}>同意並開始使用</Button></Card.Footer>
      </Card> : <>
        {enabled === false && <StateAlert live="off" tone="warning">AI 小幫手尚未設定 API key；其他課程功能仍可正常使用。</StateAlert>}
        <Card className="assistant-composer">
          <form className="flex flex-col gap-2" onSubmit={(event) => void ask(event)}>
            <Label htmlFor="assistant-question"><strong>想問什麼課程問題？</strong></Label>
            <TextArea ref={questionRef} fullWidth id="assistant-question" aria-label="AI 課程問題" maxLength={maxChars} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} placeholder="例如：我想學資料分析，也希望不要和星期一的課衝堂…" />
            <div className="assistant-input-meta"><span>{question.length}/{maxChars}</span><Button className="min-h-11" type="submit" isDisabled={loading || enabled === false || !question.trim()} isPending={loading}>{loading ? "正在整理…" : "詢問小幫手"}</Button></div>
            <div className="assistant-examples" aria-label="問題範例">{examples.map((example) => <Button key={example} size="sm" variant="secondary" onPress={() => setQuestion(example)}>{example}</Button>)}</div>
          </form>
        </Card>
        {loading && <div className="assistant-thinking"><span className="sr-only" role="status">正在整理回答</span><span className="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><strong aria-hidden="true">{phases[loadingPhase]}</strong><span aria-hidden="true">請稍候，正在依課程資料整理答案</span></div>}
        <div className="sr-only" role="status" aria-live="polite">{completionAnnouncement}</div>
        {copyError && <StateAlert tone="danger">{copyError}</StateAlert>}
        {error && <StateAlert action={<Button className="mt-2 min-h-11" variant="secondary" onPress={retry}>重試上一題</Button>} className="assistant-error" tone="danger">{error}</StateAlert>}
        {turns.length > 0 && <div className="assistant-toolbar"><span>本次對話保留最近兩輪上下文</span><div><Button className="min-h-11" size="sm" variant="secondary" onPress={() => void copyLatest()}>{copied ? "已複製" : "複製最新答案"}</Button><Button className="min-h-11" size="sm" variant="secondary" onPress={() => setTurns([])}>清除對話</Button></div></div>}
        <div className="assistant-thread">
          {turns.map((turn, turnIndex) => <article className="assistant-turn" key={`${turn.answer.request_id}-${turnIndex}`}>
            <div className="assistant-user-message"><span>你</span><p>{turn.question}</p></div>
            <Card className="assistant-answer"><div className="assistant-answer-label">AI 課程小幫手</div><p className="assistant-summary">{turn.answer.answer || "目前沒有足夠資料可以補充。"}</p>
              {turn.answer.recommendations.length > 0 && <><h2>推薦課程</h2><div className="course-grid">{turn.answer.recommendations.map((item, index) => <CourseCard key={`${turn.answer.request_id}-${item.course.course_id}`} course={item.course} rank={index + 1} reasons={[item.reason]} cautions={item.cautions} matchedFields={item.matched_fields} />)}</div></>}
              {turn.answer.follow_up_suggestions.length > 0 && <div className="assistant-followups"><strong>你也可以問：</strong>{turn.answer.follow_up_suggestions.map((suggestion) => <Button key={suggestion} size="sm" variant="secondary" onPress={() => { setQuestion(suggestion); window.requestAnimationFrame(() => questionRef.current?.focus()); }}>{suggestion}</Button>)}</div>}
              {turn.answer.limitations.length > 0 && <div className="assistant-limitations">{turn.answer.limitations.map((limitation) => <p key={limitation}><Info aria-hidden="true" />{limitation}</p>)}<NavLink to="/explore">前往探索課程 →</NavLink></div>}
            </Card>
          </article>)}
        </div>
      </>}
    </section>
  );
}
