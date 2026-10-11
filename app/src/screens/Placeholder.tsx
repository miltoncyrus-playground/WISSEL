import type { ScreenId } from "../routes";

// Ask, Listen and You arrive in later cards (docs/SDD-wissel-app.md
// §6). Until then each tab says what it will hold.
type Pending = Exclude<ScreenId, "board" | "feed">;

const COPY: Record<Pending, { title: string; text: string }> = {
  ask: { title: "Ask wissel", text: "Chat with wissel to create cards, run pipelines and check what is running. Coming soon." },
  listen: { title: "Listen", text: "Every podcast episode, with a player that keeps going while you move around. Coming soon." },
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
