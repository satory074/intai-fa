/** 新着の RSS（サイト全体・球団ごと）。最新 2 年度の行を、取り込み日（なければ発表日）の新しい順に */
import rss from "@astrojs/rss";
import { dataset } from "./data";
import { rowsForSeason, SECTIONS, teamName, type Row } from "./rows";

const SECTION_TITLE: Record<string, string> = Object.fromEntries(SECTIONS.map((s) => [s.key, s.title]));

export function feedItems(filter: (r: Row) => boolean = () => true): Row[] {
  const seasons = dataset().seasons.slice(0, 2);
  return seasons
    .flatMap((s) => rowsForSeason(s))
    .filter((r) => r.section !== "departure" && r.fresh && filter(r))
    .sort((a, b) => (b.fresh ?? "").localeCompare(a.fresh ?? ""))
    .slice(0, 100);
}

export function feedResponse(site: URL, title: string, description: string, rows: Row[]) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return rss({
    title,
    description,
    site: new URL(`${base}/`, site).toString(),
    items: rows.map((r) => ({
      title: `${teamName(r.team, r.season)} ${r.person.name} ${r.label}${r.outcome ? `（${r.outcome}）` : ""}`,
      link: `${base}/people/${r.personId}/`,
      pubDate: new Date(`${r.fresh}T00:00:00+09:00`),
      description: `${r.season}年オフ・${SECTION_TITLE[r.section]}。${r.status === "auto_unverified" ? "自動取得・未確認。" : ""}出典: ${r.sources.map((s) => s.url).join(" ")}`,
      customData: `<guid isPermaLink="false">${r.season}-${r.key}</guid>`,
    })),
    customData: "<language>ja</language>",
  });
}
