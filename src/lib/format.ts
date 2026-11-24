/** 表示用の小さな整形 */
import { SOURCE_LABEL } from "./gate";
import type { Source } from "./schema";

/** "2025-12-02" → "12/2" */
export function md(date: string | undefined): string {
  if (!date) return "";
  const [, m, d] = date.split("-");
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

/** "2025-12-02" → "2025年12月2日" */
export function ymd(date: string | undefined): string {
  if (!date) return "";
  const [y, m, d] = date.split("-");
  return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

/** 年度の見出し。オフの出来事を含むので「◯年オフ」 */
export const seasonLabel = (s: number) => `${s}年オフ`;

/** 人数のおおよそ: 10080 → "約1万人"、12600 → "約1.3万人"、9400 → "約9千人"（「約10千人」にしない） */
export function approxPeople(n: number): string {
  if (n >= 10000) return `約${(Math.round(n / 1000) / 10).toString()}万人`;
  return `約${Math.round(n / 1000)}千人`;
}

export function sourceLabel(s: Source): string {
  return SOURCE_LABEL[s.kind] ?? s.kind;
}

/** 今日（JST）。ビルドした日を基準に「直近 7 日」を決める */
export function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
