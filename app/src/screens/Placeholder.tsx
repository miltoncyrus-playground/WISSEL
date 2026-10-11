import type { ScreenId } from "../routes";

// You arrives in a later card (docs/SDD-wissel-app.md §6). Until then
// the tab says what it will hold.
type Pending = Exclude<ScreenId, "board" | "feed" | "listen" | "ask">;

const COPY: Record<Pending, { title: string; text: string }> = {
  you: { title: "You", text: "Your week in wissel: cards merged, streaks and the lesson of the week. Coming soon." },
};

export function Placeholder({ screen }: { screen: Pending }) {
  const c = COPY[screen];
  return (
    <div className={`screen placeholder screen-${screen}`}>
      <div className="screen-head">
        <h1>{c.title}</h1>
      </div>
      <p className="lede">{c.text}</p>
      <a className="btn" href="#/board">
        See the board
      </a>
    </div>
  );
}
