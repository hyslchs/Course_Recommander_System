import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { AlertDialog, Button, Modal as HeroModal } from "@heroui/react";

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Focused instead of the close button once the dialog has mounted. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Applied to `Modal.Dialog`; existing callers use it for content-level rules. */
  className?: string;
  closeLabel?: string;
}

/**
 * Controlled dialog.
 *
 * The hand-rolled focus trap this used to carry (a `focusableSelector` query
 * plus a document-level `keydown` handler that wrapped Tab and Shift+Tab, and a
 * cleanup that toggled `inert` on `.app-shell`, restored `body.overflow` and
 * re-focused the opener) is gone. React Aria's `ModalOverlay` supplies all four
 * behaviours: `FocusScope contain` for the Tab cycle, `usePreventScroll` for the
 * scroll lock, `useOverlay` for Escape, and `FocusScope restoreFocus` for the
 * return focus. The `inert` guarantee survives too, one level higher up: React
 * Aria marks `#root` inert (verified in Chrome; it degrades to `aria-hidden`
 * where `inert` is unsupported, which is what jsdom sees) instead of
 * `.app-shell`, which covers strictly more of the page than the old code did.
 *
 * One behaviour React Aria does *not* provide is initial focus placement:
 * `Overlay` mounts its `FocusScope` with `contain` and `restoreFocus` but
 * without `autoFocus`, so `useDialog` parks focus on the dialog container
 * itself. That is a regression for a small dialog whose first control is the
 * close button, and `ui.test.tsx` pins the old contract, so the same
 * `initialFocusRef ?? closeRef` placement is reproduced explicitly below.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  initialFocusRef,
  className = "",
  closeLabel = "關閉對話框",
}: ModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => (initialFocusRef?.current ?? closeRef.current)?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [initialFocusRef, open]);

  return (
    <HeroModal.Backdrop isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <HeroModal.Container>
        <HeroModal.Dialog className={className || undefined}>
          <HeroModal.Header>
            <HeroModal.CloseTrigger aria-label={closeLabel} className="min-h-11 min-w-11" ref={closeRef} />
            <HeroModal.Heading level={2}>{title}</HeroModal.Heading>
          </HeroModal.Header>
          <HeroModal.Body>{children}</HeroModal.Body>
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  destructive?: boolean;
  busy?: boolean;
}

/**
 * Destructive/irreversible confirmation.
 *
 * `role="alertdialog"` comes from HeroUI's `AlertDialog`, which is a stronger
 * promise than the plain `role="dialog"` this used to render. Backdrop dismissal
 * stays off (the HeroUI default) because a mis-click should not silently cancel,
 * but Escape is re-enabled — HeroUI disables it by default and the previous
 * implementation supported it, so leaving it off would be a regression.
 */
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
  return (
    <AlertDialog.Backdrop
      isKeyboardDismissDisabled={false}
      isOpen={open}
      onOpenChange={(next) => { if (!next) onCancel(); }}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status={destructive ? "danger" : "warning"} />
            <AlertDialog.Heading level={2}>{title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>{description}</AlertDialog.Body>
          <AlertDialog.Footer>
            <Button isDisabled={busy} variant="secondary" onPress={onCancel}>取消</Button>
            <Button
              isDisabled={busy}
              isPending={busy}
              variant={destructive ? "danger" : "primary"}
              onPress={() => void onConfirm()}
            >
              {busy ? "處理中…" : confirmLabel}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
