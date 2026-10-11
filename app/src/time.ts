// Short, plain times for the feed: "just now", "5 min ago", "3 h ago",
// "yesterday", "4 days ago", then the date. Pure; `now` is passed in.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function timeAgo(at: string, now: number): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return "";
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const today = startOfLocalDay(now);
  if (ms >= today) return `${Math.floor(diff / 3_600_000)} h ago`;
  const days = Math.round((today - startOfLocalDay(ms)) / 86_400_000);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? "" : ` ${d.getFullYear()}`}`;
}
