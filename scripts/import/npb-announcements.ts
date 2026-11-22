/**
 * NPB 公示（https://npb.jp/announcement/YYYY/）から出来事を作る。AI は使わない。
 *
 *   npm run import:npb                         # 前年度と今年度
 *   npm run import:npb -- --years 2025,2026
 *   npm run import:npb -- --years 2025 --from-dir DIR   # 取得済みの HTML（ファイル名は YYYY_page.html）
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
 *   （長野久義: 2025 年 10 月に引退発表 → 2026/3/16 公示）。1〜7 月の公示は Y-1 年度に入れる。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
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
  if (i >= 0) return process.argv[i + 1].split(",").map((x) => parseInt(x, 10));
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
    return existsSync(p) ? parseHtml(readFileSync(p, "utf-8")) : null;
  }
  const url = page.startsWith("http") ? page : `https://npb.jp/announcement/${year}/${page}`;
  const res = await politeFetch(url);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  return parseHtml(res.text);
}

const pageUrl = (year: number, page: string) => `https://npb.jp/announcement/${year}/${page}`;

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

const key = (name: string) => name.normalize("NFKC").replace(/[\s　]/g, "");
const cleanName = (s: string) => s.replace(/[\s　]+/g, " ").trim();

/** 公示のリンク付きの人物。名簿に無ければ people-extra に足す */
function personFromLink(nameCell: HTMLElement): string | null {
  const a = nameCell.querySelector("a");
  const id = a?.getAttribute("href")?.match(/players\/(\d{8})\.html/)?.[1];
  const name = cleanName(nameCell.text);
  if (!name) return null;
  if (id) {
    if (!peopleById.has(id)) {
      const p: Person = { id, npbId: id, name };
      peopleById.set(id, p);
      extra.set(id, p);
    }
    return id;
  }
  return personByName(name, null);
}

/**
 * 名前だけの人物（監督・コーチの公示）。同じ名前が 1 人ならその人、複数ならその球団に在籍したことのある人。
 * 見つからなければ people-extra に新しく作る。
 */
