/**
 * データの不変条件を 1 つずつ確かめる（CI のゲート）。件数を増やすテストではなく、壊れたら困ることだけ。
 *
 *   npm run check          # 不変条件 + 公開を保留している行の報告
 *   npm run check:urls     # さらに、下書き（auto_unverified / verified）の出典 URL を開いて data/url-status.json に記録
 *
 * 破ったら終了コード 1（デプロイしない）:
 *   1. 人物 ID が重複しない（名簿と people-extra をまたいでも）
 *   2. 出来事の ID が重複しない（すべての出来事ファイルをまたいで）
 *   3. 出来事の人物・球団が実在する
 *   4. 日付が未来でない／年度の範囲（その年の 1/1〜翌年の 12/31）に入っている
 *   5. 所属の年が 1936〜名簿の年に収まり、from ≤ to
 *   6. 同じ年に選手として 2 球団に在籍していない（その年に一方が終わり他方が始まる移籍は除く。
 *      名簿は「80,81南海,81～83西武」のように「途」を付けずに年内の移籍を書くことがある）
 * 警告だけ（件数の想定）:
 *   - NPB 公示のある年度（2003〜）で、自由契約の件数が 50〜450 に収まる
 * 報告だけ:
 *   - 公開を保留している出来事（gate.ts の条件を満たさないもの）と理由
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { eventsFileSchema, personSchema, stintSchema, type IntaiEvent, type Person, type Stint } from "../../src/lib/schema";
import { franchises } from "../../src/lib/teams";
import { gateEvent, loadUrlStatus, type UrlStatus } from "../../src/lib/gate";
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
  const targets = [...new Set(events.filter(({ e }) => e.status === "auto_unverified" || e.status === "verified").flatMap(({ e }) => e.sources.map((s) => s.url)))];
  const lastByHost = new Map<string, number>();
  for (const url of targets) {
    const host = new URL(url).hostname;
    const wait = (lastByHost.get(host) ?? 0) + 1500 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastByHost.set(host, Date.now());
    let code = 0;
    try {
      const res = await fetch(url, { method: "GET", redirect: "follow", headers: { "user-agent": UA } });
      code = res.status;
    } catch {
      code = 0;
    }
    status[url] = { status: code, checked: today };
    console.log(`  ${code} ${url}`);
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
