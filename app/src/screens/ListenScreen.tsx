import { useMemo } from "react";
import { Icon } from "../components/Icon";
import { usePodcasts } from "../hooks";
import { episodeQuickRead, type NewsRow, type QuickReadView } from "../news";
import { formatClock, formatMinutes } from "../player";
import { groupByPipeline, trackOf, type Show } from "../podcasts";
import { timeAgo } from "../time";
import type { PodcastEpisode } from "../types";
import { usePlayer } from "../usePlayer";

/** The Listen tab (docs/SDD-wissel-app.md §3.3): every podcast's
 *  episodes, latest first, each playable in the shell's mini-player,
 *  with the Quick read the board's run drawer shows (same code, through
 *  app/src/news.ts). */
export function ListenScreen({ now }: { now: number }) {
  const data = usePodcasts();
  const shows = useMemo(() => groupByPipeline(data.episodes), [data.episodes]);

  return (
    <div className="screen listen-screen">
      <div className="screen-head">
        <h1>Listen</h1>
      </div>
      {data.error && (
        <p className="error" role="alert">
          Could not load episodes: {data.error}
        </p>
      )}
      {!data.loaded ? (
        <p className="empty">Loading…</p>
      ) : shows.length === 0 ? (
        <p className="empty">No episodes yet. Run a podcast pipeline from the board or the search, and it shows up here.</p>
      ) : (
        shows.map((s) => <ShowSection key={s.pipelineId} show={s} now={now} />)
      )}
    </div>
  );
}

function ShowSection({ show, now }: { show: Show; now: number }) {
  const [latest, ...older] = show.episodes;
  const headingId = `show-${show.pipelineId}`;
  if (!latest) return null;
  return (
    <section className="show" aria-labelledby={headingId}>
      <h2 id={headingId} className="show-name">
        {show.pipelineName}
      </h2>
      <Episode episode={latest} now={now} latest />
      {older.length > 0 && (
        <ul className="episode-list" aria-label={`Earlier ${show.pipelineName} episodes`}>
          {older.map((e) => (
            <li key={e.runId}>
              <Episode episode={e} now={now} latest={false} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Episode({ episode, now, latest }: { episode: PodcastEpisode; now: number; latest: boolean }) {
  const player = usePlayer();
  const current = player.state.track?.runId === episode.runId;
  const playing = current && player.state.playing;
  const saved = current ? player.state.position : player.savedPosition(episode.runId);
  const quick = useMemo(() => episodeQuickRead(episode.quickRead), [episode.quickRead]);
  const titleId = `episode-${episode.runId}`;
  const meta = [timeAgo(episode.at, now), episode.durationSeconds !== undefined ? formatMinutes(episode.durationSeconds) : null];
  if (!playing && saved !== undefined && saved > 0) meta.push(`${current ? "Paused" : "Resume"} at ${formatClock(saved)}`);

  return (
    <article className={`episode${latest ? " is-latest" : ""}${current ? " is-current" : ""}`} aria-labelledby={titleId} data-run-id={episode.runId}>
      <div className="episode-head">
        <button
          type="button"
          className="play-btn"
          aria-label={`${playing ? "Pause" : "Play"} ${episode.title}`}
          onClick={() => (playing ? player.pause() : player.play(trackOf(episode)))}
        >
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <div className="episode-text">
          <h3 className="episode-title" id={titleId}>
            {episode.title}
          </h3>
          <p className="episode-meta">
            <time dateTime={episode.at}>{meta.filter(Boolean).join(" · ")}</time>
          </p>
        </div>
      </div>
      {quick &&
        (latest ? (
          <QuickRead view={quick} />
        ) : (
          <details className="episode-more">
            <summary>Quick read</summary>
            <QuickRead view={quick} />
          </details>
        ))}
    </article>
  );
}

function QuickRead({ view }: { view: QuickReadView }) {
  if (view.kind === "raw") return <p className="empty">Quick read unavailable: {view.reason}</p>;
  if (view.rows.length === 0) return null;
  return (
    <section className="quick-read" aria-label="Quick read">
      <h4 className="qr-head">Quick read</h4>
      <ol className="qr-list">
        {view.rows.map((r, i) => (
          <QuickReadRow key={i} row={r} />
        ))}
      </ol>
    </section>
  );
}

/** "lab.example.com" for a source link's text. */
function hostOf(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
}

function QuickReadRow({ row }: { row: NewsRow }) {
  return (
    <li className="qr-row">
      <p className="qr-headline">{row.headline}</p>
      {row.oneLine && <p className="qr-line">{row.oneLine}</p>}
      {(row.href || row.flag) && (
        <p className="qr-source">
          {row.href && (
            <a href={row.href} target="_blank" rel="noopener noreferrer">
              {hostOf(row.href)}
              <span className="sr-only"> (source, opens in a new tab)</span>
            </a>
          )}
          {row.flag && <span className="qr-flag">{row.flag}</span>}
        </p>
      )}
      {row.explained && (
        <details className="qr-detail">
          <summary>
            More<span className="sr-only"> on {row.headline}</span>
          </summary>
          <p>{row.explained.detail}</p>
          {row.explained.whyItMatters && (
            <>
              <h5>Why it matters</h5>
              <p>{row.explained.whyItMatters}</p>
            </>
          )}
          {row.explained.unknowns && (
            <>
              <h5>Not known yet</h5>
              <p>{row.explained.unknowns}</p>
            </>
          )}
        </details>
      )}
    </li>
  );
}