function personByName(name: string, franchise: string | null): string {
  const k = key(name);
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

const isoDate = (s: string): string | undefined => {
  const m = s.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : undefined;
};
const posOf = (el: HTMLElement | null | undefined): { pos?: string } => {
  const t = (el?.text ?? "").replace(/[\s　]/g, "");
  return t ? { pos: t } : {};
};
const stripParens = (s: string) => s.replace(/[（）()]/g, "").replace(/※\d+/g, "").trim();

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

/** 自由契約（支配下・育成） */
async function released(year: number, page: string, ikusei: boolean, out: IntaiEvent[]) {
  const doc = await getPage(year, page);
  if (!doc) return;
  for (const tr of doc.querySelectorAll("tr")) {
    const date = isoDate(tr.querySelector(".pndate")?.text ?? "");
    const teamCell = tr.querySelector(".pnteam");
    const nameCell = tr.querySelector(".pnname");
    if (!date || !teamCell || !nameCell) continue;
    const person = personFromLink(nameCell);
    const team = teamOf(teamCell);
    if (!person || !team) continue;
    const note = stripParens(tr.querySelector(".pnnote")?.text ?? "");
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

/** 任意引退 */
async function retired(year: number, out: IntaiEvent[]) {
  const doc = await getPage(year, "pn_retired.html");
  if (!doc) return;
  for (const tr of doc.querySelectorAll("tr")) {
    const date = isoDate(tr.querySelector(".pndate")?.text ?? "");
    const teamCell = tr.querySelector(".pnteam");
    const nameCell = tr.querySelector(".pnname");
    if (!date || !teamCell || !nameCell) continue;
    const person = personFromLink(nameCell);
    const team = teamOf(teamCell);
    if (!person || !team) continue;
    const month = parseInt(date.slice(5, 7), 10);
    out.push({
      id: eventId(["npb", year, "retired", person, date.replaceAll("-", "")]),
      season: month <= 7 ? year - 1 : year,
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
    for (const tr of table.querySelectorAll("tr")) {
      const date = isoDate(tr.querySelector(".trdate")?.text ?? "");
      const nameCell = tr.querySelector(".trname");
      const teams = tr.querySelectorAll(".trteam");
      if (!date || !nameCell || teams.length < 2) continue;
      const person = personFromLink(nameCell);
      const from = teamOf(teams[0]);
      const to = teamOf(teams[1]);
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

/** FA 宣言と、その結末（契約締結合意: 移籍 or 残留） */
async function faFiled(year: number, out: IntaiEvent[]) {
  const doc = await getPage(year, "fa_filed.html");
  if (!doc) return;
  let kind = "";
  for (const el of doc.querySelectorAll("h5, tr")) {
    if (el.tagName === "H5") {
      kind = el.text.includes("海外") ? "海外FA" : el.text.includes("国内") ? "国内FA" : kind;
      continue;
    }
    const tds = el.querySelectorAll("td");
    const nameCell = el.querySelector(".pnname");
    if (!nameCell || tds.length < 7) continue;
    const person = personFromLink(nameCell);
    const fromTeam = resolveNpbTeamName(tds[0].text);
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
      sources: [npbSource(year, "fa_filed.html", "フリーエージェント宣言選手")],
    });
    const date = isoDate(tds[5].text);
    const toText = tds[6].text.trim();
    if (date && toText) {
      const to = resolveNpbTeamName(toText);
      const base = {
        season: year,
        date,
        person,
        team: fromTeam,
        status: "npb_official" as const,
        sources: [npbSource(year, "fa_filed.html", "フリーエージェント宣言選手（契約締結合意）")],
      };
      if (to === fromTeam) out.push({ ...base, id: eventId(["npb", year, "fa-stay", person]), type: "fa_stay" });
      else if (to) out.push({ ...base, id: eventId(["npb", year, "fa-move", person]), type: "fa_move", toTeam: to });
      else out.push({ ...base, id: eventId(["npb", year, "fa-move", person]), type: "fa_move", toOrg: { name: toText, kind: "overseas" } });
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
    for (const tr of doc.querySelectorAll("tr")) {
      const date = isoDate(tr.querySelector(".pndate")?.text ?? "");
      const teamCell = tr.querySelector(".pnteam");
      const nameCell = tr.querySelector(".pnname");
      if (!date || !teamCell || !nameCell) continue;
      const person = personFromLink(nameCell);
      const team = teamOf(teamCell);
      if (!person || !team) continue;
      const fromIkusei = (tr.querySelector(".pnnote")?.text ?? "").includes("育成選手から移行");
      out.push({ person, team, date, ikusei, fromIkusei, year, page });
    }
  }
  return out;
}

/**
 * 翌年度の球団別の支配下・育成選手一覧（registered_g.html / registereddev_g.html）。
 * オフに決まった移籍・育成での再契約はここに「公示日 M/D」付きで載る（10〜12 月は前年の日付）。
 */
async function rosters(year: number): Promise<Registration[]> {
  const out: Registration[] = [];
  for (const f of franchises()) {
    if (!f.urlCode) continue;
    for (const [page, ikusei] of [[`registered_${f.urlCode}.html`, false], [`registereddev_${f.urlCode}.html`, true]] as const) {
      const doc = await getPage(year, page);
      const table = doc?.querySelector("table");
      if (!table) continue;
      for (const tr of table.querySelectorAll("tr")) {
        const cells = tr.querySelectorAll("th, td");
        if (cells.length < 4) continue;
        const md = cells[0].text.trim().match(/^(\d{1,2})\/(\d{1,2})$/);
        const nameCell = cells[cells.length - 1];
        if (!md || !nameCell.querySelector("a")) continue;
        const person = personFromLink(nameCell);
        if (!person) continue;
        const m = parseInt(md[1], 10);
        const y = m >= 10 ? year - 1 : year;
        out.push({ person, team: f.id, date: `${y}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`, ikusei, fromIkusei: false, year, page });
      }
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
      const row = now.rows.find((r) => key(r.name) === key(c.name));
      const person = row?.person ?? personByName(c.name, team);
      const [fromRole, toRole0] = (row?.role ?? "").split("→").map((s) => s.trim());
      const toRole = toRole0 ?? (c.role && c.role !== fromRole ? c.role : undefined);
      const acting = c.label.includes("監督代行");
      const type: IntaiEvent["type"] = acting
        ? "manager_in"
        : c.label.includes("抹消")
          ? "coach_out"
          : c.label.includes("登録")
            ? "coach_in"
            : "coach_change";
      out.push({
        id: eventId(["npb", year, "staff", type, team, person, c.date.replaceAll("-", "")]),
        season: year,
        date: c.date,
        type,
        person,
        team,
        ...(toRole ? { role: toRole } : acting ? { role: "監督代行" } : {}),
        ...(fromRole && toRole ? { fromRole } : {}),
        note: c.label + (c.note ? `（${c.note}）` : ""),
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
    // 「いつ取り込んだか」(seen) は前回の値を引き継ぐ。新着の並びに使う
    const seen = new Map(old.map((e) => [e.id, e.seen]));
    // 初めてこの年度を取り込むとき（過去分の一括取り込み）は「新着」にしない。2 回目以降に増えた行だけ seen=今日
    const initial = !existsSync(p);
    const list = events.map((e) => {
      const s = seen.get(e.id) ?? (initial ? undefined : today);
      const { seen: _drop, ...rest } = e;
      return s ? { ...rest, seen: s } : rest;
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
  writeFileSync(extraPath, extras.map((p) => JSON.stringify(p)).join("\n") + (extras.length ? "\n" : ""));
  console.log(`名簿にない人物: ${extras.length} 人`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
