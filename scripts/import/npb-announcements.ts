/**
 * NPB 公示（https://npb.jp/announcement/YYYY/）から出来事を作る。AI は使わない。
 *
 *   npm run import:npb                         # 前年度と今年度
 *   npm run import:npb -- --years 2025,2026
 *   npm run import:npb -- --years 2025 --from-dir DIR   # 取得済みの HTML（ファイル名は YYYY_page.html）
 *   npm run import:npb -- --years 2003,2004 --backfill  # 過去分・取り込み方を直したあと（増えた行を「新着」にしない）
 *
 * 書き出し:
 *   data/events/npb/YYYY.json   YYYY 年度のページから作った出来事（毎回作り直す。手では編集しない。
 *                               中の season は別の年度のこともある: 任意引退・オフのコーチ人事）
 *   data/people-extra.jsonl     名簿（2025 年まで）に載っていない人物（今年の新人・新任コーチなど）
 *
 * 守ること:
 * - HTML は保存しない。日付・球団・人物 ID・区分・備考の事実だけを持つ（Q33）
 * - 取得は 2.5 秒以上空ける（scripts/lib/fetch.ts）
 *
 * 年度の割り当て（Q5: NPB 年度。オフの出来事は直前シーズンの年度）:
 * - ページの年度 Y をそのまま season にする（NPB 自身が 2026 年 1 月の FA 契約を 2025 年度に入れている）
 * - ただし任意引退の公示は、引退した後の手続きとして翌年の 1〜7 月に出ることが多い
 *   （長野久義: 2025 年 10 月に引退発表 → 2026/3/16 公示）。決め方は retiredSeason()
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { parse as parseYaml } from "yaml";
import { politeFetch, todayJst } from "../lib/fetch";
import { franchises, resolveNpbTeamName, resolveUrlCode } from "../../src/lib/teams";
import { eventSchema, type IntaiEvent, type Person, type Stint } from "../../src/lib/schema";

const root = process.cwd();
const today = todayJst();
const fromDir = (() => {
  const i = process.argv.indexOf("--from-dir");
  return i >= 0 ? process.argv[i + 1] : null;
})();

function yearsArg(): number[] {
  const i = process.argv.indexOf("--years");
  if (i >= 0) return process.argv[i + 1].split(",").map((x) => parseInt(x, 10)).filter(Number.isFinite);
  // 前年度も毎回見る: 前年度に自由契約になった人の「その後」は、今年度の球団別一覧（1〜3 月の登録）で決まるため
  const y = parseInt(today.slice(0, 4), 10);
  return [y - 1, y];
}

// ---------- 取得 ----------

const pageCache = new Map<string, HTMLElement | null>();
async function getPage(year: number, page: string): Promise<HTMLElement | null> {
  const ck = `${year}/${page}`;
  if (pageCache.has(ck)) return pageCache.get(ck)!;
  const doc = await getPageUncached(year, page);
  pageCache.set(ck, doc);
  return doc;
}

async function getPageUncached(year: number, page: string): Promise<HTMLElement | null> {
  if (fromDir) {
    const p = join(fromDir, `${year}_${page}`);
    return existsSync(p) ? parseHtml(repair(readFileSync(p, "utf-8"))) : null;
  }
  const url = page.startsWith("http") ? page : pageUrl(year, page);
  const res = await politeFetch(url);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  return parseHtml(repair(res.text));
}

/**
 * 閉じ忘れの </a> を補う。2016・2017 年度の育成の自由契約に `<a href=…>小林 大誠</td>` のような行があり、
 * node-html-parser はその行ごと落とす
 */
const repair = (html: string) => html.replace(/(<a\s[^>]*>)([^<]*)<\/td>/g, "$1$2</a></td>");

const pageUrl = (year: number, page: string) =>
  `https://npb.jp/announcement/${year}/${page === "index.html" ? "" : page}`;

/** その年度の目次にあるページ名（./pn_released.html など）。年によってページの有無・名前・球団コードが違う */
async function pagesOf(year: number): Promise<Set<string>> {
  const doc = await getPage(year, "index.html");
  const out = new Set<string>();
  for (const a of doc?.querySelectorAll("a") ?? []) {
    const m = (a.getAttribute("href") ?? "").match(/^\.\/([a-z_0-9]+\.html)$/);
    if (m) out.add(m[1]);
  }
  return out;
}

// ---------- 人物 ----------

const peopleById = new Map<string, Person>();
const stintsByPerson = new Map<string, Stint[]>();
const extraPath = join(root, "data", "people-extra.jsonl");
const extra = new Map<string, Person>();

function loadPeople() {
  for (const f of ["people.jsonl", "people-extra.jsonl"]) {
    const p = join(root, "data", f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf-8").split("\n").filter(Boolean)) {
      const person = JSON.parse(line) as Person;
      peopleById.set(person.id, person);
      if (f === "people-extra.jsonl") extra.set(person.id, person);
    }
  }
  const sp = join(root, "data", "stints.jsonl");
  if (existsSync(sp)) {
    for (const line of readFileSync(sp, "utf-8").split("\n").filter(Boolean)) {
      const s = JSON.parse(line) as Stint;
      stintsByPerson.set(s.person, [...(stintsByPerson.get(s.person) ?? []), s]);
    }
  }
}

