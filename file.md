## Chat-with-any-webpage Browser Extension

**Build Guide — Roadmap, Tech Stack, Learning Resources & Implementation**

---

## Contents

1. [Project Overview](#1-project-overview)
2. [Naming Options](#2-naming-options)
3. [Architecture at a Glance](#3-architecture-at-a-glance)
4. [Full Tech Stack](#4-full-tech-stack)
5. [Where to Learn Each Piece](#5-where-to-learn-each-piece)
6. [Video Tutorials (YouTube)](#6-video-tutorials-youtube)
7. [Step-by-Step Build Plan](#7-step-by-step-build-plan)
8. [Implementation — Backend (FastAPI)](#8-implementation--backend-fastapi)
9. [Implementation — Extension (Manifest V3)](#9-implementation--extension-manifest-v3)
10. [Fallback & Reliability Plan](#10-fallback--reliability-plan)
11. [Deployment Checklist](#11-deployment-checklist)
12. [What's Next After v1](#12-whats-next-after-v1)

---

## 1. Project Overview

A browser extension that lets users select any text on a webpage and instantly get an explanation, simplification, summary, or translation — without opening a separate AI tool or tab.

**Core interaction:** User highlights text → a small floating toolbar appears next to the selection → user taps an action → an answer appears in a popover anchored to that selection. No chat panel, no login, no page-wide context required by default.

**Key design decisions made:**

- Selection-triggered UX, not a full chat panel (lighter-weight, faster, more native-feeling than competitors).
- On-device AI (Chrome's built-in Gemini Nano) as the default path — private, free, zero network call.
- Cloud fallback via your own backend, using a free-tier LLM (Gemini API or Groq), for when Nano is unavailable or answers need more depth.
- Backend built with FastAPI (Python) instead of Cloudflare Workers — with Redis for rate-limiting and caching to protect the shared free-tier quota.

---

## 2. Naming Options

**English:** Pagewise, Glance, Lucid, Skim, Clarify

**Hindi:** समझो (Samjho), बूझो (Boojho), स्पष्ट (Spasht), ज्ञान (Gyaan)

**Hinglish:** SamajhLo *(chosen)*, Explain Karo, PageGyaan, Batao, Samjhao

This guide uses "SamajhLo" as a working name throughout — swap it freely.

---

## 3. Architecture at a Glance

### Client-side flow

1. User selects text on any webpage.
2. Content script detects the selection and renders a floating toolbar (Shadow DOM, isolated from page CSS).
3. User taps an action (Explain / Simplify / Summarize / Translate).
4. Background service worker checks whether on-device Gemini Nano is available.
5. If available → runs locally, fully private, no network call.
6. If unavailable → falls back to your FastAPI backend.
7. Answer streams back and renders in a popover anchored to the original selection.

### Backend flow (cloud fallback only)

8. Request arrives at the FastAPI app with `{ text, action, install_id }`.
9. Backend checks Redis: has this `install_id` exceeded its daily rate limit? If yes, return a friendly limit message.
10. Backend checks Redis cache: has this exact `(text, action)` pair been asked before? If yes, return the cached answer instantly.
11. If neither check stops it, call the free-tier LLM API (Gemini or Groq).
12. Store the result in the Redis cache, then return it to the extension.

---

## 4. Full Tech Stack

| Layer | Technology | Role |
|---|---|---|
| Content script | TypeScript + Shadow DOM | Detects selection, renders toolbar/popover isolated from page styles |
| Build tooling | Vite + @crxjs/vite-plugin | Bundles the extension, generates the MV3 manifest, hot reload in dev |
| Background logic | MV3 service worker | Only piece that makes network calls; routes local vs. cloud |
| On-device AI | Chrome Prompt API (Gemini Nano) | Free, private, zero-latency answers when available |
| Backend framework | FastAPI (Python) | Receives fallback requests, orchestrates rate-limit, cache, and LLM call |
| Backend hosting | Render (free tier) | Public HTTPS URL for the FastAPI app |
| Rate limit + cache | Redis via Upstash (free tier) | Protects the shared free LLM quota; avoids duplicate calls |
| Cloud model | Gemini API or Groq (free tier) | Produces the actual answer when on-device isn't enough |
| Local extension storage | chrome.storage.local | Stores install ID and settings, no account needed |

---

## 5. Where to Learn Each Piece

Pointers to primary, official sources — prefer these over random tutorials, they stay current as APIs change.

**Browser extension basics (Manifest V3)**
- Chrome Extensions official docs (start here): <https://developer.chrome.com/docs/extensions/get-started>
- Manifest V3 overview: <https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3>
- Content scripts guide: <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>

**TypeScript**
- Official TypeScript Handbook: <https://www.typescriptlang.org/docs/handbook/intro.html>

**Vite + extension tooling**
- Vite official guide: <https://vite.dev/guide/>
- crxjs Vite plugin docs: <https://crxjs.dev/vite-plugin>

**Chrome built-in AI (Gemini Nano / Prompt API)**
- Chrome built-in AI overview: <https://developer.chrome.com/docs/ai/built-in>
- Prompt API explainer: <https://developer.chrome.com/docs/ai/prompt-api>

> This surface is actively evolving — re-check the docs right before you implement rather than relying on memory.

**FastAPI**
- Official FastAPI tutorial: <https://fastapi.tiangolo.com/tutorial/>
- Pydantic docs (request/response models): <https://docs.pydantic.dev/latest/>

**Redis / Upstash**
- Upstash Redis quickstart: <https://upstash.com/docs/redis/overall/getstarted>
- Redis Python client docs: <https://redis.readthedocs.io/en/stable/>

**Free-tier LLM APIs**
- Google AI Studio (Gemini API keys): <https://aistudio.google.com/>
- Gemini API docs: <https://ai.google.dev/gemini-api/docs>
- Groq API docs (alternative/faster free tier): <https://console.groq.com/docs/quickstart>

**Deployment**
- Render — deploy a web service: <https://render.com/docs/deploy-fastapi>

---

## 6. Video Tutorials (YouTube)

Paired with the official docs above — docs for exact API reference, videos for watching the workflow end to end. Organized in build order.

### Chrome Extensions / Manifest V3
- Build a Chrome Extension — Full Beginner Course (freeCodeCamp): <https://www.youtube.com/watch?v=0n809nd4Zu4>
- Chrome Extension with React & TypeScript: <https://www.youtube.com/watch?v=8OCEfOKzpAw>

### TypeScript
- Learn TypeScript — Full Course for Beginners (freeCodeCamp): <https://www.youtube.com/watch?v=SpwzRDUQ1GI>
- No BS TS by Jack Herrington (shorter, more practical): <https://www.youtube.com/watch?v=LKVHFHJsiO0>

### Vite
- Vite Crash Course (Traversy Media): <https://www.youtube.com/watch?v=89NJdbYTgJ8>

### Chrome Built-in AI (Gemini Nano / Prompt API)
- Chrome's Built-in AI in 3 min — The Prompt API: <https://www.youtube.com/watch?v=YkUcxX49Rqw>
- Practical Built-in AI with Gemini Nano in Chrome: <https://www.youtube.com/watch?v=CjpZCWYrSxM>

### FastAPI
- FastAPI Full Course for Beginners: <https://www.youtube.com/watch?v=VirndPTeRaw>
- FastAPI Course (freeCodeCamp): <https://www.youtube.com/watch?v=tLKKmouUams>

### Redis
- Redis Full Course — In-Memory Database Tutorial (freeCodeCamp): <https://www.youtube.com/watch?v=XCsS_NVAa1g>
- Redis Crash Course (Web Dev Simplified, ~20 min): <https://www.youtube.com/watch?v=jgpVdJB2sKQ>

### Gemini API
- Gemini API with Python — Getting Started Tutorial: <https://www.youtube.com/watch?v=qfWpPEgea2A>
- Get Your Gemini API Key in Google AI Studio — Easy Tutorial: <https://www.youtube.com/watch?v=JdKcFCLotZY>

> **Note:** Chrome's built-in AI surface is new and changes fast — if a video's code doesn't match what you see in `chrome://flags` or the console, trust the official docs in Section 5 over the video.

---

## 7. Step-by-Step Build Plan

Build in this order. Each phase should work end-to-end before moving to the next — don't wire the extension to the backend until the backend works alone via curl.

### Phase 1 — Environment setup

1. Install Node.js (LTS) and npm.
2. Install Chrome Canary or Chrome Dev channel — on-device Nano features are more reliable there than on stable Chrome.
3. Install Python 3.11+ and pip.
4. Create free accounts: Google AI Studio (Gemini key), Upstash (Redis), Render (hosting).

### Phase 2 — Extension skeleton (local only, no backend yet)

5. Scaffold with Vite: `npm create vite@latest`, choose `vanilla-TS`.
6. Add the crxjs plugin for MV3 support: `npm i -D @crxjs/vite-plugin`.
7. Write the smallest possible `manifest.json` (name, version, content_scripts, background service_worker) and load it via `chrome://extensions` → Developer mode → Load unpacked.
8. In the content script, listen for `mouseup` / `selectionchange` and `console.log` the selected text — prove the extension can see selections on any page.
9. Replace the `console.log` with a floating toolbar rendered in a Shadow DOM, positioned using `getSelection().getRangeAt(0).getBoundingClientRect()`. Start with one button: "Explain".
10. Wire the button to Chrome's Prompt API (Nano). Render whatever comes back in a basic popover. This alone is a demoable, fully local v0.

### Phase 3 — Backend skeleton (isolated from the extension)

11. Create a FastAPI project with one `POST /explain` endpoint that echoes back what it receives — no LLM call yet.
12. Run locally with `uvicorn main:app --reload` and confirm the round trip with curl.
13. Replace the echo with a real call to the Gemini or Groq free API. Keep testing with curl — do not touch the extension yet.

### Phase 4 — Add rate limiting and caching

14. Sign up for Upstash, create a Redis database, get the connection URL.
15. In FastAPI, before calling the LLM: check/increment a daily request counter in Redis keyed by `install_id`.
16. Check a cache key built from a hash of `(text, action)`; return the cached answer on a hit, skip the LLM call entirely.
17. After a successful LLM call, write the result into the cache with a sensible expiry (e.g. 7 days).

### Phase 5 — Deploy the backend

18. Push the FastAPI project to GitHub.
19. Connect the repo to Render, deploy as a Web Service, confirm the public HTTPS URL responds to curl the same way localhost did.
20. Store the Gemini/Groq API key and Redis URL as environment variables in Render — never commit them to the repo.

### Phase 6 — Connect extension to backend

21. In the background service worker: try Nano first; if unavailable, `fetch()` the deployed Render URL instead.
22. Generate an anonymous install ID with `crypto.randomUUID()` on first run, store it via `chrome.storage.local`, send it with every backend request.
23. Test the full local-first, cloud-fallback flow end to end on a real webpage.

### Phase 7 — Polish

24. Add the remaining toolbar actions: Simplify, Summarize, Translate.
25. Add graceful error states (Nano not available, backend rate-limited, empty selection).
26. Write the privacy policy (required for Chrome Web Store, since selected text can leave the browser via the fallback path).
27. Submit to the Chrome Web Store.

---

## 8. Implementation — Backend (FastAPI)

### main.py (current — echo version, already verified working)

```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="SamajhLo Backend")

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
        "received_text": req.text,
        "action": req.action,
        "install_id": req.install_id,
        "answer": f"[echo] You asked to '{req.action}' this: {req.text}",
    }
```

### Next edit — replace the echo with a real Gemini call

```python
import os, requests

GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]

def call_gemini(prompt: str) -> str:
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent"
    resp = requests.post(
        url,
        params={"key": GEMINI_API_KEY},
        json={"contents": [{"parts": [{"text": prompt}]}]},
    )
    resp.raise_for_status()
    data = resp.json()
    return data["candidates"][0]["content"]["parts"][0]["text"]
```

### Next edit — add Redis rate limit + cache

```python
import hashlib
from redis import Redis

redis = Redis.from_url(os.environ["REDIS_URL"])
DAILY_LIMIT = 50

def check_rate_limit(install_id: str) -> bool:
    key = f"limit:{install_id}"
    count = redis.incr(key)
    if count == 1:
        redis.expire(key, 86400)  # 24 hours
    return count <= DAILY_LIMIT

def cache_key(text: str, action: str) -> str:
    raw = f"{action}:{text}".encode()
    return "cache:" + hashlib.sha256(raw).hexdigest()

def get_cached(text: str, action: str):
    return redis.get(cache_key(text, action))

def set_cached(text: str, action: str, answer: str):
    redis.setex(cache_key(text, action), 604800, answer)  # 7 days
```

---

## 9. Implementation — Extension (Manifest V3)

### manifest.json (minimal starting point)

```json
{
  "manifest_version": 3,
  "name": "SamajhLo",
  "version": "0.1.0",
  "description": "Select any text on a webpage and get an instant explanation.",
  "permissions": ["storage"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"]
    }
  ]
}
```

### content.js (selection detection — first milestone)

```javascript
document.addEventListener("mouseup", () => {
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : "";
  if (text.length > 0) {
    console.log("Selected:", text);
    // next step: render toolbar near selection.getRangeAt(0).getBoundingClientRect()
  }
});
```

### background.js (routing logic — sketch for Phase 6)

```javascript
const BACKEND_URL = "https://your-app.onrender.com/explain";

async function getAnswer(text, action) {
  if (self.ai && self.ai.canCreateTextSession) {
    // On-device path — verify exact API shape in current Chrome docs
    const session = await self.ai.createTextSession();
    return await session.prompt(`${action}: ${text}`);
  }
  const installId = await getInstallId();
  const res = await fetch(BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, action, install_id: installId }),
  });
  const data = await res.json();
  return data.answer;
}
```

---

## 10. Fallback & Reliability Plan

**If on-device AI isn't available:**
- Detect availability on startup, cache the result.
- If unavailable, still show the toolbar — tapping an action shows a clear one-time message rather than failing silently.
- If the model needs a first-time download, show a "Setting up (one-time)" state instead of a dead spinner.

**If the backend or model returns a bad/empty answer:**
- Show "Couldn't generate an answer — try selecting a bit more text" rather than a blank popover.
- For very short/ambiguous selections, automatically widen the context (grab the containing sentence) before calling the model.

**If the shared free-tier quota is at risk:**
- Redis daily rate limit per `install_id` prevents any single install from exhausting the quota.
- Cache hits (same text + action asked before) never touch the LLM API at all.
- Monitor Render/Upstash/Gemini dashboards for usage trending toward the ceiling; revisit provider or add a paid tier only once real usage data shows it's needed.

---

## 11. Deployment Checklist

- [ ] Backend deployed on Render with a public HTTPS URL, tested with curl.
- [ ] Gemini/Groq API key and Redis URL set as environment variables, never committed to the repo.
- [ ] Extension's `background.js` points at the deployed backend URL, not localhost.
- [ ] Privacy policy written and linked, disclosing that selected text may be sent to the backend when on-device AI is unavailable.
- [ ] Extension icon set and store listing screenshots prepared.
- [ ] Manual test pass: fresh Chrome profile, install unpacked, try all four actions on 3–4 different real websites.
- [ ] Submit for Chrome Web Store review.

---

## 12. What's Next After v1

- Add a "Chat about this page" expanded mode as an optional secondary feature, if users ask for it.
- Consider Firefox support once the Chromium version is stable.
- Watch Chrome's built-in AI docs for API changes — this surface is new and evolving quickly.