import type { ScreenId } from "../routes";

// Feed, Ask, Listen and You arrive in later cards (docs/SDD-wissel-app.md
// §6). Until then each tab says what it will hold.
const COPY: Record<Exclude<ScreenId, "board">, { title: string; text: string }> = {
  ask: { title: "Ask wissel", text: "Chat with wissel to create cards, run pipelines and check what is running. Coming soon." },
  feed: { title: "Feed", text: "What landed, what needs you, and new podcasts, newest first. Coming soon." },
  listen: { title: "Listen", text: "Every podcast episode, with a player that keeps going while you move around. Coming soon." },
  you: { title: "You", text: "Your week in wissel: cards merged, streaks and the lesson of the week. Coming soon." },
};

export function Placeholder({ screen }: { screen: Exclude<ScreenId, "board"> }) {
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
