/**
 * NPB の選手ページ（https://npb.jp/bis/players/<ID>.html）から、生年月日と投打だけを取る（年齢の表示用: Q11）。
 * 成績表は取らない・載せない（成績は NPB の選手ページへのリンクで代える）。
 *
 *   npm run import:profiles                  # 去就の出来事に出てくる人のうち、まだ取っていない人
 *   npm run import:profiles -- --seasons 2025,2026
 *   npm run import:profiles -- --limit 200
 *
 * 書き出し: data/profiles.jsonl（{ id, birth, throwsBats } を 1 行 1 人。取れなかった人は { id, missing: true }）
 * 取得は 2.5 秒間隔（1 時間に約 1,400 人）。途中で止めても、取れた分は保存される（50 人ごとに書く）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseHtml } from "node-html-parser";
import { parse as parseYaml } from "yaml";
import { politeFetch } from "../lib/fetch";

const root = process.cwd();
const out = join(root, "data", "profiles.jsonl");

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const seasons = arg("--seasons")?.split(",").map(Number) ?? null;
const limit = Number(arg("--limit") ?? "100000");

type Profile = { id: string; birth?: string; throwsBats?: string; missing?: boolean };
const done = new Map<string, Profile>();
if (existsSync(out)) for (const l of readFileSync(out, "utf-8").split("\n").filter(Boolean)) {
  const p = JSON.parse(l) as Profile;
  done.set(p.id, p);
}

// 対象: 出来事に出てくる人物のうち NPB ID がある人
const wanted = new Set<string>();
for (const sub of ["npb", "manual"]) {
  const dir = join(root, "data", "events", sub);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    const txt = readFileSync(join(dir, f), "utf-8");
    const list = (f.endsWith(".json") ? JSON.parse(txt) : parseYaml(txt) ?? []) as { person: string; season: number }[];
    for (const e of list) if ((!seasons || seasons.includes(e.season)) && /^\d{8}$/.test(e.person)) wanted.add(e.person);
  }
}
const todo = [...wanted].filter((id) => !done.has(id)).slice(0, limit);

function save() {
  const all = [...done.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(out, all.map((p) => JSON.stringify(p)).join("\n") + "\n");
}

async function main() {
  console.log(`対象 ${wanted.size} 人のうち未取得 ${todo.length} 人`);
  let n = 0;
  for (const id of todo) {
    const res = await politeFetch(`https://npb.jp/bis/players/${id}.html`);
    if (res.status !== 200) {
      done.set(id, { id, missing: true });
    } else {
      const doc = parseHtml(res.text);
      const p: Profile = { id };
      for (const tr of doc.querySelectorAll("table tr")) {
        const th = tr.querySelector("th")?.text.trim();
        const td = tr.querySelector("td")?.text.trim() ?? "";
        if (th === "生年月日") {
          const m = td.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
          if (m) p.birth = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
        }
        if (th === "投打" && /^[右左両]投[右左両]打$/.test(td)) p.throwsBats = td;
      }
      if (!p.birth) p.missing = true;
      done.set(id, p);
    }
    if (++n % 50 === 0) {
      save();
      console.log(`  ${n}/${todo.length}`);
    }
  }
  save();
  console.log(`完了: ${n} 人`);
}

main().catch((e) => {
  console.error(e);
  save();
  process.exit(1);
});
