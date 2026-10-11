import { useState } from "react";
import { postAction } from "../api";
import { timeAgo } from "../time";
import type { FeedItem, FeedKind, FeedLink } from "../types";

export const KIND_LABEL: Record<FeedKind, string> = {
  landed: "Landed",
  "needs-you": "Needs you",
  podcast: "Podcast",
  checks: "Checks",
  spend: "Spend",
};

/** The colour class for an item: checks go coral when one failed. */
export function toneOf(item: Pick<FeedItem, "kind" | "pass">): string {
  if (item.kind === "checks") return item.pass ? "tone-ok" : "tone-alert";
  return `tone-${item.kind}`;
}

/** One feed item's links: a plain link, or a button that POSTs to the
 *  board's own endpoint after a confirm. `onDone` gets a short notice. */
export function FeedActions({ item, onNotice }: { item: FeedItem; onNotice: (text: string) => void }) {
  return (
    <div className="feed-actions">
      {item.links.map((l) =>
        l.method === "POST" ? (
          <ActionButton key={l.href} link={l} title={item.title} onNotice={onNotice} />
        ) : (
          <a key={l.href} className="btn btn-small" href={l.href}>
            {l.label}
          </a>
        ),
      )}
    </div>
  );
}

function ActionButton({ link, title, onNotice }: { link: FeedLink; title: string; onNotice: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small btn-primary"
      disabled={busy}
      onClick={() => {
        if (!window.confirm(`${link.label} "${title}"?`)) return;
        setBusy(true);
        postAction(link.href).then(
          () => {
            setBusy(false);
            onNotice(`${link.label}: done.`);
          },
          (err: unknown) => {
            setBusy(false);
            onNotice(`${link.label} failed: ${err instanceof Error ? err.message : String(err)}`);
          },
        );
      }}
    >
      {busy ? "Working…" : link.label}
    </button>
  );
}

/** "Waiting" for a needs-you item with no recorded time, else "5 min ago". */
export function whenText(item: Pick<FeedItem, "at" | "undated">, now: number): string {
  return item.undated ? "Waiting" : timeAgo(item.at, now);
}

/** One item in the feed list. */
export function FeedEntry({ item, now, onNotice }: { item: FeedItem; now: number; onNotice: (text: string) => void }) {
  const titleId = `feed-${item.id}`;
  return (
    <li>
      <article className={`feed-item ${toneOf(item)}`} aria-labelledby={titleId} data-kind={item.kind} data-id={item.id}>
        <div className="feed-meta">
          <span className="feed-kind">{KIND_LABEL[item.kind]}</span>
          <time dateTime={item.at}>{whenText(item, now)}</time>
        </div>
        <h2 className="feed-title" id={titleId}>
          {item.title}
        </h2>
        {item.detail && <p className="feed-detail">{item.detail}</p>}
        {item.audioUrl && <audio className="feed-audio" controls preload="none" src={item.audioUrl} aria-label={`Play ${item.title}`} />}
        {item.links.length > 0 && <FeedActions item={item} onNotice={onNotice} />}
      </article>
    </li>
  );
}
