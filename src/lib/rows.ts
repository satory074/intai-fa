/**
 * 年別・球団×年ページの「行」を出来事から組み立てる。
 *
 * 同じ人の同じ年度の出来事は、意味のまとまりで 1 行にする:
 *   - 引退（球団発表・任意引退公示）があれば「引退」の行に。同じ年度の自由契約公示は根拠として畳む
 *   - 自由契約は「戦力外・自由契約」の行。その後（他球団と契約・育成で再契約・NPB 外・コーチ就任）を同じ行に
 *   - FA 宣言は結末（移籍・残留）と同じ行に
 *   - トレード・現役ドラフト・人的補償・ポスティングは 1 件 1 行
 *   - 監督・コーチは 1 件 1 行（配置転換は折りたたむ）
 *   - 名簿から導いた退団（理由未調査）は「退団（理由未調査）」に
 */
import { ageAt, dataset, playerYearsUpTo } from "./data";
import type { IntaiEvent, Person, Source } from "./schema";
import { franchises, shortOf } from "./teams";

export const SECTIONS = [
  { key: "retire", title: "引退" },
  { key: "release", title: "戦力外・自由契約" },
  { key: "fa", title: "FA" },
  { key: "move", title: "トレード・現役ドラフト" },
  { key: "staff", title: "監督・コーチ" },
  { key: "departure", title: "退団（理由未調査）" },
] as const;
export type SectionKey = (typeof SECTIONS)[number]["key"];

export type RowStatus = IntaiEvent["status"];

export interface Row {
  key: string;
  section: SectionKey;
  season: number;
  date?: string;
  personId: string;
  person: Person;
  team?: string;
  toTeam?: string;
  pos?: string;
  /** 区分の表示（「引退」「保留されない選手」「国内FA」「トレード」「二軍投手コーチ」…） */
  label: string;
  /** その後・結末 */
  outcome?: string;
  outcomeTeam?: string;
  age: number | null;
  years: number;
  ikusei: boolean;
  status: RowStatus;
  unresearched: boolean;
  sources: Source[];
  /** 折りたたむ行（配置転換） */
  minor: boolean;
  /** 新着の基準日（取り込み日 or 発表日） */
  fresh?: string;
}

const STATUS_RANK: Record<RowStatus, number> = { verified: 3, npb_official: 2, auto_unverified: 1, register: 0 };
const bestStatus = (evs: IntaiEvent[]): RowStatus =>
  evs.map((e) => e.status).sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ?? "register";

/** その後の根拠の出来事の出典も、行の出典に並べる（育成かどうか・日付は行の出来事のまま） */
function withOutcomeSource(evs: IntaiEvent[], out: { event?: IntaiEvent } | null): { sources?: Source[] } {
  return out?.event ? { sources: uniqSources([...evs, out.event]) } : {};
}

function uniqSources(evs: IntaiEvent[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const e of evs)
    for (const s of e.sources) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      out.push(s);
    }
  // 球団発表・NPB 公示を先に
  const order = { club: 0, npb: 1, press: 2, wikipedia: 3, register: 4 } as const;
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

const teamOrder = new Map(franchises().map((f, i) => [f.id, i]));

export function teamName(id: string | undefined, season: number): string {
  return id ? shortOf(id, season) : "";
}

function staffLabel(e: IntaiEvent): string {
  switch (e.type) {
    case "manager_in":
      return e.role && e.role !== "監督" ? `${e.role}（監督）` : "監督就任";
    case "manager_out":
      return "監督退任";
    case "coach_in":
      return e.role ? `${e.role}に就任` : "コーチ就任";
    case "coach_out":
      return e.role ? `${e.role}を退任` : "コーチ退任";
    case "coach_change":
      return `${e.fromRole ?? ""} → ${e.role ?? ""}`;
    default:
      return "";
  }
}

const MOVE_LABEL: Partial<Record<IntaiEvent["type"], string>> = {
  trade: "トレード",
  active_draft: "現役ドラフト",
  fa_compensation: "FA の人的補償",
  posting: "ポスティング",
  sign: "契約",
  sign_outside: "NPB 外と契約",
};

type Outcome = { text: string; team?: string; event?: IntaiEvent };

/** その後（他球団と契約・育成再契約・コーチ就任など）。event は根拠の出来事（出典と状態を行に足すため） */
function outcomeOf(after: IntaiEvent[], season: number): Outcome | null {
  const e = after.find((x) => ["sign", "ikusei_recontract", "sign_outside", "coach_in", "manager_in", "retire", "voluntary_retired"].includes(x.type));
  if (!e) return null;
  const o = outcomeText(e, season);
  return o ? { ...o, event: e } : null;
}

