# Plan: Fix Netflix extraction for "page already open" + document it in FRONTEND.md

## Context

TeaWhiz's Netflix extraction currently only returns whatever is sitting in
`latestNetflixContent`, a cache populated by two triggers in
`frontend/src/content.ts`: a `window.load` listener (fires once, then waits
2s) and a `MutationObserver` on `document.body` (debounced 1s).

The bug: content scripts attach at `document_idle`, which for a Netflix tab
that was **already open and fully loaded** before the script attached fires
*after* `window.load` has already happened. That listener never fires again,
so the only remaining path to populated content is a future DOM mutation.
If the user opens the popup on an already-open, currently-idle Netflix tab
before any such mutation happens, `extractNetflix()` returns `""`, and
`getPageContent()` falls through to the generic HTML/Trafilatura path —
which can't make sense of Netflix's thumbnail-grid UI at all.

This was surfaced while discussing "how should we handle Netflix extraction
if the page is [already] open" — this plan fixes that specific race and
records the reasoning in `FRONTEND.md` (per project convention — `CODE.md`
already documents architecture decisions like this one for the backend/full
pipeline).

## Changes

### 1. Code fix — `frontend/src/content.ts`

Change `extractNetflix()` (currently ~line 100) from "read cache only" to
"extract live, fall back to cache":

```ts
function extractNetflix(): string {
  const isNetflix = document.location.hostname.includes("netflix");
  if (!isNetflix) return "";

  const liveContent = extractNetflixTitles();
  if (liveContent) {
    latestNetflixContent = liveContent;
    return liveContent;
  }

  // Live query came back empty (e.g. mid-transition) - fall back to the
  // last known-good cached extraction instead of returning nothing.
  return latestNetflixContent;
}
```

Rationale: `extractNetflixTitles()` is just `querySelectorAll('[aria-label]')`
plus string filtering — cheap enough to run synchronously every time the
popup asks for page content (`GET_PAGE_CONTENT` → `getPageContent()` →
`extractNetflix()`, all synchronous, same tab). This removes the dependency
on `window.load` timing entirely; the `MutationObserver`/debounce machinery
in `setupNetflixMonitoring()` stays as-is and still keeps the cache warm as
a fallback for the rare case a live query catches the DOM mid-re-render.

No other files need code changes — `getPageContent()`'s call site and the
`>= 50` chars threshold check are unaffected.

### 2. Documentation — `FRONTEND.md`

Add a new section (after "Phase 2C: Gemini Nano Integration", before
"Phase 6", and add it to the Table of Contents) titled:

**"Netflix Extraction: Handling an Already-Open Page"**

Content to include:
- Where Netflix extraction actually lives today: `frontend/src/content.ts`
  (`extractNetflixTitles()`, `extractNetflix()`, `setupNetflixMonitoring()`)
  — noting this supersedes the old Nano/toolbar-selection flow described
  earlier in this same file, which no longer reflects the shipped extension
  (see `CODE.md` for the current, accurate end-to-end architecture).
- The problem: `document_idle` vs `window.load` ordering means a tab that
  was already open before the script attached never gets its one-shot
  initial extraction; only a subsequent live DOM mutation would ever
  populate the cache, and the popup can be opened before that occurs.
- The fix: make `extractNetflix()` extract live, on demand, on every call;
  keep the `MutationObserver` cache purely as a fallback for a transient
  empty live-query.
- A short "how to verify" checklist:
  1. `npm run build` in `frontend/`, reload the unpacked extension.
  2. Open netflix.com and let it fully finish loading.
  3. **Without** scrolling or interacting, immediately open the TeaWhiz
     popup and ask a question.
  4. Confirm the response is grounded in actual show/movie titles (i.e.
     `contentType: "text"` / the `## 🎬 Netflix Content` list), not a
     generic HTML extraction fallback — check the content script's console
     logs (`[TeaWhiz] Extracted Netflix content live`) to confirm the live
     path fired instead of falling through to `getRenderedHTML()`.
  5. Repeat after scrolling the row carousel, to confirm the existing
     mutation-driven cache refresh still works for newly-rendered rows.

## Verification

- `cd frontend && npm run build` succeeds with no TypeScript errors.
- Manual checklist above, run against a real Netflix tab in Chrome
  (`chrome://extensions` → reload unpacked → `dist/`).
- Confirm existing non-Netflix pages are unaffected (extraction path for
  them doesn't touch `extractNetflix()`).
