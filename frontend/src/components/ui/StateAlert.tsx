import type { ReactNode } from "react";
import { Alert } from "@heroui/react";

/** `info` maps to HeroUI's `accent`; the design system's own `--info` is bridged separately. */
export type StateAlertTone = "info" | "success" | "warning" | "danger";

const STATUS: Record<StateAlertTone, "accent" | "success" | "warning" | "danger"> = {
  danger: "danger",
  info: "accent",
  success: "success",
  warning: "warning",
};

export interface StateAlertProps {
  tone?: StateAlertTone;
  /** Optional bold lead-in. Omit for one-line notices. */
  title?: ReactNode;
  children?: ReactNode;
  /** Retry / recovery control, rendered after the copy. */
  action?: ReactNode;
  /**
   * Announcement strength. `danger` defaults to `alert` (assertive) because an
   * error the user did not ask for has to interrupt; everything else defaults
   * to `status` (polite). `off` is for copy that is already announced by
   * something else.
   */
  live?: "assertive" | "polite" | "off";
  className?: string;
}

/**
 * The one inline message component. Replaces the hand-rolled `.notice` /
 * `.notice.danger` divs, which carried an inconsistent mix of `role="alert"`,
 * `role="status"` and no role at all, and conveyed severity with colour only —
 * `Alert.Indicator` adds the icon channel that plan §4.3 requires.
 */
export function StateAlert({ tone = "info", title, children, action, live, className }: StateAlertProps) {
  const politeness = live ?? (tone === "danger" ? "assertive" : "polite");
  const role = politeness === "assertive" ? "alert" : politeness === "polite" ? "status" : undefined;
  return (
    <Alert className={className} role={role} status={STATUS[tone]}>
      <Alert.Indicator />
      <Alert.Content>
        {title ? <Alert.Title>{title}</Alert.Title> : null}
        {children ? <Alert.Description>{children}</Alert.Description> : null}
        {action}
      </Alert.Content>
    </Alert>
  );
}
