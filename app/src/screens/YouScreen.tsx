import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { fetchWrapped } from "../api";
import { AtWork } from "../components/AtWork";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { COLORS } from "../tokens";
import type { TaskCard, Wrapped } from "../types";
import { agentName, useAgents } from "../useAgents";
import { canShareFile, cardIndexAt, pngFileName, WRAPPED_PERIODS, wrappedCards, type WrappedCard } from "../wrapped";

/** The You tab (docs/SDD-wissel-app.md §3.6): Wissel Wrapped as story
 *  cards you swipe through (a scroll-snap row, so touch, trackpad and
 *  the Previous/Next buttons all move it), a PNG of the current card to
 *  download or share, and the agents at work right now. */
export function YouScreen({ running }: { running: readonly TaskCard[] }) {
  const agents = useAgents();
  const [period, setPeriod] = useState<string>(WRAPPED_PERIODS[0].input);
  const { wrapped, error } = useWrapped(period);
  const cards = useMemo(() => (wrapped ? wrappedCards(wrapped, (id) => agentName(agents, id)) : []), [wrapped, agents]);

  return (
    <div className="screen you-screen">
      <div className="screen-head">
        <h1>You</h1>
        <div className="segmented" role="group" aria-label="Period">
          {WRAPPED_PERIODS.map((p) => (
            <button key={p.input} type="button" className="segment" aria-pressed={period === p.input} onClick={() => setPeriod(p.input)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          Could not load Wrapped: {error}
        </p>
      )}
      {!wrapped ? !error && <p className="empty">Loading your numbers…</p> : <WrappedStories wrapped={wrapped} cards={cards} />}
      <AtWork running={running} headingId="you-at-work" title="Your agents at work" />
    </div>
  );
}

function useWrapped(period: string): { wrapped: Wrapped | null; error: string | null } {
  const [state, setState] = useState<{ period: string; wrapped: Wrapped | null; error: string | null }>({ period, wrapped: null, error: null });
  useEffect(() => {
    let live = true;
    fetchWrapped(period).then(
      (wrapped) => live && setState({ period, wrapped, error: null }),
      (err: unknown) => live && setState({ period, wrapped: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [period]);
  // Another period's numbers never show under this one's button.
  return state.period === period ? state : { wrapped: null, error: null };
}

/** No scroll event for this long: the row has come to rest. */
const SETTLE_MS = 120;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function WrappedStories({ wrapped, cards }: { wrapped: Wrapped; cards: WrappedCard[] }) {
  const trackRef = useRef<HTMLOListElement>(null);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const shareable = typeof navigator.share === "function";

  useEffect(() => {
    setIndex(0);
    trackRef.current?.scrollTo({ left: 0 });
  }, [wrapped]);

  // While a Previous/Next scroll glides to its card, the scroll events on
  // the way report the cards it passes, so they are ignored; once the
  // row stops moving (no scroll event for SETTLE_MS, which also covers a
  // swipe in the middle of a glide) the index is whatever it rests on.
  const gliding = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (settle.current && clearTimeout(settle.current)), []);

  const go = useCallback(
    (i: number) => {
      const el = trackRef.current;
      if (!el || cards.length === 0) return;
      const n = Math.min(cards.length - 1, Math.max(0, i));
      if (Math.abs(el.scrollLeft - n * el.clientWidth) > 1) gliding.current = true;
      el.scrollTo({ left: n * el.clientWidth, behavior: reducedMotion() ? "auto" : "smooth" });
      setIndex(n);
    },
    [cards.length],
  );

  const onScroll = () => {
    const el = trackRef.current;
    if (!el) return;
    if (!gliding.current) setIndex(cardIndexAt(el.scrollLeft, el.clientWidth, cards.length));
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      gliding.current = false;
      setIndex(cardIndexAt(el.scrollLeft, el.clientWidth, cards.length));
    }, SETTLE_MS);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      go(index + (e.key === "ArrowRight" ? 1 : -1));
    }
  };

  const card = cards[index];

  async function png(): Promise<{ blob: Blob; name: string } | null> {
    const node = cardRefs.current[index];
    if (!node || !card) return null;
    // Loaded on first use: the rest of the app never needs it.
    const { toBlob } = await import("html-to-image");
    const blob = await toBlob(node, { pixelRatio: 2, backgroundColor: COLORS.ground });
    return blob ? { blob, name: pngFileName(wrapped, card) } : null;
  }

  async function download() {
    setBusy(true);
    setStatus("Making the image…");
    try {
      const made = await png();
      if (!made) throw new Error("no image");
      saveBlob(made.blob, made.name);
      setStatus(`Saved ${made.name}.`);
    } catch (err) {
      setStatus(`Could not make the image: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    setBusy(true);
    setStatus("Making the image…");
    try {
      const made = await png();
      if (!made) throw new Error("no image");
      const file = new File([made.blob], made.name, { type: "image/png" });
      if (canShareFile(navigator, file)) {
        await navigator.share({ files: [file], title: "Wissel Wrapped", text: card ? `${card.kicker}: ${card.big}` : "Wissel Wrapped" });
        setStatus("Shared.");
      } else {
        // This browser shares text but not images: save it instead.
        saveBlob(made.blob, made.name);
        setStatus(`This browser can't share images, so it was saved as ${made.name}.`);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") setStatus("");
      else setStatus(`Could not share: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wrapped" aria-labelledby="wrapped-title" onKeyDown={onKeyDown}>
      <h2 id="wrapped-title" className="sr-only">
        Wissel Wrapped
      </h2>
      <ol className="wrapped-track" ref={trackRef} onScroll={onScroll}>
        {cards.map((c, i) => (
          <li key={c.id} className="wrapped-slide" aria-label={`${i + 1} of ${cards.length}`} aria-current={i === index ? "true" : undefined}>
            <article className={`wrapped-card tone-${c.tone} wrapped-${c.id}`} ref={(el) => (cardRefs.current[i] = el)} data-card={c.id}>
              <p className="wrapped-kicker">{c.kicker}</p>
              <p className="wrapped-big">
                {c.big}
                {c.unit && <span className="wrapped-unit"> {c.unit}</span>}
              </p>
              {c.agentId && (
                <span className="wrapped-agent">
                  <Avatar agentId={c.agentId} size={56} />
                </span>
              )}
              {c.week && <Week week={c.week} />}
              {c.line && <p className="wrapped-line">{c.line}</p>}
              <p className="wrapped-brand">wissel</p>
            </article>
          </li>
        ))}
      </ol>
      <div className="wrapped-controls">
        <button type="button" className="icon-btn" aria-label="Previous card" onClick={() => go(index - 1)} disabled={index === 0}>
          <Icon name="back" />
        </button>
        <p className="wrapped-count mono" aria-live="polite">
          {index + 1} / {cards.length}
        </p>
        <button type="button" className="icon-btn" aria-label="Next card" onClick={() => go(index + 1)} disabled={index >= cards.length - 1}>
          <Icon name="next" />
        </button>
        <span className="wrapped-actions">
          <button type="button" className="btn" onClick={download} disabled={busy}>
            <Icon name="download" size={18} />
            Download
          </button>
          {shareable && (
            <button type="button" className="btn" onClick={share} disabled={busy}>
              <Icon name="share" size={18} />
              Share
            </button>
          )}
        </span>
      </div>
      <p className="wrapped-status" role="status">
        {status}
      </p>
    </section>
  );
}

function Week({ week }: { week: boolean[] }) {
  const on = week.filter(Boolean).length;
  return (
    <>
      <span className="wrapped-week" aria-hidden="true">
        {week.map((merged, i) => (
          <span key={i} className="wrapped-day" data-on={merged ? "" : undefined} />
        ))}
      </span>
      <span className="sr-only">
        Merged on {on} of the last 7 days.
      </span>
    </>
  );
}

/** Saves a blob under a file name through a temporary link. */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
