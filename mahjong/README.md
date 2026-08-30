# 🀄 麻雀計分（香港番數制）

單頁 PWA：開局 → 逐局計分 → 結算找數。資料存喺 Supabase，唔存 local，
所以**分享條 link 俾同枱朋友，佢哋即刻睇到實時成績**。

## 功能

- **玩法預設**：25 雞 / 12 蚊 / 5 雞，或者自訂每格番數金額
- **番數兩種入法**：大鍵盤直接撳番數，或者勾番種（平胡、對對胡、清一色…）自動計番，
  互斥規則自動處理（勾清一色會取消混一色），十三么／字一色等大牌直接封頂
- **出銃付法**：半銃（出銃全數、另兩家各半）或全銃（出銃者獨付）；亦支援自摸、流局、**詐糊**
- **中途換人**：舊玩家嘅數封盤停喺嗰一刻，新玩家由下一局計起，兩個人嘅帳分得清清楚楚
- **結算找數**：每人最終輸贏 + 最少交易嘅找數建議（邊個俾邊個幾多），一撳複製貼落 WhatsApp
- **撤銷上一局**、結束後可以重開牌局
- **觀戰模式**：冇 host key（即係唔係開局嗰部機）開條 link 只睇得，改唔到分數
- 加到手機主畫面就似 app 咁用

## 檔案

| 檔案 | 做乜 |
|---|---|
| `index.html` | 畫面 + 樣式 |
| `app.js` | 介面邏輯、Supabase 讀寫、實時訂閱 |
| `core.js` | 純計分邏輯（加減、番種、換人帳、找數）——可獨立測試 |
| `config.js` | Supabase 連線、玩法預設、番種表 |
| `test.html` | 計分自測，開條 URL 就見到 pass/fail |
| `vendor/supabase.js` | Supabase client（收埋喺 repo，唔靠 CDN） |
| `sw.js` / `manifest.json` | PWA：可安裝、靜態檔離線都開到 |
| `supabase/schema.sql` | 資料庫 schema 同 RPC（參考用，已經套咗落 project） |

## 安全點做

- 牌局資料任何人有 room code 都睇得（room code 係 12 位隨機碼）
- **改分數一定要 host key**：開局嗰部機生成、存喺該機瀏覽器，經 SECURITY DEFINER RPC 核對
- host key 只存 hash 落 `game_secrets`，呢張表冇任何 RLS policy，即係經 API 完全讀唔到
- 每局金額由資料庫計，唔信前端傳過嚟嘅數

## 部署

放上 GitHub Pages（Settings → Pages → 揀 branch）就用得，唔使 build、唔使 npm。
Private repo 嘅 Pages 要 Pro 方案；免費戶想出公開 link 就將 repo 轉 public
（程式碼冇任何秘密，Supabase publishable key 本身係設計上公開嘅）。

## 測試

```
python3 -m http.server 8899   # 喺呢個資料夾行
```
- `http://localhost:8899/test.html` — 計分邏輯自測（20 項）
- `http://localhost:8899/index.html` — 真正開局
