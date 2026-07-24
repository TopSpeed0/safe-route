# Safe Route Pipeline

## Workflow
1. Check git status and read this file before changes.
2. Create a safety commit before any work (`git add -A && git commit -m "before: ..."`; use an empty commit only when the tree is clean).
3. Make and verify the smallest change.
4. Update this file with the completed change, commit, and push `main` to `origin`.
5. For API changes, restart the Safe Route API service only after verification.

## Latest change
- 2026-07-24: Added classifier-aware tweets feed/UI. `/api/tweets` exposes only display-safe `final_score` and compact relevance metadata when present; legacy items remain supported. The desktop/mobile tweets tabs now present neutral legacy items as “דורש בדיקה / ללא השפעה”, use classified final impact for filtering/sorting, and provide a compact RTL “למה?” reason disclosure. No internal provider/cache/ledger/prompt fields are exposed.
- 2026-07-24: Added the tweets dashboard tab: desktop label “ציוצים אחרונים”, mobile label “ציוצים”; safe public `/api/tweets` feed; source/type/time/impact/keyword/search/sort filters.
