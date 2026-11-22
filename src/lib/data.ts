/**
 * ビルド時にデータを読み、検証し、引きやすい形にする（1 回だけ読んでキャッシュ）。
 *
 * 出来事は 3 つの出どころを合わせる:
 *   1. data/events/npb/YYYY.json     NPB 公示から機械的に取り込んだもの（npb_official）
 *   2. data/events/manual/YYYY.yaml  Claude Code の下書き・人が確かめたもの（auto_unverified / verified）
 *   3. 名簿（stints）から導いた入退団（register、理由は未調査）。公示・手入力で同じ人の同じ年度が
 *      埋まっていれば出さない。
 *
 * 公開の条件（Q25）: auto_unverified は gate.ts の機械チェックを通ったものだけ。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  correctionsFileSchema,
  eventsFileSchema,
  personSchema,
  stintSchema,
  type IntaiEvent,
  type Person,
  type Stint,
} from "./schema";
import { gateEvent, loadUrlStatus } from "./gate";

const root = process.cwd();
const dataDir = join(root, "data");

function readJsonl<T>(file: string, parseLine: (x: unknown) => T): T[] {
  const p = join(dataDir, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l, i) => {
      try {
        return parseLine(JSON.parse(l));
      } catch (e) {
        throw new Error(`${file}:${i + 1}: ${(e as Error).message}`);
      }
    });
}

export interface Dataset {
  people: Map<string, Person>;
  stintsByPerson: Map<string, Stint[]>;
  events: IntaiEvent[];
  eventsBySeason: Map<number, IntaiEvent[]>;
  eventsByPerson: Map<string, IntaiEvent[]>;
  /** 公開しない出来事と理由（check の報告用） */
  held: { event: IntaiEvent; reasons: string[] }[];
  seasons: number[];
  registerAsOf: number;
  corrections: { date: string; target: string; summary: string }[];
  /** データの最終更新日（出来事の seen / date の最大） */
  updated: string;
}

let cache: Dataset | null = null;

