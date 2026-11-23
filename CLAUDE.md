# intai-fa — プロ野球去就アーカイブ

NPB の選手・監督・コーチの去就（引退・戦力外/自由契約・FA・トレード・現役ドラフト・指導者人事）を、
年度別・球団×年度・人物別に見せる静的サイト。公開先 https://satory074.github.io/intai-fa/ （GitHub Pages、未公開）。
設計の決定（grilling Q1〜Q33）は `/Users/satory074/.claude/plans/fa-grilling-serene-ocean-of-a8f9a176-474a-456b-b3ef-303369b4f695.md`。

## コマンド

Node は `.nvmrc`（22.23.5）。Astro 7.4.7 が Node 22.23.4 以上を要求する（7.4.6 以前は脆弱性あり）。
シェルの既定は 22.14.0 のままなので、このリポジトリでは `nvm use` か
`export PATH="$HOME/.nvm/versions/node/v22.23.5/bin:$PATH"` してから実行する。

```bash
npm ci
npm run import:npb            # NPB 公示（前年度と今年度）→ data/events/npb/YYYY.json, data/people-extra.jsonl, data/npb-id-links.json
npm run import:npb -- --years 2003,2004 --backfill   # 過去分の取り直し（増えた行を「新着」にしない）
npm run import:register       # 在籍者名簿（年 1 回）→ data/people.jsonl, data/stints.jsonl, data/register-meta.json
npm run import:profiles       # 生年月日・投打（出来事に出てくる人）→ data/profiles.jsonl
npm run todo                  # 下書きの対象（理由未調査・その後が未定・未確認）
npm run check                 # 不変条件（破ったら exit 1）。check:urls は下書きの出典 URL と、抜粋がページにあるかも確認
npm run build                 # astro build && pagefind（約 1.1 万ページ、10 秒前後）
npm run seo                   # basecamp/scripts/seo-check.mjs の写し（--require-backlink）
npm run edit                  # 確認用エディタ http://127.0.0.1:4330/（未確認の下書きを確認済みに）
```

更新の手順は `.claude/skills/intai-update/SKILL.md`（Claude Code が球団発表から下書きを書く）。

## データ（すべて Git 管理。Git の履歴が更新履歴）

- `data/teams.yaml` — 球団の系譜 21（現行 12 ＋消滅 9）。名簿の表記（short）と年で系譜を引く。現行 12 の色は basecamp と同じ値
- `data/people.jsonl` / `data/stints.jsonl` — 名簿由来（約 1 万人・約 1.9 万件）。`src: register` は削除依頼があれば丸ごと外せる
- `data/people-extra.jsonl` — 名簿にない人（今年の新人・新任コーチ）。どの出来事からも参照されない人は取り込みのたびに消える
- `data/npb-id-links.json` — 名簿でリンクの無かった人（x…）→ 公示の NPB 選手 ID。公示の取り込みが書き足す。
  これが無いと同じ人が「名簿の人」と「公示の人」に分かれる（check の 9 で検出）。リンク先が 404 の人（主に支配下にならなかった育成選手）が
  多いので、サイトで NPB 選手ページへのリンクを出すのは profiles.jsonl で生年月日が取れた人だけ（`src/lib/data.ts`）
- `data/name-aliases.yaml` — 公示の表記で名簿の人が引けないときだけの対応表（「李 承ヨプ」→「李 承燁」など。手で足す）
- `data/events/npb/YYYY.json` — **YYYY 年度のページから**取り込んだ出来事（2003〜。手で編集しない。中の season は別年度のこともある）
- `data/events/manual/YYYY.yaml` — Claude Code の下書き（auto_unverified）と確認済み（verified）
- `data/url-status.json` — 下書きの出典 URL の確認結果（check:urls が書く）
- `data/corrections.yaml` — 訂正履歴

## しくみ

- 正本は「出来事の列」。年別・人物のページは `src/lib/rows.ts` がビルド時に組み立てる（同じ人の同じ年度の
  引退＋自由契約公示は引退の 1 行に、自由契約＋その後は 1 行に、FA 宣言＋結果は 1 行に）
- 名簿から理由未調査の入退団と指導者の就任・退任を導く（`src/lib/data.ts` の deriveFromRegister）。
  公示・下書きで同じ人の同じ年度が埋まっていれば出さない。名簿の最新年（asOf）は出さない
- 公開の条件は `src/lib/gate.ts`（ビルドと check の両方が使う）。auto_unverified は抜粋に名前・根拠の語句があり、
  出典 URL が開けて、抜粋がそのページの本文に実際にある（check:urls が確かめて url-status.json に記録）ものだけ公開。満たさない行はビルドから外れ、check に「公開を保留」として出る

