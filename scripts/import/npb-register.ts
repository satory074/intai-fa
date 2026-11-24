/**
 * NPB「プロ野球在籍者名簿」（https://npb.jp/history/register/）から人物と所属を作る。
 *
 *   npm run import:register                     # npb.jp から 44 ページを取得（2.5 秒間隔、約 2 分）
 *   npm run import:register -- --from-dir DIR   # 取得済みの HTML を読む
 *
 * 書き出し: data/people.jsonl（1 行 1 人）、data/stints.jsonl（1 行 1 所属）
 *
 * 守ること（Q28・Q33）:
 * - 名簿の表記をそのまま保存・表示しない。年×球団×役割に分解して持ち、表示は帯と年表に作り直す。
 * - 一括配布しない（このデータはサイトの表示にだけ使う）。
 *
 * 不変条件（破ったら何も書き込まずに終了コード 1）:
 * - 44 ページすべてが取得でき、各ページに 1 人以上いる
 * - 総人数が前回の ±5% に収まる（初回は 9,000〜12,000 人）
 * - 読めない表記・不明な球団が 0 件
 * - 人物 ID が重複しない
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseHtml } from "node-html-parser";
import { politeFetch } from "../lib/fetch";
import { parseRegisterCell } from "../lib/register-parse";
import type { Person, Stint } from "../../src/lib/schema";
import { KANA_ROWS as KANA_LIST } from "../../src/lib/kana";

const BASE = "https://npb.jp/history/register/";
const KANA_ROWS: Record<string, string> = Object.fromEntries(KANA_LIST.map((k) => [k.key, k.label]));

const root = process.cwd();
const PEOPLE = join(root, "data", "people.jsonl");
const STINTS = join(root, "data", "stints.jsonl");

const cleanName = (s: string) => s.replace(/[\s　]+/g, " ").trim();

function stableId(name: string, cell: string): string {
  return "x" + createHash("sha1").update(`${name}|${cell}`).digest("hex").slice(0, 8);
}

async function main() {
  const index = await politeFetch(BASE);
  if (index.status !== 200) throw new Error(`index: HTTP ${index.status}`);
  const pages = [...new Set([...index.text.matchAll(/index_([a-z]+)\.html/g)].map((m) => m[1]))];
  if (pages.length !== 44) throw new Error(`五十音ページが 44 ではない: ${pages.length}`);
  const asOf = index.text.match(/(\d{4})年シーズン終了時/)?.[1];

  const people: Person[] = [];
  const stints: Stint[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  /** 「トゥーシェン （→ 李 杜軒）」のような別名の参照（検索用に本人の names へ足す） */
  const aliases: { alias: string; target: string }[] = [];

  for (const key of pages) {
    const res = await politeFetch(`${BASE}index_${key}.html`);
    if (res.status !== 200) throw new Error(`index_${key}: HTTP ${res.status}`);
    const doc = parseHtml(res.text);
    let count = 0;
    for (const tr of doc.querySelectorAll("tr")) {
      const tds = tr.querySelectorAll("td");
      if (tds.length !== 3) continue;
      // 外国人選手は「Ｅ．ヤーナル <span>（ED YARNALL）</span>」。ローマ字は別名として持つ
      const roman = tds[0].querySelector("span")?.text.replace(/[（）()]/g, "").trim();
      tds[0].querySelector("span")?.remove();
      const name = cleanName(tds[0].text);
      const cell = tds[2].text.replace(/\s+/g, " ").trim();
      if (roman?.startsWith("→") && !cell) {
        aliases.push({ alias: name, target: cleanName(roman.slice(1)) });
        continue;
      }
      if (!name || !cell) continue;
      // リンクは行ではなく表全体を <a class="unit"> が包む形
      let anc: any = tr.parentNode;
      while (anc && anc.tagName !== "A") anc = anc.parentNode;
      const href = (anc?.getAttribute?.("href") as string | undefined) ?? "";
      const npbId = href.match(/players\/(\d{8})\.html/)?.[1];
      const id = npbId ?? stableId(name, cell);
      if (seen.has(id)) {
        errors.push(`ID 重複: ${id} ${name}`);
        continue;
      }
      seen.add(id);
      const parsed = parseRegisterCell(cell);
      for (const e of parsed.errors) errors.push(`${name}: ${e}`);
      const p: Person = { id, name, kanaRow: KANA_ROWS[key] };
      if (npbId) p.npbId = npbId;
      if (parsed.names.length) p.names = parsed.names;
      if (roman && !roman.startsWith("→")) p.names = [...(p.names ?? []), { name: roman }];
      people.push(p);
      // 「24,25巨人（コ）」のように年ごとに書かれた連続する所属は 1 つにまとめる（同じ球団・役割・表記・補足で、途中移籍の印がないとき）
      const merged: typeof parsed.stints = [];
      for (const s of parsed.stints.toSorted((a, b) => a.from - b.from)) {
        const prev = merged.find(
          (m) => m.franchise === s.franchise && m.role === s.role && m.short === s.short && (m.note ?? "") === (s.note ?? "") &&
            m.to + 1 === s.from && !m.toMid && !s.fromMid,
        );
        if (prev) {
          prev.to = s.to;
          if (s.toMid) prev.toMid = true;
        } else merged.push({ ...s });
      }
      for (const s of merged) stints.push({ person: id, ...s });
      count++;
    }
    if (count === 0) throw new Error(`index_${key}: 0 人`);
  }

  // 別名の参照は、同じ名前の人物が 1 人だけのときに限って結びつける（同姓同名は飛ばす）
  const byName = new Map<string, Person[]>();
  for (const p of people) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  let linked = 0;
  for (const a of aliases) {
    const hits = byName.get(a.target) ?? [];
    if (hits.length !== 1) continue;
    const p = hits[0];
    p.names = [...(p.names ?? []), { name: a.alias }];
    linked++;
  }
  console.log(`別名の参照 ${aliases.length} 件中 ${linked} 件を結びつけた`);

  if (errors.length) {
    console.error(`読めない表記が ${errors.length} 件あるので書き込まない:`);
    for (const e of errors.slice(0, 50)) console.error("  " + e);
    process.exit(1);
  }

  const prev = existsSync(PEOPLE) ? readFileSync(PEOPLE, "utf-8").split("\n").filter(Boolean).length : 0;
  const ok = prev ? Math.abs(people.length - prev) / prev <= 0.05 : people.length >= 9000 && people.length <= 12000;
  if (!ok) {
    console.error(`人数が想定外: 今回 ${people.length} / 前回 ${prev}。書き込まない`);
    process.exit(1);
  }

  // 既存の人物に手で足した項目（生年月日・投打）は残す
  const keep = new Map<string, Person>();
  if (existsSync(PEOPLE)) {
    for (const line of readFileSync(PEOPLE, "utf-8").split("\n").filter(Boolean)) {
      const p = JSON.parse(line) as Person;
      keep.set(p.id, p);
    }
  }
  for (const p of people) {
    const old = keep.get(p.id);
    if (old?.birth) p.birth = old.birth;
    if (old?.throwsBats) p.throwsBats = old.throwsBats;
  }

  people.sort((a, b) => a.id.localeCompare(b.id));
  stints.sort((a, b) => a.person.localeCompare(b.person) || a.from - b.from || a.role.localeCompare(b.role));
  // 手で足した所属（src: manual）は残す
  const manual = existsSync(STINTS)
    ? readFileSync(STINTS, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Stint).filter((s) => s.src === "manual")
    : [];
  writeFileSync(PEOPLE, people.map((p) => JSON.stringify(p)).join("\n") + "\n");
  writeFileSync(STINTS, [...stints, ...manual].map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(join(root, "data", "register-meta.json"), JSON.stringify({ asOf: asOf ? Number(asOf) : null, people: people.length, stints: stints.length + manual.length }, null, 2) + "\n");
  console.log(`人物 ${people.length} 人・所属 ${stints.length} 件（名簿は ${asOf} 年シーズン終了時）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