// 名前の照合用: 空白と「・」「．」を除く（公示は「Ｄ・セラフィニ」、名簿は「Ｄ．セラフィニ」のように揺れる）
const key = (name: string) => name.normalize("NFKC").replace(/[\s　・･.]|[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu, ""); // 異体字セレクタ（「辻󠄀」）も落とす
// 異体字をそろえた照合用。名簿は「髙木 大成」「澤﨑 俊和」「嘉㔟 敏弘」、2000 年代の公示は「高木 大成」「澤崎 俊和」「嘉勢 敏弘」
const VARIANTS: Record<string, string> = { 髙: "高", 﨑: "崎", 㔟: "勢", "𠮷": "吉", 德: "徳", 濵: "濱", 栁: "柳", 邉: "辺", 邊: "辺", 齋: "斎", 齊: "斉", 槇: "槙", 瀨: "瀬", 曻: "昇" };
const looseKey = (name: string) => [...key(name)].map((ch) => VARIANTS[ch] ?? ch).join("");
// 表示用: 空白をそろえ、名前の後ろの注記（「森 慎二 ※1」）を落とす
const cleanName = (s: string) => s.replace(/※\s*[0-9０-９]*/g, "").replace(/[\s　]+/g, " ").trim();

const registerAsOf: number = (() => {
  const p = join(root, "data", "register-meta.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")).asOf : 0;
})();
/** 名前で引けなかった選手（年度・球団・名前）。名簿の年度内なのに見つからないのは表記の揺れなので、作らずに報告する */
const unmatched: string[] = [];
/**
 * 名簿でリンクの無かった人（x で始まる ID）と、公示の NPB 選手 ID の対応（data/npb-id-links.json。この取り込みが書き足す）。
 * 名簿は約 2,300 人にリンクが無いが、公示には同じ人の選手ページへのリンクがあることが多い。
 * 対応を残さないと、同じ人が「名簿の人」と「公示の人」の 2 人に分かれる
 */
const linksPath = join(root, "data", "npb-id-links.json");
const npbLinks: Record<string, string> = existsSync(linksPath) ? JSON.parse(readFileSync(linksPath, "utf-8")) : {};
const xByNpb = new Map(Object.entries(npbLinks).map(([x, n]) => [n, x]));

/** 公示の表記 → 人物 ID（data/name-aliases.yaml）。名前で引けない人だけ */
const aliases: Map<string, string> = (() => {
  const p = join(root, "data", "name-aliases.yaml");
  const rows = existsSync(p) ? (parseYaml(readFileSync(p, "utf-8")) as { name: string; person: string }[]) : [];
  return new Map((rows ?? []).map((r) => [key(r.name), r.person]));
})();

/**
 * 公示の選手。リンク（NPB の選手 ID）があればそれ、名簿に無ければ people-extra に足す。
 * 2000 年代の公示には選手リンクが無いので、名前と「その年にその球団にいたか」で名簿から引く（playerByName）。
 */
function personFromLink(nameCell: HTMLElement, franchise: string | null, year: number): string | null {
  const a = nameCell.querySelector("a");
  const id = a?.getAttribute("href")?.match(/players\/(\d{8})\.html/)?.[1];
  const name = cleanName(nameCell.text);
  if (!name) return null;
  if (id) {
    const linked = xByNpb.get(id);
    if (linked && peopleById.has(linked)) return linked;
    if (peopleById.has(id) && !extra.has(id)) return id;
    // 名簿のリンク無しの人と同じ人か（名前と、その年にその球団にいたかで 1 人に絞れたときだけ）
    const x = registerUnlinked(name, franchise, year);
    if (x) {
      npbLinks[x] = id;
      xByNpb.set(id, x);
      extra.delete(id);
      return x;
    }
    if (!peopleById.has(id)) {
      const p: Person = { id, npbId: id, name };
      peopleById.set(id, p);
      extra.set(id, p);
    }
    return id;
  }
  return playerByName(name, franchise, year);
}

/** 名簿にいてリンク（NPB ID）が無い人のうち、名前が同じで、その球団に year の前後 1 年に在籍した人がちょうど 1 人ならその人 */
function registerUnlinked(name: string, franchise: string | null, year: number): string | null {
  if (!franchise) return null;
  const k = key(name);
  const lk = looseKey(name);
  const near = [...peopleById.values()].filter(
    (p) =>
      p.id.startsWith("x") &&
      !extra.has(p.id) &&
      !npbLinks[p.id] &&
      (key(p.name) === k || looseKey(p.name) === lk || p.names?.some((n) => key(n.name) === k)) &&
      stintsByPerson.get(p.id)?.some((s) => s.franchise === franchise && year >= s.from - 1 && year <= s.to + 1),
  );
  return near.length === 1 ? near[0].id : null;
}

/**
 * リンクの無い選手を名前で引く。同じ名前の人がいるので、その球団に year の前後 1 年に在籍した人に絞る。
 * 名簿の年度（asOf）以前で見つからなければ、仮の人物は作らずに unmatched に積んで飛ばす（重複した人物ページを作らないため）
 */
