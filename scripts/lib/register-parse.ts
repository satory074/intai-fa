/**
 * NPB「プロ野球在籍者名簿」の在籍球団欄の解析。
 *
 * 例（実データ）:
 *   03～15途巨人,15途～18日本ハム,20～22日本ハム（コ）,24,25巨人（コ）
 *   15～17途楽天（育）,17途～19楽天,20巨人（育）,21,22巨人［改名］～18,20～八百板卓丸,19卓丸
 *   43南海,46グレートリング・47～49南海,50～52大洋・53洋松,54高橋・55トンボ・56高橋,57大映（コ）
 *   37秋～44,46～48阪急,67～71,73阪神（コ）              ← 球団名のない年は次の球団に掛かる
 *   10開幕～途中日（育）,10途～14中日,15ロッテ              ← 「途」+「中日」
 *   94～03西武,…,23～24.5.26西武（監）［改名］～94.3.15松井和夫,3.16～松井稼頭央
 *   57大映,…,77～84日本ハム（コ）［代監］84.6.28～6.29日本ハム
 *
 * 記号: 途=シーズン途中、（育）=育成、（コ）=コーチ、（監）=監督、［改名］、［代監］=代理監督。
 * 年は 2 桁（36〜99 → 19xx、00〜35 → 20xx）。
 */
import { resolveShort, resolveShortAny } from "../../src/lib/teams";
import type { Stint } from "../../src/lib/schema";

export const yy = (s: string): number => {
  const n = parseInt(s, 10);
  return n >= 36 ? 1900 + n : 2000 + n;
};

interface YearPoint {
  year: number;
  mid: boolean;
  date?: string; // "5.26" など
}

/**
 * "17途" "10開幕" "37秋" "24.5.26" "閉幕" "夏" を読む。年が省かれていれば ctx（直前の年）を使う。
 * 途・夏・秋（開始側）・日付付きは「シーズン途中」とみなす。
 */
function parsePoint(s: string, ctx: number | null, side: "from" | "to"): YearPoint | null {
  const m = s.match(/^(\d{2})?(?:\.(\d{1,2})\.(\d{1,2}))?(春|夏|秋)?(開幕|閉幕)?(途)?$/);
  if (!m || s === "") return null;
  const year = m[1] ? yy(m[1]) : ctx;
  if (year == null) return null;
  const season = m[4];
  const mid =
    Boolean(m[6]) || Boolean(m[2]) || season === "夏" ||
    (side === "from" && season === "秋") || (side === "to" && season === "春");
  return { year, mid, date: m[2] ? `${m[2]}.${m[3]}` : undefined };
}

/** 年の部分（"15～17途" "21" "10開幕～途" "51途～閉幕" "夏～38"）を範囲にする */
export function parseYears(s: string, ctx: number | null = null): { from: YearPoint; to: YearPoint } | null {
  if (!s) return null;
  if (s.includes("～")) {
    const [a, b] = s.split("～");
    const from = parsePoint(a, ctx, "from");
    if (!from) return null;
    const to = b === "" ? null : parsePoint(b, from.year, "to");
    if (!to) return null;
    return { from, to };
  }
  const p = parsePoint(s, ctx, "from");
  return p ? { from: p, to: { year: p.year, mid: false } } : null;
}

/**
 * 役割の印。兼任（兼コ・兼監 …）は「選手」と「指導者」の 2 つの所属に分ける（在籍年数を正しく数えるため）。
 * 準支（準支配下）・準登（準登録）は選手として扱い、印は note に残す。
 */
const ROLE_OF: Record<string, { roles: Stint["role"][]; note?: string }> = {
  "コ": { roles: ["coach"] },
  "育": { roles: ["ikusei"] },
  "監": { roles: ["manager"] },
  "兼コ": { roles: ["player", "coach"], note: "選手兼任" },
  "兼監": { roles: ["player", "manager"], note: "選手兼任" },
  "兼助監": { roles: ["player", "coach"], note: "選手兼任・助監督" },
  "兼代監": { roles: ["player", "acting_manager"], note: "選手兼任" },
  "兼総監": { roles: ["player", "manager"], note: "選手兼任・総監督" },
  "総監": { roles: ["manager"], note: "総監督" },
  "助監": { roles: ["coach"], note: "助監督" },
  "二監": { roles: ["coach"], note: "二軍監督" },
  "準支": { roles: ["player"], note: "準支配下" },
  "準登": { roles: ["player"], note: "準登録" },
};

export interface ParsedRegister {
  stints: Omit<Stint, "person">[];
  names: { name: string; from?: number; to?: number }[];
  errors: string[];
}

