# Safe Route Pipeline

## Workflow
1. Check git status and read this file before changes.
2. Create a safety commit before any work (`git add -A && git commit -m "before: ..."`; use an empty commit only when the tree is clean).
3. Make and verify the smallest change.
4. Update this file with the completed change, commit, and push `main` to `origin`.
5. For API changes, restart the Safe Route API service only after verification.

## Latest change
- 2026-08-30: Optimized Safe Route startup: `/api/alerts` now defaults to the requested 30-day window (full archive only via `?days=all`), and the client loads larger ranges only when the user selects them. Manual/5-minute refreshes preserve the currently loaded range. Verified API payloads: 30 days 223B/5 alerts, 90 days 264KB/5,199 alerts, full archive 15.97MB/372,383 alerts.
- 2026-07-24: Fixed false life-safety alert replay after `safe-route-api.service` restart. `alerts-history` bootstrap is now silent; only fresh (≤10 minutes) newly observed live events may notify monitored cities. Drill events are ignored. This prevents historical test/old alerts from generating Telegram/WhatsApp notifications.
- 2026-07-24: Added classifier-aware tweets feed/UI. `/api/tweets` exposes only display-safe `final_score` and compact relevance metadata when present; legacy items remain supported. The desktop/mobile tweets tabs now present neutral legacy items as “דורש בדיקה / ללא השפעה”, use classified final impact for filtering/sorting, and provide a compact RTL “למה?” reason disclosure. No internal provider/cache/ledger/prompt fields are exposed.
- 2026-07-24: Added the tweets dashboard tab: desktop label “ציוצים אחרונים”, mobile label “ציוצים”; safe public `/api/tweets` feed; source/type/time/impact/keyword/search/sort filters.
