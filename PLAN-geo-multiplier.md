# Safe Route — תוכנית שדרוג: RPG Geo Multiplier

## תאריך: 2026-07-13
## סטטוס: ✅ בוצע (2026-07-13 18:41 UTC)

---

## מצב נוכחי (לפני השינוי)

### מד סיכון (riskGauge) — `renderRiskGauge()` in index.html
- **מקור ציון**: אזעקות היסטוריות (heatmap שעתי) + recency boost + proximity boost + geoAdd
- **geoAdd נוכחי**: `Math.round(cityRegionScore * 0.15)`, cap 15
  - קבוע: 15% מהציון הגאופוליטי, מקסימום 15 נקודות
  - דוגמה: geo=72 → geoAdd=11. תמיד 11, לא משנה מה ה-risk הבסיסי
- **Cap כללי**: `Math.min(90, risk)` — מד סיכון לא עובר 90
- **100 רק על**: אזעקה פעילה בעיר (15 דקות אחרונות)

### מחוג גאופוליטי (geoGauge) — `renderGeoGauge()` in index.html
- **חדש**: נוסף היום (2026-07-13)
- מציג את `window._regionScores` לפי אזור העיר הנבחרת
- **ויזואלי בלבד** — לא משפיע על מד הסיכון ישירות

### Monitor (threat-monitor/monitor.py)
- ציוצים עם decay ליניארי על 12 שעות (`DECAY_WINDOW = 12h`)
- קלאסטרים: blockade_hormuz, us_strikes, houthis, ceasefire, hezbollah, iran_direct, negotiations
- כל קלאסטר capped ל-20 נקודות (dedup)

### API (api-server.js)
- `/api/threat` מחזיר: `score`, `region_scores`, `breakdown`, `ceasefire_status`
- לא צריך שינוי ב-API

---

## הבעיה

geoAdd **קבוע** (0-15) לא משנה מה ה-risk הבסיסי. זה לא הגיוני:

| מצב | risk בסיסי | geo | geoAdd | סה"כ | הגיוני? |
|---|---|---|---|---|---|
| שקט + מתיחות | 0 | 72 | 11 | 11 | ❌ צריך יותר — המתיחות היא המידע היחיד |
| מלחמה + מתיחות | 70 | 72 | 11 | 81→90 | ❌ geoAdd מיותר, כבר יודעים שיש סכנה |

---

## הפתרון: RPG Diminishing Returns

### הנוסחה החדשה
```javascript
// armor = כמה "הגנה" יש (מאזעקות אמיתיות). 0 = שקט, 1.0 = מלא
var armor = Math.min(1, risk / 80);

// multiplier: ככל שיש יותר armor, ה-geo פחות משפיע
// risk=0 → mult=2.0 (damage מלא)
// risk=80 → mult=1.0 (damage מינימלי)
var multiplier = 2.0 - armor;

// geoAdd דינמי
var geoAdd = Math.round(cityRegionScore * 0.15 * multiplier);

// לא לעבור 80 סה"כ (90 הוא ה-cap הכללי, 80 הוא ה-cap של geo+base)
risk = Math.min(80, risk + geoAdd);
```

### טבלת דוגמאות
| risk (alerts) | geo score | armor | multiplier | geoAdd | סה"כ | הערה |
|---|---|---|---|---|---|---|
| 0 | 100 | 0.00 | ×2.0 | 30 | **30** | שקט + geo בוער = אזהרה |
| 0 | 72 | 0.00 | ×2.0 | 22 | **22** | פ"ת — מ-11 ל-22 |
| 0 | 30 | 0.00 | ×2.0 | 9 | **9** | מתיחות קלה |
| 0 | 0 | 0.00 | ×2.0 | 0 | **0** | שקט = שקט |
| 20 | 100 | 0.25 | ×1.75 | 26 | **46** | — |
| 40 | 100 | 0.50 | ×1.5 | 23 | **63** | — |
| 60 | 100 | 0.75 | ×1.25 | 19 | **79** | — |
| 80 | 100 | 1.00 | ×1.0 | 15 | **80**→cap | armor מלא |
| 11 | 72 | 0.14 | ×1.86 | 20 | **31** | פ"ת כרגע (היה 11) |

### מנגנוני הגנה (כבר קיימים)
1. ✅ `Math.min(90, risk)` — cap כללי ב-90, 100 רק אזעקה פעילה
2. ✅ Decay ב-monitor.py — ציוצים דועכים על 12 שעות
3. 🆕 Cap חדש: `Math.min(80, risk + geoAdd)` — geo+base לא עוברים 80
4. ✅ pre-alert override: אם פיקוד העורף שולח pre-alert, risk=75 minimum (עוקף geo)

---

## TODO — שלבי ביצוע

### שלב 1: Commit before
- [ ] `cd /var/www/yitzhakbohadana.com/safe-route && git add -A && git commit -m "before: RPG geo multiplier"`

### שלב 2: שינוי index.html — `renderRiskGauge()`
- [ ] מחליפים את בלוק ה-geoAdd (3 שורות) בנוסחה החדשה (5 שורות)
- [ ] **לא לגעת** בשום דבר אחר ב-renderRiskGauge
- [ ] **לא לגעת** ב-renderGeoGauge, fetchThreatScore, API

### שלב 3: בדיקות
- [ ] F5 — ציון פ"ת צריך להיות ~22 (במקום 11)
- [ ] localStorage.clear() + reload + בחירת עיר — אותו ציון
- [ ] מעבר בין ערים — ציון משתנה לפי אזור
- [ ] geo=0 + alerts=0 → ציון=0 (לא שבור)
- [ ] אזעקה פעילה → 100 (לא מושפע מ-geo)

### שלב 4: Commit + push
- [ ] `git add -A && git commit -m "feat: RPG geo multiplier - dynamic geoAdd based on alert armor"`
- [ ] `git push`

---

## קבצים שנוגעים
- **`index.html`** — בלוק geoAdd בתוך `renderRiskGauge()` (3 שורות → 5 שורות)
- **שום דבר אחר**. לא API, לא monitor.py, לא CSS.

## Rollback
- `git checkout -- index.html` אם משהו נשבר
