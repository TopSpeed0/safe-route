# Safe Route Pipeline

## Workflow
1. Check git status and read this file before changes.
2. Create a safety commit before any work (`git add -A && git commit -m "before: ..."`; use an empty commit only when the tree is clean).
3. Make and verify the smallest change.
4. Update this file with the completed change, commit, and push `main` to `origin`.
5. For API changes, restart the Safe Route API service only after verification.

## Latest change
- 2026-07-24: Added the tweets dashboard tab: desktop label “ציוצים אחרונים”, mobile label “ציוצים”; safe public `/api/tweets` feed; source/type/time/impact/keyword/search/sort filters.
