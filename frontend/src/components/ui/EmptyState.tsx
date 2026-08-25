import type { ComponentType, ReactNode } from "react";
import { NavLink } from "react-router";
import { Compass, FunnelX, IdentificationCard } from "@phosphor-icons/react";

/**
 * Plan §4.3's three genuinely different "nothing here" situations. They are not
 * cosmetic variants: each one implies a different next action, so each one gets
 * its own icon and its own default copy slot.
 *
 * - `first-run`          nothing has been asked for yet
 * - `over-filtered`      the query is fine, the filters are too tight
 * - `missing-prerequisite` a setup step earlier in the flow is missing
 */
export type EmptyStateVariant = "first-run" | "over-filtered" | "missing-prerequisite";

const VARIANT_ICON: Record<EmptyStateVariant, ComponentType<{ "aria-hidden"?: boolean; size?: number }>> = {
  "first-run": Compass,
  "missing-prerequisite": IdentificationCard,
  "over-filtered": FunnelX,
};

export interface EmptyStateProps {
  variant?: EmptyStateVariant;
  title: string;
  body?: ReactNode;
  /** Label of the primary control. Omit for a purely informational state. */
  action?: string;
  /** Renders the action as a route link. Mutually exclusive with `onAction`. */
  href?: string;
  onAction?: () => void;
  /** Secondary escape hatch, e.g. "modify the topic". */
  children?: ReactNode;
  /**
   * `1` when the state replaces a whole route (it then owns the route's single
   * `<h1>`, which `RouteFocusManager` depends on); `2` when it sits inside a
   * page that already has one.
   */
  headingLevel?: 1 | 2;
  /** `status` when the state appears as the result of an async update. */
  live?: boolean;
}

export function EmptyState({
  variant = "first-run",
  title,
  body,
  action,
  href,
  onAction,
  children,
  headingLevel = 1,
  live = false,
}: EmptyStateProps) {
  const Icon = VARIANT_ICON[variant];
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section
      className={headingLevel === 1 ? "empty-state" : "empty-panel"}
      data-empty-state={variant}
      role={live ? "status" : undefined}
    >
      <Icon aria-hidden={true} size={32} />
      <Heading>{title}</Heading>
      {body ? <p>{body}</p> : null}
      {action && href ? <NavLink className="primary button-link" to={href}>{action}</NavLink> : null}
      {action && !href ? <button type="button" onClick={onAction}>{action}</button> : null}
      {children}
    </section>
  );
}
