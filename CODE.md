# webwhiz ai — Complete Development Guide

**From zero to Chrome Web Store deployment — all phases in one guide**

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Prerequisites & Setup](#prerequisites--setup)
3. [Phase 2: Frontend — Extension Development](#phase-2-frontend--extension-development)
4. [Phase 3: Backend — API Development](#phase-3-backend--api-development)
5. [Phase 4: Backend — Caching & Rate Limiting](#phase-4-backend--caching--rate-limiting)
6. [Phase 5: Backend — Deployment](#phase-5-backend--deployment)
7. [Phase 6: Frontend — Wire to Backend](#phase-6-frontend--wire-to-backend)
8. [Phase 7: Frontend — Polish & Submit](#phase-7-frontend--polish--submit)
9. [Testing](#testing)
10. [Troubleshooting](#troubleshooting)

---

## Project Overview

**webwhiz ai** — A Chrome extension that lets users select any text on a webpage and instantly get explanations, simplifications, summaries, or translations.

### Key Features
- ✅ Selection-triggered UI (no sidebar, no login)
- ✅ On-device AI (Chrome Gemini Nano) for privacy
- ✅ Cloud fallback (FastAPI + Gemini API)
- ✅ Redis caching & rate limiting
- ✅ Light/dark theme support
- ✅ Beautiful teacup logo (#D85A3A cup, #F5A442 steam)

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | TypeScript + Vite + @crxjs/vite-plugin |
| **On-Device AI** | Chrome Prompt API (Gemini Nano) |
| **Backend** | FastAPI (Python) |
| **Cache/Rate-Limit** | Redis (Upstash) |
| **Hosting** | Render |

### Final Directory Structure

```
webwhiz/
├── CODE.md                          ← You are here
├── logo.png                         ← Your teacup icon
│
├── samajhlo-extension/
│   ├── src/
│   │   ├── manifest.json
│   │   ├── content.ts
│   │   └── background.ts
│   ├── public/
│   │   └── icon.png                 ← Copy logo.png here
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   └── dist/                        ← Generated on build
│
└── samajhlo-backend/
    ├── main.py
    ├── requirements.txt
    ├── .env                         ← Never commit
    ├── .gitignore
    └── venv/
```

---

## Prerequisites & Setup

### 1. Install Tools

```bash
# Node.js (LTS 18+)
node --version
npm --version

# Python 3.11+
python3 --version
pip --version

# Git
git --version
```

### 2. Create Free Accounts & Get Credentials

- [Google AI Studio](https://aistudio.google.com) → **Gemini API key**
- [Upstash](https://upstash.com) → **Redis URL** (`redis://default:password@host:port`)
- [Render](https://render.com) → **For backend hosting**
- [GitHub](https://github.com) → **For version control**

### 3. Prepare Your Logo

Your `logo.png` should be:
- 128x128 pixels
- Teacup with steam (warm terracotta #D85A3A, golden amber #F5A442)

---

---

# FRONTEND — EXTENSION DEVELOPMENT

---

## Phase 2: Frontend — Extension Development

### Phase 2A: Extension Scaffold

#### Step 1: Create Vite Project

```bash
cd ~/Desktop/webwhiz

npm create vite@latest samajhlo-extension -- --template vanilla-ts
cd samajhlo-extension

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

#### Step 4: Copy Your Logo

```bash
cp ~/your-path/logo.png public/icon.png
```

#### Step 5: Create `src/content.ts`

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

#### Step 6: Create `src/background.ts`

```typescript
// Background service worker - handles AI requests

const BACKEND_URL = "http://localhost:8000/explain"; // Change in Phase 6

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
  // Try on-device Nano first
  if (self.ai?.canCreateTextSession) {
    try {
      const session = await self.ai.createTextSession();
      const prompt = buildPrompt(text, action);
      const answer = await session.prompt(prompt);
      console.log("[Nano] Answer from on-device AI");
      return answer;
    } catch (error) {
      console.warn("[Nano] Failed, falling back to backend:", error);
    }
  }

  console.log("[Backend] Falling back to backend for:", action);
  return await callBackend(text, action);
}

async function callBackend(text: string, action: string): Promise<string> {
  const installId = await getInstallId();

  try {
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        action,
        install_id: installId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    const data: any = await response.json();

    if (data.success) {
      return data.answer;
    } else {
      throw new Error(data.error || "Backend returned an error");
    }
  } catch (error) {
    throw new Error(`Backend failed: ${(error as Error).message}`);
  }
}

async function getInstallId(): Promise<string> {
  const result = await chrome.storage.local.get("installId");

  if (result.installId) {
    return result.installId;
  }

  const installId = crypto.randomUUID();
  await chrome.storage.local.set({ installId });
  console.log("[Setup] Generated new install ID:", installId);
  return installId;
}

function buildPrompt(text: string, action: string): string {
  const prompts: Record<string, string> = {
    explain: `Explain this clearly in 2-3 sentences: "${text}"`,
    simplify: `Simplify this into basic language anyone can understand: "${text}"`,
    summarize: `Summarize this in one sentence: "${text}"`,
    translate: `Translate this to English: "${text}"`,
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

      return true;
    }
  }
);
```

#### Step 7: Build and Load

```bash
npm run build

# Load in Chrome:
# 1. chrome://extensions
# 2. Developer mode ON
# 3. Load unpacked → select dist/
```

**Test:** Select text on any webpage. Toolbar should appear.

✅ **Milestone: Extension UI works**

---

---

# BACKEND — API DEVELOPMENT

---

## Phase 3: Backend — API Development

### Phase 3A: Backend Skeleton

#### Step 1: Create Backend Project

```bash
cd ~/Desktop/webwhiz

mkdir samajhlo-backend
cd samajhlo-backend

python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
```

#### Step 2: Create `requirements.txt`

```
fastapi==0.104.1
uvicorn==0.24.0
pydantic==2.5.0
requests==2.31.0
python-dotenv==1.0.0
redis==5.0.0
```

#### Step 3: Install Dependencies

```bash
pip install -r requirements.txt
```

#### Step 4: Create `.env`

```
GEMINI_API_KEY=your_key_here
REDIS_URL=redis://default:password@host:port
```

Add to `.gitignore`:
```bash
echo ".env" >> .gitignore
echo "venv/" >> .gitignore
echo "__pycache__/" >> .gitignore
echo "*.pyc" >> .gitignore
```

#### Step 5: Create `main.py` (Echo Version)

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="webwhiz ai Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ExplainRequest(BaseModel):
    text: str
    action: str = "explain"
    install_id: str = "test-user"

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/explain")
def explain(req: ExplainRequest):
    return {
        "success": True,
        "answer": f"[ECHO] You asked to '{req.action}': {req.text}",
    }
```

#### Step 6: Run Locally

```bash
source venv/bin/activate
uvicorn main:app --reload
```

#### Step 7: Test with curl

```bash
curl http://localhost:8000/health

curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text": "Machine learning is AI", "action": "explain"}'
```

✅ **Milestone: Backend responds to requests**

### Phase 3B: Real Gemini Integration

#### Step 1: Get Gemini API Key

Go to [Google AI Studio](https://aistudio.google.com) and get your API key.

#### Step 2: Update `main.py`

Replace with:

```python
import os
import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise ValueError("GEMINI_API_KEY not set in .env")

app = FastAPI(title="webwhiz ai Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ExplainRequest(BaseModel):
    text: str
    action: str = "explain"
    install_id: str = "test-user"

def call_gemini(prompt: str) -> str:
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
    
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt}
                ]
            }
        ]
    }
    
    response = requests.post(
        url,
        params={"key": GEMINI_API_KEY},
        json=payload,
    )
    
    if response.status_code != 200:
        raise Exception(f"Gemini API error: {response.status_code} - {response.text}")
    
    data = response.json()
    
    if "candidates" not in data or len(data["candidates"]) == 0:
        raise Exception("No response from Gemini")
    
    return data["candidates"][0]["content"]["parts"][0]["text"]

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/explain")
def explain(req: ExplainRequest):
    prompts = {
        "explain": f"Explain this clearly in 2-3 sentences: {req.text}",
        "simplify": f"Simplify this into basic language: {req.text}",
        "summarize": f"Summarize this in one sentence: {req.text}",
        "translate": f"Translate this to English: {req.text}",
    }
    
    prompt = prompts.get(req.action, prompts["explain"])
    
    try:
        answer = call_gemini(prompt)
        return {
            "success": True,
            "answer": answer,
            "action": req.action,
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
        }
```

#### Step 3: Test

```bash
uvicorn main:app --reload

curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text": "Python is a programming language", "action": "explain"}'
```

✅ **Milestone: Backend calls real LLM**

---

## Phase 4: Backend — Caching & Rate Limiting

#### Step 1: Get Redis URL

Go to [Upstash](https://upstash.com) and create a Redis database. Copy the URL.

#### Step 2: Update `.env`

```
GEMINI_API_KEY=your_key
REDIS_URL=redis://default:password@host:port
```

#### Step 3: Update `main.py`

Replace entirely with:

```python
import os
import hashlib
import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from redis import Redis

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
REDIS_URL = os.getenv("REDIS_URL")

if not GEMINI_API_KEY:
    raise ValueError("GEMINI_API_KEY not set")
if not REDIS_URL:
    raise ValueError("REDIS_URL not set")

redis = Redis.from_url(REDIS_URL)
DAILY_LIMIT = 50

app = FastAPI(title="webwhiz ai Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ExplainRequest(BaseModel):
    text: str
    action: str = "explain"
    install_id: str = "test-user"

def call_gemini(prompt: str) -> str:
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
    
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt}
                ]
            }
        ]
    }
    
    response = requests.post(
        url,
        params={"key": GEMINI_API_KEY},
        json=payload,
    )
    
    if response.status_code != 200:
        raise Exception(f"Gemini API error: {response.status_code}")
    
    data = response.json()
    
    if "candidates" not in data or len(data["candidates"]) == 0:
        raise Exception("No response from Gemini")
    
    return data["candidates"][0]["content"]["parts"][0]["text"]

def check_rate_limit(install_id: str) -> tuple[bool, int]:
    key = f"limit:{install_id}"
    count = redis.incr(key)
    
    if count == 1:
        redis.expire(key, 86400)
    
    remaining = max(0, DAILY_LIMIT - count)
    return count <= DAILY_LIMIT, remaining

def cache_key(text: str, action: str) -> str:
    raw = f"{action}:{text}".encode()
    return "cache:" + hashlib.sha256(raw).hexdigest()

def get_cached(text: str, action: str) -> str | None:
    cached = redis.get(cache_key(text, action))
    return cached.decode() if cached else None

def set_cached(text: str, action: str, answer: str):
    redis.setex(cache_key(text, action), 604800, answer)

@app.get("/health")
def health():
    try:
        redis.ping()
        return {"status": "ok", "redis": "connected"}
    except Exception as e:
        return {"status": "error", "redis": str(e)}

@app.post("/explain")
def explain(req: ExplainRequest):
    allowed, remaining = check_rate_limit(req.install_id)
    if not allowed:
        return {
            "success": False,
            "error": "Daily limit reached (50 requests). Reset in 24 hours.",
        }
    
    cached_answer = get_cached(req.text, req.action)
    if cached_answer:
        return {
            "success": True,
            "answer": cached_answer,
            "action": req.action,
            "source": "cache",
        }
    
    prompts = {
        "explain": f"Explain this clearly in 2-3 sentences: {req.text}",
        "simplify": f"Simplify this into basic language: {req.text}",
        "summarize": f"Summarize this in one sentence: {req.text}",
        "translate": f"Translate this to English: {req.text}",
    }
    
    prompt = prompts.get(req.action, prompts["explain"])
    
    try:
        answer = call_gemini(prompt)
        set_cached(req.text, req.action, answer)
        
        return {
            "success": True,
            "answer": answer,
            "action": req.action,
            "source": "llm",
            "remaining_today": remaining,
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
        }
```

#### Step 4: Test

```bash
# First call (LLM)
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text": "Test", "action": "explain", "install_id": "user1"}'

# Second call (cache)
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text": "Test", "action": "explain", "install_id": "user1"}'

# Notice "source": "cache" on second response
```

✅ **Milestone: Rate limiting & caching work**

---

## Phase 5: Backend — Deployment

### Step 1: Prepare for GitHub

```bash
cd ~/Desktop/webwhiz/samajhlo-backend

git init
git add .
git commit -m "Initial backend"

# Create repo on GitHub first (github.com/new)
# Then:

git remote add origin https://github.com/YOUR_USERNAME/samajhlo-backend.git
git branch -M main
git push -u origin main
```

### Step 2: Deploy on Render

1. Go to [render.com](https://render.com) and sign in
2. Click "New +" → "Web Service"
3. Select your `samajhlo-backend` GitHub repo
4. Configure:
   - **Name:** `samajhlo-backend`
   - **Environment:** `Python 3`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port 10000`
5. Add Environment Variables:
   - `GEMINI_API_KEY` = your key
   - `REDIS_URL` = your URL
6. Click "Create Web Service"

Wait 2-3 minutes. You'll get a URL like:
```
https://samajhlo-backend.onrender.com
```

### Step 3: Test Deployment

```bash
curl https://samajhlo-backend.onrender.com/health

curl -X POST https://samajhlo-backend.onrender.com/explain \
  -H "Content-Type: application/json" \
  -d '{"text": "test", "action": "explain"}'
```

✅ **Milestone: Backend deployed and public**

---

---

# WIRE & POLISH

---

## Phase 6: Frontend — Wire to Backend

### Step 1: Update Backend URL

Edit `samajhlo-extension/src/background.ts`:

Change:
```typescript
const BACKEND_URL = "http://localhost:8000/explain";
```

To:
```typescript
const BACKEND_URL = "https://samajhlo-backend.onrender.com/explain";
```

### Step 2: Rebuild

```bash
cd samajhlo-extension
npm run build
```

### Step 3: Reload Extension

- `chrome://extensions`
- Click refresh on webwhiz ai

### Step 4: Test

1. Open any webpage
2. Select text
3. Click "Explain"
4. Should work with backend
5. Second identical request should be instant (cache)

✅ **Milestone: Extension ↔ Backend wired**

---

## Phase 7: Frontend — Polish & Submit

### Step 1: Create Privacy Policy

Create `PRIVACY.md` in your project root:

```markdown
# Privacy Policy — webwhiz ai

## Data Collection

- **Selected text:** Sent to backend when on-device AI unavailable
- **Install ID:** Anonymous identifier for rate limiting
- **Cached responses:** Stored for 7 days

## On-Device Processing

Uses Chrome's built-in Gemini Nano. No data leaves your browser.

## Data Storage

- Cache expires after 7 days
- Install IDs reset on uninstall
- We don't sell or share data

## Questions

Email: your-email@example.com
```

### Step 2: Update Manifest

Edit `src/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "webwhiz ai",
  "version": "0.1.0",
  "description": "Select any text and get instant explanations, simplifications, summaries, or translations.",
  "permissions": ["storage"],
  "host_permissions": ["<all_urls>"],
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
  }
}
```

### Step 3: Final Build

```bash
npm run build
```

### Step 4: Submit to Chrome Web Store

1. [Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole)
2. Click "New item"
3. Upload `dist/` folder
4. Fill in:
   - **Name:** webwhiz ai
   - **Short description:** Select text, get instant insights
   - **Detailed description:**
     ```
     webwhiz ai lets you select any text on a webpage and instantly get:
     - Clear explanations
     - Simplified language
     - Quick summaries
     - Translations
     
     Powered by AI. On-device processing for privacy when available.
     ```
   - **Category:** Productivity
   - **Languages:** English
   - **Icon:** icon.png (128x128)
   - **Screenshots:** 1280x800 screenshots
   - **Privacy policy:** Link to PRIVACY.md
5. Submit for review

✅ **Milestone: v1 submitted to Chrome Web Store**

---

---

# TESTING & TROUBLESHOOTING

---

## Testing

### Quick Test Checklist

```bash
# 1. Extension
cd samajhlo-extension
npm run build
# Load unpacked in chrome://extensions

# 2. Open Wikipedia

# 3. Select: "Machine learning is a field of artificial intelligence"

# 4. Toolbar appears with 4 buttons

# 5. Click "Explain"

# 6. Answer shows in popover

# 7. Select same text again → instant (cache hit)
```

### Full Test Suite

- [ ] Extension loads unpacked without errors
- [ ] Selection detection works (>10 chars)
- [ ] Toolbar appears next to selection
- [ ] All 4 buttons work (Explain, Simplify, Summary, Translate)
- [ ] Nano works when enabled (instant)
- [ ] Backend fallback works when Nano disabled
- [ ] Cache hits return instantly (check "source": "cache")
- [ ] Rate limit triggers after 50 requests
- [ ] Error messages are clear and friendly
- [ ] Dark mode colors render correctly
- [ ] Works on 3+ different websites
- [ ] Backend health check: `curl /health` returns ok

---

## Troubleshooting

### Selection Not Detected
- Selection must be >10 characters
- Check DevTools console for errors
- Reload page and extension
- Verify `content.ts` is injected (DevTools → Sources)

### No Toolbar Appears
- Check Shadow DOM is in DOM (DevTools → Elements)
- Verify CSS `z-index: 10000`
- Check console for JavaScript errors
- Reload extension

### Backend Returns 500
- Check Render logs
- Verify `GEMINI_API_KEY` is set
- Verify `REDIS_URL` is correct
- Test health endpoint: `curl https://your-app/health`

### Nano Not Working
- Go to `chrome://flags`
- Search "prompt api", enable it
- Use Chrome Canary (more reliable)
- Nano needs to download model first

### Extension Won't Load
- Delete from `chrome://extensions`
- Clear dist/: `rm -rf dist/`
- Rebuild: `npm run build`
- Load unpacked again

### Can't Send Messages to Background
- Check manifest has "service_worker"
- Verify `return true` in `onMessage` listener
- Check DevTools → Extensions → Errors
- Reload extension

### Redis Connection Error
- Verify `REDIS_URL` in `.env`
- Check Upstash console that DB is active
- Verify Render env variable is set (not .env file)

### Gemini API Error 401
- Go to Google AI Studio
- Regenerate API key
- Update `.env` locally
- Update Render env variable

---

## Commands Reference

```bash
# Frontend
cd samajhlo-extension
npm install              # First time
npm run build           # Build
npm run dev             # Dev with hot reload

# Backend
cd samajhlo-backend
python3 -m venv venv    # First time
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload  # Run locally

# Testing
curl http://localhost:8000/health
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"test","action":"explain","install_id":"test"}'

# Git
git add .
git commit -m "message"
git push origin main
```

---

## Environment Variables

**In `samajhlo-backend/.env` (never commit):**
```
GEMINI_API_KEY=sk-...
REDIS_URL=redis://default:password@host:port
```

**In Render Dashboard (safe to store):**
```
GEMINI_API_KEY=sk-...
REDIS_URL=redis://...
```

---

## File Structure (Final)

```
webwhiz/
├── CODE.md
├── logo.png
│
├── samajhlo-extension/
│   ├── src/
│   │   ├── manifest.json
│   │   ├── content.ts
│   │   └── background.ts
│   ├── public/
│   │   └── icon.png
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   └── dist/            ← Load unpacked
│
└── samajhlo-backend/
    ├── main.py          ← All code
    ├── requirements.txt
    ├── .env             ← Never commit
    ├── .gitignore
    └── venv/
```

---

## Next Steps

1. **Start with Phase 2:** Scaffold the extension
2. **Move to Phase 3:** Build the backend
3. **Deploy in Phase 5:** Push to Render
4. **Wire in Phase 6:** Update backend URL
5. **Submit in Phase 7:** Chrome Web Store

**Ready?** Run Phase 2A Step 1:

```bash
cd ~/Desktop/webwhiz
npm create vite@latest samajhlo-extension -- --template vanilla-ts
```

Let's build! 🚀