function playerByName(name: string, franchise: string | null, year: number): string | null {
  const k = key(name);
  const alias = aliases.get(k);
  if (alias && peopleById.has(alias)) return alias;
  let hits = [...peopleById.values()].filter((p) => key(p.name) === k || p.names?.some((n) => key(n.name) === k));
  if (!hits.length) {
    const lk = looseKey(name);
    hits = [...peopleById.values()].filter((p) => looseKey(p.name) === lk || p.names?.some((n) => looseKey(n.name) === lk));
  }
  const near = hits.filter((p) =>
    stintsByPerson.get(p.id)?.some((s) => (!franchise || s.franchise === franchise) && year >= s.from - 1 && year <= s.to + 1),
  );
  if (near.length === 1) return near[0].id;
  if (near.length > 1) {
    // 同じ球団・同じ頃に同名が 2 人（2004 年の西武に「カズ」が 2 人）: その年にその登録名だった人に絞る
    const inName = near.filter((p) =>
      p.names?.some((n) => (n.from || n.to) && key(n.name) === k && year >= (n.from ?? 0) && year <= (n.to ?? 9999)),
    );
    if (inName.length === 1) return inName[0].id;
  }
  if (near.length === 0 && hits.length === 1) return hits[0].id;
  if (year > registerAsOf) return personByName(name, franchise);
  unmatched.push(`${year} ${franchise ?? "?"} ${name}（候補 ${near.length || hits.length} 人）`);
  return null;
}

/**
 * 名前だけの人物（監督・コーチの公示）。同じ名前が 1 人ならその人、複数ならその球団に在籍したことのある人。
 * 見つからなければ people-extra に新しく作る。
 */
function personByName(name: string, franchise: string | null): string {
  const k = key(name);
  const alias = aliases.get(k);
  if (alias && peopleById.has(alias)) return alias;
  const hits = [...peopleById.values()].filter((p) => key(p.name) === k || p.names?.some((n) => key(n.name) === k));
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1 && franchise) {
    const atTeam = hits.filter((p) => stintsByPerson.get(p.id)?.some((s) => s.franchise === franchise));
    if (atTeam.length >= 1) return atTeam.sort((a, b) => lastYear(b.id) - lastYear(a.id))[0].id;
  }
  if (hits.length > 1) return hits.sort((a, b) => lastYear(b.id) - lastYear(a.id))[0].id;
  const id = "x" + createHash("sha1").update(`${cleanName(name)}|staff|${franchise ?? ""}`).digest("hex").slice(0, 8);
  if (!peopleById.has(id)) {
    const p: Person = { id, name: cleanName(name) };
    peopleById.set(id, p);
    extra.set(id, p);
  }
  return id;
}

const lastYear = (id: string) => Math.max(0, ...(stintsByPerson.get(id) ?? []).map((s) => s.to));

// ---------- 共通 ----------

const isoDate = (s0: string, pageYear?: number): string | undefined => {
  const s = s0.replace(/[\s　]/g, ""); // 2003 年度は「11/ 5」のように桁をそろえる空白が入る
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // 2003 年度のページは「12/17」のように年が無い。NPB の年度は 2 月 1 日〜翌年 1 月 31 日なので、1 月だけ翌年
  const md = pageYear ? s.match(/^(\d{1,2})\/(\d{1,2})$/) : null;
  if (!md) return undefined;
  const y = md[1] === "1" ? pageYear! + 1 : pageYear!;
  return `${y}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`;
};
const posOf = (el: HTMLElement | null | undefined): { pos?: string } => {
  const t = (el?.text ?? "").replace(/[\s　]/g, "");
  return t ? { pos: t } : {};
};
const stripParens = (s: string) => s.replace(/[（）()]/g, "").replace(/※\d+/g, "").trim();
/** 「〃」（上の行と同じ）。2014 年のトレードなどで日付・球団の欄に出る */
const isDitto = (el: HTMLElement | null | undefined) => /^[〃″]$/.test((el?.text ?? "").trim());

function teamOf(cell: HTMLElement): string | null {
  const href = cell.querySelector("a")?.getAttribute("href") ?? "";
  const code = href.match(/registered(?:dev)?_([a-z]+)\.html/)?.[1];
  return (code && resolveUrlCode(code)) || resolveNpbTeamName(cell.text);
}

function eventId(parts: (string | number | undefined)[]): string {
  return parts.filter((x) => x !== undefined && x !== "").join("-").toLowerCase().replace(/[^a-z0-9-]/g, "");
}

const npbSource = (year: number, page: string, title: string) => ({
  url: pageUrl(year, page),
  kind: "npb" as const,
  title: `NPB 公示 ${title}`,
  fetched: today,
});

// ---------- 各ページ ----------

/**
 * 日付・球団の欄の「〃」（上の行と同じ）を上の行の値で埋めながら行を読む。
 * 2014 年度のトレード（日高 亮・川島 慶三 ⇔ 新垣 渚・山中 浩史）のように 2 人目以降が「〃」になる
 */
function carry(pageYear: number) {
  let date: string | undefined;
  const teams: (HTMLElement | undefined)[] = [];
  return {
    date(el: HTMLElement | null | undefined) {
      if (isDitto(el)) return date;
      return (date = isoDate(el?.text ?? "", pageYear));
    },
    team(i: number, el: HTMLElement | undefined) {
      if (isDitto(el)) return teams[i];
      return (teams[i] = el);
    },
  };
}

/**
 * 表の下の注記（div.att_box の「※2 ポスティングによる移籍　（ＭＬＢ／ニューヨーク・ヤンキース）」）。
 * 名前の欄の「井川　慶 ※2」と番号で結ぶ。番号の無い「※」1 つだけの注記もある
 */
