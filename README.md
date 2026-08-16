# 🫖 TeaWhiz AI — Chrome Extension

A powerful Chrome extension that lets you **ask questions about any webpage content** and get instant AI-powered answers.

---

## 📖 What TeaWhiz AI Does

### Core Functionality:

1. **Click the extension icon** on any website
2. **Ask a question** about the page content (any question!)
3. **Get instant answer** powered by AI

### Example Questions:
- "Summarize this article"
- "What is this page about?"
- "Extract the main points"
- "Is this information reliable?"
- "What are the key takeaways?"
- "Explain this in simpler terms"
- Literally **any question** about the webpage

---

## 🏗️ How It Works

### Architecture:

```
┌─────────────────────────────────────────────────────────┐
│                   User's Browser                          │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  Website  ← TeaWhiz AI Extension                         │
│  [Page]   ├─ Content Script: Extracts page text         │
│           ├─ Popup UI: User asks questions              │
│           └─ Background: Routes to AI service            │
│                          ↓                                │
│           ┌──────────────────────────────┐               │
│           │   Send:                      │               │
│           │   - Page content             │               │
│           │   - User question            │               │
│           └──────────────────────────────┘               │
│                       ↓                                    │
└───────────────────────────────────────────────────────────┘
                        ↓
            ┌──────────────────────────┐
            │   TeaWhiz AI Backend     │
            │   (FastAPI)              │
            ├──────────────────────────┤
            │ - Receives page content  │
            │ - Receives user question │
            │ - Combines them          │
            │ - Sends to Gemini API    │
            └──────────────────────────┘
                        ↓
            ┌──────────────────────────┐
            │   Google Gemini API      │
            │   (AI Processing)        │
            └──────────────────────────┘
                        ↓
            ┌──────────────────────────┐
            │   Response sent back     │
            │   Displayed in popup     │
            └──────────────────────────┘
```

---

## 🔐 Security & Privacy

### What Happens to Your Data:

| Data | Where | Stored? | Notes |
|------|-------|---------|-------|
| **Page Content** | Sent to backend | ❌ Not stored | Processed, then deleted |
| **Your Questions** | Sent to backend | ⚠️ Cached for 7 days | For performance |
| **API Responses** | Backend cache | ⚠️ Cached for 7 days | To reduce API costs |
| **Personal Info** | Not collected | ✅ Safe | Extension doesn't track users |

### Current Security Setup:

