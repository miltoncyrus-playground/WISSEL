import { useCallback, useMemo, useState } from "react";
import { FeedEntry } from "../components/FeedEntry";
import { StoryViewer } from "../components/StoryViewer";
import { useFeed } from "../hooks";
import { loadSeen, saveSeen } from "../seen";
import { groupStories, isUnseen, markSeen, type SeenMap, type Story } from "../stories";

/** The Feed tab (docs/SDD-wissel-app.md §3.2): Stories rings for the
 *  last 24 hours, then everything newest first, live over /events. */
export function FeedScreen({ now }: { now: number }) {
  const feed = useFeed();
  const [seen, setSeen] = useState<SeenMap>(() => loadSeen());
  // The stories as they were when one was opened, so a live refresh
  // doesn't reshuffle what is playing.
  const [viewing, setViewing] = useState<{ stories: Story[]; start: number } | null>(null);
  const [notice, setNotice] = useState("");
  const stories = useMemo(() => groupStories(feed.items, now), [feed.items, now]);

  const onSeen = useCallback((story: Story) => {
    setSeen((prev) => {
      const next = markSeen(prev, story);
      saveSeen(next);
      return next;
    });
  }, []);
  const close = useCallback(() => setViewing(null), []);

  return (
    <div className="screen feed-screen">
      <div className="screen-head">
        <h1>Feed</h1>
      </div>

      {stories.length > 0 && (
        <nav className="stories" aria-label="Stories">
          <ul>
            {stories.map((s, i) => {
              const fresh = isUnseen(s, seen);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`story-ring story-${s.id} ${fresh ? "is-new" : "is-seen"}`}
                    aria-label={`${s.label}: ${s.items.length} ${s.items.length === 1 ? "item" : "items"}${fresh ? ", new" : ""}`}
                    onClick={() => setViewing({ stories, start: i })}
                  >
                    <span className="story-dot" aria-hidden="true">
                      <span className="story-count">{s.items.length}</span>
                    </span>
                    <span className="story-label">{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      {feed.error && (
        <p className="error" role="alert">
          Could not load the feed: {feed.error}
        </p>
      )}
      {!feed.loaded ? (
        <p className="empty">Loading…</p>
      ) : feed.items.length === 0 ? (
        <p className="empty">Nothing yet. Landed cards, podcasts and anything that needs you show up here.</p>
      ) : (
        <ul className="feed-list" aria-label="Feed">
          {feed.items.map((item) => (
            <FeedEntry key={item.id} item={item} now={now} onNotice={setNotice} />
          ))}
        </ul>
      )}
      {feed.next && (
        <button type="button" className="btn feed-more" onClick={feed.loadMore} disabled={feed.loadingMore}>
          {feed.loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
      <p className="feed-status" role="status" aria-live="polite">
        {notice}
      </p>

      {viewing && <StoryViewer stories={viewing.stories} start={viewing.start} now={now} onClose={close} onSeen={onSeen} onNotice={setNotice} />}
    </div>
  );
}