function footnotes(doc: HTMLElement): Map<string, string> {
  const out = new Map<string, string>();
  for (const box of doc.querySelectorAll(".att_box")) {
    for (const line of box.innerHTML.split(/<br\s*\/?>/i)) {
      const m = parseHtml(line).text.trim().match(/^※\s*([0-9０-９]*)\s*(.+)$/);
      if (m) out.set(m[1].normalize("NFKC"), m[2].trim());
    }
  }
  return out;
}
const markOf = (nameCell: HTMLElement) => nameCell.text.match(/※\s*([0-9０-９]*)/)?.[1].normalize("NFKC");

/** 自由契約（支配下・育成）。注記が「ポスティングによる移籍」の行はポスティングとして取り込む */
async function released(year: number, page: string, ikusei: boolean, out: IntaiEvent[]) {
  const doc = await getPage(year, page);
  if (!doc) return;
  const notes = footnotes(doc);
  const c = carry(year);
  for (const tr of doc.querySelectorAll("tr")) {
    const date = c.date(tr.querySelector(".pndate"));
    const teamCell = c.team(0, tr.querySelector(".pnteam") ?? undefined);
    const nameCell = tr.querySelector(".pnname");
    // 球団の欄が空の行は「任意引退選手公示抹消」（昔引退した人の手続き）なので取り込まない
    if (!date || !teamCell || !nameCell) continue;
    const team = teamOf(teamCell);
    if (!team) continue;
    const person = personFromLink(nameCell, team, year);
    if (!person) continue;
    // ※ の番号は 2018 年度までは名前の欄、2019 年度からは備考の欄（「（契約保留権放棄）※1」）
    const noteCell = tr.querySelector(".pnnote");
    const mark = markOf(nameCell) ?? (noteCell ? markOf(noteCell) : undefined);
    const foot = mark !== undefined ? notes.get(mark) : undefined;
    if (foot?.includes("ポスティング")) {
      const dest = foot.normalize("NFKC").match(/[（(]([^）)]+)[）)]/)?.[1] ?? "";
      out.push({
        id: eventId(["npb", year, "posting", person, date.replaceAll("-", "")]),
        season: year,
        date,
        type: "posting",
        person,
        team,
        ...posOf(tr.querySelector(".pnpos")),
        ...(dest ? { toOrg: { name: dest.replace(/^[^/／]*[/／]/, ""), kind: "overseas" as const } } : {}),
        note: "ポスティングによる移籍",
        status: "npb_official",
        sources: [npbSource(year, page, "自由契約選手（ポスティングによる移籍）")],
      });
      continue;
    }
    const note = stripParens(noteCell?.text ?? "");
    out.push({
      id: eventId(["npb", year, ikusei ? "dev-released" : "released", person, date.replaceAll("-", "")]),
      season: year,
      date,
      type: "release",
      person,
      team,
      ...posOf(tr.querySelector(".pnpos")),
      ...(note ? { note } : {}),
      // 「保留されない選手」「契約保留権放棄」は、戦力外か引退か退団かが公示からはわからない
      ...(note === "ウエイバー不請求" ? {} : { unresearched: true }),
      ...(ikusei ? { ikusei: true } : {}),
      status: "npb_official",
      sources: [npbSource(year, page, ikusei ? "育成選手 自由契約" : "自由契約選手")],
    });
  }
}

/**
 * 任意引退の公示がどの年度の去就か。8〜12 月の公示はその年。1〜7 月は 2 通りある:
 * - 前の年のオフに引退を決めた人の手続き（長野久義: 2025 年 10 月に引退発表 → 2026/3/16 公示 → 2025 年度）
 * - シーズン途中の引退（6〜7 月。名簿ではその年まで在籍している）
 * 名簿がその年まであれば、その球団に選手としてその年もいたかで分ける。名簿がまだ無い年は前の年度にする。
 * （2003〜2016 年度の 1〜7 月の 8 件で、名簿の最後の年が「前の年」なのは 1・3 月、「その年」なのは 6・7 月だった）
 */
function retiredSeason(person: string, team: string, date: string): number {
  const y = parseInt(date.slice(0, 4), 10);
  if (parseInt(date.slice(5, 7), 10) >= 8) return y;
  if (y > registerAsOf) return y - 1;
  const playedThatYear = (stintsByPerson.get(person) ?? []).some(
    (s) => s.franchise === team && (s.role === "player" || s.role === "ikusei") && s.from <= y && s.to >= y,
  );
  return playedThatYear ? y : y - 1;
}

/** 任意引退 */
async function retired(year: number, out: IntaiEvent[]) {
  const doc = await getPage(year, "pn_retired.html");
  if (!doc) return;
  const c = carry(year);
  for (const tr of doc.querySelectorAll("tr")) {
    const date = c.date(tr.querySelector(".pndate"));
    const teamCell = c.team(0, tr.querySelector(".pnteam") ?? undefined);
    const nameCell = tr.querySelector(".pnname");
    if (!date || !teamCell || !nameCell) continue;
    const team = teamOf(teamCell);
    const dateYear = parseInt(date.slice(0, 4), 10);
    const person = personFromLink(nameCell, team, dateYear);
    if (!person || !team) continue;
    const season = retiredSeason(person, team, date);
    out.push({
      id: eventId(["npb", year, "retired", person, date.replaceAll("-", "")]),
      season,
      date,
      type: "voluntary_retired",
      person,
      team,
      ...posOf(tr.querySelector(".pnpos")),
      status: "npb_official",
      sources: [npbSource(year, "pn_retired.html", "任意引退選手")],
    });
  }
}