function outcomeText(e: IntaiEvent, season: number): Outcome | null {
  switch (e.type) {
    case "ikusei_recontract":
      return { text: "育成で再契約" };
    case "sign":
      return e.toTeam === e.team
        ? { text: e.note ?? "再契約", team: e.toTeam }
        : { text: `${teamName(e.toTeam, season + 1)}と${e.ikusei ? "育成" : ""}契約`, team: e.toTeam };
    case "sign_outside":
      return { text: e.toOrg ? `${e.toOrg.name}と契約` : "NPB 外と契約" };
    case "coach_in":
    case "manager_in":
      return { text: `${teamName(e.team, season + 1)} ${e.role ?? (e.type === "manager_in" ? "監督" : "コーチ")}`, team: e.team };
    case "retire":
    case "voluntary_retired":
      return { text: "引退" };
  }
  return null;
}

/** 名簿から、翌年に別の球団で選手として在籍したか */
function nextFromRegister(personId: string, team: string | undefined, season: number): Outcome | null {
  const st = dataset().stintsByPerson.get(personId) ?? [];
  const next = st.find((s) => (s.role === "player" || s.role === "ikusei") && s.from === season + 1 && s.franchise !== team);
  if (next) return { text: `${next.short}と契約（名簿）`, team: next.franchise };
  const coach = st.find((s) => (s.role === "coach" || s.role === "manager") && s.from === season + 1);
  if (coach) return { text: `${coach.short} ${coach.role === "manager" ? "監督" : "コーチ"}（名簿）`, team: coach.franchise };
  return null;
}

const rowCache = new Map<number, Row[]>();

/** 年度の行（ビルド中は年度ごとに 1 回だけ組み立てる） */
export function rowsForSeason(season: number): Row[] {
  let rows = rowCache.get(season);
  if (!rows) {
    rows = buildRows(season);
    rowCache.set(season, rows);
  }
  return rows;
}

