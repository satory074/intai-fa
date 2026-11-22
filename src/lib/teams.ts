/**
 * 球団の系譜まわりの参照。data/teams.yaml を読む（ビルドと scripts の両方から使う）。
 * パスは process.cwd()（= リポジトリ直下。npm scripts / astro build のどちらでも同じ）から引く。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { teamsFileSchema, type Franchise } from "./schema";

let cache: Franchise[] | null = null;

export function franchises(): Franchise[] {
  if (!cache) {
    const raw = parse(readFileSync(join(process.cwd(), "data", "teams.yaml"), "utf-8"));
    cache = teamsFileSchema.parse(raw).franchises;
  }
  return cache;
}

export function franchise(id: string): Franchise {
  const f = franchises().find((x) => x.id === id);
  if (!f) throw new Error(`unknown franchise: ${id}`);
  return f;
}

export const CURRENT_TEAM_IDS = [
  "giants", "tigers", "dragons", "baystars", "swallows", "carp",
  "hawks", "lions", "fighters", "buffaloes", "marines", "eagles",
] as const;

/** 名簿の表記（short）と年から系譜を引く。見つからなければ null */
export function resolveShort(short: string, year: number): Franchise | null {
  for (const f of franchises()) {
    for (const e of f.eras) {
      if (e.short === short && year >= e.from && year <= (e.to ?? 9999)) return f;
    }
  }
  return null;
}

/** 年が合わなくても、その表記を使う系譜が 1 つだけならそれを返す（名簿の「40～42,46中部日本」のような書き方用） */
export function resolveShortAny(short: string): Franchise | null {
  const hits = franchises().filter((f) => f.eras.some((e) => e.short === short));
  return hits.length === 1 ? hits[0] : null;
}

/** その年の球団表記（名簿の short）。在籍していない年なら最も近い時期の表記 */
export function shortOf(id: string, year: number): string {
  const f = franchise(id);
  const hit = f.eras.find((e) => year >= e.from && year <= (e.to ?? 9999));
  if (hit) return hit.short;
  return year < f.eras[0].from ? f.eras[0].short : f.eras[f.eras.length - 1].short;
}

/** その年に存在した系譜 */
export function franchisesIn(year: number): Franchise[] {
  return franchises().filter((f) => f.eras.some((e) => year >= e.from && year <= (e.to ?? 9999)));
}

const nfkc = (s: string) => s.normalize("NFKC").replace(/[\s　]/g, "");

/**
 * NPB 公示の球団表記（正式名・略称・年によって違う）から系譜を引く。
 * 「近鉄バファローズ」を先に拾うため、近鉄の判定をバファローズより前に置く。
 */
const KEYWORDS: [string, string[]][] = [
  ["kintetsu", ["近鉄"]],
  ["giants", ["読売", "巨人", "ジャイアンツ"]],
  ["tigers", ["阪神", "タイガース"]],
  ["dragons", ["中日", "ドラゴンズ"]],
  ["baystars", ["DeNA", "ベイスターズ", "横浜"]],
  ["swallows", ["ヤクルト", "スワローズ"]],
  ["carp", ["広島", "カープ"]],
  ["hawks", ["ソフトバンク", "ダイエー", "ホークス"]],
  ["lions", ["西武", "ライオンズ"]],
  ["fighters", ["日本ハム", "ファイターズ"]],
  ["buffaloes", ["オリックス", "バファローズ", "ブルーウェーブ"]],
  ["marines", ["ロッテ", "マリーンズ"]],
  ["eagles", ["楽天", "イーグルス"]],
];

export function resolveNpbTeamName(name: string): string | null {
  const n = nfkc(name);
  for (const [id, words] of KEYWORDS) if (words.some((w) => n.includes(w))) return id;
  return null;
}

/** NPB 公示 URL の球団コード（registered_g.html の g）から系譜を引く */
export function resolveUrlCode(code: string): string | null {
  return franchises().find((f) => f.urlCode === code)?.id ?? null;
}