/** トレード（現役ドラフト・FA の人的補償を含む。表のすぐ後ろの ※ 注記で見分ける） */
async function traded(year: number, page: string, ikusei: boolean, out: IntaiEvent[]) {
  const doc = await getPage(year, page);
  if (!doc) return;
  for (const table of doc.querySelectorAll("table")) {
    const wrap = table.parentNode as HTMLElement;
    const note = wrap?.querySelector("p.note")?.text.replace(/^※/, "").trim() ?? "";
    const type: IntaiEvent["type"] = note.includes("現役ドラフト")
      ? "active_draft"
      : note.includes("FA移籍に伴う")
        ? "fa_compensation"
        : "trade";
    const c = carry(year);
    for (const tr of table.querySelectorAll("tr")) {
      const date = c.date(tr.querySelector(".trdate"));
      const nameCell = tr.querySelector(".trname");
      const cells = tr.querySelectorAll(".trteam, .trteamlong"); // 2005 年度までは trteamlong
      const fromCell = c.team(0, cells[0]);
      const toCell = c.team(1, cells[1]);
      if (!date || !nameCell || !fromCell || !toCell) continue;
      const from = teamOf(fromCell);
      const to = teamOf(toCell);
      const person = personFromLink(nameCell, from, year);
      if (!person || !from || !to) continue;
      out.push({
        id: eventId(["npb", year, ikusei ? "dev-" + type : type, person, date.replaceAll("-", "")]),
        season: year,
        date,
        type,
        person,
        team: from,
        toTeam: to,
        ...posOf(tr.querySelector(".trpos")),
        ...(note ? { note } : {}),
        ...(ikusei ? { ikusei: true } : {}),
        status: "npb_official",
        sources: [npbSource(year, page, ikusei ? "育成選手 トレード" : "トレード")],
      });
    }
  }
}

/**
 * FA 宣言と、その結末（契約締結合意: 移籍 or 残留）。
 * ページ名は 2015 年度ごろまで fa_filed2.html、その後 fa_filed.html。
 * 行の形: 球団｜名前｜位置｜背番号｜→｜合意日｜合意した球団。海外移籍は合意日・球団の代わりに「（ＭＬＢ／シアトル・マリナーズ）」
 */
async function faFiled(year: number, out: IntaiEvent[]) {
  let page = "fa_filed.html";
  let doc = await getPage(year, page);
  if (!doc) {
    page = "fa_filed2.html";
    doc = await getPage(year, page);
  }
  if (!doc) return;
  let kind = "";
  for (const el of doc.querySelectorAll("h5, tr")) {
    if (el.tagName === "H5") {
      kind = el.text.includes("海外") ? "海外FA" : el.text.includes("国内") ? "国内FA" : kind;
      continue;
    }
    const nameCell = el.querySelector(".pnname");
    const teamCells = el.querySelectorAll(".pnteam");
    if (!nameCell || !teamCells.length) continue;
    const fromTeam = resolveNpbTeamName(teamCells[0].text);
    const person = fromTeam ? personFromLink(nameCell, fromTeam, year) : null;
    if (!person || !fromTeam) continue;
    out.push({
      id: eventId(["npb", year, "fa-declare", person]),
      season: year,
      type: "fa_declare",
      person,
      team: fromTeam,
      ...posOf(el.querySelector(".pnpos")),
      ...(kind ? { note: kind } : {}),
      status: "npb_official",
      sources: [npbSource(year, page, "フリーエージェント宣言選手")],
    });
    const date = isoDate(el.querySelector(".pndate")?.text ?? "", year);
    const toText = teamCells.length >= 2 ? teamCells[teamCells.length - 1].text.trim() : "";
    const abroad = stripParens(el.querySelector(".pnnote")?.text ?? "").normalize("NFKC");
    const base = {
      season: year,
      person,
      team: fromTeam,
      status: "npb_official" as const,
      sources: [npbSource(year, page, "フリーエージェント宣言選手（契約締結合意）")],
    };
    if (date && toText) {
      const to = resolveNpbTeamName(toText);
      if (to === fromTeam) out.push({ ...base, date, id: eventId(["npb", year, "fa-stay", person]), type: "fa_stay" });
      else if (to) out.push({ ...base, date, id: eventId(["npb", year, "fa-move", person]), type: "fa_move", toTeam: to });
      else out.push({ ...base, date, id: eventId(["npb", year, "fa-move", person]), type: "fa_move", toOrg: { name: toText, kind: "overseas" } });
    } else if (/^(MLB|米|メジャー)/.test(abroad)) {
      // 海外の球団との契約。合意日は載っていない
      out.push({ ...base, id: eventId(["npb", year, "fa-move", person]), type: "fa_move", toOrg: { name: abroad.replace(/^[^/／]*[/／]/, ""), kind: "overseas" } });
    }
  }
}

