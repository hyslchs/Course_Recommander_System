import { useEffect, type ReactNode, type RefObject } from "react";
import { Drawer as HeroDrawer } from "@heroui/react";

export interface SideDrawerProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** `bottom` is the mobile default; `right`/`left` are the desktop shapes. */
  placement?: "top" | "bottom" | "left" | "right";
  /** Renders the drag affordance. Only meaningful for `bottom`/`top`. */
  showHandle?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  closeLabel?: string;
}

/**
 * Controlled edge panel, same contract as `Modal` so callers can swap by
 * breakpoint. React Aria backs it with the identical dialog machinery — focus
 * trap, scroll lock, Escape and return-focus — plus pointer drag-to-dismiss.
 */
export function SideDrawer({
  open,
  title,
  onClose,
  children,
  placement = "bottom",
  showHandle = placement === "bottom" || placement === "top",
  initialFocusRef,
  className,
  closeLabel = "關閉面板",
}: SideDrawerProps) {
  // Same gap as `Modal`: React Aria contains and restores focus but never places
  // it. Without an `initialFocusRef` the panel container itself keeps focus,
  // which is a reasonable default for a drawer (the first Tab still lands on
  // the first control), so no close-button fallback is wired up here —
  // `DrawerCloseTriggerProps` does not accept a `ref` in 3.2.4 anyway, unlike
  // its Modal counterpart.
  useEffect(() => {
    if (!open || !initialFocusRef) return;
    const frame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [initialFocusRef, open]);

  return (
    <HeroDrawer.Backdrop isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <HeroDrawer.Content placement={placement}>
        <HeroDrawer.Dialog className={className}>
          {showHandle && <HeroDrawer.Handle />}
          <HeroDrawer.CloseTrigger aria-label={closeLabel} className="min-h-11 min-w-11" />
          <HeroDrawer.Header>
            <HeroDrawer.Heading level={2}>{title}</HeroDrawer.Heading>
          </HeroDrawer.Header>
          <HeroDrawer.Body>{children}</HeroDrawer.Body>
        </HeroDrawer.Dialog>
      </HeroDrawer.Content>
    </HeroDrawer.Backdrop>
  );
}
