/**
 * サイトマップの lastmod（astro.config.mjs の sitemap の serialize が使う）。
 * ページに載っている行の fresh（seen = 取り込んだ日、無ければ出来事の日付）の最大値。年度のページの「最終更新」と同じ決め方。
 * 日付の取れないページ（名簿だけの人物、about など）には入れない。キーは base を除いたパス（例: /2025/）。
 */
import { dataset } from "./data";
import { rowsForSeason, teamSeasonRows, teamSeasons, type Row } from "./rows";
import { franchises } from "./teams";

const maxFresh = (rows: Row[]) => rows.map((r) => r.fresh).filter((x): x is string => Boolean(x)).sort().pop();

export function lastmodByPath(): Map<string, string> {
  const ds = dataset();
  const out = new Map<string, string>();
  const set = (path: string, d: string | undefined) => {
    if (d) out.set(path, d);
  };
  for (const s of ds.seasons) set(`/${s}/`, maxFresh(rowsForSeason(s)));
  for (const f of franchises()) {
    const seasons = teamSeasons(f.id);
    for (const s of seasons) set(`/teams/${f.id}/${s}/`, maxFresh(teamSeasonRows(f.id, s)));
    set(`/teams/${f.id}/`, maxFresh(seasons.flatMap((s) => teamSeasonRows(f.id, s))));
  }
  for (const [id, events] of ds.eventsByPerson) {
    set(`/people/${id}/`, events.map((e) => e.seen ?? e.date).filter((x): x is string => Boolean(x)).sort().pop());
  }
  set("/", ds.updated);
  return out;
}
