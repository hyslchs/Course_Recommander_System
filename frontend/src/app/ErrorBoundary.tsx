import { Component, type ErrorInfo, type ReactNode } from "react";
import { track } from "@/analytics/client";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error?: Error;
}

/**
 * Route-level error boundary. React still has no hook equivalent, so this stays
 * a class component. The fallback renders the route's single `<h1>` so the
 * focus contract in `RouteFocusManager` keeps holding when a route throws.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("頁面發生未預期的錯誤", error, info.componentStack);
    // Two fixed enum members and nothing else. The message and the component
    // stack stay in the console, where they are useful and where they cannot
    // carry a course name, a query or a profile field into a database.
    track("error", { component: "app_shell", error_code: "RENDER_ERROR" });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="page">
        <div className="empty-panel">
          <h1>這個頁面發生錯誤</h1>
          <p>其他功能仍可使用；重新載入頁面通常就能恢復。你儲存在這台裝置上的資料不受影響。</p>
          <p className="muted">{error.message}</p>
          <div className="empty-actions">
            <button type="button" onClick={() => this.setState({ error: undefined })}>重試這個頁面</button>
            <button type="button" onClick={() => window.location.reload()}>重新載入</button>
          </div>
        </div>
      </section>
    );
  }
}
