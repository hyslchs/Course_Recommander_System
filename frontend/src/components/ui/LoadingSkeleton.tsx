import type { ReactNode } from "react";
import { Skeleton } from "@heroui/react";

export interface LoadingSkeletonProps {
  /**
   * `card-grid` mirrors `.course-grid`, `list` mirrors a stacked result list,
   * `text` is a paragraph placeholder.
   */
  variant?: "card-grid" | "list" | "text";
  /** Number of placeholder rows/cards. Keep it close to the real result count. */
  count?: number;
  /** Announced while the real content loads. */
  label: string;
  /**
   * Visible copy rendered inside the live region, above the bones. Use it when
   * the wait is long enough to deserve an explanation rather than a shimmer.
   */
  caption?: ReactNode;
  className?: string;
}

/**
 * Reserves the space the real content will take, which is the whole point:
 * plan §5 and the `content-jumping` UX rule both care more about the layout not
 * moving than about the shimmer. Animation is left to HeroUI's default so the
 * global `--skeleton-animation` kill switch (T40) can turn it off in one place
 * for `prefers-reduced-motion`.
 */
export function LoadingSkeleton({ variant = "list", count = 4, label, caption, className }: LoadingSkeletonProps) {
  const items = Array.from({ length: count }, (_, index) => index);
  if (variant === "text") {
    return (
      <div aria-label={label} className={className} role="status">
        {caption}
        {items.map((index) => (
          <Skeleton className="h-4 mb-2 rounded" key={index} style={{ width: `${100 - index * 12}%` }} />
        ))}
      </div>
    );
  }
  const isGrid = variant === "card-grid";
  return (
    <div aria-label={label} className={className} role="status">
      {caption}
      <div className={isGrid ? "course-grid" : undefined}>
        {items.map((index) => (
          <div className="flex flex-col gap-3 p-4" key={index}>
            <Skeleton className="h-5 w-3/5 rounded" />
            <Skeleton className="h-4 w-4/5 rounded" />
            <Skeleton className="h-4 w-2/5 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
