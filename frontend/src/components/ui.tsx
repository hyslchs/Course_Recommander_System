import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";

export interface FeedbackAction {
  label: string;
  onAction: () => void | Promise<void>;
}

type FeedbackTone = "success" | "error";
interface FeedbackMessage {
  id: number;
  message: string;
  tone: FeedbackTone;
  action?: FeedbackAction;
}

const FeedbackContext = createContext<{
  notify: (message: string, tone?: FeedbackTone, action?: FeedbackAction) => void;
}>({ notify: () => undefined });

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [feedback, setFeedback] = useState<FeedbackMessage | null>(null);
  const nextId = useRef(0);
  const notify = useCallback((message: string, tone: FeedbackTone = "success", action?: FeedbackAction) => {
    nextId.current += 1;
    setFeedback({ id: nextId.current, message, tone, action });
  }, []);

  useEffect(() => {
    if (!feedback || feedback.action) return;
    const timer = window.setTimeout(
      () => setFeedback((current) => (current?.id === feedback.id ? null : current)),
      5000,
    );
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const value = useMemo(() => ({ notify }), [notify]);
  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {feedback && createPortal(
        <div
          className={`toast toast-${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
          aria-live={feedback.tone === "error" ? "assertive" : "polite"}
        >
          <span>{feedback.message}</span>
          {feedback.action && (
            <button
              type="button"
              className="toast-action"
              onClick={async () => {
                await feedback.action?.onAction();
                setFeedback(null);
              }}
            >
              {feedback.action.label}
            </button>
          )}
          <button type="button" className="icon-button toast-close" aria-label="關閉通知" onClick={() => setFeedback(null)}>
            <X aria-hidden="true" />
          </button>
        </div>,
        document.body,
      )}
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const context = useContext(FeedbackContext);
  return context;
}

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  closeLabel?: string;
}

export function Modal({
  open,
  title,
  onClose,
  children,
  initialFocusRef,
  className = "",
  closeLabel = "關閉對話框",
}: ModalProps) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const app = document.querySelector<HTMLElement>(".app-shell");
    const previousOverflow = document.body.style.overflow;
    if (app) app.inert = true;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => (initialFocusRef?.current ?? closeRef.current)?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (app) app.inert = false;
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [initialFocusRef, onClose, open]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        className={`modal-card ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        <div className="modal-heading">
          <h2 id={headingId}>{title}</h2>
          <button ref={closeRef} type="button" className="icon-button dialog-close" aria-label={closeLabel} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  destructive?: boolean;
  busy?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive = false,
  busy = false,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal open={open} title={title} onClose={onCancel} initialFocusRef={cancelRef}>
      <div className="dialog-content">{description}</div>
      <div className="dialog-actions">
        <button ref={cancelRef} type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button>
        <button
          type="button"
          className={destructive ? "danger" : ""}
          disabled={busy}
          aria-busy={busy}
          onClick={() => void onConfirm()}
        >
          {busy ? "處理中…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
