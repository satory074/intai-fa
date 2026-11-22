/**
 * データの形（サイトのビルドと scripts/ の両方が使う唯一の定義）。
 *
 * 正本は「出来事の列」(events)。年別・球団別・人物別のページはビルド時にここから作る。
 * 1 選手 1 年 1 行の表にしないのは、同じ年に「戦力外 → 他球団と契約」「FA 宣言 → 残留」
 * 「引退 → コーチ就任」のように複数の出来事が起きるため。
 */
import { z } from "zod";

// ---------- 球団 ----------

export const eraSchema = z.object({
  /** 在籍者名簿の表記（巨人・南海・大毎 …） */
  short: z.string().min(1),
  from: z.number().int().min(1936),
  to: z.number().int().optional(),
});

export const franchiseSchema = z.object({
  id: z.string().regex(/^[a-z]+$/),
  league: z.enum(["central", "pacific"]).optional(),
  /** 現行球団の正式名（NPB 公示の表記） */
  full: z.string().optional(),
  /** NPB 公示 URL の球団コード（registered_g.html の g） */
  urlCode: z.string().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  colorDark: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  eras: z.array(eraSchema).min(1),
});
export type Franchise = z.infer<typeof franchiseSchema>;

export const teamsFileSchema = z.object({ franchises: z.array(franchiseSchema) });

// ---------- 人物 ----------

export const personSchema = z.object({
  /** NPB 選手 ID（8 桁）があればそれ。無い人は "x" + 8 桁の16進（名前と最初の在籍から作る安定 ID） */
  id: z.string().regex(/^(\d{8}|x[0-9a-f]{8})$/),
  /** NPB 選手ページの ID。無い人（1 軍未出場の OB、選手経験のない監督など）は省略 */
  npbId: z.string().regex(/^\d{8}$/).optional(),
  /** 現在（最新）の登録名。姓と名の間は全角スペース（NPB の表記どおり） */
  name: z.string().min(1),
  /** 改名の履歴（名簿の［改名］）。古い順 */
  names: z
    .array(z.object({ name: z.string(), from: z.number().int().optional(), to: z.number().int().optional() }))
    .optional(),
  /** 名簿の五十音ページ（あ・か・さ …）。並べ替えと索引に使う */
  kanaRow: z.string().optional(),
  /** 生年月日（NPB 選手ページから。無ければ省略） */
  birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** 投打（例: 右投右打） */
  throwsBats: z.string().optional(),
});
export type Person = z.infer<typeof personSchema>;

// ---------- 所属（年×球団） ----------

export const ROLES = ["player", "ikusei", "coach", "manager", "acting_manager"] as const;
export const stintSchema = z.object({
  person: z.string(),
  franchise: z.string(),
  /** その時期の球団表記（名簿どおり） */
  short: z.string(),
  from: z.number().int(),
  to: z.number().int(),
  role: z.enum(ROLES),
  /** シーズン途中に加入／離脱した（名簿の「途」） */
  fromMid: z.boolean().optional(),
  toMid: z.boolean().optional(),
  /** 名簿の補足（「60.7.12～閉幕」など） */
  note: z.string().optional(),
  /** 出典の種類。削除依頼が来たら register 由来だけを外せるようにする */
  src: z.enum(["register", "manual"]),
});
export type Stint = z.infer<typeof stintSchema>;

// ---------- 出来事 ----------

export const EVENT_TYPES = [
  // 引退
  "retire", //               引退（球団発表・本人表明）
  "voluntary_retired", //    任意引退の公示（NPB）
  // 戦力外・自由契約・退団
  "release", //              戦力外通告・自由契約（ウエイバー不請求・保留されない選手 など）
  "departure", //            名簿から機械的にわかる退団（理由は未調査）
  // その後（戦力外・自由契約のあと）
  "sign", //                 他球団（NPB）と契約
  "ikusei_recontract", //    育成で再契約
  "sign_outside", //         NPB 外（独立リーグ・社会人・海外）と契約
  // FA
  "fa_declare", //           FA 宣言
  "fa_move", //              FA で移籍（契約締結合意）
  "fa_stay", //              宣言残留
  "fa_compensation", //      FA の補償（人的・金銭・指名権）
  // 移籍
  "trade",
  "active_draft", //         現役ドラフト
  "posting", //              ポスティング
  // 監督・コーチ
  "manager_in",
  "manager_out",
  "coach_in",
  "coach_out",
  "coach_change", //         同じ球団内の配置転換
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SOURCE_KINDS = ["npb", "club", "press", "wikipedia", "register"] as const;
export const sourceSchema = z.object({
  url: z.string().url(),
  kind: z.enum(SOURCE_KINDS),
  /** 媒体名・ページ名（「NPB 公示 自由契約選手」「読売ジャイアンツ公式」など） */
  title: z.string().optional(),
  /** 分類の根拠になる語句を、出典の文からそのまま抜き出したもの（自動取得・未確認の行で必須） */
  quote: z.string().optional(),
  fetched: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type Source = z.infer<typeof sourceSchema>;

export const OUTSIDE_KINDS = ["independent", "industrial", "overseas", "other"] as const;

export const eventSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** NPB 年度。オフの出来事は直前シーズンの年度（2026 年 1 月の FA 契約 → 2025） */
  season: z.number().int().min(1936),
  /** 発表日（ISO）。わからなければ省略 */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** 日付が推定 */
  dateApprox: z.boolean().optional(),
  type: z.enum(EVENT_TYPES),
  person: z.string(),
  /** 出来事の時点で所属していた（＝出ていく側の）球団 */
  team: z.string().optional(),
  /** 移籍・契約先の球団（NPB） */
  toTeam: z.string().optional(),
  /** NPB 外の契約先 */
  toOrg: z.object({ name: z.string(), kind: z.enum(OUTSIDE_KINDS) }).optional(),
  /** ポジション（投手・捕手・内野手・外野手） */
  pos: z.string().optional(),
  /** 役職（コーチ人事）。配置転換は fromRole → role */
  role: z.string().optional(),
  fromRole: z.string().optional(),
  /** 公示の備考（「ウエイバー不請求」「保留されない選手」「国内 FA」など） */
  note: z.string().optional(),
  /** 引退か戦力外か等の理由が未調査（古い年の departure、分類前の自由契約） */
  unresearched: z.boolean().optional(),
  /** 育成選手としての出来事 */
  ikusei: z.boolean().optional(),
  /**
   * npb_official: NPB 公示から機械的に取り込んだ（確定）
   * register:     在籍者名簿から機械的に導いた（理由は未調査）
   * verified:     人が出典と照合した
   * auto_unverified: Claude Code の下書き（「自動取得・未確認」と表示。CI の機械チェックを通ったものだけ公開）
   */
  status: z.enum(["npb_official", "register", "verified", "auto_unverified"]),
  /** 取り込みで初めて見つけた日（新着の並びに使う。発表日ではない） */
  seen: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sources: z.array(sourceSchema).min(1),
});
export type IntaiEvent = z.infer<typeof eventSchema>;

export const eventsFileSchema = z.array(eventSchema);

// ---------- 訂正履歴 ----------

export const correctionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** 対象の出来事 id または人物 id */
  target: z.string(),
  summary: z.string().min(1),
});
export const correctionsFileSchema = z.array(correctionSchema);
