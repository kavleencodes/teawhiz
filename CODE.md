# webwhiz ai — Complete Development Guide

**From zero to Chrome Web Store deployment — all phases in one guide**

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Tech Stack](#tech-stack)
3. [Architecture](#architecture)
4. [Phase 1: Backend Setup](#phase-1-backend-setup)
5. [Phase 2: Backend Implementation](#phase-2-backend-implementation)
   - [Groq API Integration](#groq-api-integration)
   - [In-Memory Caching Strategy](#in-memory-caching-strategy)
   - [Streaming Implementation](#streaming-implementation)
   - [Error Handling & Resilience](#error-handling--resilience)
6. [Phase 3: Frontend — Extension Development](#phase-3-frontend--extension-development)
7. [Phase 4: Frontend — Wire to Backend](#phase-4-frontend--wire-to-backend)
8. [Phase 5: Testing & Deployment](#phase-5-testing--deployment)
9. [API Reference](#api-reference)
10. [Troubleshooting](#troubleshooting)

---

## Project Overview

**webwhiz ai** — A Chrome extension that lets users select any text on a webpage and instantly get explanations, simplifications, summaries, or translations.

### Key Features
- ✅ Selection-triggered UI (no sidebar, no login)
- ✅ Free AI backend (Groq + Llama 3.1 8B Instant)
- ✅ Smart in-memory caching (7-day TTL)
- ✅ Server-side request streaming (word-by-word)
- ✅ Automatic rate limiting with exponential backoff
- ✅ Light/dark theme support
- ✅ Beautiful teacup logo (#D85A3A cup, #F5A442 steam)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | TypeScript + Vite + @crxjs/vite-plugin |
| **Backend** | FastAPI (Python) + Groq API |
| **AI Model** | Llama 3.1 8B Instant (free on Groq) |
| **Caching** | In-Memory Dictionary (Python dict) |
| **Hosting** | Render (backend) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Chrome Extension                              │
│  ┌──────────────────┐           ┌──────────────────┐            │
│  │  Content Script  │──────────▶│ Background Worker│            │
│  │  (content.ts)    │  Message  │  (background.ts) │            │
│  └──────────────────┘  Passing  └────────┬─────────┘            │
│                                          │                       │
│                                   HTTP POST Request              │
└──────────────────────────────────────┬──────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    FastAPI Backend (Render)                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  POST /explain                                          │   │
│  │  ├─ 1. Check Cache (in-memory dict)                    │   │
│  │  ├─ 2a. Cache HIT → Return instantly ⚡               │   │
│  │  ├─ 2b. Cache MISS → Call Groq API                   │   │
│  │  │     ├─ Exponential backoff on rate limit           │   │
│  │  │     ├─ Async/await pattern                         │   │
│  │  ├─ 3. Save response to cache                         │   │
│  │  └─ 4. Return response + cached flag                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  POST /explain-stream                                   │   │
│  │  ├─ 1. Check Cache (in-memory dict)                    │   │
│  │  ├─ 2a. Cache HIT → Stream cached response ⚡         │   │
│  │  ├─ 2b. Cache MISS → Stream from Groq API            │   │
│  │  ├─ 3. Save full response to cache                    │   │
│  │  └─ 4. Return SSE stream with [DONE] marker           │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  GET /health                                            │   │
│  │  └─ Check if Groq API key is configured               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────┐                              │
│  │  Response Cache (Dict)       │                              │
│  │  {                           │                              │
│  │    "hash1": {               │                              │
│  │      "answer": "...",       │                              │
│  │      "timestamp": "2026-..." │                              │
│  │    },                        │                              │
│  │    "hash2": { ... }         │                              │
│  │  }                           │                              │
│  │                              │                              │
│  │  Max: 5000 entries           │                              │
│  │  TTL: 7 days                 │                              │
│  └──────────────────────────────┘                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                              ┌──────────────┐
                              │  Groq API    │
                              │  (Free Tier) │
                              │              │
                              │ llama-3.1-   │
                              │ 8b-instant   │
                              └──────────────┘
```

---

## Phase 1: Backend Setup

### Step 1: Create Project Structure

```bash
cd ~/Desktop/webwhiz

mkdir backend
cd backend

python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
```

### Step 2: Create `requirements.txt`

```
fastapi==0.104.1
uvicorn==0.24.0
pydantic==2.5.0
python-dotenv==1.0.0
groq>=0.15.0
redis==5.0.1
```

### Step 3: Install Dependencies

```bash
pip install -r requirements.txt
```

### Step 4: Create `.env`

```
GROK_API_KEY=gsk_YOUR_KEY_HERE
```

Add to `.gitignore`:
```
.env
venv/
__pycache__/
*.pyc
.DS_Store
```

---

## Phase 2: Backend Implementation

### Groq API Integration

#### What is Groq?

**Groq** is a cloud AI service that provides free access to high-performance open-source models. We're using:
- **Model:** `llama-3.1-8b-instant`
- **Cost:** Free (with rate limiting)
- **Speed:** Ultra-fast inference (2-5 seconds)

#### Why Groq instead of Gemini?

| Feature | Groq | Gemini |
|---------|------|--------|
| Cost | Free | Free (API key) |
| Speed | 🚀 Very Fast | Normal |
| Model | Open (Llama) | Google's (Gemini) |
| Rate Limit | Generous | Strict |
| Setup | Easy | Easy |

### In-Memory Caching Strategy

The backend uses a **simple, efficient in-memory cache** built with Python dictionaries.

#### How Caching Works

```
Request arrives
  ↓
Generate cache key (SHA256 hash of action:text)
  ↓
Check if key exists in response_cache dict?
  ├─ YES: Is timestamp < 7 days old?
  │   ├─ YES: Return cached answer ✅ (INSTANT)
  │   └─ NO: Delete expired entry, fall through
  └─ NO: Call Groq API (SLOW, 2-5 seconds)
         ↓
      Save response to cache
         ↓
      Return answer to user
```

#### Cache Implementation Details

**1. Cache Key Generation** (lines 56-58 in main.py)

```python
def get_cache_key(text: str, action: str) -> str:
    """Generate a SHA256 hash as the cache key"""
    value = f"{action}:{text.strip()}"
    return hashlib.sha256(value.encode()).hexdigest()
```

**Why hash?**
- Fixed-length key (64 characters)
- Handles special characters safely
- Deterministic (same input = same key)
- Example: `"explain:photosynthesis"` → `a3f9b8c...` (256-bit hex)

**2. Cache Validation** (lines 60-65)

```python
def is_cache_valid(timestamp_iso: str, days: int = 7) -> bool:
    """Check if cached entry is still valid (< 7 days old)"""
    cached_time = datetime.fromisoformat(timestamp_iso)
    return (datetime.now(timezone.utc) - cached_time) < timedelta(days=days)
```

**Why 7 days?**
- Long enough to catch repeated requests
- Short enough to avoid stale answers
- Automatically expires without database

**3. Retrieval Logic** (lines 67-74)

```python
def get_from_cache(text: str, action: str):
    """Get answer from cache if valid, delete if expired"""
    key = get_cache_key(text, action)
    if key in response_cache:
        entry = response_cache[key]
        if is_cache_valid(entry["timestamp"]):  # Still valid?
            return entry["answer"], True         # Cache hit! ✅
        del response_cache[key]                  # Clean up expired
    return None, False                           # Cache miss
```

**4. Storage Logic** (lines 76-87)

```python
def save_to_cache(text: str, action: str, answer: str):
    """Save answer to cache, evict old entries if full"""
    if len(response_cache) >= MAX_CACHE_ENTRIES:  # Max 5000
        # Remove oldest 500 entries (10% eviction)
        keys_to_remove = list(response_cache.keys())[:500]
        for k in keys_to_remove:
            response_cache.pop(k, None)
    
    key = get_cache_key(text, action)
    response_cache[key] = {
        "answer": answer,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
```

**Why this eviction strategy?**
- **Max 5000 entries:** Prevents unbounded memory growth
- **Remove oldest 10%:** Simple FIFO (first-in-first-out)
- **No external DB:** Everything in RAM = ultra-fast

#### Cache Performance Example

```bash
# Request 1: "Explain photosynthesis" with action="explain"
POST /explain
{
  "text": "photosynthesis",
  "action": "explain"
}

Response (cache miss):
{
  "answer": "Photosynthesis is the process...",
  "cached": false  # ← Not from cache
}
⏱️ Time: 3 seconds (Groq API call)

---

# Request 2: Same text, same action
POST /explain
{
  "text": "photosynthesis",
  "action": "explain"
}

Response (cache hit):
{
  "answer": "Photosynthesis is the process...",
  "cached": true  # ← From cache!
}
⏱️ Time: 0.001 seconds (instant!)
```

#### Cache Storage Format

```python
response_cache = {
    "a3f9b8c...": {
        "answer": "Photosynthesis is...",
        "timestamp": "2026-08-17T10:30:00+00:00"
    },
    "f2d1e4c...": {
        "answer": "Machine learning is...",
        "timestamp": "2026-08-16T15:22:00+00:00"
    },
    # ... up to 5000 entries
}
```

---

### Streaming Implementation

The `/explain-stream` endpoint uses **Server-Sent Events (SSE)** to stream responses word-by-word to the frontend.

#### What is SSE (Server-Sent Events)?

A protocol that lets the server push data to the client over HTTP:

```
Client connects
  ↓
Server sends: "data: hello world\n\n"
  ↓
Client receives and renders
  ↓
Server sends: "data: more text\n\n"
  ↓
(repeat until done)
  ↓
Server sends: "data: [DONE]\n\n"
  ↓
Client closes connection
```

#### Streaming Implementation (lines 216-270)

**For cached responses:**

```python
async def stream_cached():
    words = cached_answer.split()
    for i in range(0, len(words), 3):  # Send 3 words at a time
        chunk = " ".join(words[i:i+3])
        yield f"data: {chunk} \n\n"  # SSE format
        await asyncio.sleep(0.1)     # Pause for natural feel
    yield "data: [DONE]\n\n"         # Signal completion

return StreamingResponse(stream_cached(), media_type="text/event-stream")
```

**For fresh responses from Groq:**

```python
async def stream_response():
    # Get full response first (Groq doesn't support streaming)
    response = await asyncio.to_thread(
        client.chat.completions.create,
        model=PRIMARY_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
        max_tokens=2048
    )
    
    full_response = response.choices[0].message.content
    save_to_cache(cleaned_text, request.action, full_response)
    
    # Stream it word-by-word to the client
    words = full_response.split()
    for i in range(0, len(words), 3):
        chunk = " ".join(words[i:i+3])
        yield f"data: {chunk} \n\n"
        await asyncio.sleep(0.1)
    
    yield "data: [DONE]\n\n"

return StreamingResponse(stream_response(), media_type="text/event-stream")
```

#### Streaming Example

**Request:**
```
POST /explain-stream
Content-Type: application/json

{
  "text": "machine learning",
  "action": "explain"
}
```

**Response (Server-Sent Events):**
```
data: Machine learning is \n\n
data: a subset of artificial \n\n
data: intelligence that enables \n\n
data: systems to learn from \n\n
data: data without explicit \n\n
data: programming. \n\n
data: [DONE]\n\n
```

**Frontend receives in real-time:**
```
1. "Machine learning is "
2. "a subset of artificial "
3. "intelligence that enables "
4. (continues...)
```

---

### Error Handling & Resilience

#### Exponential Backoff on Rate Limits

When Groq rate limits you (HTTP 429), we automatically retry with increasing delays:

```python
async def _call_groq_with_retry(model_name: str, prompt: str, max_retries: int = 2) -> str:
    """Retry with exponential backoff: 1.5s, 2.5s"""
    for attempt in range(max_retries + 1):
        try:
            response = await asyncio.to_thread(
                client.chat.completions.create,
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.7,
                max_tokens=2048
            )
            return response.choices[0].message.content
        except RateLimitError:
            if attempt < max_retries:
                delay = (2 ** attempt) + 0.5  # 1.5s, 2.5s
                print(f"⚠️ Rate limited. Retrying in {delay}s...")
                await asyncio.sleep(delay)
                continue
            raise
```

**How it works:**
- **Attempt 1:** Fails with 429 → Wait 1.5 seconds → Retry
- **Attempt 2:** Fails with 429 → Wait 2.5 seconds → Retry
- **Attempt 3:** Fails with 429 → Give up, return error

#### Input Validation

```python
@app.post("/explain")
async def explain(request: ExplainRequest):
    cleaned_text = request.text.strip()
    
    # Reject empty text
    if not cleaned_text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Text cannot be empty"
        )
    
    # Validate action is supported
    if request.action not in ACTION_PROMPTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid action. Supported: {', '.join(ACTION_PROMPTS.keys())}"
        )
```

#### API Response Errors

```python
# If Groq API is not configured
raise HTTPException(
    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
    detail="GROK_API_KEY is not configured on the server"
)

# If Groq returns empty response
raise HTTPException(
    status_code=status.HTTP_502_BAD_GATEWAY,
    detail="Groq returned an empty response"
)

# If rate limit exceeded
raise HTTPException(
    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
    detail="Rate limit reached. Please try again later."
)
```

---

## Phase 3: Frontend — Extension Development

### Phase 3A: Extension Scaffold

#### Step 1: Create Vite Project

```bash
cd ~/Desktop/webwhiz

npm create vite@latest frontend -- --template vanilla-ts
cd frontend

npm i -D @crxjs/vite-plugin
npm install
```

#### Step 2: Update `vite.config.ts`

```typescript
import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.json'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
  },
})
```

#### Step 3: Create `src/manifest.json`

```json
{
  "manifest_version": 3,
  "name": "webwhiz ai",
  "version": "0.1.0",
  "description": "Select any text and get instant explanations, simplifications, summaries, or translations.",
  "permissions": ["storage"],
  "background": {
    "service_worker": "background.ts",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.ts"]
    }
  ],
  "icons": {
    "16": "icon.png",
    "48": "icon.png",
    "128": "icon.png"
  },
  "web_accessible_resources": [
    {
      "resources": ["icon.png"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

#### Step 4: Create `src/content.ts`

```typescript
// Selection detection and toolbar rendering

let toolbar: ShadowRoot | null = null;
let lastSelectedText: string = "";

interface ToolbarPosition {
  top: number;
  left: number;
}

function getSelectionPosition(): ToolbarPosition | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  return {
    top: window.scrollY + rect.bottom + 10,
    left: window.scrollX + rect.left,
  };
}

function renderToolbar(text: string): void {
  if (toolbar?.host) {
    toolbar.host.remove();
    toolbar = null;
  }

  lastSelectedText = text;
  const position = getSelectionPosition();
  if (!position) return;

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.top = position.top + "px";
  container.style.left = position.left + "px";
  container.style.zIndex = "10000";

  toolbar = container.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      --primary: #D85A3A;
      --steam: #F5A442;
      --bg: #ffffff;
      --text: #1f2937;
      --border: #e5e7eb;
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #1f2937;
        --text: #f3f4f6;
        --border: #374151;
      }
    }

    .toolbar {
      position: absolute;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      display: flex;
      gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    button {
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 4px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.2s;
    }

    button:hover { opacity: 0.9; }
    button:active { opacity: 0.8; }
  `;
  toolbar.appendChild(style);

  const toolbarEl = document.createElement("div");
  toolbarEl.className = "toolbar";
  toolbarEl.innerHTML = `
    <button data-action="explain">Explain</button>
    <button data-action="simplify">Simplify</button>
    <button data-action="summarize">Summary</button>
    <button data-action="translate">Translate</button>
  `;
  toolbar.appendChild(toolbarEl);

  toolbarEl.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const action = (e.target as HTMLElement).getAttribute("data-action") || "explain";
      handleAction(action);
    });
  });

  document.body.appendChild(container);
}

function handleAction(action: string): void {
  chrome.runtime.sendMessage(
    { type: "GET_ANSWER", text: lastSelectedText, action },
    (response: any) => {
      if (response?.success) {
        renderPopover(lastSelectedText, response.answer, action);
        if (toolbar?.host) {
          toolbar.host.remove();
          toolbar = null;
        }
      } else {
        renderError(response?.error || "Failed to get answer");
      }
    }
  );
}

function renderPopover(text: string, answer: string, action: string): void {
  const position = getSelectionPosition();
  if (!position) return;

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.top = position.top + "px";
  container.style.left = position.left + "px";
  container.style.zIndex = "10000";

  const popover = container.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      --bg: #ffffff;
      --text: #1f2937;
      --border: #e5e7eb;
      --primary: #D85A3A;
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #1f2937;
        --text: #f3f4f6;
        --border: #374151;
      }
    }

    .popover {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      max-width: 400px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--text);
      line-height: 1.6;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    .popover h3 {
      margin: 0 0 8px 0;
      font-size: 14px;
      font-weight: 600;
      text-transform: capitalize;
      color: var(--primary);
    }

    .popover p {
      margin: 0;
      font-size: 14px;
      word-wrap: break-word;
    }
  `;
  popover.appendChild(style);

  const content = document.createElement("div");
  content.className = "popover";
  content.innerHTML = `
    <h3>${action}</h3>
    <p>${escapeHtml(answer)}</p>
  `;
  popover.appendChild(content);

  document.body.appendChild(container);

  setTimeout(() => {
    try { container.remove(); } catch (e) {}
  }, 8000);
}

function renderError(error: string): void {
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.top = "50%";
  container.style.left = "50%";
  container.style.transform = "translate(-50%, -50%)";
  container.style.zIndex = "10000";

  const popover = container.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .error {
      background: #fee2e4;
      border: 1px solid #fca5ac;
      color: #c41e3a;
      padding: 16px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      max-width: 400px;
    }

    @media (prefers-color-scheme: dark) {
      .error {
        background: #5f2c31;
        border: 1px solid #8b3a42;
        color: #ff9ca3;
      }
    }
  `;
  popover.appendChild(style);

  const errorEl = document.createElement("div");
  errorEl.className = "error";
  errorEl.textContent = "Error: " + error;
  popover.appendChild(errorEl);

  document.body.appendChild(container);

  setTimeout(() => {
    try { container.remove(); } catch (e) {}
  }, 5000);
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

document.addEventListener("mouseup", () => {
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : "";

  if (text.length > 10) {
    renderToolbar(text);
  } else if (toolbar?.host) {
    toolbar.host.remove();
    toolbar = null;
  }
});

document.addEventListener("selectionchange", () => {
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : "";

  if (text.length > 10) {
    renderToolbar(text);
  } else if (toolbar?.host) {
    toolbar.host.remove();
    toolbar = null;
  }
});
```

#### Step 5: Create `src/background.ts`

```typescript
// Background service worker - handles AI requests

const BACKEND_URL = "http://localhost:8000/explain";  // Change when deploying
const BACKEND_STREAM_URL = "http://localhost:8000/explain-stream";

interface MessageRequest {
  type: string;
  text: string;
  action: string;
}

interface AIResponse {
  success: boolean;
  answer?: string;
  error?: string;
}

async function getAnswer(text: string, action: string): Promise<string> {
  // Always use backend for now (can add Nano support later)
  return await callBackend(text, action);
}

async function callBackend(text: string, action: string): Promise<string> {
  try {
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        action,
      }),
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    const data: any = await response.json();

    if (data.answer) {
      return data.answer;
    } else {
      throw new Error(data.error || "Backend returned an error");
    }
  } catch (error) {
    throw new Error(`Backend failed: ${(error as Error).message}`);
  }
}

function buildPrompt(text: string, action: string): string {
  const prompts: Record<string, string> = {
    explain: `Explain this clearly in 2-3 sentences: "${text}"`,
    simplify: `Simplify this into basic language anyone can understand: "${text}"`,
    summarize: `Summarize this in one sentence: "${text}"`,
    translate: `Translate this to Hindi: "${text}"`,
  };

  return prompts[action] || prompts.explain;
}

chrome.runtime.onMessage.addListener(
  (request: MessageRequest, sender: any, sendResponse: (response: AIResponse) => void) => {
    if (request.type === "GET_ANSWER") {
      getAnswer(request.text, request.action)
        .then((answer) => {
          sendResponse({ success: true, answer });
        })
        .catch((error) => {
          sendResponse({ success: false, error: (error as Error).message });
        });

      return true; // Keep channel open for async response
    }
  }
);
```

#### Step 6: Build and Load

```bash
npm run build

# Load in Chrome:
# 1. chrome://extensions
# 2. Developer mode ON (top right)
# 3. Load unpacked → select dist/
```

**Test:** Select text on any webpage. Toolbar should appear.

✅ **Milestone: Extension UI works**

---

## Phase 4: Frontend — Wire to Backend

### Step 1: Start Backend Locally

```bash
cd ~/Desktop/webwhiz/backend
source venv/bin/activate
python main.py
```

You should see:
```
✅ TeaWhiz AI - Groq API configured (Model: llama-3.1-8b-instant)
INFO: Uvicorn running on http://0.0.0.0:8000
```

### Step 2: Test Backend with curl

```bash
# Health check
curl http://localhost:8000/health

# Test /explain endpoint
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"machine learning","action":"explain"}'

# Test /explain-stream endpoint
curl -X POST http://localhost:8000/explain-stream \
  -H "Content-Type: application/json" \
  -d '{"text":"machine learning","action":"explain"}'
```

### Step 3: Test Extension

1. Open any website (e.g., Wikipedia)
2. Select text (> 10 characters)
3. Click "Explain" button
4. Response should appear in popover
5. Check DevTools → Application → Logs for debug messages

### Step 4: Verify Caching

Make two identical requests:

```bash
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"photosynthesis","action":"explain"}'
```

First response: `"cached": false` (slow, 2-5 seconds)
Second response: `"cached": true` (instant)

✅ **Milestone: Extension ↔ Backend wired**

---

## Phase 5: Testing & Deployment

### Local Testing Checklist

- [ ] Extension loads unpacked without errors
- [ ] Selection detection works (>10 chars)
- [ ] Toolbar appears next to selection
- [ ] All 4 buttons work (Explain, Simplify, Summary, Translate)
- [ ] Backend returns answers correctly
- [ ] Cache hits return instantly (check `"cached": true`)
- [ ] Dark mode colors render correctly
- [ ] Works on 3+ different websites

### Deployment to Render

#### Step 1: Push to GitHub

```bash
cd ~/Desktop/webwhiz/backend
git init
git add .
git commit -m "Initial backend with Groq"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/webwhiz-backend.git
git push -u origin main
```

#### Step 2: Deploy on Render

1. Go to [render.com](https://render.com)
2. Click "New +" → "Web Service"
3. Select your GitHub repo
4. Configure:
   - **Name:** `webwhiz-backend`
   - **Environment:** `Python 3`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port 10000`
5. Add Environment Variables:
   - `GROK_API_KEY` = your Groq API key
6. Click "Create Web Service"

You'll get a URL like:
```
https://webwhiz-backend.onrender.com
```

#### Step 3: Test Deployed Backend

```bash
curl https://webwhiz-backend.onrender.com/health

curl -X POST https://webwhiz-backend.onrender.com/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"test","action":"explain"}'
```

#### Step 4: Update Extension to Use Deployed Backend

Edit `frontend/src/background.ts`:

```typescript
const BACKEND_URL = "https://webwhiz-backend.onrender.com/explain";
const BACKEND_STREAM_URL = "https://webwhiz-backend.onrender.com/explain-stream";
```

Rebuild extension:
```bash
cd ~/Desktop/webwhiz/frontend
npm run build
```

Reload extension in Chrome.

---

## API Reference

### POST /explain

**Standard (non-streaming) endpoint**

**Request:**
```json
{
  "text": "machine learning",
  "action": "explain"
}
```

**Response:**
```json
{
  "answer": "Machine learning is a subset of artificial intelligence...",
  "cached": false
}
```

**Actions:**
- `explain` — Clear explanation (2-3 sentences)
- `simplify` — Simplified language for general audience
- `summarize` — One-sentence summary
- `translate` — Hindi translation

**Response Headers:**
```
Content-Type: application/json
```

---

### POST /explain-stream

**Streaming (Server-Sent Events) endpoint**

**Request:**
```json
{
  "text": "machine learning",
  "action": "explain"
}
```

**Response Stream:**
```
data: Machine learning is \n\n
data: a subset of artificial \n\n
data: intelligence that enables \n\n
...
data: [DONE]\n\n
```

**Response Headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Frontend Implementation:**
```javascript
const eventSource = new EventSource('/explain-stream');

eventSource.onmessage = (event) => {
  if (event.data === '[DONE]') {
    eventSource.close();
  } else {
    console.log('Received chunk:', event.data);
  }
};
```

---

### GET /health

**Health check endpoint**

**Response:**
```json
{
  "status": "ok",
  "service": "TeaWhiz AI API (Groq)",
  "groq_ready": true
}
```

---

## Troubleshooting

### Backend Won't Start

**Error:** `TypeError: Client.__init__() got an unexpected keyword argument 'proxies'`

**Solution:** Upgrade groq to latest version
```bash
pip install --upgrade groq
```

---

### Extension Doesn't Detect Selection

- Selection must be **> 10 characters**
- Check DevTools console for JavaScript errors
- Reload page and extension
- Verify `content.ts` is injected (DevTools → Sources)

---

### Toolbar Not Appearing

- Check Shadow DOM in DevTools → Elements
- Verify CSS `z-index: 10000`
- Check console for JavaScript errors
- Reload extension

---

### Backend Returns 500 Error

- Check `.env` file has `GROK_API_KEY` set
- Verify API key is valid (get from [console.groq.com](https://console.groq.com))
- Check backend logs: `tail -f logs.txt`

---

### Cache Not Working

Check if entry is in cache:
```python
print(response_cache)  # Should show entries
```

Verify timestamp is valid:
```python
from datetime import datetime, timezone, timedelta
ts = "2026-08-17T10:30:00+00:00"
is_valid = (datetime.now(timezone.utc) - datetime.fromisoformat(ts)) < timedelta(days=7)
print(is_valid)  # Should be True
```

---

### Streaming Not Working

1. Test endpoint with curl:
```bash
curl -N -X POST http://localhost:8000/explain-stream \
  -H "Content-Type: application/json" \
  -d '{"text":"test","action":"explain"}'
```

You should see chunks ending with `[DONE]`

2. Check if frontend is using correct URL
3. Verify `Content-Type: text/event-stream` header

---

## Commands Reference

```bash
# Backend Setup
cd ~/Desktop/webwhiz/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Backend Run
python main.py
# OR with hot reload:
uvicorn main:app --reload

# Backend Test
curl http://localhost:8000/health
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"test","action":"explain"}'

# Frontend Setup
cd ~/Desktop/webwhiz/frontend
npm install

# Frontend Build
npm run build

# Frontend Dev
npm run dev

# Git
git add .
git commit -m "message"
git push origin main
```

---

## Directory Structure

```
webwhiz/
├── CODE.md                    ← You are here
│
├── backend/
│   ├── main.py               ← All FastAPI code
│   ├── requirements.txt
│   ├── .env                  ← Never commit (GROK_API_KEY)
│   ├── .gitignore
│   └── venv/
│
└── frontend/
    ├── src/
    │   ├── manifest.json
    │   ├── content.ts
    │   └── background.ts
    ├── public/
    │   └── icon.png
    ├── vite.config.ts
    ├── tsconfig.json
    ├── package.json
    └── dist/                 ← Load unpacked from here
```

---

## Environment Variables

**In `backend/.env` (never commit):**
```
GROK_API_KEY=gsk_YOUR_KEY_HERE
```

**To get Groq API key:**
1. Go to [console.groq.com](https://console.groq.com)
2. Sign up (free)
3. Create API key
4. Copy to `.env`

---

## Next Steps

1. **Verify Backend Works:**
   ```bash
   cd backend
   source venv/bin/activate
   python main.py
   ```

2. **Test with curl:**
   ```bash
   curl -X POST http://localhost:8000/explain \
     -H "Content-Type: application/json" \
     -d '{"text":"AI","action":"explain"}'
   ```

3. **Build Extension:**
   ```bash
   cd frontend
   npm run build
   ```

4. **Load in Chrome:**
   - `chrome://extensions`
   - Developer mode ON
   - Load unpacked → `frontend/dist/`

5. **Test on any website** by selecting text

Ready? Start with:
```bash
cd backend
python main.py
```

Let's build! 🚀