/** 新規の支配下・育成登録。自由契約になった人のその後（他球団と契約・育成で再契約）にだけ使う */
interface Registration { person: string; team: string; date: string; ikusei: boolean; fromIkusei: boolean; year: number; page: string }
async function registrations(year: number): Promise<Registration[]> {
  const out: Registration[] = [];
  for (const [page, ikusei] of [["pn_registered.html", false], ["pndev_registered.html", true]] as const) {
    const doc = await getPage(year, page);
    if (!doc) continue;
    const c = carry(year);
    for (const tr of doc.querySelectorAll("tr")) {
      const date = c.date(tr.querySelector(".pndate"));
      const teamCell = c.team(0, tr.querySelector(".pnteam") ?? undefined);
      const nameCell = tr.querySelector(".pnname");
      if (!date || !teamCell || !nameCell) continue;
      const team = teamOf(teamCell);
      // 新人・新外国人は名簿の前年にいないので、名前で引けなくても報告しない（リンクの無い年は使わない）
      if (!team || !nameCell.querySelector("a")) continue;
      const person = personFromLink(nameCell, team, year);
      if (!person) continue;
      const fromIkusei = (tr.querySelector(".pnnote")?.text ?? "").includes("育成選手から移行");
      out.push({ person, team, date, ikusei, fromIkusei, year, page });
    }
  }
  return out;
}

/**
 * 翌年度の球団別の支配下・育成選手一覧（registered_g.html / registereddev_g.html）。
 * オフに決まった移籍・育成での再契約はここに「公示日 M/D」付きで載る（10〜12 月は前年の日付）。
 * 球団コードは年で変わる（横浜 yb→db、オリックス bs→b）ので、その年度の目次にあるページを使う。
 * 一覧が無い年（2000 年代）は、その後を名簿の次の所属から出す（src/lib/rows.ts）
 */
async function rosters(year: number): Promise<Registration[]> {
  const out: Registration[] = [];
  const pages = [...(await pagesOf(year))].filter((p) => /^registered(dev)?_[a-z]+\.html$/.test(p)).sort();
  for (const page of pages) {
    const m0 = page.match(/^registered(dev)?_([a-z]+)\.html$/)!;
    const ikusei = !!m0[1];
    const team = resolveUrlCode(m0[2]);
    if (!team) {
      console.warn(`  球団コード不明: ${year}/${page}`);
      continue;
    }
    const doc = await getPage(year, page);
    if (!doc) continue;
    // 一覧は 2 段組みで表が 2 つに分かれる。後ろの「選手登録公示以降の動き」の表は先頭が △▼ なので日付の判定で外れる
    for (const tr of doc.querySelectorAll("table tr")) {
      const cells = tr.querySelectorAll("th, td");
      if (cells.length < 4) continue;
      const md = cells[0].text.trim().match(/^(\d{1,2})\/(\d{1,2})$/);
      const nameCell = cells[cells.length - 1];
      if (!md || !nameCell.querySelector("a")) continue;
      const person = personFromLink(nameCell, team, year);
      if (!person) continue;
      const m = parseInt(md[1], 10);
      const y = m >= 10 ? year - 1 : year;
      out.push({ person, team, date: `${y}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`, ikusei, fromIkusei: false, year, page });
    }
  }
  return out;
}

// ---------- 監督・コーチ（2020 年度以降） ----------

interface StaffRow { role: string; name: string; person: string }
interface StaffChange { date: string; name: string; role?: string; label: string; note: string }
async function staff(year: number): Promise<Map<string, { rows: StaffRow[]; changes: StaffChange[] }>> {
  const out = new Map<string, { rows: StaffRow[]; changes: StaffChange[] }>();
  if (year < 2020) return out;
  for (const f of franchises()) {
    if (!f.urlCode) continue;
    const page = `managers_${f.urlCode}.html`;
    const doc = await getPage(year, page);
    if (!doc) continue;
    const tables = doc.querySelectorAll("table");
    if (!tables.length) continue;
    const rows: StaffRow[] = [];
    for (const tr of tables[0].querySelectorAll("tr")) {
      const tds = tr.querySelectorAll("td");
      if (tds.length < 3) continue;
      const role = tds[0].text.replace(/\s+/g, "").trim();
      const name = cleanName(tds[2].text);
      if (!role || !name) continue;
      rows.push({ role, name, person: personByName(name, f.id) });
    }
    // 「監督・コーチ登録公示以降の動き」: 【コーチ登録】【コーチ登録抹消】【コーチ異動】【監督代行】… の見出しの下に行が並ぶ
    const changes: StaffChange[] = [];
    const html = doc.toString();
    const tail = html.slice(html.indexOf("登録公示以降の動き") >= 0 ? html.indexOf("登録公示以降の動き") : html.length);
    const tailDoc = parseHtml(tail);
    let label = "";
    for (const el of tailDoc.querySelectorAll("*")) {
      const t = el.childNodes.length === 1 ? el.text.trim() : "";
      const lm = t.match(/^【(.+)】$/);
      if (lm) label = lm[1];
      if (el.tagName === "TR") {
        // 行の形: 「◎｜日付｜役職｜名前」または「◎｜日付｜名前｜（5/26～）」。名前は最後の文字列、役職はその前
        const cells = el.querySelectorAll("td").map((c) => c.text.trim());
        const date = cells.map(isoDate).find(Boolean);
        const words = cells.filter((c) => c && !isoDate(c) && !/^[◎○●◇◆□■]+$/.test(c) && !/^（.*）$/.test(c));
        const name = words[words.length - 1];
        const role = words.length >= 2 ? words[words.length - 2] : undefined;
        const paren = cells.find((c) => /^（.*）$/.test(c));
        if (date && name) changes.push({ date, name: cleanName(name), role, label, note: paren ? stripParens(paren) : "" });
      }
    }
    out.set(f.id, { rows, changes });
  }
  return out;
}

