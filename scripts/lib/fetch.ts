/**
 * npb.jp などへの控えめな取得。
 * - UA はボットであることと説明ページだけを名乗る（個人の連絡先は入れない）
 * - 同じプロセス内では前回の取得から最低 minIntervalMs 空ける（既定 2.5 秒）
 * - --from-dir <dir> を付けて実行した場合は、ネットに出ずにそのディレクトリのファイルを読む
 *   （ファイル名は URL のパス部分の最後の要素。例: index_ya.html）
 */
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export const UA = "intai-fa-bot (+https://satory074.github.io/intai-fa/about/)";

let last = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fromDirArg(): string | null {
  const i = process.argv.indexOf("--from-dir");
  return i >= 0 ? process.argv[i + 1] : null;
}

export async function politeFetch(url: string, minIntervalMs = 2500): Promise<{ status: number; text: string }> {
  const dir = fromDirArg();
  if (dir) {
    const path = new URL(url).pathname;
    const p = join(dir, path.endsWith("/") ? "index.html" : basename(path));
    if (!existsSync(p)) return { status: 404, text: "" };
    return { status: 200, text: readFileSync(p, "utf-8") };
  }
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "ja" } });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(5000);
    }
  }
  throw new Error("unreachable");
}

/** 今日の日付（JST）を YYYY-MM-DD で */
export function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}
