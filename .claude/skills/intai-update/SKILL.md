---
name: intai-update
description: プロ野球去就アーカイブ（intai-fa）の更新コマンド。NPB 公示を取り込み、理由未調査の自由契約・その後が未定の選手・オフの監督コーチ人事について、球団の公式発表を読んで出典付きの下書きを data/events/manual/ に書き、チェックしてコミットする。「去就を更新して」「/intai-update」「2024年オフを埋めて」で使う。
---

# 更新コマンド（intai-update）

時間があるときに実行する（Q23・Q26）。下書きは「自動取得・未確認」として公開される（Q24・Q25）ので、
**出典にない事実を 1 つも書かないこと**が最優先。迷ったら書かない（「理由未調査」「未定」のままでよい）。

## 手順

1. 取り込み（AI は使わない）
   ```bash
   nvm use            # .nvmrc（Node 22.23 以上。Astro 7 の要件）
   npm run import:npb             # 前年度と今年度
   npm run import:profiles -- --seasons <今年度>   # 新しく出てきた人の生年月日（年齢の表示用）
   ```
   名簿（npm run import:register）は年 1 回、npb.jp/history/register/ の「YYYY年シーズン終了時」が更新されたときだけ。
   取り込みの最後に「名前で名簿から引けず飛ばした選手」が出たら、名簿（在籍球団・年が合うこと）で本人を確かめて
   `data/name-aliases.yaml` に 1 行足し、もう一度取り込む。監督・コーチの登録名が名簿と違う人も同じ
   （people-extra に名簿の人と同じ名前の人が増えていたら、それが目印）。

2. 対象を出す
   ```bash
   npm run todo                       # 最新 2 年度
   npm run todo -- --seasons 2024 --json
   ```
   - 「理由未調査」: 引退・戦力外・退団のどれかを球団発表で確かめる
   - 「その後が未定」: 他球団・独立リーグ・社会人・海外の所属先を確かめる（Q13）
   - オフの監督・コーチ人事（翌年度の NPB 公示が出るまでは球団発表から）

3. 球団の公式サイトの発表を読み、下書きを `data/events/manual/<年度>.yaml` に追記する
   - 球団公式（`src/lib/gate.ts` の CLUB_DOMAINS にある各球団のドメイン）を最優先。kind: club
   - **今年・昨年の分は球団発表か NPB 公示だけ**（Q8）。「引退へ」「意向」のような報道段階の記事は使わない
   - 過去の年度（球団発表が残っていない）に限り、確定した事実を伝える報道記事（kind: press）と Wikipedia（kind: wikipedia）を使ってよい（Q29）。文章は写さず、事実だけ
   - `quote` には出典の文を**そのまま**抜き出す（名前と、分類の根拠の語句「引退」「来季の契約を結ばない」「育成契約」「就任」などを含む 1〜2 文）。要約・言い換えはしない
   - 推測で埋めない（「40 歳だから引退」などは不可）。出典 URL のない下書きは作らない
   - 写真・記事本文・見出しを保存しない

4. チェックとビルド
   ```bash
   npm run check:urls   # 下書きの出典 URL を開いて data/url-status.json に記録（開けない URL の行は公開されない）
   npm run check        # 不変条件。「公開を保留している出来事」に出たものは理由を読んで直す
   npm run build && npm run seo
   ```

5. コミット（push は本人に確かめてから。push ＝ 本番反映）

## 下書きの書き方（data/events/manual/2026.yaml）

```yaml
- id: d-2026-retire-51655117          # d-<年度>-<区分>-<人物ID>（重複しないこと）
  season: 2026                         # NPB 年度（オフの出来事は直前シーズン）
  date: "2026-10-01"                   # 球団の発表日
  type: retire                         # retire / release / sign / ikusei_recontract / sign_outside / coach_in / coach_out / manager_in / manager_out / coach_change
  person: "51655117"                   # data/people.jsonl・people-extra.jsonl の id
  team: giants                         # data/teams.yaml の id
  status: auto_unverified              # 下書きは必ずこれ。本人が npm run edit で確認すると verified になる
  sources:
    - url: https://www.giants.jp/news/...
      kind: club
      title: 読売ジャイアンツ公式「○○選手 現役引退のお知らせ」
      quote: ○○選手が今季限りで現役を引退することになりましたのでお知らせします。
      fetched: "2026-11-22"
```

- 戦力外: `type: release`、`note: 戦力外通告`（球団の書き方が「来季の契約を結ばない」なら `note: 来季契約を結ばない`）
- 引退して同じ球団のコーチになる: `retire` と `coach_in`（role: 二軍打撃コーチ など）を別の行で
- NPB 外: `type: sign_outside`、`toOrg: { name: 徳島インディゴソックス, kind: independent }`（industrial / overseas / other）
- 名簿にいない人（新人・新任の外国人コーチなど）は先に `data/people-extra.jsonl` に足す

## 公開の条件（src/lib/gate.ts。満たさない行はビルドから外れる）

- 抜粋に本人の名前と、区分ごとの根拠の語句がある
- 球団名が抜粋にあるか、出典がその球団の公式サイトか NPB
- 出典 URL が開ける（`npm run check:urls` の記録が 2xx）
- 日付が未来でなく、年度の範囲内

## 確認（本人）

`npm run edit` → http://127.0.0.1:4330/ で、出典の抜粋と下書きを並べて見て「確認済みにする」か「取り消す」。
直した誤りは `data/corrections.yaml` に 1 行足す（訂正履歴ページに出る）。