const isTopManager = (role: string) => /^監督$/.test(role.replace(/→.*$/, ""));

function staffEvents(prevYear: number, prev: Awaited<ReturnType<typeof staff>>, cur: Awaited<ReturnType<typeof staff>>, out: IntaiEvent[]) {
  // prevYear のシーズン後（オフ）の人事 = prevYear の名簿と prevYear+1 の名簿の差
  const season = prevYear;
  for (const [team, now] of cur) {
    const before = prev.get(team);
    if (!before) continue;
    const roleOf = (rows: StaffRow[], person: string) => rows.find((r) => r.person === person)?.role.replace(/→.*$/, "").trim();
    const src = [
      { url: pageUrl(prevYear, `managers_${franchises().find((f) => f.id === team)!.urlCode}.html`), kind: "npb" as const, title: `NPB 公示 ${prevYear}年度 監督・コーチ`, fetched: today },
      { url: pageUrl(prevYear + 1, `managers_${franchises().find((f) => f.id === team)!.urlCode}.html`), kind: "npb" as const, title: `NPB 公示 ${prevYear + 1}年度 監督・コーチ`, fetched: today },
    ];
    const beforeIds = new Set(before.rows.map((r) => r.person));
    const nowIds = new Set(now.rows.map((r) => r.person));
    for (const r of before.rows) {
      if (nowIds.has(r.person)) continue;
      const role = r.role.replace(/^.*→\s*/, "").trim();
      out.push({
        id: eventId(["npb", season, isTopManager(role) ? "manager-out" : "coach-out", team, r.person]),
        season, type: isTopManager(role) ? "manager_out" : "coach_out", person: r.person, team, role,
        status: "npb_official", sources: src,
      });
    }
    for (const r of now.rows) {
      const role = r.role.replace(/→.*$/, "").trim();
      if (!beforeIds.has(r.person)) {
        out.push({
          id: eventId(["npb", season, isTopManager(role) ? "manager-in" : "coach-in", team, r.person]),
          season, type: isTopManager(role) ? "manager_in" : "coach_in", person: r.person, team, role,
          status: "npb_official", sources: src,
        });
      } else {
        const old = roleOf(before.rows, r.person)!.replace(/^.*→\s*/, "").trim();
        if (old !== role) {
          out.push({
            id: eventId(["npb", season, isTopManager(role) ? "manager-in" : "coach-change", team, r.person]),
            season, type: isTopManager(role) ? "manager_in" : "coach_change", person: r.person, team, role, fromRole: old,
            status: "npb_official", sources: src,
          });
        }
      }
    }
  }
}

/** シーズン中の動き（監督代行・コーチ異動・登録・抹消） */
function staffInSeason(year: number, cur: Awaited<ReturnType<typeof staff>>, out: IntaiEvent[]) {
  for (const [team, now] of cur) {
    const code = franchises().find((f) => f.id === team)!.urlCode;
    for (const c of now.changes) {
      // 背番号の変更は去就ではない（行の最後の語が新しい背番号「82」になる）
      if (c.label.includes("背番号")) continue;
      const row = now.rows.find((r) => key(r.name) === key(c.name));
      const person = row?.person ?? personByName(c.name, team);
      const [fromRole, toRole0] = (row?.role ?? "").split("→").map((s) => s.trim());
      const toRole = toRole0 ?? (c.role && c.role !== fromRole ? c.role : undefined);
      const acting = c.label.includes("監督代行");
      const managerLabel = /^監督(登録|抹消)/.test(c.label); // 【監督登録】【監督抹消】（2026 年 6 月の楽天など）
      const type: IntaiEvent["type"] = acting
        ? "manager_in"
        : c.label.includes("抹消")
          ? managerLabel ? "manager_out" : "coach_out"
          : c.label.includes("登録")
            ? managerLabel ? "manager_in" : "coach_in"
            : "coach_change";
      // 公示の日付の誤り（2024 年度のオリックスに「2022/6/13 コーチ登録抹消」）。直さずに日付を外し、その旨を備考に残す
      const dateFits = c.date >= `${year}-01-01` && c.date <= `${year + 1}-01-31`;
      out.push({
        id: eventId(["npb", year, "staff", type, team, person, c.date.replaceAll("-", "")]),
        season: year,
        ...(dateFits ? { date: c.date } : {}),
        type,
        person,
        team,
        ...(toRole ? { role: toRole } : acting ? { role: "監督代行" } : managerLabel ? { role: "監督" } : {}),
        ...(fromRole && toRole ? { fromRole } : {}),
        note: c.label + (c.note ? `（${c.note}）` : "") + (dateFits ? "" : `（公示の日付 ${c.date.replaceAll("-", "/")} が年度と合わないため日付は載せていない）`),
        status: "npb_official",
        sources: [{ url: pageUrl(year, `managers_${code}.html`), kind: "npb", title: `NPB 公示 ${year}年度 監督・コーチ`, fetched: today }],
      });
    }
  }
}

// ---------- 本体 ----------

