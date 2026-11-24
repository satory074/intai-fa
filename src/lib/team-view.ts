/** 球団の一覧・球団のページで使う表示用の文字（系譜の名前の移り変わり、リーグ名） */
import type { Franchise } from "./schema";
import { CURRENT_TEAM_IDS } from "./teams";

export const isCurrent = (id: string) => (CURRENT_TEAM_IDS as readonly string[]).includes(id);

/** 球団の見出しに使う名前。現行球団は正式名、消滅した系譜は最後の時期の名前 */
export const displayName = (f: Franchise) => f.full ?? f.eras[f.eras.length - 1].short;

/** 名前の移り変わり（「名古屋（1936〜1943）→ 産業（1944）→ …」）。同じ名前に戻った時期も並べる */
export const erasText = (f: Franchise) =>
  f.eras.map((e) => `${e.short}（${e.from}${e.to === e.from ? "" : `〜${e.to ?? ""}`}）`).join(" → ");

/** 存在した年（消滅した系譜だけ「1950〜2004」） */
export const yearsText = (f: Franchise) => `${f.eras[0].from}〜${isCurrent(f.id) ? "" : (f.eras[f.eras.length - 1].to ?? "")}`;

export const LEAGUE_LABEL: Record<string, string> = { central: "セントラル・リーグ", pacific: "パシフィック・リーグ" };