export function dataset(): Dataset {
  if (cache) return cache;

  const people = new Map<string, Person>();
  for (const p of [...readJsonl("people.jsonl", (x) => personSchema.parse(x)), ...readJsonl("people-extra.jsonl", (x) => personSchema.parse(x))]) {
    const old = people.get(p.id);
    people.set(p.id, old ? { ...p, ...old, names: old.names ?? p.names } : p);
  }
  const birthPath = join(dataDir, "profiles.jsonl");
  if (existsSync(birthPath)) {
    for (const prof of readJsonl("profiles.jsonl", (x) => x as { id: string; birth?: string; throwsBats?: string })) {
      const p = people.get(prof.id);
      if (p) people.set(p.id, { ...p, ...(prof.birth ? { birth: prof.birth } : {}), ...(prof.throwsBats ? { throwsBats: prof.throwsBats } : {}) });
    }
  }

  const stints = readJsonl("stints.jsonl", (x) => stintSchema.parse(x));
  const stintsByPerson = new Map<string, Stint[]>();
  for (const s of stints) stintsByPerson.set(s.person, [...(stintsByPerson.get(s.person) ?? []), s]);
  for (const list of stintsByPerson.values()) list.sort((a, b) => a.from - b.from || (a.fromMid ? 1 : 0) - (b.fromMid ? 1 : 0));

  const meta = existsSync(join(dataDir, "register-meta.json"))
    ? (JSON.parse(readFileSync(join(dataDir, "register-meta.json"), "utf-8")) as { asOf: number })
    : { asOf: 2025 };

  // 1. NPB 公示
  const npb: IntaiEvent[] = [];
  const npbDir = join(dataDir, "events", "npb");
  if (existsSync(npbDir)) {
    for (const f of readdirSync(npbDir).filter((f) => f.endsWith(".json")).sort()) {
      npb.push(...eventsFileSchema.parse(JSON.parse(readFileSync(join(npbDir, f), "utf-8"))));
    }
  }
  // 2. 手入力・下書き
  const manual: IntaiEvent[] = [];
  const manualDir = join(dataDir, "events", "manual");
  if (existsSync(manualDir)) {
    for (const f of readdirSync(manualDir).filter((f) => f.endsWith(".yaml")).sort()) {
      const raw = parse(readFileSync(join(manualDir, f), "utf-8")) ?? [];
      try {
        manual.push(...eventsFileSchema.parse(raw));
      } catch (e) {
        throw new Error(`events/manual/${f}: ${(e as Error).message}`);
      }
    }
  }

  // 公開の条件
  const urlStatus = loadUrlStatus();
  const held: Dataset["held"] = [];
  const publishable = [...npb, ...manual].filter((e) => {
    const reasons = gateEvent(e, people, urlStatus);
    if (reasons.length) held.push({ event: e, reasons });
    return reasons.length === 0;
  });

  // 3. 名簿から導く入退団
  const covered = new Set(publishable.map((e) => `${e.person}|${e.season}`));
  const npbStaffSeasons = new Set(
    publishable.filter((e) => e.status === "npb_official" && /^(coach|manager)_/.test(e.type)).map((e) => `${e.team}|${e.season}`),
  );
  const derived = deriveFromRegister(stintsByPerson, meta.asOf, covered, npbStaffSeasons);

  const events = [...publishable, ...derived];
  const eventsBySeason = new Map<number, IntaiEvent[]>();
  const eventsByPerson = new Map<string, IntaiEvent[]>();
  for (const e of events) {
    eventsBySeason.set(e.season, [...(eventsBySeason.get(e.season) ?? []), e]);
    eventsByPerson.set(e.person, [...(eventsByPerson.get(e.person) ?? []), e]);
  }
  for (const list of eventsByPerson.values()) list.sort(byTime);
  for (const list of eventsBySeason.values()) list.sort(byTime);

  const corrPath = join(dataDir, "corrections.yaml");
  const corrections = existsSync(corrPath) ? correctionsFileSchema.parse(parse(readFileSync(corrPath, "utf-8")) ?? []) : [];

  const updated = events.reduce((m, e) => {
    const d = e.seen ?? e.date ?? "";
    return d > m ? d : m;
  }, "");

  cache = {
    people,
    stintsByPerson,
    events,
    eventsBySeason,
    eventsByPerson,
    held,
    seasons: [...eventsBySeason.keys()].sort((a, b) => b - a),
    registerAsOf: meta.asOf,
    corrections: [...corrections].sort((a, b) => b.date.localeCompare(a.date)),
    updated,
  };
  return cache;
}

/** 時間順（年度 → 日付 → 種類の自然な順）。日付のないものは年度の終わり扱い */
const TYPE_ORDER = [
  "manager_out", "coach_out", "release", "departure", "retire", "voluntary_retired", "fa_declare",
  "trade", "active_draft", "posting", "fa_move", "fa_stay", "fa_compensation", "sign", "ikusei_recontract",
  "sign_outside", "manager_in", "coach_in", "coach_change",
];
export function byTime(a: IntaiEvent, b: IntaiEvent): number {
  return (
    a.season - b.season ||
    (a.date ?? `${a.season + 1}-01-31`).localeCompare(b.date ?? `${b.season + 1}-01-31`) ||
    TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
  );
}

const PLAYER_ROLES = new Set(["player", "ikusei"]);
const STAFF_ROLES = new Set(["coach", "manager"]);

/**
 * 名簿から、年×球団の所属の切れ目を出来事にする（理由は未調査）。
 * - 選手: ある球団での最後の年 E の後に「退団」。翌年（または同じ年の途中）に別球団にいれば移籍先として付ける。
 * - 監督・コーチ: 在任の始まりと終わり。NPB 公示（2020 年度〜）で同じ球団・年度が埋まっていれば出さない。
 * - 名簿の最新年（asOf）は翌年のことがまだわからないので出さない（公示から取る）。
 */
