import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Toast, ToastQueue } from "@heroui/react";

export interface FeedbackAction {
  label: string;
  onAction: () => void | Promise<void>;
}

export type FeedbackTone = "success" | "error";

interface FeedbackToast {
  message: string;
  tone: FeedbackTone;
  action?: FeedbackAction;
}

/** Dismissal is generous: an undo has to survive reading the sentence first. */
const ACTION_TIMEOUT_MS = 6000;
const PLAIN_TIMEOUT_MS = 5000;

/**
 * Module-level on purpose: this is what lets `notify` be callable from anywhere
 * without threading a ref, and it is the single queue that replaced the three
 * parallel mechanisms (this provider's own toast, `ScheduleWorkspace`'s
 * `.undo-toast`, `ManualCoursePanel`'s `.notice`) — plan §6.3-3.
 */
const feedbackQueue = new ToastQueue<FeedbackToast>({ maxVisibleToasts: 3 });

const FeedbackContext = createContext<{
  notify: (message: string, tone?: FeedbackTone, action?: FeedbackAction) => void;
}>({ notify: () => undefined });

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => ({
    notify: (message: string, tone: FeedbackTone = "success", action?: FeedbackAction) => {
      feedbackQueue.add({ action, message, tone }, {
        timeout: action ? ACTION_TIMEOUT_MS : PLAIN_TIMEOUT_MS,
      });
    },
  }), []);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <Toast.Provider<FeedbackToast> placement="bottom end" queue={feedbackQueue}>
        {({ toast: item }) => {
          const { action, message, tone } = item.content;
          const isError = tone === "error";
          return (
            <Toast toast={item} variant={isError ? "danger" : "success"}>
              <Toast.Indicator variant={isError ? "danger" : "success"} />
              {/*
                React Aria hard-codes `role="alert"` (implicitly assertive) on
                every toast body. That would make routine "saved" confirmations
                interrupt whatever the screen reader is saying, so the tone ->
                politeness mapping the old implementation had is re-asserted
                here: danger interrupts, success waits its turn. Both props are
                spread after the context props inside HeroUI's `ToastContent`,
                so they genuinely win.
              */}
              <Toast.Content
                aria-live={isError ? "assertive" : "polite"}
                role={isError ? "alert" : "status"}
              >
                <Toast.Title>{message}</Toast.Title>
              </Toast.Content>
              {action && (
                <Toast.ActionButton
                  className="min-h-11"
                  variant="tertiary"
                  onPress={() => {
                    void Promise.resolve(action.onAction()).finally(() => feedbackQueue.close(item.key));
                  }}
                >
                  {action.label}
                </Toast.ActionButton>
              )}
              <Toast.CloseButton aria-label="關閉通知" className="min-h-11 min-w-11" />
            </Toast>
          );
        }}
      </Toast.Provider>
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  return useContext(FeedbackContext);
}
