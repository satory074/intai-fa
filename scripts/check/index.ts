/**
 * データの不変条件を 1 つずつ確かめる（CI のゲート）。件数を増やすテストではなく、壊れたら困ることだけ。
 *
 *   npm run check          # 不変条件 + 公開を保留している行の報告
 *   npm run check:urls     # さらに、下書き（auto_unverified / verified）の出典 URL を開き、開けるかと、抜粋（quote）が
 *                          # ページの本文にあるかを data/url-status.json に記録（取得は同じホストに 2.5 秒以上の間隔）
 *
 * 破ったら終了コード 1（デプロイしない）:
 *   1. 人物 ID が重複しない（名簿と people-extra をまたいでも）
 *   2. 出来事の ID が重複しない（すべての出来事ファイルをまたいで）
 *   3. 出来事の人物・球団が実在する
 *   4. 日付が未来でない／年度の範囲（その年の 1/1〜翌年の 12/31）に入っている
 *   5. 所属の年が 1936〜名簿の年に収まり、from ≤ to
 *   6. 同じ年に選手として 2 球団に在籍していない（その年に一方が終わり他方が始まる移籍は除く。
 *      名簿は「80,81南海,81～83西武」のように「途」を付けずに年内の移籍を書くことがある）
 *   7. 出来事の球団がその年度（か翌年）に存在する（公示の球団コードの読み違いを捕まえる。
 *      2004 年オフの近鉄→楽天のように、翌年にできた球団への移籍があるので翌年まで許す）
 *   8. data/name-aliases.yaml の人物が実在し、同じ表記が 2 回出ない
 *   9. data/npb-id-links.json（名簿のリンク無しの人 → NPB ID）の人物が実在し、同じ NPB ID が 2 人に付かない。
 *      その NPB ID の人が別人として people-extra にいない（同じ人が 2 人に分かれていない）
 * 警告だけ（件数の想定）:
 *   - NPB 公示のある年度（2003〜）で、自由契約の件数が 50〜450 に収まる
 * 報告だけ:
 *   - 公開を保留している出来事（gate.ts の条件を満たさないもの）と理由
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseHtml } from "node-html-parser";
import { parse } from "yaml";
import { eventsFileSchema, personSchema, stintSchema, type IntaiEvent, type Person, type Stint } from "../../src/lib/schema";
import { franchises, franchisesIn } from "../../src/lib/teams";
import { gateEvent, loadUrlStatus, normText, quoteKey, quoteParts, type UrlStatus } from "../../src/lib/gate";
import { UA, todayJst } from "../lib/fetch";

const root = process.cwd();
const data = join(root, "data");
const today = todayJst();
const errors: string[] = [];
const warnings: string[] = [];

const jsonl = (f: string) =>
  existsSync(join(data, f)) ? readFileSync(join(data, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// ---------- 読み込み（形はスキーマで確かめる） ----------
const people: Person[] = [...jsonl("people.jsonl"), ...jsonl("people-extra.jsonl")].map((p) => personSchema.parse(p));
const stints: Stint[] = jsonl("stints.jsonl").map((s) => stintSchema.parse(s));
const events: { e: IntaiEvent; file: string }[] = [];
for (const sub of ["npb", "manual"]) {
  const dir = join(data, "events", sub);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).sort()) {
    const raw = f.endsWith(".json") ? JSON.parse(readFileSync(join(dir, f), "utf-8")) : f.endsWith(".yaml") ? parse(readFileSync(join(dir, f), "utf-8")) ?? [] : null;
    if (raw === null) continue;
    const parsed = eventsFileSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(`events/${sub}/${f}: 形が違う: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join(" / ")}`);
      continue;
    }
    for (const e of parsed.data) events.push({ e, file: `events/${sub}/${f}` });
  }
}
const asOf = existsSync(join(data, "register-meta.json")) ? JSON.parse(readFileSync(join(data, "register-meta.json"), "utf-8")).asOf : 2025;

// ---------- 1. 人物 ID ----------
const personIds = new Map<string, number>();
for (const p of people) personIds.set(p.id, (personIds.get(p.id) ?? 0) + 1);
for (const [id, n] of personIds) if (n > 1) errors.push(`人物 ID が重複: ${id}（${n} 回）`);
const peopleMap = new Map(people.map((p) => [p.id, p]));

// ---------- 2. 出来事 ID ----------
const eventIds = new Map<string, string[]>();
for (const { e, file } of events) eventIds.set(e.id, [...(eventIds.get(e.id) ?? []), file]);
for (const [id, files] of eventIds) if (files.length > 1) errors.push(`出来事 ID が重複: ${id}（${files.join(", ")}）`);

// ---------- 3・4. 参照と日付 ----------
const teamIds = new Set(franchises().map((f) => f.id));
for (const { e, file } of events) {
  const where = `${file} ${e.id}`;
  if (!peopleMap.has(e.person)) errors.push(`${where}: 人物 ${e.person} がいない`);
  for (const t of [e.team, e.toTeam]) if (t && !teamIds.has(t)) errors.push(`${where}: 球団 ${t} がない`);
  if (e.date && e.date > today) errors.push(`${where}: 日付 ${e.date} が未来`);
  if (e.date && (e.date < `${e.season}-01-01` || e.date > `${e.season + 1}-12-31`)) errors.push(`${where}: 日付 ${e.date} が ${e.season} 年度の範囲外`);
  if (e.season > Number(today.slice(0, 4))) errors.push(`${where}: 年度 ${e.season} が未来`);
}

// ---------- 7. その年度に存在する球団 ----------
const existsIn = new Map<number, Set<string>>();
const teamsIn = (y: number) => existsIn.get(y) ?? existsIn.set(y, new Set(franchisesIn(y).map((f) => f.id))).get(y)!;
for (const { e, file } of events) {
  for (const t of [e.team, e.toTeam]) {
    if (t && teamIds.has(t) && !teamsIn(e.season).has(t) && !teamsIn(e.season + 1).has(t))
      errors.push(`${file} ${e.id}: 球団 ${t} は ${e.season} 年度に存在しない`);
  }
}

// ---------- 8. 名前の対応表 ----------
const aliasPath = join(data, "name-aliases.yaml");
if (existsSync(aliasPath)) {
  const seenAlias = new Set<string>();
  for (const a of (parse(readFileSync(aliasPath, "utf-8")) ?? []) as { name: string; person: string }[]) {
    if (!peopleMap.has(String(a.person))) errors.push(`name-aliases.yaml: ${a.name} の人物 ${a.person} がいない`);
    if (seenAlias.has(a.name)) errors.push(`name-aliases.yaml: ${a.name} が 2 回出る`);
    seenAlias.add(a.name);
  }
}

// ---------- 9. NPB ID の対応 ----------
const linkPath = join(data, "npb-id-links.json");
if (existsSync(linkPath)) {
  const links = JSON.parse(readFileSync(linkPath, "utf-8")) as Record<string, string>;
  const byNpb = new Map<string, string>();
  for (const [x, n] of Object.entries(links)) {
    if (!peopleMap.has(x)) errors.push(`npb-id-links.json: 人物 ${x} がいない`);
    if (byNpb.has(n)) errors.push(`npb-id-links.json: NPB ID ${n} が ${byNpb.get(n)} と ${x} の 2 人に付いている`);
    byNpb.set(n, x);
    if (peopleMap.has(n)) errors.push(`npb-id-links.json: NPB ID ${n} の人が別に ${peopleMap.get(n)!.name} としている（${x} と同じ人）`);
  }
}

// ---------- 5・6. 所属 ----------
const playerYears = new Map<string, Map<number, { f: string; end: boolean; start: boolean }[]>>();
for (const s of stints) {
  if (!peopleMap.has(s.person)) errors.push(`所属の人物 ${s.person} がいない`);
  if (!teamIds.has(s.franchise)) errors.push(`所属の球団 ${s.franchise} がない（${s.person}）`);
  if (s.from > s.to) errors.push(`所属の年が逆: ${s.person} ${s.from}〜${s.to}`);
  if (s.from < 1936 || s.to > asOf) errors.push(`所属の年が範囲外: ${s.person} ${s.from}〜${s.to}`);
  if (s.role !== "player" && s.role !== "ikusei") continue;
  const m = playerYears.get(s.person) ?? new Map();
  for (let y = s.from; y <= s.to; y++) {
    m.set(y, [...(m.get(y) ?? []), { f: s.franchise, end: y === s.to, start: y === s.from }]);
  }
  playerYears.set(s.person, m);
}
let overlaps = 0;
for (const [pid, m] of playerYears) {
  for (const [y, list] of m) {
    const fs = new Set(list.map((x) => x.f));
    const boundary = list.some((a) => a.end && list.some((b) => b.f !== a.f && b.start));
    if (fs.size > 1 && !boundary) {
      overlaps++;
      if (overlaps <= 10) errors.push(`同じ年に 2 球団: ${pid} ${y}（${[...fs].join(", ")}）`);
    }
  }
}

// ---------- 件数の想定（警告） ----------
for (let y = 2003; y <= Number(today.slice(0, 4)); y++) {
  const n = events.filter(({ e }) => e.season === y && e.type === "release").length;
  if (n > 0 && (n < 50 || n > 450)) warnings.push(`${y} 年度の自由契約が ${n} 件（想定 50〜450）`);
}

// ---------- 出典 URL の確認（--urls） ----------
async function checkUrls(): Promise<UrlStatus> {
  const status = loadUrlStatus();
  const drafts = events.filter(({ e }) => e.status === "auto_unverified" || e.status === "verified").flatMap(({ e }) => e.sources);
  // 同じページ（#以降だけ違う URL）は 1 回だけ取得する
  const page = (url: string) => url.replace(/#.*$/, "");
  const quotesByUrl = new Map<string, Set<string>>();
  for (const s of drafts) {
    if (!quotesByUrl.has(s.url)) quotesByUrl.set(s.url, new Set());
    if (s.quote) quotesByUrl.get(s.url)!.add(s.quote);
  }
  const bodies = new Map<string, { code: number; text: string }>();
  const lastByHost = new Map<string, number>();
  for (const url of quotesByUrl.keys()) {
    if (!bodies.has(page(url))) {
      const host = new URL(url).hostname;
      const wait = (lastByHost.get(host) ?? 0) + 2500 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastByHost.set(host, Date.now());
      let code = 0;
      let text = "";
      try {
        const res = await fetch(url, { method: "GET", redirect: "follow", headers: { "user-agent": UA } });
        code = res.status;
        // 本文の文字だけを使う（タグ・スクリプトを除き、文字参照は戻す）。ページは保存しない
        const doc = parseHtml(await res.text());
        for (const el of doc.querySelectorAll("script, style, noscript")) el.remove();
        text = normText(doc.text);
      } catch {
        code = 0;
      }
      bodies.set(page(url), { code, text });
    }
    const { code, text } = bodies.get(page(url))!;
    const quotes: Record<string, boolean> = {};
    for (const q of quotesByUrl.get(url)!) quotes[quoteKey(q)] = quoteParts(q).every((part) => text.includes(part));
    status[url] = { status: code, checked: today, quotes };
    const missing = Object.values(quotes).filter((x) => !x).length;
    console.log(`  ${code} ${url}${missing ? `（抜粋が見つからない ${missing} 件）` : ""}`);
  }
  writeFileSync(join(data, "url-status.json"), JSON.stringify(status, null, 1) + "\n");
  return status;
}

async function main() {
  const urls = process.argv.includes("--urls") ? await checkUrls() : loadUrlStatus();

  // ---------- 公開を保留している行 ----------
  const held = events.map(({ e }) => ({ e, reasons: gateEvent(e, peopleMap, urls) })).filter((x) => x.reasons.length);
  const auto = events.filter(({ e }) => e.status === "auto_unverified").length;

  console.log(`人物 ${people.length} 人・所属 ${stints.length} 件・出来事 ${events.length} 件（うち自動取得・未確認 ${auto} 件）`);
  if (held.length) {
    console.log(`公開を保留している出来事 ${held.length} 件:`);
    for (const h of held.slice(0, 40)) console.log(`  ${h.e.id}: ${h.reasons.join(" / ")}`);
  }
  for (const w of warnings) console.log(`注意 ${w}`);
  if (errors.length) {
    for (const e of errors.slice(0, 60)) console.error(`NG ${e}`);
    console.error(`check: ${errors.length} 件の問題`);
    process.exit(1);
  }
  console.log("check: 問題なし");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
