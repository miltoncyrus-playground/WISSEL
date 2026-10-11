import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { step, type Story } from "../stories";
import { FeedActions, KIND_LABEL, toneOf, whenText } from "./FeedEntry";
import { Icon } from "./Icon";

interface StoryViewerProps {
  stories: Story[];
  /** Index of the story to open. Mount the viewer to open it. */
  start: number;
  now: number;
  onClose: () => void;
  /** Called with each story as it is shown, to grey its ring. */
  onSeen: (story: Story) => void;
  onNotice: (text: string) => void;
}

/** A horizontal move of at least this many px is a swipe. */
const SWIPE_PX = 50;

/** Full-screen story player: a modal <dialog> (Escape closes it,
 *  natively), open while mounted. Tap the right side or swipe left for
 *  the next item, the left side or swipe right for the previous one;
 *  arrow keys too. Past a story's last item it moves on to the next
 *  story, and past the last story it closes. A swipe down closes. No
 *  auto-advance, so nothing moves on its own (reduced motion needs
 *  nothing extra). */
export function StoryViewer({ stories, start, now, onClose, onSeen, onNotice }: StoryViewerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [at, setAt] = useState({ story: start, item: 0 });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  // A swipe that starts and ends on a nav button would also click it.
  const swiped = useRef(false);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const story = stories[at.story];
  const item = story?.items[at.item];

  useEffect(() => {
    if (story) onSeen(story);
  }, [story, onSeen]);

  // The live feed can shrink a story while it plays; close rather than
  // point past the end.
  useEffect(() => {
    if (!item) onClose();
  }, [item, onClose]);

  const go = (dir: 1 | -1) => {
    const to = step(stories, at, dir);
    if (to) setAt(to);
    else if (dir === 1) onClose();
  };

  const onNav = (dir: 1 | -1) => () => {
    if (swiped.current) {
      swiped.current = false;
      return;
    }
    go(dir);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    pointer.current = { x: e.clientX, y: e.clientY };
    swiped.current = false;
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const from = pointer.current;
    pointer.current = null;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      markSwiped();
      go(dx < 0 ? 1 : -1);
    } else if (dy >= SWIPE_PX * 2 && dy > Math.abs(dx)) {
      markSwiped();
      onClose();
    }
  };
  // The swipe's own click, if any, comes right after pointerup in the
  // same task. When it lands on the frame rather than a nav button
  // (down and up on different elements), nothing clears the flag, so it
  // is cleared after the task; otherwise a later keyboard Enter on Next
  // would be swallowed.
  const markSwiped = () => {
    swiped.current = true;
    setTimeout(() => {
      swiped.current = false;
    }, 0);
  };

  return (
    <dialog
      ref={dialog}
      className="story-viewer"
      aria-label={story ? `${story.label} story` : "Story"}
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          go(1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          go(-1);
        }
      }}
    >
      {story && item && (
        <div className="story-frame" onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
          <ol className="story-progress" aria-label={`Item ${at.item + 1} of ${story.items.length}`}>
            {story.items.map((it, i) => (
              <li key={it.id} className={i < at.item ? "is-done" : i === at.item ? "is-current" : ""} />
            ))}
          </ol>
          <div className="story-head">
            <span className="story-name">{story.label}</span>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close story">
              <Icon name="close" />
            </button>
          </div>
          <button type="button" className="story-nav story-prev" onClick={onNav(-1)} aria-label="Previous">
            <Icon name="back" />
          </button>
          <button type="button" className="story-nav story-next" onClick={onNav(1)} aria-label="Next">
            <Icon name="next" />
          </button>
          <article className={`story-card ${toneOf(item)}`} aria-live="polite" data-id={item.id}>
            <div className="feed-meta">
              <span className="feed-kind">{KIND_LABEL[item.kind]}</span>
              <time dateTime={item.at}>{whenText(item, now)}</time>
            </div>
            <h2 className="story-title">{item.title}</h2>
            {item.detail && <p className="story-detail">{item.detail}</p>}
            {item.audioUrl && <audio className="feed-audio" controls preload="none" src={item.audioUrl} aria-label={`Play ${item.title}`} />}
            {item.links.length > 0 && <FeedActions item={item} onNotice={onNotice} />}
          </article>
        </div>
      )}
    </dialog>
  );
}