export function parseRegisterCell(cell: string): ParsedRegister {
  const errors: string[] = [];
  const stints: Omit<Stint, "person">[] = [];
  const names: { name: string; from?: number; to?: number }[] = [];

  const text = cell.replace(/\s+/g, " ").trim();
  // ［改名］［代監］の区切り
  const parts = text.split(/(?=［)/);
  const main = parts[0].trim().replace(/）\./g, "）,");
  const extras = parts.slice(1);

  let pending: { from: YearPoint; to: YearPoint }[] = [];
  let ctx: number | null = null;
  for (const raw of main.split(/[,・、]/)) {
    const tok = raw.trim();
    if (!tok) continue;
    const m = tok.match(/^([0-9～途開幕閉春夏秋.]*)(.*?)((?:（[^）]*）)*)$/);
    if (!m) {
      errors.push(`読めない: ${tok}`);
      continue;
    }
    const [, yearsPart, short, rolesPart] = m;
    const range = parseYears(yearsPart, ctx);
    if (!range) {
      errors.push(`年が読めない: ${tok}`);
      continue;
    }
    ctx = range.to.year;
    if (!short.trim()) {
      pending.push(range);
      continue;
    }
    const roleChars = [...rolesPart.matchAll(/（([^）]*)）/g)].map((x) => x[1]);
    let roles: Stint["role"][] = ["player"];
    let roleNote: string | undefined;
    for (const c of roleChars) {
      const r = ROLE_OF[c];
      if (r) {
        roles = r.roles;
        roleNote = r.note;
      } else errors.push(`不明な役割: （${c}） in ${tok}`);
    }
    for (const r of [...pending, range]) {
      const f = resolveShort(short.trim(), r.from.year) ?? resolveShort(short.trim(), r.to.year) ?? resolveShortAny(short.trim());
      if (!f) {
        errors.push(`不明な球団: ${short.trim()} (${r.from.year})`);
        continue;
      }
      const dateNote = [r.from.date && `${r.from.date}～`, r.to.date && `～${r.to.date}`].filter(Boolean).join("");
      const note = [roleNote, dateNote].filter(Boolean).join("・");
      for (const role of roles) {
        stints.push({
          franchise: f.id,
          short: short.trim(),
          from: r.from.year,
          to: r.to.year,
          role,
          ...(r.from.mid ? { fromMid: true } : {}),
          ...(r.to.mid ? { toMid: true } : {}),
          ...(note ? { note } : {}),
          src: "register",
        });
      }
    }
    pending = [];
  }
  if (pending.length) errors.push(`球団の付かない年が残った: ${main}`);

  for (const ex of extras) {
    if (ex.startsWith("［改名］")) {
      let pendingNames: { from?: number; to?: number }[] = [];
      for (const raw of ex.slice("［改名］".length).split(",")) {
        const tok = raw.trim();
        const m = tok.match(/^([0-9～.]*)(.*)$/);
        if (!m) continue;
        const ys = m[1];
        const nm = m[2].trim();
        const range: { from?: number; to?: number } = {};
        if (ys.includes("～")) {
          const [a, b] = ys.split("～");
          if (/^\d{2}/.test(a)) range.from = yy(a.slice(0, 2));
          if (/^\d{2}/.test(b)) range.to = yy(b.slice(0, 2));
        } else if (/^\d{2}/.test(ys)) {
          range.from = range.to = yy(ys.slice(0, 2));
        }
        if (!nm) {
          pendingNames.push(range);
          continue;
        }
        for (const r of [...pendingNames, range]) names.push({ name: nm, ...r });
        pendingNames = [];
      }
    } else if (ex.startsWith("［代監］")) {
      // 例: "16.4.22,8.9～閉幕 中日"  "66.6.7～6.22,7.27～9.7,9.11～閉幕,72.9.24～閉幕 大洋"  "02.4.3～4.4"
      // 球団名は最後の要素にだけ付くことがある（前の要素にも掛かる）。年のない "8.9" は直前の年。
      // 球団名がどこにも無ければ、その年にコーチ・監督として在籍した球団を使う。
      const entries: { year: number; note: string; short: string | null }[] = [];
      let year: number | null = null;
      for (const raw of ex.slice("［代監］".length).split(",")) {
        const tok = raw.replace(/（[^）]*）/g, "").trim();
        if (!tok) continue;
        const m = tok.match(/^([\d.]+)(?:～([\d.]+|閉幕|開幕))?\s*(.*)$/);
        if (!m) {
          errors.push(`代監が読めない: ${tok}`);
          continue;
        }
        const parts = m[1].split(".");
        if (parts.length === 3 || parts.length === 1) year = yy(parts[0]);
        if (year == null) {
          errors.push(`代監の年が不明: ${tok}`);
          continue;
        }
        entries.push({ year, note: `${m[1]}${m[2] ? "～" + m[2] : ""}`, short: m[3].trim() || null });
      }
      let carry: string | null = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].short) carry = entries[i].short;
        else entries[i].short = carry;
      }
      for (const e of entries) {
        let fid: string | null = null;
        let short = e.short;
        if (short) fid = resolveShort(short, e.year)?.id ?? resolveShortAny(short)?.id ?? null;
        if (!fid) {
          const host = stints.find((x) => (x.role === "coach" || x.role === "manager") && e.year >= x.from && e.year <= x.to);
          if (host) {
            fid = host.franchise;
            short = host.short;
          }
        }
        if (!fid || !short) {
          errors.push(`代監の球団が不明: ${e.short ?? ""} (${e.year})`);
          continue;
        }
        stints.push({ franchise: fid, short, from: e.year, to: e.year, role: "acting_manager", note: e.note, src: "register" });
      }
    } else {
      errors.push(`不明な補足: ${ex}`);
    }
  }
  return { stints, names, errors };
}
