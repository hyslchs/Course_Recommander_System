import { useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router";
import { List } from "@phosphor-icons/react";
import { RouteFocusManager } from "./RouteFocusManager";
import { navigationItems } from "./navigation";
import { Modal } from "@/components/ui";
import { useProfile } from "@/hooks/localData";

/**
 * Header, primary navigation, main landmark and footer.
 *
 * The skip link stays outside `.app-shell` on purpose: `Modal` marks
 * `.app-shell` as `inert` while a dialog is open.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const profile = useProfile();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuFirstRef = useRef<HTMLAnchorElement>(null);
  const profileLabel = profile ? profile.department + " " + profile.grade + " 年級" : "開始設定";
  return (
    <>
      <a className="skip-link" href="#main-content">跳到主要內容</a>
      <div className="app-shell">
        <header className="topbar">
          <NavLink to="/recommend" className="brand"><span>FJU</span><strong>選課指南</strong></NavLink>
          <nav className="desktop-nav" aria-label="主要導覽">
            {navigationItems.map((item) => <NavLink key={item.to} to={item.to}>{item.label}</NavLink>)}
          </nav>
          <NavLink className="profile-link desktop-profile" to="/onboarding">
            <span className="profile-full">{profileLabel}</span>
            <span className="profile-compact">{profile ? "個人設定 · " + profile.grade + " 年級" : "開始設定"}</span>
          </NavLink>
          <button type="button" className="icon-button menu-button" aria-label="開啟選單" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <List aria-hidden="true" />
          </button>
        </header>
        <main id="main-content">
          <RouteFocusManager />
          {children}
        </main>
        <footer>MVP 1.0 · 推薦結果僅供規劃參考，實際資格、名額與開課資訊以校方選課系統為準。</footer>
      </div>
      <Modal open={menuOpen} title="前往功能" onClose={() => setMenuOpen(false)} initialFocusRef={menuFirstRef} className="navigation-drawer">
        <nav aria-label="行動版主要導覽" onClick={() => setMenuOpen(false)}>
          {navigationItems.map((item, index) => <NavLink ref={index === 0 ? menuFirstRef : undefined} key={item.to} to={item.to}>{item.label}</NavLink>)}
          <NavLink to="/onboarding">個人設定<span>{profileLabel}</span></NavLink>
        </nav>
      </Modal>
    </>
  );
}
