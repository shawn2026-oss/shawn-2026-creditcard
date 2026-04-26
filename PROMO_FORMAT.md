# promo_status.json 文案規範

iOS app（CardRewardManager）會把 `promos[]` 內的 `title` 顯示在首頁「活動額滿狀態」清單、`body` 用在本機推播通知。為避免使用者看到「icash Pay 4% 已額滿」卻不知道是哪張卡的活動，所有額滿訊息**必須帶卡名識別**。

---

## 顯示位置與字串長度

| 字段 | 顯示位置 | 空間 |
|------|---------|------|
| `title` | 首頁清單列、單行 | 緊（建議 < 25 字） |
| `body` | iOS 本機推播通知 body | 寬（可較長、容錯） |

→ **title 用「卡片簡名」**、**body 用「卡片全名」**。

---

## 卡片簡名／全名對照

| 簡名（title 用） | 全名（body / 頂層 msg 用） |
|---|---|
| UniOpen | 中信 UniOpen 卡 |
| 聯邦信用卡 | 聯邦信用卡（多卡共用活動，如 iPASS MONEY 綠點，不限特定卡） |
| (其他卡) | 待補 |

各銀行 icash Pay 系列（交通 10% / 網購 3C 10%）：title／body 都用銀行名（已是卡片識別、不需再加「卡」字）。

---

## 各系列 title／body 模板

### A. UniOpen（中信 UniOpen 卡）icash Pay 系列

對應 promos[] id：`icash_4`、`starbucks_5`、`sunday_7`、`uniopen_autoload`

```
title: "UniOpen [活動名] [%] 已額滿"
body:  "中信 UniOpen 卡 icash Pay [活動名] [%] [月份] 名額已滿"
```

例：
- `icash_4` — title `"UniOpen icash Pay 4% 已額滿"` / body `"中信 UniOpen 卡 icash Pay 全通路 4% 4 月名額已滿"`
- `starbucks_5` — title `"UniOpen 星巴克 5% 已額滿"` / body `"中信 UniOpen 卡 icash Pay 星巴克 5% 4 月名額已滿"`
- `uniopen_autoload` — title `"UniOpen 自動加值 10% 已額滿"` / body `"中信 UniOpen 卡 自動加值 10% 4 月名額已滿"`

### B. 各銀行 icash Pay 交通 10% 系列

對應 id pattern：`transport_[銀行名]`（台新／兆豐／一銀／華南／元大）

```
title: "[銀行名] 交通 10% 已額滿"
body:  "[銀行名] icash Pay 交通 10% [月份] 名額已滿"
```

例：
- `transport_台新` — title `"台新 交通 10% 已額滿"` / body `"台新 icash Pay 交通 10% 4 月名額已滿"`

### C. 各銀行 icash Pay 網購 3C 10% 系列

對應 id pattern：`online3c_[銀行名]`（玉山／國泰／台新／富邦／兆豐）

```
title: "[銀行名] 網購 3C 10% 已額滿"
body:  "[銀行名] icash Pay 網購 3C 10% [月份] 名額已滿"
```

例：
- `online3c_台新` — title `"台新 網購 3C 10% 已額滿"` / body `"台新 icash Pay 網購 3C 10% 4 月名額已滿"`

### D. 聯邦信用卡 iPASS MONEY 系列（綁卡活動，多卡共用）

對應 id pattern：`ubot_ipassmoney_[月份]`

聯邦旗下多張卡（c2 聯邦綠卡 / c5 聯邦賴點卡 / j2 聯邦吉鶴卡 / ubot_m 聯邦M卡 / ubot_lb 聯邦LINE Bank聯名卡）綁 iPASS MONEY app 都能參加，不限特定卡，故 title／body 用「聯邦信用卡」泛稱。

```
title: "聯邦信用卡 iPASS MONEY 10% [月份] 已額滿"
body:  "聯邦信用卡 綁定 iPASS MONEY 10% 綠點 [月份] 名額已滿"
```

例：
- `ubot_ipassmoney_4` — title `"聯邦信用卡 iPASS MONEY 10% 4 月已額滿"` / body `"聯邦信用卡 綁定 iPASS MONEY 10% 綠點 4 月名額已滿"`

---

## 頂層 msg 字段

`uniopen_icash_msg` 等頂層欄位是 iOS app 直接顯示在卡片詳情頁的字串、需依現有內容判斷怎麼插卡名、不要硬塞改變語意：

| 欄位 | 模板 |
|------|------|
| `uniopen_icash_msg` | `"YYYY 年 M 月 中信 UniOpen 卡 icash Pay 4% 已額滿"`（保留時間前綴） |
| `starbucks_5_msg` | `"中信 UniOpen 卡 星巴克 5% 已額滿"` |
| `sunday_7_msg` | `"中信 UniOpen 卡 星期天 7% 已額滿"`（**僅當 `sunday_7_full: true` 才填**、否則保留 `""`） |
| `uniopen_autoload_msg` | `"中信 UniOpen 卡 自動加值 10% 已額滿"` |

→ `*_full: false` 時 `*_msg` 保留 `""`、避免顯示「已額滿」誤導。

---

## 範圍外（不規範化）

下列字段目前**不**走此規範：

- `easycard_results`（80 筆悠遊付活動）— 卡名歸屬複雜、改造工作量大、未來再說
- `cube_mobile_msg`（國泰 CUBE）— 待整合 CUBE 卡時再規範
- `transport_10` / `online3c_10` 頂層 dict 內的 `msg`（如 `"台新04月份贈點已於2026/04/04 17:21 p.m.額滿"`）— 屬爬蟲原文、不規範化、僅 `promos[]` 規範化版本進入 iOS 顯示
- `reminders[]` / `manualCheckPromos[]` — 另有規則

---

## 變更原則

修改 `promos[]` 時：
- **只動 `title` / `body` 字串**、`id` / `full` / `category` 原樣
- title 必須帶卡片簡名（除非銀行名本身就是識別）
- body 必須帶卡片全名（除非銀行名本身就是識別）
- 已額滿訊息結尾統一「已額滿」/「名額已滿」、保持與舊版 iOS 端 `replacingOccurrences("已額滿", "")` 後處理相容
- 數字、百分比、月份等之間留全形空格（如 `"icash Pay 4% 已額滿"` 而非 `"icash Pay 4%已額滿"`）

修改完整跑一次 `python3 -c "import json; json.load(open('promo_status.json'))"` 驗 JSON 合法。