✅ **HTTPS in transit** (when deployed to Render)
✅ **No login required** (privacy-first)
✅ **No cookies/tracking** (no analytics)
✅ **Data not sold** (open source)
⚠️ **Page data sent to Gemini API** (Google's privacy policy applies)

---

## ⚠️ Before Deploying (Important!)

### You Need a Backend Server

TeaWhiz AI requires a backend server to process requests. **You MUST deploy one** before the extension works.

### Backend Deployment Options:

#### **Option 1: Render (Recommended) ✅ FREE**
- Deploy FastAPI backend in 5 minutes
- Free tier: 750 hours/month (always on)
- Easy deployment from GitHub

**Steps:**
```bash
1. Push backend to GitHub
2. Go to render.com
3. Create new "Web Service"
4. Connect GitHub repo
5. Deploy
6. Get backend URL (e.g., https://teawhiz-api.render.com)
7. Update frontend with this URL
```

#### **Option 2: Google Cloud Platform (GCP)**
- Free tier: $300 credit + always-free services
- More control
- Requires Google Cloud account

#### **Option 3: Heroku (Paid)**
- Used to be free, now paid ($7/month)
- Easy for beginners

#### **Option 4: Your Own Server**
- Self-hosted (VPS, Linode, Digital Ocean)
- Full control
- Costs $5-20/month

---

## 🌐 About Domains

### Do You Need a Domain?

**Short answer: NO (initially)**

You can deploy without a custom domain:
- Render gives you a free subdomain (e.g., `teawhiz-api.render.com`)
- Use that URL in your extension
- It works perfectly!

### Optional: Add a Custom Domain Later

If you want `teawhiz.com`:

1. **Buy domain** ($10-15/year)
   - Namecheap, GoDaddy, Hostinger

2. **Point domain to your backend**
   - Update DNS settings
   - Takes 5 minutes

3. **Update extension**
   - Change backend URL in code

**But for now: Use the free Render domain!**

---

## 🚀 Deployment Checklist

### Before Going Live:

- [ ] Backend deployed to Render/GCP
- [ ] Backend URL working (`https://your-backend.com/health`)
- [ ] Extension code updated with backend URL
- [ ] Extension built (`npm run build`)
- [ ] Extension tested in Chrome
- [ ] API key secure (in `.env`, never committed)

### Optional - For Chrome Web Store:

- [ ] Privacy policy written
- [ ] Screenshots created
- [ ] Extension description finalized
- [ ] Review guidelines followed

---

## 🔑 API Keys & Secrets

### What You Need:

| Service | Why | Cost | How to Get |
|---------|-----|------|-----------|
| **Gemini API Key** | AI processing | Free tier: 60 requests/min | [Google AI Studio](https://aistudio.google.com) |
| **Render Account** | Backend hosting | Free | [Render.com](https://render.com) |

### Keep Them Safe:

```
❌ DON'T:
- Commit .env files to GitHub
- Share keys in messages
- Use keys in frontend code

✅ DO:
- Use environment variables
- Rotate keys regularly
- Store in server .env only
```

---

## 📁 Project Structure

```
webwhiz/
├── README.md                    ← You are here
├── frontend/                    ← Chrome extension
│   ├── src/
│   │   ├── manifest.json       ← Extension metadata
│   │   ├── popup.html          ← UI popup
│   │   ├── popup.ts            ← Popup logic
│   │   ├── content.ts          ← Page content extraction
│   │   └── background.ts       ← Message routing
│   ├── dist/                   ← Built extension (load in Chrome)
│   └── package.json
│
└── backend/                     ← FastAPI server
    ├── main.py                 ← API endpoints
    ├── requirements.txt        ← Python dependencies
    ├── .env                    ← API keys (never commit!)
    └── venv/                   ← Python virtual environment
```

---

## 🛠️ Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| **Extension** | TypeScript + Vite | Modern, fast builds |
| **UI** | HTML/CSS/TypeScript | Minimal, clean design |
| **Backend** | FastAPI (Python) | Fast, easy, great for ML |
| **AI** | Google Gemini API | Free tier, very capable |
| **Hosting** | Render | Free, easy deployment |

---

## 🧪 Testing

### Local Testing:

1. **Backend running:**
   ```bash
   cd backend
   source venv/bin/activate
   uvicorn main:app --reload --port 8000
   ```

2. **Extension loaded in Chrome:**
   - `chrome://extensions/`
   - Load unpacked → `frontend/dist/`

3. **Test on any website:**
   - Click TeaWhiz AI icon
   - Ask a question
   - Get answer!

---

## 🚨 Troubleshooting

### Extension not showing:
- Check `chrome://extensions/` (enabled?)
- Reload the extension
- Clear Chrome cache

### Backend errors:
- Check `.env` has `GEMINI_API_KEY`
- Verify Render deployment
- Check API quota (free tier: 60 req/min)

### Quota exceeded:
- Wait 24 hours for daily quota reset
- Or upgrade to paid Gemini tier
- Or use Ollama (local, unlimited)

---

## 📝 Next Steps

1. **Deploy backend** → Render/GCP
2. **Update extension** with backend URL
3. **Build & test** (`npm run build`)
4. **Submit to Chrome Web Store** (optional)

---

## 📄 License

Open source. Use, modify, share freely!

---

## 🤝 Support

Questions? Check the code comments or file an issue!

Happy coding! 🫖✨