## 落とし穴

- **年度**: NPB 年度（オフの出来事は直前シーズン）。ページ年度をそのまま season にするが、任意引退の公示は
  1〜7 月なら、名簿でその年もその球団にいればその年（シーズン途中の引退）、いなければ前年度
  （長野久義: 2025/10 引退発表 → 2026/3/16 公示 → 2025 年度）。`retiredSeason()`
- **2003〜2015 年度の公示の書式**（年で違う。`scripts/import/npb-announcements.ts` の各関数のコメント参照）:
  2003〜2005 は選手リンクが無い → 名前（異体字「髙/高」「﨑/崎」・「・」「．」をそろえる）＋その年の球団で名簿から引く。
  引けない行は取り込まずに報告するので `data/name-aliases.yaml` に足す。2003 は日付に年が無く「11/ 5」の空白もある。
  2005 までトレードの球団欄は `trteamlong`。FA は 2015 ごろまで `fa_filed2.html`。球団別の一覧（registered_X）は 2014 から
  で、球団コードも年で違う（teams.yaml の `oldUrlCodes`）。一覧が無い年の「その後」は名簿の翌年の所属から出す。
  日付・球団の「〃」は上の行と同じ。2016・2017 は `</a>` の閉じ忘れがあり、取得後に補ってから読む（`repair`）
- **自由契約の表の ※ 注記**: 「ポスティングによる移籍（ＭＬＢ／…）」の行は posting として取り込む。
  球団欄が空の行は「任意引退選手公示抹消」（昔引退した人の手続き）なので取り込まない
- **2004 年オフの近鉄・オリックス→オリックス・楽天**（球団合併に伴う分配）は、NPB 公示がトレードの表に載せているので
  サイトでもトレードの区分に出る
- **FA 1993〜2002 年度**は NPB 公示に無い（公示は 2003 年度から）。Wikipedia「フリーエージェント (日本プロ野球)」の
  移籍表（国内・海外）から `data/events/manual/1993〜2002.yaml` に下書きした（宣言＋移籍、人的補償。宣言残留は出典が無く未収録）。
  同じ表の 2003〜2007 年度は NPB 公示の FA 移籍と全員一致（移籍先も）することを確かめてある
- **名簿の書式**: 「24.5.26」（日付付きの年）、「夏～38」（年の省略）、「（兼コ）」など 13 種の役割、［改名］［代監］、
  「）.」の誤記、リンクは行ではなく表全体を包む `<a class="unit">`。`scripts/lib/register-parse.ts` 参照。
  ［改名］は区切りが「,」「、」・空白と混ざり、年に「開幕」「秋」や月日（「5.10」、年.月の「40.9」とは別）が付く。
  「（読み方）」は読みの変更なので名前にしない。「赤見内銀次（銀次）」の括弧の中は登録名
- **名簿の年内移籍**: 「80,81南海,81～83西武」のように「途」なしで同じ年に 2 球団に出ることがある（check はこれを許す）
- **その後（他球団と契約・育成再契約）**: 新規登録ページは「1/30 以降」しか載らない。オフの契約は翌年度の
  `registered_X.html` / `registereddev_X.html`（公示日 M/D、10〜12 月は前年）から拾う
- **監督・コーチの公示**: 2020 年度以降だけ。氏名にリンクが無いので名前で人物を引く（登録名が名簿と違う人は
  name-aliases.yaml）。【背番号変更】は去就ではないので飛ばす。オフの人事は「前年度名簿と
  今年度名簿の差」なので、翌年度の名簿が出るまで（2 月ごろ）は球団発表の下書きで入れる
- **seen**: その年度ファイルの初回取り込みでは付けない（過去分が「新着」に並ばないように）
- **search**: Pagefind は人物ページだけを索引（`data-pagefind-body`）。帯は `data-pagefind-ignore`

## 守ること（法務・運用の決定）

- NPB の表や名簿の表記をそのまま載せない・保存しない（事実だけを自前の形で）。一括配布（CSV 等）はしない
- 写真・ロゴ・広告なし。取得は 2.5 秒以上の間隔、UA は `intai-fa-bot (+…/about/)`（個人の連絡先を入れない）
- 掲載は球団発表か NPB 公示から（報道段階は載せない）。過去分だけ確定後の報道・Wikipedia 可
- **push ＝ 本番反映**。push とリポジトリ作成・Pages 設定は本人が行う