function buildRows(season: number): Row[] {
  const ds = dataset();
  const evs = ds.eventsBySeason.get(season) ?? [];
  const nextEvs = ds.eventsBySeason.get(season + 1) ?? [];
  const byPerson = new Map<string, IntaiEvent[]>();
  for (const e of evs) byPerson.set(e.person, [...(byPerson.get(e.person) ?? []), e]);

  const rows: Row[] = [];
  for (const [pid, list] of byPerson) {
    const person = ds.people.get(pid);
    if (!person) continue;
    const stints = ds.stintsByPerson.get(pid);
    const later = [...list, ...nextEvs.filter((e) => e.person === pid)];
    const base = (e: IntaiEvent, extra: IntaiEvent[] = []) => {
      const all = [e, ...extra];
      return {
        season,
        personId: pid,
        person,
        team: e.team,
        toTeam: e.toTeam,
        pos: all.find((x) => x.pos)?.pos,
        age: ageAt(person.birth, e.date, season),
        years: playerYearsUpTo(stints, season),
        ikusei: all.some((x) => x.ikusei),
        status: bestStatus(all),
        sources: uniqSources(all),
        fresh: all.map((x) => x.seen ?? x.date).filter(Boolean).sort().pop(),
        date: all.map((x) => x.date).filter(Boolean).sort()[0],
      };
    };

    const retires = list.filter((e) => e.type === "retire" || e.type === "voluntary_retired");
    const releases = list.filter((e) => e.type === "release");
    if (retires.length) {
      const primary = retires.find((e) => e.type === "retire") ?? retires[0];
      const out = outcomeOf(later.filter((e) => ["coach_in", "manager_in"].includes(e.type)), season);
      const others = [...retires.filter((e) => e !== primary), ...releases];
      rows.push({
        ...base(primary, others),
        ...withOutcomeSource([primary, ...others], out),
        key: `retire-${pid}`,
        section: "retire",
        // 引退と分類した根拠の出来事の状態を出す（未確認の下書きなら「自動取得・未確認」）。その後が下書きならそれも
        status: out?.event?.status === "auto_unverified" ? "auto_unverified" : primary.status,
        label: primary.type === "retire" ? "引退" : "任意引退",
        outcome: out?.text,
        outcomeTeam: out?.team,
        unresearched: false,
        minor: false,
      });
    } else if (releases.length) {
      const primary = releases.find((e) => e.status !== "npb_official") ?? releases[0];
      const relDate = releases.map((e) => e.date).filter(Boolean).sort()[0] ?? "";
      const out =
        outcomeOf(later.filter((e) => !e.date || !relDate || e.date >= relDate), season) ?? nextFromRegister(pid, primary.team, season);
      // その後（他球団と契約・育成で再契約・コーチ就任など）がわかっていれば、引退か戦力外かの区別はついている
      const unresearched = releases.every((e) => e.unresearched) && !out;
      const notes = [...new Set(releases.map((e) => e.note).filter(Boolean))];
      rows.push({
        ...base(primary, releases.filter((e) => e !== primary)),
        ...withOutcomeSource(releases, out),
        key: `release-${pid}`,
        section: "release",
        // 理由（戦力外通告など）を付けた出来事か、その後の出来事が下書きなら、その状態を出す
        status:
          out?.event?.status === "auto_unverified" ? "auto_unverified" : primary.status === "npb_official" ? bestStatus(releases) : primary.status,
        label: primary.status !== "npb_official" && primary.note ? primary.note : notes.join("・") || "自由契約",
        outcome: out?.text,
        outcomeTeam: out?.team,
        unresearched,
        minor: false,
      });
    }

    const declares = list.filter((e) => e.type === "fa_declare");
    for (const d of declares) {
      const result = list.find((e) => e.type === "fa_move" || e.type === "fa_stay");
      rows.push({
        ...base(d, result ? [result] : []),
        key: `fa-${pid}`,
        section: "fa",
        label: d.note ?? "FA宣言",
        outcome: result ? (result.type === "fa_stay" ? "残留" : `${result.toOrg?.name ?? teamName(result.toTeam, season)}へ移籍`) : undefined,
        outcomeTeam: result?.toTeam,
        toTeam: result?.type === "fa_move" ? result.toTeam : undefined,
        date: result?.date,
        unresearched: false,
        minor: false,
      });
    }
    for (const e of list.filter((x) => (x.type === "fa_move" || x.type === "fa_stay") && !declares.length)) {
      rows.push({
        ...base(e),
        key: `fa-${e.id}`,
        section: "fa",
        label: "FA",
        outcome: e.type === "fa_stay" ? "残留" : `${e.toOrg?.name ?? teamName(e.toTeam, season)}へ移籍`,
        unresearched: false,
        minor: false,
      });
    }

    for (const e of list.filter((x) => ["trade", "active_draft", "fa_compensation", "posting"].includes(x.type))) {
      rows.push({
        ...base(e),
        key: `move-${e.id}`,
        section: "move",
        label: MOVE_LABEL[e.type] ?? e.type,
        outcome: e.toTeam ? `${teamName(e.toTeam, season)}へ` : e.toOrg?.name,
        outcomeTeam: e.toTeam,
        unresearched: false,
        minor: false,
      });
    }
    // 自由契約に紐づかない契約（NPB 外との契約など）
    if (!releases.length && !retires.length) {
      for (const e of list.filter((x) => x.type === "sign" || x.type === "sign_outside")) {
        rows.push({
          ...base(e),
          key: `move-${e.id}`,
          section: "move",
          label: MOVE_LABEL[e.type] ?? "契約",
          outcome: e.toOrg?.name ?? (e.toTeam ? `${teamName(e.toTeam, season)}へ` : undefined),
          outcomeTeam: e.toTeam,
          unresearched: false,
          minor: false,
        });
      }
    }

    for (const e of list.filter((x) => /^(manager|coach)_/.test(x.type))) {
      rows.push({
        ...base(e),
        key: `staff-${e.id}`,
        section: "staff",
        label: staffLabel(e),
        unresearched: false,
        minor: e.type === "coach_change",
      });
    }

    if (!retires.length && !releases.length) {
      for (const e of list.filter((x) => x.type === "departure")) {
        const out = e.toTeam
          ? { text: `${teamName(e.toTeam, e.note === "シーズン途中" ? season : season + 1)}へ`, team: e.toTeam }
          : nextFromRegister(pid, e.team, season);
        rows.push({
          ...base(e),
          key: `dep-${e.id}`,
          section: "departure",
          label: e.note ?? "退団",
          outcome: out?.text,
          outcomeTeam: out?.team,
          unresearched: true,
          minor: false,
        });
      }
    }
  }

  return rows.sort(
    (a, b) =>
      (a.date ?? "9999").localeCompare(b.date ?? "9999") ||
      (teamOrder.get(a.team ?? "") ?? 99) - (teamOrder.get(b.team ?? "") ?? 99) ||
      a.person.name.localeCompare(b.person.name, "ja"),
  );
}

export function rowsForTeamSeason(team: string, season: number): Row[] {
  return rowsForSeason(season).filter((r) => r.team === team || r.toTeam === team || r.outcomeTeam === team);
}

/** 収録状況: 引退・戦力外・退団の行のうち、理由まで調べてある割合 */
export function coverage(rows: Row[]): { total: number; researched: number; pct: number } {
  const target = rows.filter((r) => r.section === "retire" || r.section === "release" || r.section === "departure");
  const researched = target.filter((r) => !r.unresearched).length;
  return { total: target.length, researched, pct: target.length ? Math.round((researched / target.length) * 100) : 100 };
}
