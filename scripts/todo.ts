/**
 * 更新コマンド（.claude/skills/intai-update）が下書きを作る対象を一覧にする。
 *
 *   npm run todo                    # 最新 2 年度
 *   npm run todo -- --seasons 2024  # 年度を指定
 *   npm run todo -- --json          # 機械向け
 *
 * 出すもの:
 *   - 理由未調査の自由契約（保留されない選手など）… 引退か戦力外か退団かを球団発表で確かめる
 *   - その後が「未定」の自由契約（NPB 外の所属先を含む: Q13）
 *   - 自動取得・未確認の行（本人が確認する対象）
 */
import { dataset } from "../src/lib/data";
import { rowsForSeason } from "../src/lib/rows";
import { shortOf } from "../src/lib/teams";

const i = process.argv.indexOf("--seasons");
const ds = dataset();
const seasons = i >= 0 ? process.argv[i + 1].split(",").map(Number) : ds.seasons.slice(0, 2);
const asJson = process.argv.includes("--json");

const out: Record<string, unknown>[] = [];
for (const season of seasons) {
  const rows = rowsForSeason(season);
  for (const r of rows) {
    const team = r.team ? shortOf(r.team, season) : "";
    if (r.section === "release" && r.unresearched)
      out.push({ kind: "理由未調査", season, person: r.personId, name: r.person.name, team, teamId: r.team, note: r.label, date: r.date, ikusei: r.ikusei });
    else if (r.section === "release" && !r.outcome)
      out.push({ kind: "その後が未定", season, person: r.personId, name: r.person.name, team, teamId: r.team, note: r.label, date: r.date, ikusei: r.ikusei });
    if (r.status === "auto_unverified")
      out.push({ kind: "未確認", season, person: r.personId, name: r.person.name, team, teamId: r.team, note: r.label, sources: r.sources.map((s) => s.url) });
  }
}
for (const h of ds.held) out.push({ kind: "公開保留", season: h.event.season, id: h.event.id, person: h.event.person, reasons: h.reasons });

if (asJson) console.log(JSON.stringify(out, null, 1));
else {
  const by = new Map<string, number>();
  for (const o of out) by.set(`${o.season}年度 ${o.kind}`, (by.get(`${o.season}年度 ${o.kind}`) ?? 0) + 1);
  for (const [k, n] of by) console.log(`${k}: ${n} 件`);
  for (const o of out.slice(0, 30)) console.log(`  ${o.kind} ${o.season} ${o.team ?? ""} ${o.name ?? o.id}（${o.person}）${o.note ? ` ${o.note}` : ""}${o.ikusei ? " 育成" : ""}`);
  if (out.length > 30) console.log(`  …ほか ${out.length - 30} 件（--json で全件）`);
}
