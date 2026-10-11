import { SKIP_BACK_SECONDS, SKIP_FORWARD_SECONDS, formatClock } from "../player";
import { usePlayer } from "../usePlayer";
import { Icon } from "./Icon";

/** The persistent player (docs/SDD-wissel-app.md §3.3): a bar above the
 *  tab bar on a phone, a card in the Live panel on desktop. Only the
 *  controls; the <audio> itself belongs to the shell. Renders nothing
 *  until something has been played. */
export function MiniPlayer({ variant }: { variant: "bar" | "panel" }) {
  const { state, toggle, skip, seek } = usePlayer();
  const { track, playing, position, duration, error } = state;
  if (!track) return null;
  const max = Math.max(0, Math.floor(duration));
  const at = max ? Math.min(Math.floor(position), max) : Math.floor(position);
  const clock = `${formatClock(at)} / ${max > 0 ? formatClock(max) : "--:--"}`;

  return (
    <section className={`mini-player mp-${variant}`} aria-label="Player" data-run-id={track.runId}>
      <div className="mp-row">
        <button type="button" className="icon-btn mp-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <div className="mp-text">
          <a className="mp-title" href="#/listen">
            {track.title}
          </a>
          <span className="mp-sub">
            {track.pipelineName} · <span className="mono mp-clock">{clock}</span>
          </span>
        </div>
        <button type="button" className="icon-btn" onClick={() => skip(-SKIP_BACK_SECONDS)} aria-label={`Back ${SKIP_BACK_SECONDS} seconds`}>
          <Icon name="rewind" />
        </button>
        <button type="button" className="icon-btn" onClick={() => skip(SKIP_FORWARD_SECONDS)} aria-label={`Forward ${SKIP_FORWARD_SECONDS} seconds`}>
          <Icon name="forward" />
        </button>
      </div>
      <input
        type="range"
        className="mp-seek"
        aria-label="Position"
        min={0}
        max={max || 1}
        step={1}
        value={max ? at : 0}
        disabled={!max}
        aria-valuetext={`${formatClock(at)} of ${max ? formatClock(max) : "unknown"}`}
        onChange={(e) => seek(Number(e.currentTarget.value))}
      />
      {error && (
        <p className="mp-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