async function importYear(year: number) {
  const out: IntaiEvent[] = [];
  await released(year, "pn_released.html", false, out);
  await released(year, "pndev_released.html", true, out);
  await retired(year, out);
  await traded(year, "pn_traded.html", false, out);
  await traded(year, "pndev_traded.html", true, out);
  await faFiled(year, out);

  // 自由契約のその後: 同じ年度と翌年度の新規登録から、公示日より後の登録を拾う
  const regs = [...(await registrations(year)), ...(await rosters(year + 1))];
  for (const rel of out.filter((e) => e.type === "release")) {
    const next = regs
      .filter((r) => r.person === rel.person && r.date > rel.date! && !r.fromIkusei)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!next) continue;
    const type: IntaiEvent["type"] = next.ikusei && next.team === rel.team ? "ikusei_recontract" : "sign";
    out.push({
      id: eventId(["npb", year, type, rel.person, next.date.replaceAll("-", "")]),
      season: year,
      date: next.date,
      type,
      person: rel.person,
      team: rel.team,
      toTeam: next.team,
      ...(next.ikusei ? { ikusei: true } : {}),
      ...(next.team === rel.team && type === "sign" ? { note: next.ikusei ? "育成で再契約" : "再契約" } : {}),
      status: "npb_official",
      sources: [{ ...npbSource(next.year, next.page, next.ikusei ? "新規育成選手登録" : "新規支配下選手登録"), url: pageUrl(next.year, next.page) }],
    });
  }

  // 監督・コーチ
  const cur = await staff(year);
  staffInSeason(year, cur, out);
  if (year >= 2021) {
    const prev = await staff(year - 1);
    staffEvents(year - 1, prev, cur, out);
  }

  // 同じ id が重なったら連番を付ける（同日に同じ人が 2 回など）
  const seenIds = new Map<string, number>();
  for (const e of out) {
    const n = seenIds.get(e.id) ?? 0;
    seenIds.set(e.id, n + 1);
    if (n > 0) e.id = `${e.id}-${n + 1}`;
  }
  for (const e of out) eventSchema.parse(e);
  return out;
}

async function main() {
  loadPeople();
  const dir = join(root, "data", "events", "npb");
  mkdirSync(dir, { recursive: true });
  for (const year of yearsArg()) {
    const events = await importYear(year);
    // ファイルは「どの年度のページから取り込んだか」で分ける（data/events/npb/YYYY.json）。
    // 出来事の season は中身に持つので、任意引退（翌年の公示）やオフのコーチ人事が別の年度でもかまわない。
    // 再取り込みはこのファイルだけを作り直す（ほかの年度のページから来た出来事は消さない）
    const p = join(dir, `${year}.json`);
    const old: IntaiEvent[] = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : [];
    // 「いつ取り込んだか」(seen) は前回の値を引き継ぐ。新着の並びに使う。
    // 前回すでにあった行は、seen が無くても（過去分として取り込んだ行）新着にしない
    const oldById = new Map(old.map((e) => [e.id, e]));
    // 初めてこの年度を取り込むとき（過去分の一括取り込み）は「新着」にしない。2 回目以降に増えた行だけ seen=今日
    // --backfill: 取り込み方を直したあとの取り直し。増えた行は昔の出来事なので「新着」にしない
    const initial = !existsSync(p) || process.argv.includes("--backfill");
    // 取得日（fetched）と seen を除いた中身。前回と同じなら取得日も前回のまま（毎日の差分を、変わった行だけにする）
    const body = (e: IntaiEvent) => JSON.stringify({ ...e, seen: undefined, sources: e.sources.map(({ fetched: _f, ...s }) => s) });
    const list = events.map((e) => {
      const prev = oldById.get(e.id);
      const s = prev ? prev.seen : initial ? undefined : today;
      const { seen: _drop, ...rest } = e;
      const kept = prev && body(prev) === body(rest) ? { ...rest, sources: prev.sources } : rest;
      return s ? { ...kept, seen: s } : kept;
    });
    list.sort((a, b) => a.season - b.season || (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id));
    writeFileSync(p, JSON.stringify(list, null, 1) + "\n");
    const bySeason = new Map<number, number>();
    for (const e of list) bySeason.set(e.season, (bySeason.get(e.season) ?? 0) + 1);
    console.log(`${year}年度のページ: ${list.length} 件（${[...bySeason].map(([s, n]) => `${s}年度 ${n}`).join("、")}）`);
  }
  // どの出来事からも参照されない仮の人物（名簿に無い人）は消す
  const referenced = new Set<string>();
  for (const sub of ["npb", "manual"]) {
    const d = join(root, "data", "events", sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const txt = readFileSync(join(d, f), "utf-8");
      for (const m of txt.matchAll(/"?person"?\s*:\s*"?([0-9a-fx]{8,9})"?/g)) referenced.add(m[1]);
    }
  }
  const extras = [...extra.values()].filter((p) => referenced.has(p.id)).sort((a, b) => a.id.localeCompare(b.id));
  const links = Object.fromEntries(Object.entries(npbLinks).filter(([x]) => peopleById.has(x)).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(linksPath, JSON.stringify(links, null, 1) + "\n");
  console.log(`名簿のリンク無しの人と公示の選手 ID の対応: ${Object.keys(links).length} 人`);
  writeFileSync(extraPath, extras.map((p) => JSON.stringify(p)).join("\n") + (extras.length ? "\n" : ""));
  console.log(`名簿にない人物: ${extras.length} 人`);
  if (unmatched.length) {
    // 名簿の年度内なのに名前で引けなかった選手（2000 年代前半の公示はリンクが無い）。その行は取り込んでいない
    console.warn(`名前で名簿から引けず飛ばした選手: ${unmatched.length} 件`);
    for (const u of [...new Set(unmatched)]) console.warn(`  ${u}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
