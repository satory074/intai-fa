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

/** 背景色の上に置く文字色（WCAG の相対輝度で白か墨か） */
export function onColor(hex: string): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const contrastWhite = 1.05 / (L + 0.05);
  const contrastInk = (L + 0.05) / (0.0255 + 0.05); // #1f2633 ≈ L 0.0255
  return contrastWhite >= contrastInk ? "#ffffff" : "#1f2633";
}
