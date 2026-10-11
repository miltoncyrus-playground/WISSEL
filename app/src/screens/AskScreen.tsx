import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { chipsOf, costText, isSendKey, MAX_MESSAGE_LENGTH, quickReplies, sendable, type Chip } from "../ask";
import { Icon } from "../components/Icon";
import { usePodcasts } from "../hooks";
import { routeHash } from "../routes";
import { timeAgo } from "../time";
import type { ChatMessage, PipelineDef, PodcastEpisode, TaskCard } from "../types";
import type { AskState } from "../useAsk";
import { usePlayer } from "../usePlayer";

/** The Ask tab (docs/SDD-wissel-app.md §3.4): the chat with the
 *  concierge. Cards it makes show as chips that follow the board live;
 *  a podcast run gets Play once its audio is ready. */
export function AskScreen({
  ask,
  tasks,
  tasksLoaded,
  pipelines,
  now,
}: {
  ask: AskState;
  tasks: TaskCard[];
  tasksLoaded: boolean;
  pipelines: PipelineDef[];
  now: number;
}) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const podcasts = usePodcasts();
  const replies = useMemo(() => quickReplies(pipelines), [pipelines]);

  // The newest message (or "Thinking") in view.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [ask.messages.length, ask.thinking]);

  const submit = (text: string) => {
    const t = sendable(text);
    if (!t || ask.thinking) return;
    ask.send(t);
    setDraft("");
    input.current?.focus();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const { key, shiftKey, altKey, ctrlKey, metaKey } = e;
    if (!isSendKey({ key, shiftKey, altKey, ctrlKey, metaKey, isComposing: e.nativeEvent.isComposing })) return;
    e.preventDefault();
    submit(draft);
  };

  const empty = ask.loaded && ask.messages.length === 0 && !ask.thinking;

  return (
    <div className="screen ask-screen">
      <div className="screen-head">
        <h1>Ask wissel</h1>
        <button type="button" className="btn btn-small" onClick={ask.newChat} disabled={ask.messages.length === 0 && !ask.conversationId}>
          <Icon name="plus" size={18} />
          New chat
        </button>
      </div>

      <details
        className="ask-history"
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) ask.listChats();
        }}
      >
        <summary>Earlier chats</summary>
        {ask.chats === null ? (
          <p className="empty">Loading…</p>
        ) : ask.chats.length === 0 ? (
          <p className="empty">No chats yet.</p>
        ) : (
          <ul className="chat-list">
            {ask.chats.map((c) => (
              <li key={c.id}>
                <button type="button" className="chat-link" aria-current={c.id === ask.conversationId ? "true" : undefined} onClick={() => ask.openChat(c.id)}>
                  <span className="chat-title">{c.title}</span>
                  <time className="mono" dateTime={c.updatedAt}>
                    {timeAgo(c.updatedAt, now)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>

      {!ask.loaded ? (
        <p className="empty">Loading…</p>
      ) : empty ? (
        <p className="lede">Ask for a card, a pipeline run, or what is going on. Merging and settings stay on the board.</p>
      ) : null}

      <ol className="chat" role="log" aria-label="Messages">
        {ask.messages.map((m) => (
          <Message key={m.id} message={m} tasks={tasks} tasksLoaded={tasksLoaded} episodes={podcasts.episodes} />
        ))}
        {ask.thinking && (
          <li className="msg msg-assistant is-thinking">
            <p className="msg-text">
              Thinking
              <span className="dots" aria-hidden="true">
                <span>.</span>
                <span>.</span>
                <span>.</span>
              </span>
            </p>
          </li>
        )}
      </ol>
      <div ref={end} />

      {ask.error && (
        <p className="error" role="alert">
          Could not send: {ask.error}
        </p>
      )}

      <div className="composer-wrap">
        <ul className="quick-replies" aria-label="Quick replies">
          {replies.map((r) => (
            <li key={r.label}>
              {"href" in r ? (
                <a className="quick-reply" href={r.href}>
                  {r.label}
                </a>
              ) : (
                <button type="button" className="quick-reply" disabled={ask.thinking} onClick={() => submit(r.text)}>
                  {r.label}
                </button>
              )}
            </li>
          ))}
        </ul>
        <form className="composer" onSubmit={onSubmit}>
          <label htmlFor="ask-input" className="sr-only">
            Message
          </label>
          <textarea
            id="ask-input"
            ref={input}
            rows={1}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="Ask wissel"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="icon-btn send-btn" aria-label="Send" disabled={ask.thinking || !sendable(draft)}>
            <Icon name="send" size={20} />
          </button>
        </form>
      </div>
    </div>
  );
}

function Message({ message, tasks, tasksLoaded, episodes }: { message: ChatMessage; tasks: TaskCard[]; tasksLoaded: boolean; episodes: PodcastEpisode[] }) {
  const chips = message.role === "assistant" ? chipsOf(message, tasks, episodes, tasksLoaded) : [];
  const cost = message.role === "assistant" ? costText(message.costUsd) : "";
  return (
    <li className={`msg msg-${message.role}`} data-id={message.id}>
      <span className="sr-only">{message.role === "user" ? "You:" : "wissel:"}</span>
      <p className="msg-text">{message.text}</p>
      {chips.length > 0 && (
        <ul className="chips" aria-label="Cards">
          {chips.map((c) => (
            <ChipView key={c.key} chip={c} />
          ))}
        </ul>
      )}
      {cost && <p className="msg-cost mono">{cost}</p>}
    </li>
  );
}

function ChipView({ chip }: { chip: Chip }) {
  return (
    <li className={`chip tone-chip-${chip.tone}`} data-task-id={chip.taskId}>
      <a className="chip-link" href={routeHash({ screen: "board", taskId: chip.taskId })}>
        <span className="chip-dot" aria-hidden="true" />
        <span className="chip-text">
          <span className="chip-label">{chip.label}</span>
          <span className="chip-status">{chip.statusText}</span>
        </span>
      </a>
      {chip.track && <ChipPlay chip={chip} />}
    </li>
  );
}

function ChipPlay({ chip }: { chip: Chip }) {
  const player = usePlayer();
  const track = chip.track!;
  const playing = player.state.playing && player.state.track?.runId === track.runId;
  return (
    <button type="button" className="icon-btn chip-play" aria-label={`${playing ? "Pause" : "Play"} ${track.title}`} onClick={() => (playing ? player.pause() : player.play(track))}>
      <Icon name={playing ? "pause" : "play"} size={18} />
    </button>
  );
}
