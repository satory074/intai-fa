/**
 * 公開の条件（Q25）。ビルドと npm run check の両方が同じ関数を使う。
 *
 * すべての出来事:
 *   - 人物が実在する、球団（team / toTeam）が実在する
 *   - 日付が未来でなく、年度の範囲（その年の 1/1 〜 翌年の 12/31）に入っている
 * 自動取得・未確認（auto_unverified）の出来事は、さらに:
 *   - 出典の抜粋（quote）があり、そこに本人の名前と、分類の根拠になる語句がある
 *   - 球団名が抜粋にあるか、出典がその球団の公式サイト（または NPB）
 *   - 出典 URL が開ける（data/url-status.json の記録が 2xx。記録は npm run check:urls が作る）
 * 通らないものは公開しない（ビルドから外し、check の報告に出す）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IntaiEvent, Person } from "./schema";
import { franchises } from "./teams";

export type UrlStatus = Record<string, { status: number; checked: string }>;

export function loadUrlStatus(): UrlStatus {
  const p = join(process.cwd(), "data", "url-status.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as UrlStatus) : {};
}

/** 球団公式サイトのドメイン */
export const CLUB_DOMAINS: Record<string, string[]> = {
  giants: ["giants.jp"],
  tigers: ["hanshintigers.jp"],
  dragons: ["dragons.jp"],
  baystars: ["baystars.co.jp"],
  swallows: ["yakult-swallows.co.jp"],
  carp: ["carp.co.jp"],
  hawks: ["softbankhawks.co.jp"],
  lions: ["seibulions.jp"],
  fighters: ["fighters.co.jp"],
  buffaloes: ["buffaloes.co.jp"],
  marines: ["marines.co.jp"],
  eagles: ["rakuteneagles.jp"],
};

const TEAM_WORDS: Record<string, string[]> = {
  giants: ["巨人", "読売", "ジャイアンツ"],
  tigers: ["阪神", "タイガース"],
  dragons: ["中日", "ドラゴンズ"],
  baystars: ["DeNA", "ベイスターズ", "横浜"],
  swallows: ["ヤクルト", "スワローズ"],
  carp: ["広島", "カープ"],
  hawks: ["ソフトバンク", "ホークス"],
  lions: ["西武", "ライオンズ"],
  fighters: ["日本ハム", "ファイターズ"],
  buffaloes: ["オリックス", "バファローズ"],
  marines: ["ロッテ", "マリーンズ"],
  eagles: ["楽天", "イーグルス"],
};

/** 区分ごとの「分類の根拠になる語句」 */
const EVIDENCE: Partial<Record<IntaiEvent["type"], RegExp>> = {
  retire: /引退/,
  release: /戦力外|契約を結ばない|契約しない|自由契約|退団|契約満了/,
  departure: /退団|自由契約|契約満了/,
  ikusei_recontract: /育成/,
  sign: /契約|入団|獲得|加入/,
  sign_outside: /契約|入団|獲得|加入/,
  fa_declare: /FA|フリーエージェント/,
  fa_move: /FA|フリーエージェント|移籍|契約/,
  fa_stay: /残留|契約/,
  fa_compensation: /補償|人的/,
  trade: /トレード|移籍|交換/,
  active_draft: /現役ドラフト/,
  posting: /ポスティング/,
  manager_in: /監督/,
  manager_out: /監督|退任|辞任|退団/,
  coach_in: /コーチ|就任|入閣|監督/,
  coach_out: /退団|退任|契約しない|契約を結ばない/,
  coach_change: /コーチ|配置|担当/,
};

const norm = (s: string) => s.normalize("NFKC").replace(/[\s　・．.]/g, "");

/** 名前の照合。外国人選手の「Ｓ．ラオ」は「ラオ」でもよい */
function nameIn(quote: string, person: Person): boolean {
  const q = norm(quote);
  const names = [person.name, ...(person.names?.map((n) => n.name) ?? [])];
  for (const n of names) {
    if (q.includes(norm(n))) return true;
    const family = n.normalize("NFKC").split(/[.．]/).pop()?.trim();
    if (family && family !== n && family.length >= 2 && q.includes(norm(family))) return true;
  }
  return false;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export function gateEvent(e: IntaiEvent, people: Map<string, Person>, urls: UrlStatus, today = new Date().toISOString().slice(0, 10)): string[] {
  const reasons: string[] = [];
  const person = people.get(e.person);
  if (!person) reasons.push(`人物 ${e.person} がいない`);
  const ids = new Set(franchises().map((f) => f.id));
  if (e.team && !ids.has(e.team)) reasons.push(`球団 ${e.team} がない`);
  if (e.toTeam && !ids.has(e.toTeam)) reasons.push(`球団 ${e.toTeam} がない`);
  if (e.date) {
    if (e.date > today) reasons.push(`日付 ${e.date} が未来`);
    if (e.date < `${e.season}-01-01` || e.date > `${e.season + 1}-12-31`) reasons.push(`日付 ${e.date} が ${e.season} 年度の範囲外`);
  }

  if (e.status === "auto_unverified" && person) {
    const withQuote = e.sources.filter((s) => s.quote && s.quote.trim().length >= 4);
    if (!withQuote.length) reasons.push("出典の抜粋（quote）がない");
    const quotes = withQuote.map((s) => s.quote!).join(" ");
    if (withQuote.length && !nameIn(quotes, person)) reasons.push(`抜粋に名前「${person.name}」がない`);
    const ev = EVIDENCE[e.type];
    if (withQuote.length && ev && !ev.test(quotes)) reasons.push(`抜粋に分類の根拠（${ev.source}）がない`);
    const team = e.team;
    if (team && TEAM_WORDS[team]) {
      const onClubSite = e.sources.some((s) => CLUB_DOMAINS[team]?.some((d) => hostOf(s.url).endsWith(d)) || hostOf(s.url).endsWith("npb.jp"));
      const inQuote = TEAM_WORDS[team].some((w) => norm(quotes).includes(norm(w)));
      if (!onClubSite && !inQuote) reasons.push("球団名が抜粋になく、出典も球団公式・NPB ではない");
    }
    for (const s of e.sources) {
      const st = urls[s.url];
      if (!st) reasons.push(`出典 URL が未確認（npm run check:urls）: ${s.url}`);
      else if (st.status < 200 || st.status >= 400) reasons.push(`出典 URL が開けない（HTTP ${st.status}）: ${s.url}`);
    }
  }
  return reasons;
}

/** 出典の種類の表示名 */
export const SOURCE_LABEL: Record<string, string> = {
  npb: "NPB公示",
  club: "球団発表",
  press: "報道",
  wikipedia: "Wikipedia",
  register: "在籍者名簿",
};
