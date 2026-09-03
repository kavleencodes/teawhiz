# TeaWhiz AI — Complete Implementation Guide

**Chrome Extension + FastAPI Backend — Full Architecture & Implementation Details**

---

## 📋 Table of Contents

1. [Project Overview](#project-overview)
2. [Tech Stack](#tech-stack)
3. [Architecture Diagram](#architecture-diagram)
4. [Current Implementation Status](#current-implementation-status)
5. [Backend Implementation](#backend-implementation)
6. [Frontend Implementation](#frontend-implementation)
7. [Message Passing Flow](#message-passing-flow)
8. [Content Extraction Strategy](#content-extraction-strategy)
9. [Streaming & Caching](#streaming--caching)
10. [Frontend UI & UX](#frontend-ui--ux)
11. [Case Study: Fixing the Broken FAQ Table](#case-study-fixing-the-broken-faq-table)
12. [Running the Extension](#running-the-extension)
13. [Troubleshooting](#troubleshooting)
14. [Known Weaknesses & Limitations](#known-weaknesses--limitations)

---

## Project Overview

**TeaWhiz AI** is a Chrome extension that allows users to:
- ✅ Ask questions about any webpage
- ✅ Get AI-powered explanations, summaries, or simplifications
- ✅ Receive responses streamed word-by-word in real-time
- ✅ See results in a beautiful popup UI with loading animations
- ✅ Benefit from intelligent content extraction and response caching

### Current Capabilities
- 🎯 **Full Page Analysis**: Automatically extracts main content from any webpage
- 🚀 **Streaming Responses**: Word-by-word delivery via Server-Sent Events (SSE)
- ⚡ **Instant Display**: Responses appear immediately as chunks arrive
- 💾 **Intelligent Caching**: SHA256-based keys with 7-day TTL
- 🤖 **Smart Model Selection**: OpenAI GPT-OSS-120B primary, with automatic failover to ALLAM-2-7B and rate-limit retry/backoff on both `/explain` and `/explain-stream`
- 🔄 **Graceful Degradation**: Content extraction runs server-side (Trafilatura) on the browser's own rendered DOM, with a client-side plain-text fallback if HTML capture fails or is too large
- 📺 **Netflix Monitoring**: Real-time dynamic content detection with MutationObserver
- 🎨 **Beautiful Markdown**: marked (bundled via npm) rendering with regex fallback for gorgeous formatted responses, tables included
- 📊 **Clean Tables**: Minimal table styling with subtle dividers (no ugly borders)

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Frontend Framework** | TypeScript + Vite | Latest |
| **Extension Plugin** | @crxjs/vite-plugin | v3 |
| **DOM Capture** | Content script (`document.documentElement.outerHTML`, post-render) | Browser native |
| **Content Extraction** | Trafilatura (Python, runs on the backend) | 2.2.0 |
| **Markdown Rendering** | marked (bundled via npm, not CDN) | v18.x |
| **Markdown Fallback** | Regex-based converter (incl. GFM table support) | Custom |
| **Dynamic Monitoring** | MutationObserver API | Browser native |
| **Build System** | Vite | v8.2.1 |
| **Backend** | FastAPI (Python) | 0.104.1+ |
| **AI Provider** | Groq API | Latest |
| **AI Models** | openai/gpt-oss-120b (primary), allam-2-7b (fallback) | - |
| **Streaming** | Server-Sent Events (SSE) | HTTP Standard |
| **Caching** | In-Memory Python Dict | SHA256 keys, 7-day TTL |
| **Deployment** | LocalHost (8000) or Cloud | - |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                 Chrome Browser                              │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           Content Script (content.ts)               │   │
│  │  • Captures the page's own RENDERED DOM             │   │
│  │    (document.documentElement.outerHTML, post-JS)    │   │
│  │  • No extraction logic runs here anymore -          │   │
│  │    Readability.js was removed; Trafilatura on the   │   │
│  │    backend does that job now (see below)            │   │
│  │  • Netflix monitoring with MutationObserver         │   │
│  │    (its own DOM-scraping path, sent as plain text)  │   │
│  │  • Runs at document_idle (after page fully loads)   │   │
│  │  • Listens for GET_PAGE_CONTENT messages            │   │
│  │  • Replies with { title, contentType, content }     │   │
│  └──────────────────┬──────────────────────────────────┘   │
│                     │                                        │
│                     │ chrome.tabs.sendMessage()              │
│                     │ (GET_PAGE_CONTENT)                     │
│                     ▼                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │             Popup UI (popup.ts)                     │   │
│  │  • Conversation interface with message threads      │   │
│  │  • Renders markdown with marked (bundled via npm)   │   │
│  │  • Fallback: regex-based markdown converter         │   │
│  │  • Displays user messages & AI responses            │   │
│  │  • Instant response display (no delay)              │   │
│  │  • Loading animation with teacup icon               │   │
│  │  • Accumulates streamed chunks into full response   │   │
│  │  • Keeps content/contentType/title/question SEPARATE│   │
│  │    (no longer glues page content + question client- │   │
│  │    side - the backend combines them after extraction)│  │
│  │  • Sends GET_ANSWER to background worker            │   │
│  └──────────────────┬──────────────────────────────────┘   │
│                     │                                        │
│                     │ chrome.runtime.sendMessage()           │
│                     │ (GET_ANSWER: content, contentType,     │
│                     │  title, question)                      │
│                     ▼                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │        Background Worker (background.ts)            │   │
│  │  • Receives GET_ANSWER messages from popup          │   │
│  │  • Fetches from backend /explain-stream endpoint    │   │
│  │    with { text, content_type, title, question }     │   │
│  │  • Streams response chunks back to popup            │   │
│  │  • Handles error responses (RESPONSE_ERROR)         │   │
│  │  • Uses chrome.runtime.sendMessage to broadcast    │   │
│  └──────────────────┬──────────────────────────────────┘   │
│                     │                                        │
└─────────────────────┼────────────────────────────────────────┘
                      │
                      │ HTTP POST /explain-stream
                      │ (SSE - Server-Sent Events)
                      ▼
        ┌──────────────────────────────────────┐
        │   FastAPI Backend                     │
        │   (http://localhost:8000)             │
        │                                       │
        │  ┌─────────────────────────────────┐  │
        │  │ POST /explain-stream            │  │
        │  │                                 │  │
        │  │ 1. Receive { text, content_type,│  │
        │  │    title, question, action }    │  │
        │  │ 2. build_cleaned_text():        │  │
        │  │    a. content_type == "html"?   │  │
        │  │       → extract_clean_text()    │  │
        │  │         (Trafilatura extracts   │  │
        │  │         the main content from   │  │
        │  │         the RENDERED HTML the   │  │
        │  │         browser sent - no       │  │
        │  │         `requests.get()` here,  │  │
        │  │         so SPA/React pages like │  │
        │  │         Netflix still work)     │  │
        │  │    b. Prepend "Page Title: ..." │  │
        │  │    c. Append "User Question:..."│  │
        │  │ 3. Check cache on combined text │  │
        │  │ 4a. Cache HIT? → Stream cached  │  │
        │  │ 4b. Cache MISS? → Call Groq     │  │
        │  │ 5. Stream response              │  │
        │  │ 6. Save to cache                │  │
        │  │ 7. Send [DONE] marker           │  │
        │  └─────────────────────────────────┘  │
        │                                       │
        │  ┌─────────────────────────────────┐  │
        │  │ Response Cache                  │  │
        │  │ • SHA256 keys                   │  │
        │  │ • 7-day TTL                     │  │
        │  │ • FIFO eviction                 │  │
        │  │ • Max 5000 entries              │  │
        │  └─────────────────────────────────┘  │
        └──────────────┬────────────────────────┘
                       │
                       ▼
            ┌──────────────────────┐
            │   Groq/OpenAI API    │
            │  • llama models      │
            │  • gpt-oss models    │
            │  • Fast inference    │
            └──────────────────────┘
```

**Why extraction moved from the browser to the backend:** the earlier design ran Readability.js *in the content script*, which worked, but meant every future improvement to extraction quality had to ship as an extension update. The tempting alternative - have the backend just `requests.get(url)` the page itself and run Trafilatura on that - was rejected, because for JS-rendered pages (Netflix, React/SPA sites in general) a plain server-side fetch only ever sees the near-empty pre-hydration HTML shell, not the real content. The chosen design keeps the one thing the browser is uniquely positioned to do (run the page's JS and produce a fully hydrated DOM) in the content script, and moves the one thing Python is better at (robust, actively-maintained article extraction via Trafilatura) to the backend - the content script just hands over `outerHTML` after the browser has already rendered it.

---

## Current Implementation Status

### ✅ Completed
- [x] FastAPI backend with Groq/OpenAI API integration
- [x] Chrome extension manifest v3 structure
- [x] Content extraction: content script forwards the browser's rendered DOM, backend runs Trafilatura on it (Netflix keeps its own dedicated title-scraping path)
- [x] Popup-based UI (conversation style with message threads)
- [x] Message passing architecture (content → background → popup)
- [x] SSE streaming from backend
- [x] **Instant response display** (removed 5-second delay)
- [x] Response chunk accumulation
- [x] **Markdown rendering with marked (bundled via npm) + regex fallback (both support GFM tables)**
- [x] **Whitespace-preserving, JSON-encoded SSE streaming** (see [Case Study](#case-study-fixing-the-broken-faq-table))
- [x] **Netflix dynamic content monitoring with MutationObserver**
- [x] **Clean, beautiful markdown styling**
- [x] **Minimal table design (no borders, subtle dividers)**
- [x] **Server-side content extraction with Trafilatura** (replaces the earlier client-side Readability.js) - see [Content Extraction Strategy](#content-extraction-strategy)
- [x] In-memory caching with SHA256 keys and 7-day TTL
- [x] **Async-safe extraction** - Trafilatura's CPU-bound parse runs via `asyncio.to_thread`, no longer blocks the event loop (see [Known Weaknesses](#known-weaknesses--limitations))
- [x] **Rate-limit retry + model fallback on `/explain-stream`** - `_call_groq_with_fallback()` shares the same retry/backoff as `/explain`, then falls back to `FALLBACK_MODEL` if the primary model is still unavailable
- [x] Error handling and resilience
- [x] Comprehensive logging at each step
- [x] Loading animation with teacup icon and rotating text
- [x] Dark mode support with CSS variables

### 🔄 In Progress
- [ ] Test on more websites for robustness
- [ ] Optimize Netflix extraction for edge cases

### 📝 TODO
- [ ] Deploy backend to cloud (Render/Railway)
- [ ] Update extension to use cloud backend URL
- [ ] Chrome Web Store submission
- [ ] User authentication & sync
- [ ] Conversation history storage
- [ ] Advanced settings panel

---

## Backend Implementation

### File: `backend/main.py`

**Location:** `/home/kavleen/Desktop/webwhiz/backend/main.py`

**Key Components:**

1. **FastAPI Setup**
   - Creates Groq API client with `GROK_API_KEY` from `.env`
   - Primary model: `openai/gpt-oss-120b` (changed for better quality)
   - Fallback model: `allam-2-7b` - actually wired up via `_call_groq_with_fallback()` (`main.py:332`): tries `PRIMARY_MODEL` with its own retry/backoff first, and only falls back to `FALLBACK_MODEL` (with one retry of its own) if the primary is still rate-limited or hard-erroring
   - Configuration: Max 5000 cache entries, 7-day TTL

2. **Content Extraction (`extract_clean_text()` + `build_cleaned_text()`)**
   - `ExplainRequest` carries `text` (either plain text or rendered HTML), `content_type` (`"text"` | `"html"`), an optional `title`, and an optional `question` - the popup no longer glues page content and the question into one string before sending
   - `extract_clean_text(html)`: runs `trafilatura.extract()` (`output_format="markdown"`, `include_tables=True`, `favor_recall=True`) on the browser's rendered HTML - see [Content Extraction Strategy](#content-extraction-strategy) for why the HTML has to come from the browser rather than a server-side fetch
   - `build_cleaned_text(request)` is `async` and calls `extract_clean_text()` via `await asyncio.to_thread(...)` - Trafilatura's parse is synchronous/CPU-bound, so running it inline used to stall FastAPI's single asyncio event loop for the whole process on large pages (see [Known Weaknesses](#known-weaknesses--limitations)); it's now offloaded to a worker thread the same way the Groq call already was
   - `build_cleaned_text(request)`: the shared pipeline both endpoints call:
     1. If `content_type == "html"`: guards payload size (`413` above `MAX_HTML_LENGTH` = 2,000,000 chars), runs `extract_clean_text()`, and errors `422` if nothing usable comes back
     2. If `title` is set, prepends `"Page Title: {title}\n\nContent:\n{content}"`
     3. If `question` is set, appends `"\n\n---\n\nUser Question: {question}"`
     4. Errors `400` only if the *final combined* text is still empty (so an empty page extraction + a real question is still valid - matches the old behavior of falling back to just the user's question)

3. **Caching System**
   - **Key Generation:** SHA256 hash of `action:cleaned_text` → 64-char hex string (`cleaned_text` is the fully-combined title+content+question string from `build_cleaned_text()`, not the raw HTML)
   - **Validation:** Checks timestamp age, auto-deletes if >7 days old
   - **Retrieval:** Returns cached answer instantly if valid
   - **Storage:** Saves responses with ISO timestamp
   - **Eviction:** FIFO - removes oldest 500 entries when cache reaches 5000

4. **POST /explain-stream Endpoint**
   - Validates `action`, then calls `build_cleaned_text()` (extraction + title/question combination happens here, before caching)
   - Checks cache first (cache hit = instant stream)
   - If cache miss: Calls Groq/OpenAI API via `_call_groq_with_fallback()` - same rate-limit retry/backoff and primary→fallback-model behavior as `/explain` (previously this endpoint called Groq directly with zero resilience)
   - Streams response word-by-word via `chunk_preserving_whitespace()` (~15 words/chunk, 50ms delays, real newlines kept intact)
   - Each chunk is JSON-encoded with `to_sse_data()` (`json.dumps`) before being written to the SSE line, so markdown structure (blank lines, table rows) survives transport
   - Returns SSE format: `data: <json-encoded chunk>\n\n`
   - Ends with: `data: [DONE]\n\n` marker

5. **GET /health Endpoint**
   - Returns status and Groq API readiness
   - Used for backend verification

#### Starting the Backend

```bash
cd backend
source venv/bin/activate
python -m uvicorn main:app --reload --port 8000
```

Should see: `INFO: Uvicorn running on http://127.0.0.1:8000`

---

## Frontend Implementation

### File: `frontend/src/manifest.json`

**Location:** `/home/kavleen/Desktop/webwhiz/frontend/src/manifest.json`

**Key Settings:**
- Manifest v3 (latest Chrome extension format)
- **Background worker:** Handles all backend communication
- **Content scripts:** Injected on all pages to capture the rendered DOM (no extraction library ships in the extension anymore - that runs server-side)
- **`run_at: "document_idle"`** ⚠️ CRITICAL: Waits for DOM to fully load/hydrate before capturing `outerHTML`
- **Action popup:** Shows main UI when extension icon clicked
- **Icons:** TeaWhiz logo at multiple sizes

### File: `frontend/src/content.ts`

**Location:** `/home/kavleen/Desktop/webwhiz/frontend/src/content.ts`

**Purpose:** Capture the page's rendered DOM for backend extraction, plus Netflix real-time monitoring

**Key Functions:**
- **`getRenderedHTML()`:** Captures the current, post-render DOM
  - Clones `document`, strips `<script>`/`<style>`/`<noscript>` (pure payload-size trim, Trafilatura ignores them anyway)
  - Returns `document.documentElement.outerHTML` - this is the browser's own fully-hydrated DOM, not a fresh fetch, which is what makes SPA/React pages (Netflix included) work at all. See [Content Extraction Strategy](#content-extraction-strategy)
  - Actual article/main-content extraction no longer happens here - it happens backend-side via Trafilatura

- **`extractNetflixTitles()`:** Netflix-specific extraction (unchanged)
  - Looks for `aria-label` attributes on Netflix elements
  - Filters out UI text ("Play", "Browse", "Menu", etc.)
  - Returns markdown list of show/movie titles
  - Sent to the backend as `contentType: "text"`, bypassing HTML capture and Trafilatura entirely - a generic extractor can't make sense of Netflix's row-of-thumbnails UI

- **`setupNetflixMonitoring()`:** Real-time Netflix content detection
  - `MutationObserver` watches `document.body` for DOM changes
  - Waits 2 seconds after page load for Netflix to render
  - `scheduleNetflixExtraction()` debounces to 1 second (prevents spam on hundreds of mutations)
  - Caches titles in `latestNetflixContent` to avoid redundant extractions

- **`extractFallback()`:** Selector-based plain-text extraction - now only an emergency fallback for when HTML capture is empty or exceeds `MAX_HTML_LENGTH`
  - Tries: `<article>`, `<main>`, `.main-content`, `.article-content`, etc.
  - Falls back to `document.body.innerText` as last resort
  - Sent as `contentType: "text"` (skips backend Trafilatura extraction - it's already plain text)

- **`cleanText(text)`:** Markdown-preserving text cleaning (used only by the Netflix/fallback text paths, not by the HTML path)
  - Only normalizes whitespace (collapse spaces/tabs)
  - Removes leading/trailing spaces on lines
  - Normalizes multiple newlines to double newlines
  - **Preserves markdown syntax:** `**`, `*`, `_`, `|`, `#`, `-`, etc.

- **`getPageContent()`:** Orchestrates what gets sent to the backend
  - Netflix (cached titles, ≥50 chars) → `{ contentType: "text" }`
  - Otherwise → `getRenderedHTML()`, capped at `MAX_HTML_LENGTH` (2,000,000 chars, kept in sync with the backend's own limit) → `{ contentType: "html" }`
  - HTML empty or oversized → `extractFallback()`, capped at `MAX_CONTENT_LENGTH` (8000 chars) → `{ contentType: "text" }`
  - Returns `{ title, contentType, content }` - title and content are no longer flattened into one string here

- **Message Listener:** Responds to `GET_PAGE_CONTENT` messages from popup
  - Synchronous response (no async/await issues)
  - Replies with `{ success, title, contentType, content }`
  - Includes error handling

### File: `frontend/src/background.ts`

**Location:** `/home/kavleen/Desktop/webwhiz/frontend/src/background.ts`

**Purpose:** Message handler between popup and backend API

**Key Functions:**
- **`streamAnswer(content, contentType, title, question, tabId)`:** Main handler for AI requests
  - Fetches from `http://localhost:8000/explain-stream` with `{ text: content, content_type: contentType, title, question, action: "explain" }`
  - `content` may be plain text or the page's rendered HTML - the backend, not this function, decides whether Trafilatura extraction is needed and combines `title`/`question` into the final prompt
  - Reads SSE stream (Server-Sent Events)
  - Parses `data: <json-encoded chunk>` lines, `JSON.parse()`s the payload (reverses the backend's `json.dumps`) to recover real newlines untouched
  - Does **not** trim or re-space the chunk — whitespace at chunk boundaries is meaningful markdown structure and is forwarded as-is
  - Broadcasts chunks back to popup

- **`broadcastResponse(message)`:** Send response to all runtime listeners
  - Uses `chrome.runtime.sendMessage()` (not tabs)
  - Catches errors silently (listener may be gone)
  - Messages: RESPONSE_CHUNK, RESPONSE_DONE, RESPONSE_ERROR

- **Message Listener:** Catches `GET_ANSWER` from popup
  - Reads `content`, `contentType`, `title`, `question` from the message (no pre-combined `text` field anymore)
  - Calls `streamAnswer()`
  - Returns `true` to keep channel open for async response

### File: `frontend/src/popup.ts`

**Location:** `/home/kavleen/Desktop/webwhiz/frontend/src/popup.ts`

**Purpose:** Main UI - conversation interface with loading animation

**Key Functions:**
- **`loadPageContent()`:** When popup opens, request page content from content script
  - Uses `chrome.tabs.sendMessage()` with GET_PAGE_CONTENT
  - Stores the response across three separate variables: `pageContent`, `pageContentType` (`"html"` | `"text"`), `pageTitle` - no longer flattened into one string

- **`submit()`:** User submits a question
  - Sends `{ content: pageContent, contentType: pageContentType, title: pageTitle, question: userQuestion }` to the background worker as a `GET_ANSWER` message
  - The popup itself does **not** glue page content and the question together anymore - `build_cleaned_text()` on the backend does that after any needed Trafilatura extraction, so raw HTML never gets a plain-text question string awkwardly appended to it before parsing
  - Shows user message immediately
  - Starts loading animation (teacup with rotating text)

- **`renderMarkdown(text)`:** Convert markdown to beautiful HTML
  - Primary: Uses `marked.parse()` from the **bundled** `marked` npm package (v18, imported directly — not loaded from a CDN; GFM/tables on by default, `gfm`/`breaks` set explicitly)
  - Fallback (only if `marked.parse()` throws): `basicMarkdownToHTML()` with regex patterns for headers, bold, italic, code, lists, **and GFM-style pipe tables**
  - Handles both strategies seamlessly

- **`showLoading()`:** Display teacup animation
  - Creates loading message with icon
  - Cycles through: "boiling" → "brewing" → "teaying" → "sipping" → "vibing"
  - Updates every 600ms
  - Shows immediately on submit

- **`stopLoading()`:** Remove loading animation
  - Called once when first chunk arrives
  - Stops animation interval instantly
  - Response displays immediately

- **Response Handler:** Listen for chunks from background
  - RESPONSE_CHUNK: Accumulates in `data-raw-text` attribute, renders markdown
  - Display chunks immediately (no 5-second delay)
  - Supports headers, bold, italic, tables, code blocks, blockquotes
  - RESPONSE_DONE: Stop button, re-enable submit
  - RESPONSE_ERROR: Show error message

---

## Message Passing Flow

### Step-by-Step Message Flow

1. **Popup Opens** → `loadPageContent()` calls `chrome.tabs.sendMessage(GET_PAGE_CONTENT)`
2. **Content Script** → Receives message, captures the rendered DOM (`getRenderedHTML()`) or Netflix/fallback plain text - does **not** run any extraction itself, sends `{ title, contentType, content }` back
3. **Popup Receives** → Stores `pageContent` / `pageContentType` / `pageTitle` separately for later use
4. **User Submits** → Sends `GET_ANSWER` to background with `{ content: pageContent, contentType: pageContentType, title: pageTitle, question: userQuestion }` (nothing concatenated client-side)
5. **Background** → Receives GET_ANSWER, calls `streamAnswer(content, contentType, title, question, tabId)`, fetches from `/explain-stream` with `{ text, content_type, title, question, action }`
6. **Backend** → `build_cleaned_text()` runs Trafilatura extraction if `content_type == "html"`, then prepends the title and appends the question; checks cache on the result, calls Groq/OpenAI if needed, streams SSE chunks
7. **Background Parses** → Reads SSE stream, extracts chunks, broadcasts via `chrome.runtime.sendMessage()`
8. **Popup Accumulates** → Catches RESPONSE_CHUNK messages, appends each chunk to `data-raw-text` immediately, and re-renders markdown on every chunk (no artificial delay)
9. **Complete** → Receives RESPONSE_DONE, removes loading animation, shows full response

---

## Markdown Rendering System

### Two-Tier Architecture

**Primary Renderer: marked (bundled via npm)**
- Installed as a real dependency (`npm install marked`) and imported directly: `import { marked } from "marked"` in `popup.ts`
- Bundled into the extension's JS at build time by Vite/@crxjs — **not** loaded from a CDN `<script>` tag (see [Case Study](#case-study-fixing-the-broken-faq-table) for why that mattered)
- Full markdown spec support incl. GFM (`gfm: true`, `breaks: true` set explicitly)
- Handles headers, bold, italic, code, lists, tables, blockquotes

**Fallback Renderer: basicMarkdownToHTML()**
- Only activates if `marked.parse()` throws (belt-and-suspenders, not the primary path anymore)
- Regex-based conversion
- Handles: `#` headers, `**bold**`, `*italic*`, `` `code` ``, `- lists`, and GFM-style pipe tables (`| a | b |` / `|---|---|` blocks → real `<table>`/`<th>`/`<td>`)
- Escapes HTML properly
- Ensures graceful degradation

### Feature Support

| Element | Support | Styling |
|---------|---------|---------|
| Headers (h1-h6) | ✅ | Primary color, bold, h1 has border |
| Bold/Strong | ✅ | Primary color, font-weight 700 |
| Italic/Emphasis | ✅ | Light text color, italic style |
| Inline Code | ✅ | Light background, primary color |
| Code Blocks | ✅ | Dark background, left border |
| Unordered Lists | ✅ | Bullets in primary color |
| Ordered Lists | ✅ | Numbers in primary color |
| Tables | ✅ | Clean design, no borders, subtle dividers |
| Blockquotes | ✅ | Left border, light background, italic |
| Horizontal Rule | ✅ | Subtle border styling |
| Links | ✅ | Primary color with underline |

---

## Netflix Dynamic Monitoring

### Why MutationObserver?

Netflix loads content dynamically as user scrolls and interacts. Content doesn't exist when page first loads.

**Solution: Real-time monitoring**
- Watch for DOM changes
- Extract titles when they appear
- Cache results to avoid redundant API calls
- Intelligent debouncing to prevent performance issues

### How It Works

1. **Page Loads** → Content script starts
2. **Setup Monitoring** → MutationObserver watches document.body
3. **Wait for Render** → 2-second delay for Netflix UI to render
4. **Detect Changes** → Every DOM mutation triggers extraction
5. **Debounce** → 1-second delay prevents spam on hundreds of mutations
6. **Extract Titles** → Look for `aria-label` attributes with show/movie names
7. **Cache** → Store in `latestNetflixContent` variable
8. **Return** → User asks question, gets cached Netflix list instantly

### Performance Optimization

| Strategy | Benefit |
|----------|---------|
| **Debouncing (1sec)** | Thousands of mutations → single extraction |
| **Caching** | Avoid redundant extraction on user questions |
| **Filtered Selectors** | Only look for title-like aria-labels |
| **Text Filtering** | Remove UI text ("Play", "Menu", etc.) |

---

## Content Extraction Strategy

### Decision History

1. **Originally considered:** Defuddle (Node.js-only, not browser-native - ruled out early)
2. **Then used:** [Mozilla Readability](https://github.com/mozilla/readability) running *inside the content script*, on the live page's DOM
3. **Now using:** the content script forwards the browser's **rendered DOM** (`outerHTML`, captured after the page's own JS has run) to the backend, which runs **Trafilatura** (Python) to do the actual article extraction

Readability-in-the-browser worked fine, but every extraction-quality improvement meant shipping a new extension build. Moving extraction server-side means it can be tuned/improved without touching the extension at all - the content script's job shrank to "capture the DOM as-is and send it."

### Why not have the backend just fetch the URL itself?

The obvious-looking simpler design would be:

```
FastAPI → requests.get(url) → Trafilatura → clean text
```

This was deliberately **rejected**. A plain server-side `requests.get()` only ever receives the page's *initial* HTML - for a JS-rendered SPA (Netflix, a React app, etc.) that's a near-empty shell; the actual content only exists after the page's own JavaScript runs (hydration, client-side routing, API calls filling in the DOM). The backend has no browser, so it can't render any of that.

The design actually used instead:

```
Browser (already rendering the page)
   │  rendered DOM (outerHTML, post-hydration)
   ▼
Content Script  →  FastAPI  →  Trafilatura  →  clean text
```

The browser is doing exactly the JS-execution work it was already doing anyway; the content script just captures the result *after* that work is done and hands it to the backend. Trafilatura then only ever has to parse fully-hydrated HTML, never a pre-render shell - which is what makes this work uniformly for both a static blog post and a React/Netflix-style page.

### Where Trafilatura runs, and on what

| Aspect | Detail |
|--------|--------|
| **Runs where** | Backend (`backend/main.py`, `extract_clean_text()`), not the browser |
| **Input** | The content script's `document.documentElement.outerHTML`, captured post-render (`<script>`/`<style>`/`<noscript>` stripped client-side first, purely to shrink payload size) |
| **Output format** | `markdown` (`output_format="markdown"`) - preserves headings/lists/tables the same way the old Readability + custom HTML-to-text traversal tried to |
| **Options** | `include_tables=True`, `include_links=False`, `include_comments=False`, `favor_recall=True` |
| **Size guard** | Backend rejects (`413`) HTML payloads over `MAX_HTML_LENGTH` (2,000,000 chars); content script also gives up and falls back to plain DOM text client-side above the same threshold, rather than sending a payload it knows will be rejected |
| **Failure mode** | If Trafilatura returns nothing usable, the backend responds `422 Could not extract readable content from the page HTML` rather than silently sending empty content to the LLM |

### Netflix is a deliberate exception

Trafilatura is built to find "the article" on a page - it has no way to make sense of Netflix's UI (rows of thumbnails, no article body). Netflix keeps its own dedicated path: the content script scrapes `aria-label` attributes via `MutationObserver` (unchanged from before) and sends that back as plain text (`contentType: "text"`), skipping HTML capture and backend extraction entirely for that domain.

---

## Text Extraction Pipeline (Complete Flow)

### High-Level Flow Diagram

This flow now spans **two processes** - the content script only captures, the backend extracts:

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER OPENS POPUP                             │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
        ┌────────────────────────────────────┐
        │  popup.ts: loadPageContent()        │
        │  Requests page content from        │
        │  content script via message        │
        └─────────────┬──────────────────────┘
                      │
                      │ chrome.tabs.sendMessage()
                      │ Type: "GET_PAGE_CONTENT"
                      ▼
        ┌────────────────────────────────────────┐
        │  content.ts: getPageContent()           │
        │  CAPTURE only - no article extraction  │
        │  happens in the browser anymore        │
        │  (See detailed pipeline below)         │
        └─────────────┬──────────────────────────┘
                      │
                      ▼
        ┌──────────────────────────────────────────────────┐
        │         CAPTURE PIPELINE (content.ts)             │
        │                                                   │
        │  1️⃣ Check if on Netflix?                         │
        │     → extractNetflix() (cached titles)           │
        │     → If >50 chars: RETURN as contentType "text" │
        │                                                   │
        │  2️⃣ Otherwise, capture the rendered DOM          │
        │     → getRenderedHTML()                           │
        │     → Clone document, strip script/style/noscript│
        │     → If non-empty and ≤ MAX_HTML_LENGTH:        │
        │       RETURN outerHTML as contentType "html"     │
        │       (Trafilatura extraction happens BACKEND-   │
        │        SIDE on this - see below)                 │
        │                                                   │
        │  3️⃣ HTML empty or too large → fallback           │
        │     → extractFallback()                           │
        │     → Try: <article>, <main>, .main-content      │
        │     → cleanText(), capped at MAX_CONTENT_LENGTH  │
        │     → RETURN as contentType "text"                │
        │                                                   │
        └────────┬────────────────────────────────────────┘
                 │
                 ▼
        ┌──────────────────────────────────────┐
        │  Send { title, contentType, content }│
        │  back to popup.ts via sendResponse   │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────────┐
        │  popup.ts stores title/contentType/content│
        │  separately - NOT flattened into one      │
        │  string. Ready for user to ask a question │
        └──────────────┬─────────────────────────────┘
                       │
                       │ (user submits a question - see
                       │  Complete User Question Flow below)
                       ▼
        ┌──────────────────────────────────────────┐
        │  backend/main.py: build_cleaned_text()    │
        │  If contentType == "html":                │
        │    extract_clean_text() runs Trafilatura  │
        │    on the rendered HTML - THIS is where   │
        │    "main content" actually gets pulled    │
        │    out, not in the browser                │
        │  Then prepends title, appends question    │
        └────────────────────────────────────────────┘
```

---

## Text Extraction Pipeline (Detailed)

### Step 1: Netflix Detection & Extraction

**Function:** `extractNetflix()` + `setupNetflixMonitoring()`

```
Is page Netflix?
├─ YES → Use cached Netflix titles (via MutationObserver)
│  ├─ Look for aria-label attributes
│  ├─ Filter UI text ("Play", "Menu", etc.)
│  ├─ Extract show/movie names
│  ├─ Return markdown list: "## 🎬 Netflix Content\n- **Show1**\n- **Show2**"
│  └─ Cached for instant reuse
│
└─ NO → Skip to DOM capture (next step)
```

**Performance:** 
- First visit: Waits 2 seconds for Netflix to render
- Subsequent visits: Instant (cached content)
- Dynamic updates: MutationObserver detects changes, re-extracts with 1-second debounce

---

### Step 2: Rendered-DOM Capture (client) → Trafilatura Extraction (backend)

**Function (browser):** `getRenderedHTML()` — **Function (backend):** `extract_clean_text()`

```
content.ts (browser)                    main.py (backend)
─────────────────────                   ──────────────────
Clone the document
        │
        ▼
Strip <script>/<style>/<noscript>
(payload-size trim only)
        │
        ▼
outerHTML = document.documentElement
.outerHTML  (the browser's OWN
post-JS, post-hydration DOM)
        │
        ▼
≤ MAX_HTML_LENGTH?
        │ yes                          ── sent over HTTP as
        └──────────────────────────────→  { text: html, content_type: "html" }
                                                  │
                                                  ▼
                                        trafilatura.extract(html,
                                          output_format="markdown",
                                          include_tables=True,
                                          include_links=False,
                                          include_comments=False,
                                          favor_recall=True)
                                                  │
                                                  ▼
                                        Non-empty? → clean markdown text
                                        Empty?     → 422 error (no silent
                                                     empty-content prompt)
```

**What this step removes/keeps (via Trafilatura, not Readability):**
- ❌ Navigation menus, sidebar ads, footer links
- ❌ Scripts, comments, tracking pixels
- ✅ Keeps main article/content, headings, lists, tables (as markdown)

Because the HTML comes from the browser's own rendered DOM (not a fresh server fetch), this works the same way for a static blog post and a JS-heavy SPA page.

---

### Step 3: DOM Selector Fallback (client, plain text)

**Function:** `extractFallback()` — only runs when `getRenderedHTML()` came back empty or over `MAX_HTML_LENGTH`

```
Try these selectors in order:
1. <article> tag
2. <main> tag
3. [role='main'] attribute
4. .main-content class
5. .article-content class
6. .post-content class
7. .entry-content class

First match with >100 chars:
├─ Extract innerText
└─ Return result

If no selector matches:
└─ Use document.body.innerText (full page)
```

This is sent to the backend as `contentType: "text"`, so it skips Trafilatura entirely (it's already plain text, not HTML to parse).

---

### Step 4: Text Cleaning (Netflix / fallback text paths only)

**Function:** `cleanText(text)` — not applied to the HTML path; Trafilatura's `output_format="markdown"` already produces clean, structured text server-side.

```
Input: Raw extracted text
        │
        ▼
Replace /[ \t]+/g with single space
        (Collapse multiple spaces/tabs)
        │
        ▼
Replace /\n[ \t]+/g with \n
        (Remove leading spaces on lines)
        │
        ▼
Replace /[ \t]+\n/g with \n
        (Remove trailing spaces on lines)
        │
        ▼
Replace /\n{3,}/g with \n\n
        (Normalize multiple newlines to double)
        │
        ▼
.trim() to remove leading/trailing whitespace
        │
        ▼
Output: Clean, readable text
        (✅ All markdown syntax preserved!)
```

---

## Complete User Question Flow

```
┌────────────────────────────────────────────────────────────┐
│               USER ASKS A QUESTION                         │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────────────────┐
        │  popup.ts: submit()                │
        │  ✅ Show user message immediately │
        │  ✅ Start loading animation        │
        └─────────────┬──────────────────────┘
                      │
                      ▼
        ┌────────────────────────────────────────┐
        │  Send GET_ANSWER with, SEPARATELY:      │
        │  { content: pageContent,                │
        │    contentType: pageContentType,        │
        │    title: pageTitle,                    │
        │    question: userQuestion }             │
        │  (no client-side string concatenation - │
        │   raw HTML never gets a question glued  │
        │   onto it before the backend parses it) │
        └─────────────┬────────────────────────────┘
                      │
                      │ chrome.runtime.sendMessage()
                      │ Type: "GET_ANSWER"
                      ▼
        ┌────────────────────────────────────┐
        │  background.ts: streamAnswer()     │
        │  Fetch from backend /explain-stream│
        │  Method: POST                      │
        │  Content-Type: application/json    │
        │  Body: { text: content,            │
        │    content_type, title, question,  │
        │    action: "explain" }             │
        └─────────────┬──────────────────────┘
                      │
                      ▼
        ┌───────────────────────────────────────────┐
        │        BACKEND (FastAPI)                   │
        │  http://localhost:8000/explain-stream      │
        │                                            │
        │  1. Receive { text, content_type, title,  │
        │     question, action }                     │
        │  2. build_cleaned_text(request):           │
        │     a. content_type == "html"?             │
        │        → extract_clean_text() runs         │
        │          Trafilatura on the rendered HTML  │
        │          (413 if > MAX_HTML_LENGTH,        │
        │           422 if nothing extractable)      │
        │        else use `text` as-is               │
        │     b. Prepend "Page Title: {title}"       │
        │     c. Append "User Question: {question}"  │
        │        (question alone is still valid if   │
        │         page content came back empty)      │
        │  3. Create SHA256 cache key from the        │
        │     combined result of step 2               │
        │  4. Check cache:                            │
        │     ✅ HIT → Stream cached response        │
        │     ❌ MISS → Call Groq/OpenAI API        │
        │  5. Stream response via SSE (whitespace     │
        │     preserved, JSON-encoded per chunk):     │
        │     data: "chunk1 text..."\n\n              │
        │     data: "chunk2\\ntext..."\n\n            │
        │     data: [DONE]\n\n                        │
        │  6. Save response to cache (7-day TTL)     │
        └─────────────┬───────────────────────────────┘
                      │
                      │ SSE Stream
                      ▼
        ┌───────────────────────────────────────┐
        │  background.ts: parseSSE()             │
        │  Split on \n                           │
        │  Extract data: prefix, JSON.parse() it │
        │  (reverses backend's json.dumps escape)│
        │  Broadcast via chrome.runtime.send     │
        │  Type: "RESPONSE_CHUNK"                │
        └─────────────┬─────────────────────────┘
                      │
                      │ chrome.runtime.onMessage
                      ▼
        ┌───────────────────────────────────────┐
        │  popup.ts: Listen for chunks          │
        │  • Append to data-raw-text attribute  │
        │  • renderMarkdown(fullText)           │
        │    ├─ Try: marked.parse() (bundled)   │
        │    └─ Fallback: basicMarkdownToHTML() │
        │  • Set innerHTML with rendered HTML   │
        │  • Scroll to bottom                    │
        └─────────────┬─────────────────────────┘
                      │
                      │ (repeat for each chunk)
                      ▼
        ┌───────────────────────────────────────┐
        │  popup.ts: Receive RESPONSE_DONE      │
        │  ✅ Stop loading animation            │
        │  ✅ Re-enable submit button            │
        │  ✅ Show complete formatted response  │
        └───────────────────────────────────────┘
```

---

## Summary: Browser Captures, Backend Extracts

### Why This Choice?

| Factor | Impact |
|--------|--------|
| **Defuddle** | Node.js library, not browser-native - ruled out from the start ❌ |
| **Readability.js (previous approach)** | Worked, but every extraction-quality tweak required a new extension build ⚠️ |
| **Server-side fetch + Trafilatura (rejected alternative)** | `requests.get(url)` only sees pre-render HTML - breaks on Netflix/React/SPA pages entirely ❌ |
| **Rendered HTML → backend Trafilatura (current)** | Extraction logic lives in one place (backend), improvable without shipping extension updates, and still works on SPA pages because the *browser* did the rendering ✅ |

### What We Extract

1. **Netflix:** Show/movie titles from `aria-label` (real-time monitoring, unchanged) - sent as plain text, bypasses Trafilatura entirely
2. **Regular/SPA Pages:** Content script captures `document.documentElement.outerHTML` post-render; backend's `extract_clean_text()` runs Trafilatura on it
3. **Fallback Pages:** If HTML capture is empty or exceeds `MAX_HTML_LENGTH`, client-side selector/body-text fallback (`extractFallback()`) sent as plain text
4. **Clean Text:** Trafilatura outputs markdown directly for the HTML path; `cleanText()` still handles whitespace normalization for the Netflix/fallback text paths

### Result

Rendered DOM (or Netflix/fallback text) → backend combines title + Trafilatura-extracted content + user's question → Sent to LLM → Beautiful markdown response displayed instantly! 🚀

---

## Streaming & Caching

### SSE (Server-Sent Events) Format

Backend streams responses in SSE format:
- Each chunk: `data: <json-encoded chunk>\n\n` — the chunk text is passed through Python's `json.dumps()` before being written, so any character that would otherwise break a single SSE `data:` line (newlines, but also backslashes/quotes) survives transport intact
- Final marker: `data: [DONE]\n\n`
- Frontend parses by splitting on `\n`, extracting the `data: ` prefix, then reversing the encoding with `JSON.parse()` — see [Case Study](#case-study-fixing-the-broken-faq-table) for why this replaced an earlier hand-rolled `\n` ↔ `\\n` escaper

### Caching Performance

| Scenario | Process | Time |
|----------|---------|------|
| **Cache Hit** | SHA256 hash → lookup → instant ⚡ | ~1ms |
| **Cache Miss** | Hash → miss → API call → stream → save → send | 2-5 sec |

### Cache Storage Format

Dictionary with SHA256 keys:
- Key: `hashlib.sha256(f"{action}:{cleaned_text}")` → 64-char hex, where `cleaned_text` is `build_cleaned_text()`'s output (title + Trafilatura-extracted content + question already combined) - **not** the raw HTML the client sent, so identical page content with different raw markup (or a cache lookup before extraction ever runs) can't produce mismatched keys
- Value: `{ "answer": "...", "timestamp": "ISO string" }`
- Max 5000 entries, FIFO eviction, 7-day TTL

---

## Frontend UI & UX

### Popup Layout

```
┌─────────────────────────────┐
│  TeaWhiz AI                 │
│  Ask about any webpage      │
├─────────────────────────────┤
│                             │
│  User: "What is this page?" │
│                             │
│  🫖 Tea is boiling...       │ ← Loading animation
│                             │
│  AI: # Main Points          │ ← Appears instantly
│  - Point 1                  │   with markdown
│  - Point 2                  │   formatting
│  **Key takeaway**: ...      │
│                             │
│  | Column 1 | Column 2  |   │ ← Clean tables
│  |-----------|-----------|   │   (no ugly borders)
│  | Value 1  | Value 2  |   │
│                             │
├─────────────────────────────┤
│  [Ask...                  ✕] │
│                           ⬆ │
└─────────────────────────────┘
```

### Markdown Rendering Features

**Headers:**
- Primary color `#D85A3A`
- h1 with bottom border
- Proper sizing and spacing

**Emphasis:**
- **Bold** text in primary color
- *Italic* text in lighter color

**Code:**
- Inline code with light background
- Code blocks with left border and dark background
- Monospace fonts (Fira Code, Monaco)

**Lists:**
- Bullets in primary color
- Proper indentation
- Custom markers

**Tables:**
- Clean styling with **no borders**
- Subtle row dividers (1px light lines)
- Header row with 2px primary color underline
- No alternating row colors
- No hover effects

**Blockquotes:**
- Left border in primary color
- Light background
- Italic text with proper spacing

### Styling

**Colors:**
- Primary: `#D85A3A` (orange/brown - teacup)
- Accent: `#F5A442` (orange/gold - steam)
- Dark mode supported via CSS variables
- Automatically adapts to system preference

**Animations:**
- Loading teacup: `floatTeacup 2s ease-in-out infinite`
- Glow effect: `glowEffect 2s ease-in-out infinite`
- Message appearance: `slideIn 0.3s ease`
- Button hover: `scale(1.1)`

**Responsive:**
- Width: 500px fixed
- Height: 600px fixed (scrollable)
- Fonts: System fonts (-apple-system, Segoe UI, Roboto)
- Custom scrollbar styling

---

## Case Study: Fixing the Broken FAQ Table

**Symptom:** Asked the extension for a webpage's FAQs "in table format." Instead of a rendered `<table>`, the response showed the raw markdown as literal text — pipes, dashes, and all squashed onto one line, e.g.:

```
Question | Answer | |---|---------|-------|| 1 | Does BioPharmaSys sit inside
the control loop? | No. It only reads data...
```

This took **three separate, stacked bugs** to fully fix — each one hid the next. All three were found and fixed by walking the pipeline end-to-end: LLM → backend SSE stream → background worker → popup renderer.

### Bug 1 — `marked` was loaded from a CDN `<script>` tag, which Manifest V3 silently blocks

`popup.html` had:
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/13.0.3/marked.min.js"></script>
```
Chrome's default Manifest V3 CSP disallows remotely-hosted code in extensions, so this tag never actually executed — `marked` was `undefined` at runtime. `popup.ts` detected that and silently fell back to `basicMarkdownToHTML()`, a hand-rolled regex converter that had **no table-parsing rule at all** — so a markdown table's raw `| Question | Answer |` text just passed through untouched.

**Fix:**
- `npm install marked` as a real dependency; `import { marked } from "marked"` directly in `popup.ts` so Vite/@crxjs bundles it into the extension's own JS (no remote fetch, works under MV3 policy).
- Removed the CDN `<script>` tag from `popup.html` entirely.
- As a safety net, also taught the regex fallback (`basicMarkdownToHTML()`) to parse GFM-style pipe tables into real `<table>`/`<th>`/`<td>` markup, in case `marked.parse()` ever throws.

### Bug 2 — the backend was destroying every newline before it ever left the server

Even after Bug 1 was fixed, the *exact same symptom* came back on the next test. The real root cause was upstream: `/explain-stream` chunked the LLM's response for streaming with:
```python
words = full_response.split()
chunk = " ".join(words[i:i+15])
yield f"data: {chunk} \n\n"
```
`text.split()` + `" ".join(...)` collapses **every** space, newline, and blank line to a single space — so by the time the text reached the browser, the table rows had no newlines left between them at all. `marked`'s table parser (correctly working after Bug 1) had nothing to parse, because the markdown structure was already gone.

Interestingly, a previous session had already half-fixed this: `chunk_preserving_whitespace()` and `to_sse_data()` existed in `main.py` with a docstring correctly diagnosing the problem — but neither function was ever actually called by the live endpoints.

**Fix:** wired both helpers into `stream_cached()` and `stream_response()` in `backend/main.py`, replacing the collapsing `split()`/`join()` logic.

A second layer of the same bug lived in `background.ts`, which parsed each SSE line with `line.slice(6).trim()` and rebroadcast it as `chunk + " "` — `.trim()` strips exactly the newlines the backend now preserved whenever they land at a chunk boundary, then replaces them with a literal space. **Fix:** stopped trimming/re-spacing chunks in `background.ts`; whitespace is forwarded as-is.

### Bug 3 (hardening) — manual `\n` escaping → JSON encoding

The fix above escaped embedded newlines as literal `\n` two-character sequences (`chunk.replace("\n", "\\n")`) so a multi-line chunk could survive a single SSE `data:` line, unescaped client-side with `raw.replace(/\\n/g, "\n")`. This worked, but it's a narrower fix than it looks — it only handles newlines, and a hand-rolled escaper is easy to get subtly wrong for anything else unusual in the text (backslashes, quotes, etc.).

**Final fix:** replaced the manual escaper with real JSON encoding:
```python
# backend/main.py
def to_sse_data(chunk: str) -> str:
    return json.dumps(chunk)
```
```ts
// frontend/src/background.ts
const chunk = JSON.parse(raw);  // wrapped in try/catch so a bad line logs & skips, doesn't crash the stream
```
The `ERROR: ...` yield path was routed through the same `to_sse_data()` helper too, so every non-`[DONE]` SSE line is valid JSON the client can parse uniformly.

### Verification

Rather than trust it by inspection, the whole `chunk_preserving_whitespace → to_sse_data → SSE wire format → JSON.parse → reassembly` round trip was simulated in isolation (Python generating the SSE bytes, Node parsing them back) against a sample containing a markdown table plus a backslash and a quoted string (to stress the encoding). The reassembled text came back **byte-for-byte identical** to the original.

### One thing that turned out *not* to be a factor

It's tempting to assume the response cache (`save_to_cache`/`get_from_cache`, SHA256-keyed, 7-day TTL) needed clearing for this fix to take effect on a repeated question. It didn't: `save_to_cache` stores the **raw LLM completion text**, before any chunking or SSE-encoding happens — cache entries were never corrupted by Bug 2 or Bug 3, only the streaming *transport* was. Re-asking a cached question re-runs it through the fixed `chunk_preserving_whitespace`/`to_sse_data` on every request regardless of cache hit/miss, so no cache-clearing was actually required. (Restarting the backend process *was* still required, since Python doesn't hot-reload edited code without `--reload` picking it up.)

### Files touched

| File | Change |
|------|--------|
| `frontend/package.json` | Added `marked` as a real dependency |
| `frontend/src/popup.html` | Removed the CDN `<script src="...marked.min.js">` tag |
| `frontend/src/popup.ts` | `import { marked } from "marked"`; simplified `renderMarkdown()`; added table support to `basicMarkdownToHTML()` fallback |
| `backend/main.py` | Wired `chunk_preserving_whitespace()`/`to_sse_data()` into both stream endpoints; switched `to_sse_data()` to `json.dumps`; routed the `ERROR:` yield through it too |
| `frontend/src/background.ts` | Stopped `.trim()`-ing / re-spacing chunks; switched from manual `\n` unescaping to `JSON.parse()` with a try/catch guard |

---

## Running the Extension

### Quick Start

```bash
# 1. Start backend
cd /home/kavleen/Desktop/webwhiz/backend
source venv/bin/activate
python -m uvicorn main:app --reload --port 8000

# 2. In another terminal, build frontend
cd /home/kavleen/Desktop/webwhiz/frontend
npm run build

# 3. Load in Chrome
# - Go to chrome://extensions
# - Toggle "Developer mode" (top right)
# - Click "Load unpacked"
# - Select frontend/dist/

# 4. Test
# - Go to any website
# - Click TeaWhiz AI extension icon
# - Type a question
# - See loading animation (teacup with rotating text)
# - Response appears instantly with beautiful markdown formatting!
```

### Verification Checklist

- [ ] Backend running on http://localhost:8000
- [ ] `/health` endpoint responds
- [ ] Frontend builds without errors
- [ ] Extension loads in chrome://extensions
- [ ] Extension icon visible
- [ ] Click extension icon → popup opens
- [ ] Ask a question about current page
- [ ] Loading animation appears (teacup with rotating text)
- [ ] Response appears instantly with markdown formatting
- [ ] Headers, bold, italic, code blocks render beautifully
- [ ] Tables display with clean styling (no ugly borders)
- [ ] Multiple questions work
- [ ] Cache works (2nd identical question is instant)
- [ ] Netflix titles extract correctly with MutationObserver
- [ ] Dark mode works automatically

---

## Troubleshooting

### Backend Issues

**Error: `TypeError: Failed to fetch`**
- ❌ Backend not running
- ✅ Start backend: `python -m uvicorn main:app --reload`

**Error: `net::ERR_CONNECT_FAILED`**
- ❌ Backend not accessible on localhost:8000
- ✅ Check firewall, port number, backend process

**Error: `GROK_API_KEY not configured`**
- ❌ `.env` file missing or empty
- ✅ Add to `backend/.env`: `GROK_API_KEY=gsk_YOUR_KEY`

**Error: `422` with a `"String should have at most N characters"` detail** (previously `413 Rendered HTML exceeds ... characters`)
- ❌ One of `ExplainRequest`'s fields exceeded its length cap: `text` > `MAX_HTML_LENGTH` (2,000,000 chars, applies regardless of `content_type` - so this now also catches oversized plain-text payloads, not just HTML), `question` > `MAX_QUESTION_LENGTH` (2,000 chars), or `title` > `MAX_TITLE_LENGTH` (500 chars). These are enforced by Pydantic `Field(max_length=...)` on `ExplainRequest` (`main.py:139-149`) at the request-body validation layer, so FastAPI returns a generic `422` automatically before the route handler ever runs - there's no longer a custom `413` for the HTML case specifically.
- ✅ For an oversized `text`: the content script is supposed to catch this itself and fall back to `extractFallback()` plain text before sending - if you see this from the backend for HTML content, check `content.ts`'s `MAX_HTML_LENGTH` is still in sync with `main.py`'s
- ✅ For an oversized `question`/`title`: these are new caps (added to close a gap where plain-text/question/title payloads had no size limit at all - see [Known Weaknesses](#known-weaknesses--limitations)) - if a legitimate use case needs a longer question or title than 2,000/500 chars, raise `MAX_QUESTION_LENGTH`/`MAX_TITLE_LENGTH` in `main.py` rather than removing the cap entirely

**Error: `422 Could not extract readable content from the page HTML`**
- ❌ Trafilatura ran on the rendered HTML but found nothing it considered main content (very sparse page, or a layout it doesn't recognize as an article)
- ✅ Not necessarily a bug - some pages genuinely have no "article" for Trafilatura to find. Confirm by testing the same HTML directly: `python3 -c "import trafilatura; print(trafilatura.extract(open('page.html').read()))"`
- ✅ If this happens often on a specific site, consider adding a dedicated extraction path for it (as was done for Netflix) rather than relying on generic extraction

**Backend fails to import `trafilatura` (`ImportError: lxml.html.clean module is now a separate project`)**
- ❌ `lxml` ≥ 5 split `lxml.html.clean` into a separate `lxml_html_clean` package, which `justext` (a Trafilatura dependency) still imports directly
- ✅ Install it: `pip install lxml_html_clean` (already pinned in `backend/requirements.txt`)

### Frontend Issues

**Extension won't load**
- ❌ `npm run build` failed
- ✅ Check for TypeScript errors, rebuild

**Popup won't open**
- ❌ Extension disabled or corrupted
- ✅ Try reloading extension in chrome://extensions

**No page content extracted**
- ❌ Content script not running, or `getRenderedHTML()` returned nothing
- ✅ Check DevTools Console → look for `[TeaWhiz] Content script loaded`
- ✅ Verify `run_at: "document_idle"` in manifest
- ✅ Check the popup's console for the logged `contentType`/content length from `loadPageContent()` - if `contentType` is `"html"` but the answer looks off-topic, the issue is likely on the backend side (Trafilatura extraction), not the capture step; check the backend logs for a `422`

**Response not appearing**
- ❌ Backend connection failed (see Network tab)
- ❌ Response chunks not being parsed
- ✅ Check DevTools Console for streaming logs
- ✅ Open Network tab → /explain-stream request → Response tab

**Markdown not rendering (showing literal `**bold**`)**
- ❌ `marked.parse()` threw an error on this input
- ✅ Check the console for "[TeaWhiz] Markdown rendering error" — the regex fallback (`basicMarkdownToHTML()`) activates automatically and should still render most formatting
- Note: `marked` is bundled into the extension's JS at build time (not loaded from a CDN), so a network/CDN block is no longer a possible cause here — see [Case Study](#case-study-fixing-the-broken-faq-table)

**Tables showing as literal pipe text (e.g. `| Q | A | |---|---|`) instead of a real table**
- ❌ Most likely cause: markdown structure (real newlines between rows) got collapsed somewhere before `marked.parse()` ever saw it — check the SSE stream in the Network tab for the raw `data: ...` payloads and confirm they still contain `\n` inside the JSON-encoded chunk strings
- ✅ See the full writeup in [Case Study: Fixing the Broken FAQ Table](#case-study-fixing-the-broken-faq-table) — this exact symptom took three stacked bugs (CDN-blocked `marked`, whitespace-collapsing SSE chunking, and a fragile manual newline escaper) to fully resolve

**Tables showing with ugly borders**
- ❌ CSS not loaded properly
- ✅ Check that popup.html is loading correctly
- ✅ Rebuild extension: `npm run build`
- ✅ Reload extension in chrome://extensions

**Netflix titles not appearing**
- ❌ Content script may not be monitoring correctly
- ❌ Netflix content loading too slow
- ✅ Wait a few seconds for Netflix to render content
- ✅ Trigger re-extraction by scrolling (MutationObserver will detect)
- ✅ Check console for "[TeaWhiz] Netflix content updated" messages

### Debugging Tips

**1. Check Console Logs**
```
DevTools → Console tab
Look for: [TeaWhiz] prefixed logs
```

**2. Check Network Tab**
```
DevTools → Network tab
Filter: /explain-stream
Check Status (should be 200)
Check Response (should show SSE chunks)
```

**3. Inspect Elements**
```
DevTools → Elements tab
Find: #responseContent element
Should have textContent accumulating chunks
```

**4. Backend Logs**
```
Terminal running backend
Should show streaming logs
```

---

## Summary

### What We Built

✅ **Chrome Extension** with beautiful popup UI that:
- Captures the page's own rendered DOM (post-JS) for the backend to extract - plus dedicated Netflix real-time monitoring
- Monitors Netflix in real-time with MutationObserver
- Sends page content, title, and question to the backend as separate fields (no client-side prompt-gluing)
- Displays streaming responses instantly (no 5-second delay)
- Shows beautiful markdown formatting (headers, bold, code, tables)
- Renders tables cleanly without ugly borders
- Shows loading animation with teacup icon and rotating text
- Supports multiple questions and conversation history

✅ **FastAPI Backend** that:
- Runs Trafilatura on the browser's rendered HTML to extract main content ([Content Extraction Strategy](#content-extraction-strategy)) - the key reason SPA/React pages like Netflix work at all, since it never does its own `requests.get()`
- Integrates with Groq/OpenAI APIs
- Caches responses (7-day TTL)
- Streams responses via SSE
- Handles errors gracefully (including `413`/`422` for oversized or unextractable HTML)
- Validates inputs

✅ **Message Architecture** that:
- Connects content script → background → popup
- Handles async/await patterns properly
- Prevents race conditions
- Logs everything for debugging

✅ **Beautiful UI/UX** with:
- Markdown rendering via marked (bundled via npm) + regex fallback
- Theme-aware design (light/dark mode)
- Conversation-style messaging
- Message animations (slide-in effect)
- Teacup icon and floating animations
- Clean, minimal aesthetic

### Files Structure

```
webwhiz/
├── CODE.md (← You are here)
├── code.md (Quick reference guide)
├── backend/
│   ├── main.py (FastAPI backend + Trafilatura extraction)
│   ├── requirements.txt (now includes trafilatura, lxml_html_clean)
│   ├── .env (API keys)
│   └── venv/
├── frontend/
│   ├── src/
│   │   ├── manifest.json (Extension config v3)
│   │   ├── content.ts (Rendered-DOM capture + Netflix monitoring - no extraction library)
│   │   ├── background.ts (Message handler)
│   │   ├── popup.ts (UI, streaming, markdown rendering)
│   │   └── popup.html (UI structure & styling)
│   ├── public/
│   │   └── icon.png (TeaWhiz logo)
│   ├── vite.config.ts (Build config)
│   └── dist/ (← Load unpacked from here)
```

### Recent Updates (Reliability Session)

🔧 **Fixed Trafilatura blocking the event loop** - `build_cleaned_text()` is now `async` and runs extraction via `asyncio.to_thread`, matching the pattern already used for the Groq call - see [Known Weaknesses](#known-weaknesses--limitations)
🔁 **Added retry/backoff + model fallback to `/explain-stream`** - previously only `/explain` had rate-limit resilience; both endpoints now share `_call_groq_with_fallback()`
🤖 **Wired up `FALLBACK_MODEL`** - `allam-2-7b` is now a real fallback if the primary model (`openai/gpt-oss-120b`) is rate-limited past its retry budget or hard-errors
🧹 **Removed the unused `redis` dependency** - it was never imported anywhere; the cache is (and remains) an in-process dict

### Recent Updates (Latest Session)

🔀 **Content extraction moved from client-side Readability.js to server-side Trafilatura** - the content script now only captures the browser's rendered DOM (`outerHTML`, post-hydration) and forwards it; `backend/main.py`'s `extract_clean_text()`/`build_cleaned_text()` do the actual extraction, plus combine title/question server-side instead of the popup gluing strings together. Deliberately still avoids having the backend fetch URLs itself (`requests.get`), since that would break on SPA/React pages like Netflix - see [Content Extraction Strategy](#content-extraction-strategy). `@mozilla/readability` dependency removed.  
🐛 **Fixed markdown tables rendering as literal pipe text** - see [Case Study](#case-study-fixing-the-broken-faq-table) for the full three-bug investigation  
📦 **`marked` bundled via npm instead of CDN** - required for Manifest V3 compliance, and was silently failing before  
🔧 **SSE streaming now preserves whitespace** - `chunk_preserving_whitespace()` + JSON-encoded (`json.dumps`/`JSON.parse`) chunks replace the old whitespace-collapsing `split()`/`join()` logic  
✨ **Removed 5-second animation delay** - Responses display instantly  
🎨 **Added beautiful markdown rendering** - marked (bundled) + regex fallback, both with table support  
📺 **Netflix real-time monitoring** - MutationObserver with debouncing  
📊 **Clean table styling** - No borders, subtle dividers  
🎯 **Enhanced markdown CSS** - Headers, code blocks, blockquotes  
🌙 **Dark mode support** - Automatic theme detection  

### Next Steps

1. ✅ Verify backend is running
2. ✅ Build frontend: `npm run build`
3. ✅ Load extension: chrome://extensions → Load unpacked
4. ✅ Test on real websites (all core features working!)
5. ⏳ Deploy backend to cloud (Render/Railway)
6. ⏳ Update backend URL for production
7. ⏳ Submit to Chrome Web Store

---

**Last Updated:** September 3, 2026  
**Status:** Core functionality complete and tested ✅  
**Feature Complete:** ✨ Instant responses, beautiful markdown (tables included), Netflix monitoring, server-side Trafilatura extraction on browser-rendered HTML, async-safe extraction, rate-limit retry + model fallback on both endpoints  
**Next Phase:** Cloud deployment and Chrome Web Store submission (see [Known Weaknesses](#known-weaknesses--limitations) for the gap list to work through first)

---

## Known Weaknesses & Limitations

An honest list of where the current design is thin - found by re-reading the actual code, not hypothetical. Several of these were introduced or made worse by the Trafilatura migration; a few have since been fixed (see below), most haven't.

### ✅ Recently Fixed

| Weakness | Fix |
|----------|-----|
| **Trafilatura extraction blocked the event loop** | `build_cleaned_text()` is now `async` and calls `extract_clean_text()` via `await asyncio.to_thread(...)` (`main.py:207`, `:233`) - same pattern already used for the Groq call. Both `/explain` and `/explain-stream` now `await build_cleaned_text(request)`. |
| **`/explain-stream` had zero rate-limit resilience** | It previously called Groq directly with no retry logic (only `/explain` had it). Both endpoints now go through `_call_groq_with_fallback()` (`main.py:332`), which reuses `_call_groq_with_retry()`'s exponential backoff. |
| **`FALLBACK_MODEL` and `redis` were declared but unused** | `FALLBACK_MODEL` is now wired via `_call_groq_with_fallback()` (`main.py:332`): if `PRIMARY_MODEL` is still rate-limited past its retry budget or hard-errors, it falls back once to `FALLBACK_MODEL`. The unused `redis==5.0.1` dependency was removed from `requirements.txt` entirely (actually integrating a real Redis-backed cache would require provisioning external infra - an Upstash/Redis instance and `REDIS_URL` - which is a deployment decision, not a code fix, so it was deleted rather than left as dead weight). |
| **No size cap on `text`, `question`, or `title`** | `MAX_HTML_LENGTH` used to only guard `content_type == "html"` payloads; plain text, `question`, and `title` had no limit. `ExplainRequest` now has `Field(max_length=...)` on all three (`main.py:139-149`): `text` capped at `MAX_HTML_LENGTH` (2,000,000, regardless of `content_type`), `question` at the new `MAX_QUESTION_LENGTH` (2,000), `title` at the new `MAX_TITLE_LENGTH` (500). Enforced by Pydantic before the route handler runs, so the old manual `413` check in `build_cleaned_text()` (which would now be unreachable dead code) was removed - an over-limit request gets a generic `422` instead. |

### Performance / Concurrency

| Weakness | Detail |
|----------|--------|
| **Extraction re-runs per question, not per page** | The cache key is SHA256 of the *final combined* `action:cleaned_text` (title + extracted content + question). Two different questions about the same page currently re-run Trafilatura from scratch each time, since there's no separate cache keyed on just the raw HTML/extracted content. |
| **Bigger payload than before** | Sending full rendered `outerHTML` (up to 2,000,000 chars) is much heavier over the wire than the old client-extracted text (capped at 8,000 chars). Slower on weak connections, more data per question. |
| **`query_normalizer`'s SymSpell dictionary load isn't offloaded** | `_get_sym_spell()` (`query_normalizer.py:150`, `lru_cache`d) does a real, if small ("tens of ms" per its own docstring), synchronous dictionary load on its first call, and `/normalize-query` (`main.py:399`, fires on every space keypress) calls into it directly inside an `async def` with no `asyncio.to_thread`. Same *class* of bug as the Trafilatura one above, just far smaller and one-time-only. |

### Security / Privacy

| Weakness | Detail |
|----------|--------|
| **Wider data-exposure surface** | The old pipeline only ever sent *visible, Readability-extracted article text* off the browser. The new pipeline sends the **entire rendered DOM** (minus `<script>`/`<style>`/`<noscript>`) to the backend, and Trafilatura's output can include text from hidden elements, prefilled form/input values, `aria-*` attributes, and other DOM content a user never intended to share - all of which then also goes to Groq's API. This is a real regression in blast radius for sensitive pages (banking, webmail, internal tools) that hasn't been mitigated (e.g. stripping `<input>`/`<form>` values or `hidden`/`aria-hidden` subtrees before sending). |
| **CORS is not authentication** | `ALLOWED_ORIGINS` only stops *browser-enforced* cross-origin `fetch()` calls. Anyone who knows the backend URL can call `/explain-stream` directly with `curl` or server-to-server, bypassing CORS entirely and burning Groq quota. There's no API key, token, or rate limit on the backend itself - see the payload-size gap above, which makes this worse than it looks. |
| **`BACKEND.md`/`README.md` describe a different, never-shipped backend** | Both docs describe an earlier design (project named "SamajhLo", Google Gemini instead of Groq, `allow_origins=["*"]` CORS, a Redis-backed rate limiter keyed on a nonexistent `install_id` field). None of that matches the actual shipped `main.py`. Anyone onboarding from those docs instead of this one would believe rate-limiting/Redis caching already exists. |

### Reliability / Robustness

| Weakness | Detail |
|----------|--------|
| **No fallback when Trafilatura fails** | If `trafilatura.extract()` returns empty, the request just fails with `422` for that page - there's no server-side fallback chain (e.g. try `<article>`/`<main>` selectors, or the raw text) the way the old client pipeline had four stacked fallback layers (Netflix → Readability → selectors → body text). |
| **Netflix-style handling doesn't generalize** | Only Netflix gets a dedicated extraction path and a `MutationObserver` for dynamically-loaded content. Other heavy-SPA / infinite-scroll sites (X/Twitter, Instagram, YouTube comments, etc.) get neither - they go through generic Trafilatura, which may return sparse or unhelpful results, and the content script only captures **one DOM snapshot** at the moment the popup opens (no re-render capture for anything other than Netflix). |
| **In-memory-only cache** | Response cache is a plain dict inside one process: lost on every restart, and won't work correctly if the backend is ever scaled to multiple workers/processes (each would have its own separate cache). Only worth revisiting with a real cache backend (Redis or otherwise) if/when actually deployed with multiple workers - don't reflexively re-add the `redis` dependency just removed above. |
| **Loading animation doesn't reset on the 2nd+ question in the same session** | `popup.ts`'s `hasStoppedLoading` flag is set `true` once `stopLoading()` runs and is **never reset to `false`** in `submit()`. Starting with the 2nd question in a session, the `RESPONSE_CHUNK` handler's `if (!hasStoppedLoading)` guard is already false, so the "Tea is boiling…" animation stays on screen for the entire streaming duration instead of clearing on the first chunk. Fix: set `hasStoppedLoading = false` at the top of `submit()`. |
| **Unreachable dead-code path in the popup's `GET_ANSWER` callback** | `background.ts`'s `GET_ANSWER` handler kicks off `streamAnswer()` and returns `true` (promising an async `sendResponse`) but never actually calls `sendResponse()`. The corresponding callback in `popup.ts`'s `submit()` - which has its own `stopLoading()`/error-message logic - is therefore unreachable; all real answer/error handling happens through the separate `RESPONSE_CHUNK`/`RESPONSE_DONE`/`RESPONSE_ERROR` broadcasts. Harmless today, but misleading dead code that reads as load-bearing. |

### Engineering Hygiene

| Weakness | Detail |
|----------|--------|
| **`MAX_HTML_LENGTH` is duplicated, not shared** | The same `2_000_000` limit is hand-copied into both `frontend/src/content.ts` and `backend/main.py`, kept in sync only by a code comment ("keep in sync with backend..."). Nothing enforces this at build/test time, so the two can silently drift. |
| **Zero automated test coverage** | There is no test suite anywhere in the repo (frontend or backend). Highest-value untested code: `query_normalizer.normalize_query()` (the most algorithmically complex pure function in the repo), the `chunk_preserving_whitespace()`/`to_sse_data()` round-trip (exactly the regression class from the [FAQ-table case study](#case-study-fixing-the-broken-faq-table)), and `build_cleaned_text()`'s title/question/content combination logic. |
| **Extraction only exercised on hand-written test HTML** | The Trafilatura migration has been verified against one synthetic HTML snippet end-to-end, not against a real spread of site types (paywalled articles, infinite-scroll feeds, login-gated pages, non-English content, heavily animated layouts). Real-world extraction quality is currently unverified beyond that. |
| **No-op exception handling** | `_call_groq_with_retry()`'s `except APIError as e: raise e` (`main.py:329`) catches and immediately re-raises the identical exception with no added behavior (no logging, unlike the `RateLimitError` branch two lines above it). Either drop the clause or add the logging that looks like it was intended. |
| **Unused `tabId` parameter** | `streamAnswer(..., tabId: number)` (`background.ts:18`) is plumbed all the way from `sender.tab?.id` but never referenced in the function body - `broadcastResponse()` fans out to all runtime listeners, not a specific tab. Dead parameter. |
| **Unused frontend dependencies** | `@types/react` and `@types/react-dom` sit in `frontend/package.json` devDependencies with zero React/JSX usage anywhere in `frontend/src` (no `.tsx` files exist) - leftover from an earlier scaffold. |
| **Verbose, unconditional debug logging** | Dozens of `console.log` calls (`content.ts`, `background.ts`, `popup.ts`) fire on every normal use, including full page-content/answer text, none gated behind a debug flag. Not a security issue by itself, but console noise and a "looks unfinished" hygiene issue for any user who opens DevTools. |

None of these are blockers for personal/local use, but they're the honest gap list before wider deployment (cloud hosting, Chrome Web Store, multiple users) mentioned in [Next Steps](#next-steps).
