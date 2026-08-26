import { useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router";
import { List, PencilSimple } from "@phosphor-icons/react";
import { RouteFocusManager } from "./RouteFocusManager";
import { navigationItems } from "./navigation";
// Deliberately the module, not a `@/components/motion` barrel. AppShell is in
// the entry graph; a barrel that also re-exported `BlurFade`/`NumberTicker`
// would drag `motion` (~44 kB gzip) into the entry chunk and load it on
// /onboarding and /schedule, which have no motion at all. Measured: it did.
import { ThemeToggle } from "@/components/motion/ThemeToggle";
import { SideDrawer } from "@/components/ui";
import { useProfile } from "@/hooks/localData";

/**
 * Header, primary navigation, main landmark and footer.
 *
 * The skip link is hand-written and stays first in the document: HeroUI has no
 * equivalent primitive. It sits outside `.app-shell` because the old `Modal`
 * marked that element `inert`; React Aria marks the whole of `#root` inert
 * instead, so the link is covered too — correct either way, since a skip link
 * has nothing to skip to while a dialog owns the screen.
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
            <PencilSimple aria-hidden="true" className="profile-edit-icon" />
            <span className="profile-full">{profileLabel}</span>
            <span className="profile-compact">{profile ? "個人設定 · " + profile.grade + " 年級" : "開始設定"}</span>
          </NavLink>
          {/* Before the menu button so the tab order is …導覽 → 個人設定 →
              外觀 → 選單, matching the visual order at every width. */}
          <ThemeToggle />
          <button type="button" className="icon-button menu-button" aria-label="開啟選單" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <List aria-hidden="true" />
          </button>
        </header>
        <main id="main-content">
          <RouteFocusManager />
          {children}
        </main>
        <footer>
          <span>推薦結果僅供規劃參考；實際資格、名額與開課資訊以校方選課系統為準。</span>
          {/* The disclosure §25 asks for has to be reachable from anywhere, and
              the footer is the one element on every route. */}
          <NavLink className="footer-link" to="/privacy">資料蒐集說明</NavLink>
        </footer>
      </div>
      {/* An edge panel that was being faked with a centred Modal; it is now a
          real Drawer, which also gives it drag-to-dismiss on touch. */}
      <SideDrawer className="navigation-drawer" initialFocusRef={menuFirstRef} open={menuOpen} placement="right" title="前往功能" onClose={() => setMenuOpen(false)}>
        <nav aria-label="行動版主要導覽" onClick={() => setMenuOpen(false)}>
          {navigationItems.map((item, index) => <NavLink ref={index === 0 ? menuFirstRef : undefined} key={item.to} to={item.to}>{item.label}</NavLink>)}
          <NavLink to="/onboarding"><PencilSimple aria-hidden="true" className="profile-edit-icon" />個人設定<span>{profileLabel}</span></NavLink>
        </nav>
      </SideDrawer>
    </>
  );
}
