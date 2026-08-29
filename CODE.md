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
11. [Running the Extension](#running-the-extension)
12. [Troubleshooting](#troubleshooting)

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
- 🤖 **Smart Model Selection**: OpenAI GPT-OSS-120B primary, fallback to ALLAM-2-7B
- 🔄 **Graceful Degradation**: Content extraction has Readability.js + fallback mechanisms
- 📺 **Netflix Monitoring**: Real-time dynamic content detection with MutationObserver
- 🎨 **Beautiful Markdown**: marked.js rendering with regex fallback for gorgeous formatted responses
- 📊 **Clean Tables**: Minimal table styling with subtle dividers (no ugly borders)

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Frontend Framework** | TypeScript + Vite | Latest |
| **Extension Plugin** | @crxjs/vite-plugin | v3 |
| **Content Extraction** | Readability.js (Mozilla) | Latest |
| **Markdown Rendering** | marked.js (CDN) | v13.0.3 |
| **Markdown Fallback** | Regex-based converter | Custom |
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
│  │  • Extracts page content with Readability.js        │   │
│  │  • Netflix monitoring with MutationObserver         │   │
│  │  • Runs at document_idle (after page fully loads)   │   │
│  │  • Listens for GET_PAGE_CONTENT messages            │   │
│  │  • Sends extracted content back to popup            │   │
│  └──────────────────┬──────────────────────────────────┘   │
│                     │                                        │
│                     │ chrome.tabs.sendMessage()              │
│                     │ (GET_PAGE_CONTENT)                     │
│                     ▼                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │             Popup UI (popup.ts)                     │   │
│  │  • Conversation interface with message threads      │   │
│  │  • Renders markdown with marked.js (CDN)            │   │
│  │  • Fallback: regex-based markdown converter         │   │
│  │  • Displays user messages & AI responses            │   │
│  │  • Instant response display (no delay)              │   │
│  │  • Loading animation with teacup icon               │   │
│  │  • Accumulates streamed chunks into full response   │   │
│  │  • Sends GET_ANSWER to background worker            │   │
│  └──────────────────┬──────────────────────────────────┘   │
│                     │                                        │
│                     │ chrome.runtime.sendMessage()           │
│                     │ (GET_ANSWER with full prompt)          │
│                     ▼                                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │        Background Worker (background.ts)            │   │
│  │  • Receives GET_ANSWER messages from popup          │   │
│  │  • Fetches from backend /explain-stream endpoint    │   │
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
        ┌──────────────────────────────┐
        │   FastAPI Backend            │
        │   (http://localhost:8000)    │
        │                              │
        │  ┌────────────────────────┐  │
        │  │ POST /explain-stream   │  │
        │  │                        │  │
        │  │ 1. Receive prompt      │  │
        │  │ 2. Check cache         │  │
        │  │ 3a. Cache HIT?         │  │
        │  │     ↓ Stream cached    │  │
        │  │ 3b. Cache MISS?        │  │
        │  │     ↓ Call Groq/OpenAI │  │
        │  │ 4. Stream response     │  │
        │  │ 5. Save to cache       │  │
        │  │ 6. Send [DONE] marker  │  │
        │  └────────────────────────┘  │
        │                              │
        │  ┌────────────────────────┐  │
        │  │ Response Cache         │  │
        │  │ • SHA256 keys          │  │
        │  │ • 7-day TTL            │  │
        │  │ • FIFO eviction        │  │
        │  │ • Max 5000 entries     │  │
        │  └────────────────────────┘  │
        └──────────────┬───────────────┘
                       │
                       ▼
            ┌──────────────────────┐
            │   Groq/OpenAI API    │
            │  • llama models      │
            │  • gpt-oss models    │
            │  • Fast inference    │
            └──────────────────────┘
```

---

## Current Implementation Status

### ✅ Completed
- [x] FastAPI backend with Groq/OpenAI API integration
- [x] Chrome extension manifest v3 structure
- [x] Content extraction using Readability.js + Netflix monitoring
- [x] Popup-based UI (conversation style with message threads)
- [x] Message passing architecture (content → background → popup)
- [x] SSE streaming from backend
- [x] **Instant response display** (removed 5-second delay)
- [x] Response chunk accumulation
- [x] **Markdown rendering with marked.js + regex fallback**
- [x] **Netflix dynamic content monitoring with MutationObserver**
- [x] **Clean, beautiful markdown styling**
- [x] **Minimal table design (no borders, subtle dividers)**
- [x] In-memory caching with SHA256 keys and 7-day TTL
- [x] Error handling and resilience
- [x] Comprehensive logging at each step
- [x] Loading animation with teacup icon and rotating text
- [x] Dark mode support with CSS variables

### 🔄 In Progress
- [ ] Test on more websites for robustness
- [ ] Optimize Netflix extraction for edge cases
- [ ] Verify marked.js CDN reliability across regions

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
   - Fallback model: `allam-2-7b`
   - Configuration: Max 5000 cache entries, 7-day TTL

2. **Caching System**
   - **Key Generation:** SHA256 hash of `action:text` → 64-char hex string
   - **Validation:** Checks timestamp age, auto-deletes if >7 days old
   - **Retrieval:** Returns cached answer instantly if valid
   - **Storage:** Saves responses with ISO timestamp
   - **Eviction:** FIFO - removes oldest 500 entries when cache reaches 5000

3. **POST /explain-stream Endpoint**
   - Checks cache first (cache hit = instant stream)
   - If cache miss: Calls Groq/OpenAI API
   - Streams response word-by-word (3 words/chunk, 100ms delays)
   - Returns SSE format: `data: chunk \n\n`
   - Ends with: `data: [DONE]\n\n` marker

4. **GET /health Endpoint**
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
- **Content scripts:** Inject Readability.js on all pages
- **`run_at: "document_idle"`** ⚠️ CRITICAL: Waits for DOM to fully load before extraction (prevents Readability.js crashes)
- **Action popup:** Shows main UI when extension icon clicked
- **Icons:** TeaWhiz logo at multiple sizes

### File: `frontend/src/content.ts`

**Location:** `/home/kavleen/Desktop/webwhiz/frontend/src/content.ts`

**Purpose:** Extract main webpage content intelligently with Netflix real-time monitoring

**Key Functions:**
- **`extractReadability()`:** Use Mozilla's Readability library to parse article/main content
  - Clones document for Readability analysis
  - Removes ads, navigation, noise automatically
  - Returns clean text content if extraction succeeds
  - Converts HTML to text while preserving structure

- **`extractNetflixTitles()`:** Netflix-specific extraction
  - Looks for `aria-label` attributes on Netflix elements
  - Filters out UI text ("Play", "Browse", "Menu", etc.)
  - Returns markdown list of show/movie titles

- **`setupNetflixMonitoring()`:** Real-time Netflix content detection
  - `MutationObserver` watches `document.body` for DOM changes
  - Waits 2 seconds after page load for Netflix to render
  - `scheduleNetflixExtraction()` debounces to 1 second (prevents spam on hundreds of mutations)
  - Caches titles in `latestNetflixContent` to avoid redundant extractions

- **`extractFallback()`:** Selector-based extraction if Readability fails
  - Tries: `<article>`, `<main>`, `.main-content`, `.article-content`, etc.
  - Falls back to `document.body.innerText` as last resort

- **`cleanText(text)`:** Markdown-preserving text cleaning
  - Only normalizes whitespace (collapse spaces/tabs)
  - Removes leading/trailing spaces on lines
  - Normalizes multiple newlines to double newlines
  - **Preserves markdown syntax:** `**`, `*`, `_`, `|`, `#`, `-`, etc.

- **`getPageContent()`:** Orchestrates extraction pipeline
  - Priority order: Netflix → Readability → Fallback
  - Returns cached Netflix content if available
  - Limits output to MAX_CONTENT_LENGTH (8000 chars)
  - Includes page title in response

- **Message Listener:** Responds to `GET_PAGE_CONTENT` messages from popup
  - Synchronous response (no async/await issues)
  - Includes error handling

### File: `frontend/src/background.ts`

**Location:** `/home/kavleen/Desktop/webwhiz/frontend/src/background.ts`

**Purpose:** Message handler between popup and backend API

**Key Functions:**
- **`streamAnswer(text)`:** Main handler for AI requests
  - Fetches from `http://localhost:8000/explain-stream`
  - Reads SSE stream (Server-Sent Events)
  - Parses `data: chunk \n\n` format
  - Broadcasts chunks back to popup

- **`broadcastResponse(message)`:** Send response to all runtime listeners
  - Uses `chrome.runtime.sendMessage()` (not tabs)
  - Catches errors silently (listener may be gone)
  - Messages: RESPONSE_CHUNK, RESPONSE_DONE, RESPONSE_ERROR

- **Message Listener:** Catches `GET_ANSWER` from popup
  - Extracts text from message
  - Calls `streamAnswer()`
  - Returns `true` to keep channel open for async response

### File: `frontend/src/popup.ts`

**Location:** `/home/kavleen/Desktop/webwhiz/frontend/src/popup.ts`

**Purpose:** Main UI - conversation interface with loading animation

**Key Functions:**
- **`loadPageContent()`:** When popup opens, request page content from content script
  - Uses `chrome.tabs.sendMessage()` with GET_PAGE_CONTENT
  - Stores result in `pageContent` variable

- **`submit()`:** User submits a question
  - Combines: `pageContent + "\n\n---\n\n" + userQuestion`
  - Sends to background worker: GET_ANSWER message
  - Shows user message immediately
  - Starts loading animation (teacup with rotating text)

- **`renderMarkdown(text)`:** Convert markdown to beautiful HTML
  - Primary: Uses `marked.parse()` from marked.js CDN (v13.0.3)
  - Fallback: `basicMarkdownToHTML()` with regex patterns for headers, bold, italic, code, lists
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
2. **Content Script** → Receives message, extracts content via Readability, sends back
3. **Popup Receives** → Stores `pageContent` variable for later use
4. **User Submits** → Builds `fullPrompt = pageContent + userQuestion`, sends `GET_ANSWER` to background
5. **Background** → Receives GET_ANSWER, calls `streamAnswer(text)`, fetches from `/explain-stream`
6. **Backend** → Checks cache, calls Groq/OpenAI if needed, streams SSE chunks
7. **Background Parses** → Reads SSE stream, extracts chunks, broadcasts via `chrome.runtime.sendMessage()`
8. **Popup Accumulates** → Catches RESPONSE_CHUNK messages, waits 5 seconds, then appends chunks
9. **Complete** → Receives RESPONSE_DONE, removes loading animation, shows full response

---

## Markdown Rendering System

### Two-Tier Architecture

**Primary Renderer: marked.js (CDN)**
- Loads from: `https://cdnjs.cloudflare.com/ajax/libs/marked/13.0.3/marked.min.js`
- Full markdown spec support
- Handles headers, bold, italic, code, lists, tables, blockquotes
- Fast and reliable

**Fallback Renderer: basicMarkdownToHTML()**
- Activates if marked.js is unavailable
- Regex-based conversion
- Handles: `#` headers, `**bold**`, `*italic*`, `` `code` ``, `- lists`, etc.
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

## Why NOT Defuddle? → Using Readability.js Instead

### Decision History

**Originally Considered:** Defuddle (npm package for text extraction)  
**Actually Using:** [Mozilla Readability](https://github.com/mozilla/readability) (browser-compatible alternative)

### Why We Chose Readability.js

| Aspect | Defuddle | Readability.js |
|--------|----------|----------------|
| **Type** | Node.js library | Browser library |
| **Installation** | NPM package | Included in manifest |
| **Browser Support** | ❌ Not browser-native | ✅ Works in content scripts |
| **Content Extraction** | Good | ⭐ Excellent (Mozilla-backed) |
| **Learning Curve** | Higher | Lower |
| **Performance** | Slower in browser | Faster in browser |
| **Maintenance** | Less active | Actively maintained by Mozilla |

**Result:** Readability.js is the **better choice for Chrome extensions** because it runs natively in the browser without requiring Node.js runtime.

---

## Text Extraction Pipeline (Complete Flow)

### High-Level Flow Diagram

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
        │  Executes extraction pipeline          │
        │  (See detailed pipeline below)         │
        └─────────────┬──────────────────────────┘
                      │
                      ▼
        ┌──────────────────────────────────────────────────┐
        │         EXTRACTION PIPELINE                       │
        │                                                   │
        │  1️⃣ Check if on Netflix?                         │
        │     → extractNetflix() (cached titles)           │
        │     → If >50 chars: RETURN with Netflix list     │
        │                                                   │
        │  2️⃣ If not Netflix or empty, try Readability    │
        │     → extractReadability()                       │
        │     → Clone document                             │
        │     → Run Mozilla Readability parser             │
        │     → Extract main article content               │
        │     → If >100 chars: RETURN cleaned text         │
        │                                                   │
        │  3️⃣ If Readability fails/empty, try selectors   │
        │     → extractFallback()                          │
        │     → Try: <article>, <main>, .main-content     │
        │     → If found: RETURN content                   │
        │                                                   │
        │  4️⃣ Last resort: Full body text                  │
        │     → document.body.innerText                     │
        │     → cleanText() to normalize                    │
        │     → RETURN body content                         │
        │                                                   │
        └────────┬────────────────────────────────────────┘
                 │
                 ▼
        ┌──────────────────────────────────────┐
        │  cleanText(text)                     │
        │  Markdown-preserving cleaning:       │
        │  • Collapse spaces/tabs only         │
        │  • Remove leading/trailing spaces    │
        │  • Normalize multiple newlines       │
        │  • PRESERVE: **, *, _, |, #, -, etc │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────┐
        │  Limit to MAX_CONTENT_LENGTH (8000)  │
        │  Format result:                      │
        │  "Page Title: [title]                │
        │   Content: [extracted text]"         │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────┐
        │  Send back to popup.ts via message   │
        │  Type: Response with .content        │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────┐
        │  popup.ts stores in pageContent var  │
        │  Ready for user to ask questions     │
        └──────────────────────────────────────┘
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
└─ NO → Skip to Readability (next step)
```

**Performance:** 
- First visit: Waits 2 seconds for Netflix to render
- Subsequent visits: Instant (cached content)
- Dynamic updates: MutationObserver detects changes, re-extracts with 1-second debounce

---

### Step 2: Readability.js Extraction

**Function:** `extractReadability()`

```
Clone the document (prevents DOM modification)
        │
        ▼
Create Readability parser
        │
        ▼
Parse article/content
        │
        ▼
Extract HTML content
        │
        ▼
Convert HTML to clean text (extractTextFromHTML)
        │
        ├─ Traverse all nodes
        ├─ Extract text from TEXT_NODES
        ├─ Add line breaks for block elements:
        │  - <p>, <div>, <section>, <article>
        │  - <h1-h6>, <li>, <tr>, <table>
        └─ Preserve structure
        │
        ▼
Return clean text (50-8000 chars)
```

**What Readability removes:**
- ❌ Navigation menus
- ❌ Sidebar ads
- ❌ Footer links
- ❌ Script tags and comments
- ❌ Tracking pixels
- ✅ Keeps main article/content

---

### Step 3: DOM Selector Fallback

**Function:** `extractFallback()`

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

---

### Step 4: Text Cleaning

**Function:** `cleanText(text)`

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
        ┌────────────────────────────────────┐
        │  Combine prompt:                   │
        │  pageContent +                     │
        │  "\n\n---\n\n" +                   │
        │  userQuestion                      │
        └─────────────┬──────────────────────┘
                      │
                      │ chrome.runtime.sendMessage()
                      │ Type: "GET_ANSWER"
                      ▼
        ┌────────────────────────────────────┐
        │  background.ts: streamAnswer()     │
        │  Fetch from backend /explain-stream│
        │  Method: POST                      │
        │  Content-Type: application/json    │
        └─────────────┬──────────────────────┘
                      │
                      ▼
        ┌─────────────────────────────────────────┐
        │        BACKEND (FastAPI)                │
        │  http://localhost:8000/explain-stream   │
        │                                         │
        │  1. Receive prompt + page content      │
        │  2. Create SHA256 cache key             │
        │  3. Check cache:                        │
        │     ✅ HIT → Stream cached response    │
        │     ❌ MISS → Call Groq/OpenAI API    │
        │  4. Stream response via SSE:            │
        │     data: chunk1 \n\n                   │
        │     data: chunk2 \n\n                   │
        │     data: [DONE]\n\n                    │
        │  5. Save response to cache (7-day TTL) │
        └─────────────┬───────────────────────────┘
                      │
                      │ SSE Stream
                      ▼
        ┌───────────────────────────────────────┐
        │  background.ts: parseSSE()            │
        │  Split on \n\n                        │
        │  Extract data: prefix from each chunk │
        │  Broadcast via chrome.runtime.send    │
        │  Type: "RESPONSE_CHUNK"               │
        └─────────────┬─────────────────────────┘
                      │
                      │ chrome.runtime.onMessage
                      ▼
        ┌───────────────────────────────────────┐
        │  popup.ts: Listen for chunks          │
        │  • Append to data-raw-text attribute  │
        │  • renderMarkdown(fullText)           │
        │    ├─ Try: marked.parse() (CDN)       │
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

## Summary: No Defuddle, Using Readability.js

### Why This Choice?

| Factor | Impact |
|--------|--------|
| **Defuddle** | Node.js library, not browser-native ❌ |
| **Readability.js** | Browser-compatible, Mozilla-backed ✅ |
| **Performance** | Readability faster in extension context ✅ |
| **Simplicity** | Readability easier to integrate ✅ |
| **Maintenance** | Mozilla maintains Readability actively ✅ |

### What We Extract

1. **Netflix:** Show/movie titles from `aria-label` (real-time monitoring)
2. **Regular Pages:** Main article content via Readability parser
3. **Fallback Pages:** Content from common selectors or full body text
4. **Clean Text:** Markdown-preserving whitespace normalization

### Result

Clean, readable text content → Sent to LLM with user question → Beautiful markdown response displayed instantly! 🚀

---

## Streaming & Caching

### SSE (Server-Sent Events) Format

Backend streams responses in SSE format:
- Each chunk: `data: words here \n\n`
- Final marker: `data: [DONE]\n\n`
- Frontend parses by splitting on `\n\n`, extracting `data: ` prefix

### Caching Performance

| Scenario | Process | Time |
|----------|---------|------|
| **Cache Hit** | SHA256 hash → lookup → instant ⚡ | ~1ms |
| **Cache Miss** | Hash → miss → API call → stream → save → send | 2-5 sec |

### Cache Storage Format

Dictionary with SHA256 keys:
- Key: `hashlib.sha256(f"{action}:{text}")` → 64-char hex
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

### Frontend Issues

**Extension won't load**
- ❌ `npm run build` failed
- ✅ Check for TypeScript errors, rebuild

**Popup won't open**
- ❌ Extension disabled or corrupted
- ✅ Try reloading extension in chrome://extensions

**No page content extracted**
- ❌ Content script not running
- ✅ Check DevTools Console → look for `[TeaWhiz] Content script loaded`
- ✅ Verify `run_at: "document_idle"` in manifest

**Response not appearing**
- ❌ Backend connection failed (see Network tab)
- ❌ Response chunks not being parsed
- ✅ Check DevTools Console for streaming logs
- ✅ Open Network tab → /explain-stream request → Response tab

**Markdown not rendering (showing literal `**bold**`)**
- ❌ marked.js CDN may be blocked or unavailable
- ✅ Check Network tab → marked.min.js should load successfully
- ✅ Fallback regex converter will automatically activate if CDN fails
- ✅ Look for console logs: "[TeaWhiz] Markdown rendered with marked library" or "using basic markdown fallback"

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
- Extracts webpage content intelligently (Readability.js + Netflix monitoring)
- Monitors Netflix in real-time with MutationObserver
- Sends questions to backend with full page context
- Displays streaming responses instantly (no 5-second delay)
- Shows beautiful markdown formatting (headers, bold, code, tables)
- Renders tables cleanly without ugly borders
- Shows loading animation with teacup icon and rotating text
- Supports multiple questions and conversation history

✅ **FastAPI Backend** that:
- Integrates with Groq/OpenAI APIs
- Caches responses (7-day TTL)
- Streams responses via SSE
- Handles errors gracefully
- Validates inputs

✅ **Message Architecture** that:
- Connects content script → background → popup
- Handles async/await patterns properly
- Prevents race conditions
- Logs everything for debugging

✅ **Beautiful UI/UX** with:
- Markdown rendering via marked.js + regex fallback
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
│   ├── main.py (FastAPI backend)
│   ├── requirements.txt
│   ├── .env (API keys)
│   └── venv/
├── frontend/
│   ├── src/
│   │   ├── manifest.json (Extension config v3)
│   │   ├── content.ts (Content extraction + Netflix monitoring)
│   │   ├── background.ts (Message handler)
│   │   ├── popup.ts (UI, streaming, markdown rendering)
│   │   └── popup.html (UI structure & styling)
│   ├── public/
│   │   └── icon.png (TeaWhiz logo)
│   ├── vite.config.ts (Build config)
│   └── dist/ (← Load unpacked from here)
```

### Recent Updates (Latest Session)

✨ **Removed 5-second animation delay** - Responses display instantly  
🎨 **Added beautiful markdown rendering** - marked.js + regex fallback  
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

**Last Updated:** August 29, 2026  
**Status:** Core functionality complete and tested ✅  
**Feature Complete:** ✨ Instant responses, beautiful markdown, Netflix monitoring  
**Next Phase:** Cloud deployment and Chrome Web Store submission