function deriveFromRegister(
  stintsByPerson: Map<string, Stint[]>,
  asOf: number,
  covered: Set<string>,
  npbStaffSeasons: Set<string>,
): IntaiEvent[] {
  const out: IntaiEvent[] = [];
  const src = [{ url: "https://npb.jp/history/register/", kind: "register" as const, title: "NPB プロ野球在籍者名簿" }];

  for (const [person, list] of stintsByPerson) {
    // 選手としての在籍（年 → 系譜）
    const playerYears = new Map<number, { franchise: string; toMid: boolean; fromMid: boolean }[]>();
    for (const s of list.filter((s) => PLAYER_ROLES.has(s.role))) {
      for (let y = s.from; y <= s.to; y++) {
        playerYears.set(y, [
          ...(playerYears.get(y) ?? []),
          { franchise: s.franchise, toMid: y === s.to && Boolean(s.toMid), fromMid: y === s.from && Boolean(s.fromMid) },
        ]);
      }
    }
    const years = [...playerYears.keys()].sort((a, b) => a - b);
    for (const y of years) {
      for (const m of playerYears.get(y)!) {
        const stillNext = playerYears.get(y + 1)?.some((n) => n.franchise === m.franchise) ?? false;
        const midMove = m.toMid;
        if (stillNext && !midMove) continue;
        if (y >= asOf && !midMove) continue;
        // 同じ年の途中に別の球団へ、または翌年に別の球団へ
        const sameYearNext = playerYears.get(y)!.find((n) => n.franchise !== m.franchise && n.fromMid);
        const nextYear = playerYears.get(y + 1)?.find((n) => n.franchise !== m.franchise);
        const to = midMove ? sameYearNext?.franchise : nextYear?.franchise;
        if (stillNext && midMove && !sameYearNext) continue;
        if (covered.has(`${person}|${y}`)) continue;
        out.push({
          id: `reg-${y}-departure-${person}-${m.franchise}`,
          season: y,
          type: "departure",
          person,
          team: m.franchise,
          ...(to ? { toTeam: to } : {}),
          ...(midMove ? { note: "シーズン途中" } : {}),
          unresearched: true,
          status: "register",
          sources: src,
        });
      }
    }

    // 監督・コーチ（在任の切れ目）
    for (const s of list.filter((s) => STAFF_ROLES.has(s.role))) {
      const prevSame = list.some((o) => o !== s && o.franchise === s.franchise && STAFF_ROLES.has(o.role) && o.to === s.from - 1 && o.role === s.role);
      const nextSame = list.some((o) => o !== s && o.franchise === s.franchise && STAFF_ROLES.has(o.role) && o.from === s.to + 1 && o.role === s.role);
      const kind = s.role === "manager" ? "manager" : "coach";
      // 就任: 前年オフの人事として前年度に入れる（NPB 年度の扱いに合わせる）
      if (!prevSame && s.from > 1936 && !npbStaffSeasons.has(`${s.franchise}|${s.from - 1}`)) {
        out.push({
          id: `reg-${s.from - 1}-${kind}-in-${person}-${s.franchise}`,
          season: s.from - 1,
          type: `${kind}_in` as IntaiEvent["type"],
          person,
          team: s.franchise,
          ...(s.note ? { note: s.note } : {}),
          status: "register",
          sources: src,
        });
      }
      if (!nextSame && s.to < asOf && !npbStaffSeasons.has(`${s.franchise}|${s.to}`)) {
        out.push({
          id: `reg-${s.to}-${kind}-out-${person}-${s.franchise}`,
          season: s.to,
          type: `${kind}_out` as IntaiEvent["type"],
          person,
          team: s.franchise,
          ...(s.note ? { note: s.note } : {}),
          status: "register",
          sources: src,
        });
      }
    }
  }
  return out;
}

// ---------- 人物まわりの計算 ----------

/** その年度までのプロ（選手）在籍年数 */
export function playerYearsUpTo(stints: Stint[] | undefined, season: number): number {
  const ys = new Set<number>();
  for (const s of stints ?? []) {
    if (!PLAYER_ROLES.has(s.role)) continue;
    for (let y = s.from; y <= Math.min(s.to, season); y++) ys.add(y);
  }
  return ys.size;
}

/** 年齢（出来事の日付、なければその年度の 12 月 1 日時点の満年齢） */
export function ageAt(birth: string | undefined, date: string | undefined, season: number): number | null {
  if (!birth) return null;
  const ref = date ?? `${season}-12-01`;
  const [by, bm, bd] = birth.split("-").map(Number);
  const [ry, rm, rd] = ref.split("-").map(Number);
  return ry - by - (rm < bm || (rm === bm && rd < bd) ? 1 : 0);
}
