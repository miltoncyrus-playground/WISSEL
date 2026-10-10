import { shortcutLabel } from "../commands";
import { SCREENS, routeHash, type ScreenId } from "../routes";
import { Icon } from "./Icon";

interface NavProps {
  current: ScreenId;
  onOpenPalette: () => void;
}

/** Phone: the bottom tab bar. Real links, so the tabs work without
 *  JavaScript tricks and show their URL. */
export function TabBar({ current }: { current: ScreenId }) {
  return (
    <nav className="tabbar" aria-label="Screens">
      {SCREENS.map((s) => (
        <a key={s.id} href={routeHash({ screen: s.id })} className="tab" aria-current={s.id === current ? "page" : undefined}>
          <Icon name={s.id} />
          <span>{s.label}</span>
        </a>
      ))}
    </nav>
  );
}

/** Desktop: the left rail, with the palette as a search field-like
 *  button and a way back to the full board. */
export function Rail({ current, onOpenPalette }: NavProps) {
  return (
    <nav className="rail" aria-label="Screens">
      <a className="brand" href={routeHash({ screen: "ask" })}>
        wissel
      </a>
      <button type="button" className="rail-search" onClick={onOpenPalette} aria-keyshortcuts="Meta+K Control+K">
        <Icon name="search" size={18} />
        <span>Search or jump</span>
        <kbd>{shortcutLabel(navigator.platform)}</kbd>
      </button>
      <ul>
        {SCREENS.map((s) => (
          <li key={s.id}>
            <a href={routeHash({ screen: s.id })} className="rail-link" aria-current={s.id === current ? "page" : undefined}>
              <Icon name={s.id} size={20} />
              <span>{s.label}</span>
            </a>
          </li>
        ))}
      </ul>
      <a className="rail-board" href="/board">
        <Icon name="external" size={18} />
        <span>Open full board</span>
      </a>
    </nav>
  );
}

/** Phone: the top bar with the screen title and the palette button. */
export function TopBar({ title, onOpenPalette }: { title: string; onOpenPalette: () => void }) {
  return (
    <header className="topbar">
      <a className="brand" href={routeHash({ screen: "ask" })}>
        wissel
      </a>
      <span className="topbar-title">{title}</span>
      <button type="button" className="icon-btn" onClick={onOpenPalette} aria-label="Search or jump" aria-keyshortcuts="Meta+K Control+K">
        <Icon name="search" />
      </button>
    </header>
  );
}
