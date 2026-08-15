# Frontend Development Guide

**Extension development — Phases 2, 6, and 7**

See [CODE.md](./CODE.md) for the complete project overview.

---

## Table of Contents

1. [Phase 2A: Extension Scaffold](#phase-2a-extension-scaffold)
2. [Phase 2B: Toolbar & UI](#phase-2b-toolbar--ui)
3. [Phase 2C: Gemini Nano Integration](#phase-2c-gemini-nano-integration)
4. [Phase 6: Wire to Backend](#phase-6-wire-extension-to-backend)
5. [Phase 7: Polish & Submit](#phase-7-polish--submit)
6. [Testing](#testing)
7. [Troubleshooting](#troubleshooting)

---

## Phase 2A: Extension Scaffold

### Step 1: Create Vite Project

```bash
cd ~/Desktop/webwhiz

npm create vite@latest samajhlo-extension -- --template vanilla-ts
cd samajhlo-extension

npm i -D @crxjs/vite-plugin
npm install
```

### Step 2: Update `vite.config.ts`

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

### Step 3: Create `src/manifest.json`

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

### Step 4: Copy Your Logo

Place your `logo.png` in `public/icon.png`:

```bash
cp ~/your-path/logo.png public/icon.png
# Or manually copy the teacup logo (128x128px)
```

### Step 5: Create `src/content.ts`

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
  // Remove old toolbar if exists
  if (toolbar?.host) {
    toolbar.host.remove();
    toolbar = null;
  }

  lastSelectedText = text;
  const position = getSelectionPosition();
  if (!position) return;

  // Create container
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.top = position.top + "px";
  container.style.left = position.left + "px";
  container.style.zIndex = "10000";

  // Attach Shadow DOM
  toolbar = container.attachShadow({ mode: "open" });

  // Add styles
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

    button:hover {
      opacity: 0.9;
    }

    button:active {
      opacity: 0.8;
    }
  `;
  toolbar.appendChild(style);

  // Add toolbar HTML
  const toolbarEl = document.createElement("div");
  toolbarEl.className = "toolbar";
  toolbarEl.innerHTML = `
    <button data-action="explain">Explain</button>
    <button data-action="simplify">Simplify</button>
    <button data-action="summarize">Summary</button>
    <button data-action="translate">Translate</button>
  `;
  toolbar.appendChild(toolbarEl);

  // Add event listeners
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
    try {
      container.remove();
    } catch (e) {
      // Already removed
    }
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
    try {
      container.remove();
    } catch (e) {
      // Already removed
    }
  }, 5000);
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Listen for text selection
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

### Step 6: Create `src/background.ts`

```typescript
// Background service worker - handles AI requests

const BACKEND_URL = "http://localhost:8000/explain"; // Will update in Phase 6

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

  // Fall back to backend
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

  // Generate new ID
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

// Listen for messages from content script
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

### Step 7: Build and Load

```bash
npm run build

# You should see dist/ folder created

# Now load in Chrome:
# 1. Open chrome://extensions
# 2. Enable "Developer mode" (top right)
# 3. Click "Load unpacked"
# 4. Select the dist/ folder
```

**Test:**
- Open any webpage
- Select text (>10 characters)
- Toolbar should appear with 4 buttons
- Click any button (will fail without backend, but UI should work)

✅ **Milestone: Extension UI works, can detect selections and render toolbar**

---

## Phase 2B: Toolbar & UI

The toolbar and popover are already implemented in `content.ts` from Phase 2A. They include:

- ✅ Floating toolbar positioned near selection
- ✅ 4 action buttons (Explain, Simplify, Summary, Translate)
- ✅ Popover that shows answers
- ✅ Error messages
- ✅ Auto-close after 8 seconds
- ✅ Light & dark mode support (uses CSS custom properties)
- ✅ Shadow DOM isolation from page styles

**Colors used:**
- Cup: `#D85A3A` (warm terracotta)
- Steam: `#F5A442` (golden amber)

---

## Phase 2C: Gemini Nano Integration

The background worker already has Nano integration in `src/background.ts`. It:

1. ✅ Checks if `self.ai?.canCreateTextSession` exists
2. ✅ Creates a session and calls `session.prompt()`
3. ✅ Falls back to backend if unavailable
4. ✅ Builds appropriate prompts for each action

**To test Nano locally:**
- Go to `chrome://flags`
- Search "prompt api"
- Enable it
- Use Chrome Canary (more reliable)

---

## Phase 6: Wire Extension to Backend

Once your backend is deployed (see [BACKEND.md](./BACKEND.md)), update the backend URL:

### Step 1: Update Backend URL

Edit `src/background.ts`:

```typescript
// Change this line:
const BACKEND_URL = "http://localhost:8000/explain"; // For local testing

// To this when deployed:
const BACKEND_URL = "https://samajhlo-backend.onrender.com/explain";
```

### Step 2: Rebuild

```bash
npm run build
```

### Step 3: Reload Extension

- Go to `chrome://extensions`
- Click the refresh icon on webwhiz ai
- Extension is now live with backend

### Step 4: Test End-to-End

1. Open any webpage
2. Select text
3. Click "Explain"
4. Should get answer from backend (slightly slower than Nano)
5. Click same action again → should be instant (cache hit)

✅ **Milestone: Extension works with backend**

---

## Phase 7: Polish & Submit

### Step 1: Update Manifest Permissions

Update `src/manifest.json`:

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

### Step 2: Create Privacy Policy

Create `PRIVACY.md` in your project root:

```markdown
# Privacy Policy — webwhiz ai

## What Data We Collect

- **Selected text:** When on-device AI is unavailable, selected text is sent to our backend for processing
- **Install ID:** Anonymous identifier for rate limiting (not tied to your identity)
- **Cached responses:** Stored on our servers for 7 days

## What We Don't Collect

- No personal information
- No browsing history
- No user identity

## On-Device Processing

When available, all processing happens on your device using Chrome's built-in Gemini Nano. No data ever leaves your browser in this case.

## Data Storage

- Cache entries expire after 7 days
- Install IDs reset when you uninstall the extension
- We don't sell or share data

## Contact

Questions? Email: your-email@example.com
```

### Step 3: Final Build

```bash
npm run build
```

### Step 4: Create Chrome Web Store Listing

1. Go to [Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole)
2. Click "New item"
3. Upload `dist/` folder (zip it first if needed)
4. Fill in store listing:
   - **Name:** webwhiz ai
   - **Short description:** Select text, get instant insights
   - **Detailed description:**
     ```
     webwhiz ai lets you select any text on a webpage and instantly get:
     - Clear explanations
     - Simplified language
     - Quick summaries
     - Translations
     
     Powered by AI. When available, uses on-device processing for complete privacy.
     ```
   - **Category:** Productivity
   - **Languages:** English
   - **Screenshots:** Create 1280x800 screenshots showing the extension in action
   - **Icon:** Your icon.png (128x128)
   - **Privacy policy:** Link to PRIVACY.md or your website

### Step 5: Submit for Review

- Review all details
- Accept policies
- Submit for review

⏳ Google reviews in 1-3 days

✅ **Milestone: v1 submitted to Chrome Web Store**

---

## Testing

### Before Submission

- [ ] Selection detection works on multiple websites
- [ ] Toolbar appears next to selection
- [ ] All 4 buttons work (Explain, Simplify, Summary, Translate)
- [ ] Nano answers work when enabled (on-device, instant)
- [ ] Backend fallback works when Nano disabled
- [ ] Cache works (identical request is instant)
- [ ] Rate limit shows friendly message
- [ ] Error messages are clear
- [ ] Dark mode colors look good
- [ ] Tested on at least 3 different sites

### Quick Test Checklist

```bash
# 1. Build
npm run build

# 2. Load unpacked in chrome://extensions

# 3. Open wikipedia.org

# 4. Select text like "Machine learning is..."

# 5. Click "Explain"

# 6. Toolbar should appear, answer should show in popover

# 7. Select same text again

# 8. Should be instant (cache hit from backend)
```

---

## Troubleshooting

### "Selection not detected"
**Problem:** Text is selected but toolbar doesn't appear  
**Solution:**
- Make sure selection is >10 characters
- Check DevTools console for errors
- Try reloading the page and extension
- Verify `content.ts` is being injected (DevTools → Sources)

### "No toolbar appears"
**Problem:** Selected text but no floating button group  
**Solution:**
- Check that Shadow DOM CSS is correct
- Verify `z-index: 10000` is high enough
- Open DevTools → Elements → Find toolbar in DOM
- Check console for JavaScript errors

### "Backend returns 500 error"
**Problem:** Extension works locally but fails when deployed  
**Solution:**
- Verify `GEMINI_API_KEY` is set in Render environment
- Verify `REDIS_URL` is correct
- Check Render logs: Dashboard → Your app → Logs
- Try hitting backend health endpoint: `curl https://your-app.onrender.com/health`

### "Nano not working"
**Problem:** Trying to use on-device AI but it's unavailable  
**Solution:**
- Go to `chrome://flags`
- Search "prompt api"
- Enable it
- Use Chrome Canary (Stable Chrome may not support it yet)
- Nano needs to be enabled AND download the model first

### "Extension won't load unpacked"
**Problem:** "Manifest error" or similar  
**Solution:**
- Clear dist folder: `rm -rf dist/`
- Rebuild: `npm run build`
- Delete the extension from chrome://extensions
- Load unpacked again, pointing to the dist/ folder

### "Can't send messages to background worker"
**Problem:** `chrome.runtime.sendMessage` fails  
**Solution:**
- Check that background.ts is loaded (check manifest permissions)
- Verify `return true` in onMessage listener to keep channel open
- Check DevTools → Extensions → Errors
- Try reloading extension

---

## Development Commands

```bash
# Setup (first time)
npm install
npm i -D @crxjs/vite-plugin

# Development
npm run dev      # Hot reload dev mode
npm run build    # Production build

# Testing
# Open chrome://extensions, load unpacked dist/ folder
```

---

## File Structure

```
samajhlo-extension/
├── src/
│   ├── manifest.json        ← Extension config
│   ├── content.ts           ← Content script (selection, UI)
│   ├── background.ts        ← Background worker (AI logic)
│   └── styles/
│       └── shadow-dom.css   ← (Optional, inline in content.ts)
├── public/
│   └── icon.png             ← Your logo (128x128)
├── vite.config.ts
├── tsconfig.json
├── package.json
└── dist/                    ← Generated on build (load this unpacked)
```

---

**Next:** When your backend is deployed (see [BACKEND.md](./BACKEND.md)), come back to Phase 6 to wire everything together! 🚀
