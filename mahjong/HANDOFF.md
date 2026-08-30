# 交接：麻雀計分 App

## 依家狀態

App 已經寫好晒，喺 `elephantplan/travel_planner` repo 嘅
`claude/mahjong-scoring-app-oa9737` branch，`mahjong/` 資料夾入面。
**未 merge、未搬去 `elephantplan/mahjong_app`**（新 session 因為 GitHub
存取 scope 只限 `travel_planner`，搬唔到）。

## 呢個 app 做乜

單頁 PWA 麻雀計分（香港番數制），資料存喺 Supabase（唔存 local），
分享一條 link 俾同枱朋友就即刻睇到實時成績。

功能：
- 開局揀玩法預設（25雞／12蚊／5雞）或自訂番數換錢對照表
- 記分：番數大鍵盤直接入，或者勾番種自動計番（清一色/混一色、大三元/小三元
  等互斥處理好；十三么等大牌自動封頂）
- 自摸／半銃／全銃／流局／詐糊
- 中途換人（新舊玩家嘅帳按局數分開，唔會混埋）
- 撤銷上一局
- 結束牌局出結算頁：每人最終輸贏 + 最少交易嘅找數建議，可複製貼 WhatsApp
- 觀戰模式：冇 host key 開條 link 淨係睇得，改唔到分數
- 可加到手機主畫面用（manifest + service worker）

## 檔案（喺 `mahjong/` 資料夾）

- `index.html` `app.js` `core.js` `config.js` — app 本身（零 build、零 npm）
- `test.html` — 計分邏輯自測，20 項全部通過
- `vendor/supabase.js` — Supabase client（收埋喺 repo，唔靠 CDN）
- `manifest.json` `sw.js` `icon.svg` — PWA
- `supabase/schema.sql` — 資料庫 schema/RPC 摘要（實際已經套咗落 Supabase project）
- `README.md` — 詳細功能同安全設計說明

## 後端

新開咗一個免費 Supabase project：
- **project ref**：`fhmrktvyekrbbhgpipvv`（region ap-southeast-1，喺 org
  `msszzdwhnfnfmwhbxkbg`，同 `seoul-family-trip` 果個 org）
- Schema：`games` / `seats` / `rounds` / `game_secrets`
- 寫入一律經 SECURITY DEFINER RPC（`create_game` `add_round`
  `undo_last_round` `substitute_player` `finish_game` `reopen_game`），
  要 host key 核對啱先做得到；host key 只存 hash 喺冇 RLS policy 嘅
  `game_secrets`，經 API 讀唔到
- 讀取（`games`/`seats`/`rounds`）任何人有 room code 都得（room code
  12 位隨機碼）
- `config.js` 入面已經寫死咗 project URL 同 publishable key（呢個係
  設計上公開嘅，安全靠上面嘅 RLS + RPC）

## 仲未做／未驗到

- **未試過真實 realtime**：呢個開發容器嘅網絡政策擋咗 `supabase.co`，
  淨係用假 REST 層測過 UI 流程。上到 GitHub Pages 用真手機開兩部機
  先可以驗實時同步得唔得。
- **未搬去 `mahjong_app` repo**（見下面）
- **未開 GitHub Pages**：`travel_planner` 而家係咪 public/private？如果
  要出公開 link 俾朋友用，記得開 Pages（Settings → Pages）

## 下一步：搬去 `elephantplan/mahjong_app`

新 session 開嘅時候，若果想 clone/push 呢個獨立 repo，記得：

1. 開 session 嗰陣要將 `elephantplan/mahjong_app` 加落 GitHub 存取
   scope（唔係淨係 `travel_planner`）——喺 claude.ai 嗰邊揀返個 repo，
   或者用 `add_repo` 工具，等佢批准
2. Clone `mahjong_app`（依家係空 repo，default branch `main`）
3. 將 `travel_planner` 嘅 `mahjong/` 資料夾內容，複製做 `mahjong_app`
   嘅根目錄（唔使 `mahjong/` 呢層），即係 `mahjong_app/index.html`
   `mahjong_app/app.js` 咁樣擺法
4. Commit + push 去 `mahjong_app` 嘅 `main`（或者你想要嘅 branch）
5. 之後可以喺 `travel_planner` 果個 branch 度刪走 `mahjong/`
   資料夾（如果唔想個旅遊 repo 留低呢啲檔案），或者直接唔理佢
6. 開 GitHub Pages（`mahjong_app` → Settings → Pages），因為新 repo
   應該係你自己開嘅，如果係 private 記得轉 public 先出到公開 link

Supabase 個 project 唔使郁，前端 `config.js` 已經寫死咗連線資料，
搬去邊個 repo 都照用得。
