import { NavLink } from "react-router";

/** Full-page empty state. Owns the route's single `<h1>`. */
export function EmptyState({ title, body, action, href }: { title: string; body: string; action: string; href: string }) {
  return <section className="empty-state"><h1>{title}</h1><p>{body}</p><NavLink className="primary button-link" to={href}>{action}</NavLink></section>;
}
