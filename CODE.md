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
- ⏱️ **Smart Loading**: 5-second "Tea is brewing..." animation before showing responses
- 💾 **Intelligent Caching**: SHA256-based keys with 7-day TTL
- 🤖 **Smart Model Selection**: OpenAI GPT-OSS-120B primary, fallback to ALLAM-2-7B
- 🔄 **Graceful Degradation**: Content extraction has Readability.js + fallback mechanisms

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Frontend Framework** | TypeScript + Vite | Latest |
| **Extension Plugin** | @crxjs/vite-plugin | v3 |
| **Content Extraction** | Readability.js (Mozilla) | Latest |
| **Build System** | Vite | v8.2.1 |
| **Backend** | FastAPI (Python) | 0.104.1+ |
| **AI Provider** | Groq API | Latest |
| **AI Models** | openai/gpt-oss-120b (primary), allam-2-7b (fallback) | - |
| **Streaming** | Server-Sent Events (SSE) | HTTP Standard |
| **Caching** | In-Memory Python Dict | - |
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
│  │  • Main conversation interface                       │   │
│  │  • 5-second "Tea is brewing..." animation           │   │
│  │  • Displays user messages & AI responses             │   │
│  │  • Accumulates streamed chunks into full response    │   │
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
- [x] Content extraction using Readability.js
- [x] Popup-based UI (conversation style)
- [x] Message passing architecture (content → background → popup)
- [x] SSE streaming from backend
- [x] 5-second loading animation
- [x] Response chunk accumulation
- [x] In-memory caching with SHA256 keys and 7-day TTL
- [x] Error handling and resilience
- [x] Comprehensive logging at each step

### 🔄 In Progress
- [ ] Fix backend connectivity (currently localhost:8000 required)
- [ ] Test on multiple websites
- [ ] Optimize content extraction for different page types
- [ ] Response quality improvements

### 📝 TODO
- [ ] Deploy backend to cloud (Render/Railway)
- [ ] Update extension to use cloud backend URL
- [ ] Chrome Web Store submission
- [ ] User authentication & sync
- [ ] Advanced settings panel
- [ ] Dark mode refinements

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

**Purpose:** Extract main webpage content using Readability.js with fallback mechanism

**Key Functions:**
- **`extractWithReadability()`:** Use Mozilla's Readability library to parse article/main content
  - ⚠️ Uses REAL document (not clone) - Readability needs real DOM access
  - Removes ads, navigation, noise automatically
  - Returns clean textContent if extraction succeeds

- **`extractFallback()`:** Selector-based extraction if Readability fails
  - Tries: `<article>`, `<main>`, `.main-content`, `.article-content`, etc.
  - Falls back to `document.body.innerText` as last resort

- **`getPageContent()`:** Orchestrates extraction pipeline
  - Tries Readability first
  - If returns <100 chars, uses fallback
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
  - Starts 5-second loading animation

- **`showLoading()`:** Display teacup animation during 5-second wait
  - Creates loading message with icon
  - Cycles through: "boiling" → "brewing" → "teaying" → "sipping" → "vibing"
  - Updates every 600ms

- **`stopLoading()`:** Remove loading animation
  - Called once when first chunk arrives
  - Stops animation interval

- **Response Handler:** Listen for chunks from background
  - RESPONSE_CHUNK: Append to response element
  - Only delay FIRST chunk by remaining 5 seconds
  - Display subsequent chunks immediately
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

## Content Extraction Strategy

### Why Readability.js?

Modern webpages have tons of noise:
- Navigation menus
- Sidebars
- Ads
- Footer links
- Tracking scripts

**Readability.js** is Mozilla's library that:
- ✅ Removes boilerplate HTML
- ✅ Extracts main article/content
- ✅ Returns clean text only
- ✅ Handles complex page structures

### Extraction Pipeline

1. **Wait for page load** (`document_idle`) → Ensures all content is rendered
2. **Try Readability** → `new Readability(document).parse()` → Returns article text
3. **Fallback if needed** → If <100 chars, try selector-based extraction
   - Looks for: `<article>`, `<main>`, `.main-content`, `.article-content`, etc.
4. **Last resort** → If all else fails, use `document.body.innerText`
5. **Clean text** → Remove extra spaces, preserve paragraph breaks
6. **Limit length** → Trim to MAX_CONTENT_LENGTH (8000 chars)
7. **Return** → Formatted as `"Page Title: ...\n\nContent: ..."`

**Example:** Messy HTML with ads/nav → Gets cleaned to just article text

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
│  🫖 Tea is brewing...       │ ← 5-second loading
│                             │
│     (after 5 seconds)       │
│                             │
│  AI: "This page is about..."│
│                             │
├─────────────────────────────┤
│  [Ask...                  ✕] │
│                           ⬆ │
└─────────────────────────────┘
```

### Styling

**Colors:**
- Primary: `#D85A3A` (orange/brown - teacup)
- Accent: `#F5A442` (orange/gold - steam)
- Dark mode supported via CSS variables

**Animations:**
- Loading teacup: `floatTeacup 2s ease-in-out infinite`
- Message appearance: `slideIn 0.3s ease`
- Button hover: `scale(1.1)`

**Responsive:**
- Width: 500px fixed
- Height: 600px fixed (scrollable)
- Fonts: System fonts (-apple-system, Segoe UI, Roboto)

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
# - Wait 5 seconds for "Tea is brewing..."
# - Read the response!
```

### Verification Checklist

- [ ] Backend running on http://localhost:8000
- [ ] `/health` endpoint responds
- [ ] Frontend builds without errors
- [ ] Extension loads in chrome://extensions
- [ ] Extension icon visible
- [ ] Click extension icon → popup opens
- [ ] Ask a question about current page
- [ ] 5-second loading animation appears
- [ ] Response streams in word-by-word
- [ ] Multiple questions work
- [ ] Cache works (2nd identical question is instant)

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

**Response disappears after appearing**
- ❌ Old issue (fixed): Response elements being removed
- ✅ Current implementation should work - check console for errors

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

✅ **Chrome Extension** with popup UI that:
- Extracts webpage content intelligently
- Sends questions to backend
- Displays streaming responses
- Shows loading animation
- Supports multiple questions

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

### Files Structure

```
webwhiz/
├── CODE.md (← You are here)
├── backend/
│   ├── main.py (FastAPI backend)
│   ├── requirements.txt
│   ├── .env (API keys)
│   └── venv/
├── frontend/
│   ├── src/
│   │   ├── manifest.json (Extension config)
│   │   ├── content.ts (Content extraction)
│   │   ├── background.ts (Message handler)
│   │   ├── popup.ts (UI & streaming)
│   │   └── popup.html (UI structure)
│   ├── public/
│   │   └── icon.png (TeaWhiz logo)
│   ├── vite.config.ts (Build config)
│   └── dist/ (← Load unpacked from here)
```

### Next Steps

1. ✅ Verify backend is running
2. ✅ Build frontend: `npm run build`
3. ✅ Load extension: chrome://extensions → Load unpacked
4. ✅ Test on real websites
5. ⏳ Deploy backend to cloud (Render/Railway)
6. ⏳ Submit to Chrome Web Store

---

**Last Updated:** August 27, 2026  
**Status:** Core functionality working, ready for cloud deployment  
**Next:** Deploy backend + cloud URLs
