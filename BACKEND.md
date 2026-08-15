# Backend Development Guide

**Server development — Phases 3, 4, and 5**

See [CODE.md](./CODE.md) for the complete project overview.

---

## Table of Contents

1. [Phase 3: Backend Skeleton](#phase-3-backend-skeleton)
2. [Phase 3B: Real Gemini Integration](#phase-3b-real-gemini-integration)
3. [Phase 4: Rate Limiting & Caching](#phase-4-rate-limiting--caching)
4. [Phase 5: Deploy to Render](#phase-5-deploy-to-render)
5. [Testing](#testing)
6. [Troubleshooting](#troubleshooting)

---

## Phase 3: Backend Skeleton

### Step 1: Create Backend Project

```bash
cd ~/Desktop/webwhiz

mkdir samajhlo-backend
cd samajhlo-backend

# Create virtual environment
python3 -m venv venv

# Activate it
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

### Step 2: Create `requirements.txt`

```
fastapi==0.104.1
uvicorn==0.24.0
pydantic==2.5.0
requests==2.31.0
python-dotenv==1.0.0
redis==5.0.0
```

### Step 3: Install Dependencies

```bash
pip install -r requirements.txt
```

### Step 4: Create `.env`

**Important: Add this to `.gitignore` — never commit credentials!**

```bash
# samajhlo-backend/.env
GEMINI_API_KEY=your_gemini_api_key_here
REDIS_URL=redis://default:your_password@your_host:port
```

Add to `.gitignore`:
```bash
echo ".env" >> .gitignore
```

### Step 5: Create `main.py` (Echo Version)

This is the minimal version to test that the server works:

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="webwhiz ai Backend")

# Allow CORS for the extension
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
    """Health check endpoint"""
    return {"status": "ok"}

@app.post("/explain")
def explain(req: ExplainRequest):
    """Echo endpoint — just returns what it receives"""
    return {
        "success": True,
        "received_text": req.text,
        "action": req.action,
        "answer": f"[ECHO] You asked to '{req.action}': {req.text}",
    }
```

### Step 6: Run Locally

```bash
# Make sure venv is activated
source venv/bin/activate

# Run the server
uvicorn main:app --reload
```

**Expected output:**
```
INFO:     Uvicorn running on http://127.0.0.1:8000
```

### Step 7: Test with curl

In another terminal:

```bash
# Test health
curl http://localhost:8000/health

# Expected: {"status":"ok"}

# Test explain endpoint
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text": "Machine learning is a type of AI", "action": "explain"}'

# Expected:
# {
#   "success": true,
#   "received_text": "Machine learning is a type of AI",
#   "action": "explain",
#   "answer": "[ECHO] You asked to 'explain': Machine learning is a type of AI"
# }
```

✅ **Milestone: Backend responds to requests**

---

## Phase 3B: Real Gemini Integration

Now replace the echo with a real Gemini API call.

### Step 1: Get Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com)
2. Click "Get API Key"
3. Create new key
4. Copy it to `.env`: `GEMINI_API_KEY=sk-...`

### Step 2: Update `main.py`

Replace the entire file with:

```python
import os
import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise ValueError("GEMINI_API_KEY environment variable not set. Add it to .env")

app = FastAPI(title="webwhiz ai Backend")

# Allow CORS for the extension
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
    """Call Gemini API and return the response"""
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
    
    # Check for errors
    if response.status_code != 200:
        raise Exception(f"Gemini API error: {response.status_code} - {response.text}")
    
    data = response.json()
    
    # Extract answer from response
    if "candidates" not in data or len(data["candidates"]) == 0:
        raise Exception("No response from Gemini")
    
    return data["candidates"][0]["content"]["parts"][0]["text"]

@app.get("/health")
def health():
    """Health check endpoint"""
    return {"status": "ok"}

@app.post("/explain")
def explain(req: ExplainRequest):
    """Process explain request and call Gemini"""
    
    # Build prompts for each action
    prompts = {
        "explain": f"Explain this clearly in 2-3 sentences: {req.text}",
        "simplify": f"Simplify this into basic language anyone can understand: {req.text}",
        "summarize": f"Summarize this in one sentence: {req.text}",
        "translate": f"Translate this to English: {req.text}",
    }
    
    prompt = prompts.get(req.action, prompts["explain"])
    
    try:
        # Call Gemini
        answer = call_gemini(prompt)
        
        return {
            "success": True,
            "answer": answer,
            "action": req.action,
        }
    except Exception as e:
        # Return error response
        return {
            "success": False,
            "error": str(e),
        }
```

### Step 3: Test Real Gemini

```bash
# Make sure you're in the backend folder and venv is activated
source venv/bin/activate

# Restart the server
uvicorn main:app --reload

# Test with curl
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text": "Python is a programming language", "action": "explain"}'

# Should return actual explanation from Gemini:
# {
#   "success": true,
#   "answer": "Python is a flexible, easy-to-learn programming language known for its clean syntax and wide library support. It's used for web development, data analysis, artificial intelligence, and automation. Python's popularity comes from being beginner-friendly while remaining powerful for professional applications.",
#   "action": "explain"
# }
```

✅ **Milestone: Backend calls real LLM**

---

## Phase 4: Rate Limiting & Caching

Add Redis integration for rate limiting and response caching.

### Step 1: Get Redis URL

1. Go to [Upstash](https://upstash.com)
2. Create a new Redis database (free tier)
3. Copy the URL: `redis://default:password@host:port`
4. Add to `.env`: `REDIS_URL=redis://...`

### Step 2: Update `main.py`

Replace the entire file with:

```python
import os
import hashlib
import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from redis import Redis

# Load environment variables
load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
REDIS_URL = os.getenv("REDIS_URL")

if not GEMINI_API_KEY:
    raise ValueError("GEMINI_API_KEY environment variable not set")
if not REDIS_URL:
    raise ValueError("REDIS_URL environment variable not set")

# Initialize Redis
redis = Redis.from_url(REDIS_URL)
DAILY_LIMIT = 50  # 50 requests per user per day

app = FastAPI(title="webwhiz ai Backend")

# Allow CORS for the extension
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
    """Call Gemini API"""
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

def check_rate_limit(install_id: str) -> tuple[bool, int]:
    """Check if user has exceeded daily limit. Returns (allowed, remaining)"""
    key = f"limit:{install_id}"
    count = redis.incr(key)
    
    # Set expiry on first request
    if count == 1:
        redis.expire(key, 86400)  # 24 hours
    
    remaining = max(0, DAILY_LIMIT - count)
    return count <= DAILY_LIMIT, remaining

def cache_key(text: str, action: str) -> str:
    """Generate cache key from text and action"""
    raw = f"{action}:{text}".encode()
    return "cache:" + hashlib.sha256(raw).hexdigest()

def get_cached(text: str, action: str) -> str | None:
    """Get cached answer if exists"""
    cached = redis.get(cache_key(text, action))
    return cached.decode() if cached else None

def set_cached(text: str, action: str, answer: str):
    """Store answer in cache for 7 days"""
    redis.setex(cache_key(text, action), 604800, answer)  # 7 days in seconds

@app.get("/health")
def health():
    """Health check endpoint"""
    try:
        redis.ping()
        return {"status": "ok", "redis": "connected"}
    except Exception as e:
        return {"status": "error", "redis": str(e)}

@app.post("/explain")
def explain(req: ExplainRequest):
    """Process explain request with rate limiting and caching"""
    
    # Check rate limit
    allowed, remaining = check_rate_limit(req.install_id)
    if not allowed:
        return {
            "success": False,
            "error": f"Daily limit reached (50 requests). Reset in 24 hours.",
        }
    
    # Check cache
    cached_answer = get_cached(req.text, req.action)
    if cached_answer:
        print(f"Cache hit for {req.action}: {req.text[:50]}...")
        return {
            "success": True,
            "answer": cached_answer,
            "action": req.action,
            "source": "cache",
        }
    
    # Build prompts
    prompts = {
        "explain": f"Explain this clearly in 2-3 sentences: {req.text}",
        "simplify": f"Simplify this into basic language anyone can understand: {req.text}",
        "summarize": f"Summarize this in one sentence: {req.text}",
        "translate": f"Translate this to English: {req.text}",
    }
    
    prompt = prompts.get(req.action, prompts["explain"])
    
    try:
        # Call Gemini
        answer = call_gemini(prompt)
        
        # Cache the answer
        set_cached(req.text, req.action, answer)
        
        print(f"LLM call for {req.action}: {req.text[:50]}...")
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

### Step 3: Test Rate Limiting & Caching

```bash
# Restart server
uvicorn main:app --reload

# First call (hits LLM, slow)
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text": "Test text here", "action": "explain", "install_id": "user1"}'

# Second identical call (cache hit, instant)
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text": "Test text here", "action": "explain", "install_id": "user1"}'

# Notice the second response has "source": "cache"

# Test rate limit (make 51 requests)
for i in {1..51}; do
  curl -X POST http://localhost:8000/explain \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"Request $i\", \"action\": \"explain\", \"install_id\": \"user2\"}" 
done

# The 51st request should return error about daily limit
```

✅ **Milestone: Rate limiting & caching work**

---

## Phase 5: Deploy to Render

### Step 1: Prepare for Deployment

Make sure you have:
- [ ] `main.py` with all code
- [ ] `requirements.txt` with dependencies
- [ ] `.env` with credentials (but this will NOT be pushed)
- [ ] `.gitignore` with `.env`

### Step 2: Push to GitHub

```bash
cd ~/Desktop/webwhiz/samajhlo-backend

# Initialize git
git init

# Create .gitignore
echo ".env" >> .gitignore
echo "venv/" >> .gitignore
echo "__pycache__/" >> .gitignore
echo "*.pyc" >> .gitignore

# Add files
git add .

# Commit
git commit -m "Initial backend commit

- FastAPI server with Gemini integration
- Rate limiting via Redis
- Response caching
- CORS enabled for extension"

# Create repository on GitHub (go to github.com/new)
# Then push:
git remote add origin https://github.com/YOUR_USERNAME/samajhlo-backend.git
git branch -M main
git push -u origin main
```

### Step 3: Deploy on Render

1. **Go to [render.com](https://render.com)** and sign in with GitHub

2. **Click "New +"** and select **"Web Service"**

3. **Connect your repository:**
   - Select `samajhlo-backend` repo
   - Click "Connect"

4. **Configure the service:**
   - **Name:** `samajhlo-backend`
   - **Environment:** `Python 3`
   - **Region:** Select closest to you
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port 10000`

5. **Add Environment Variables:**
   - Click "Environment"
   - Add `GEMINI_API_KEY` = (your Gemini API key)
   - Add `REDIS_URL` = (your Upstash Redis URL)

6. **Click "Create Web Service"**

Wait 2-3 minutes for deployment. You'll get a public URL:
```
https://samajhlo-backend.onrender.com
```

### Step 4: Test Deployment

```bash
# Test health endpoint
curl https://samajhlo-backend.onrender.com/health

# Test explain endpoint
curl -X POST https://samajhlo-backend.onrender.com/explain \
  -H "Content-Type: application/json" \
  -d '{"text": "Test from internet", "action": "explain"}'
```

**If it doesn't work:**
- Check Render dashboard → Logs
- Verify environment variables are set
- Make sure GEMINI_API_KEY and REDIS_URL are correct

✅ **Milestone: Backend deployed and public**

---

## Testing

### Local Testing

```bash
# 1. Activate environment
source venv/bin/activate

# 2. Make sure .env has credentials
cat .env

# 3. Start server
uvicorn main:app --reload

# 4. In another terminal, test endpoints
curl http://localhost:8000/health
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"test","action":"explain","install_id":"test"}'
```

### Production Testing (After Deployment)

```bash
# Replace with your actual Render URL
curl https://your-app.onrender.com/health

# Test explain
curl -X POST https://your-app.onrender.com/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"test","action":"explain","install_id":"test"}'
```

### Test All Actions

```bash
# Explain
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"Machine learning","action":"explain"}'

# Simplify
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"Machine learning","action":"simplify"}'

# Summarize
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"Machine learning is a subset of artificial intelligence","action":"summarize"}'

# Translate
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"Hola mundo","action":"translate"}'
```

---

## Troubleshooting

### "Redis connection error"
**Problem:** `ConnectionError` or `redis.exceptions.ConnectionError`  
**Solution:**
- Verify `REDIS_URL` is correct in `.env`
- Check that Upstash database is active (visit console.upstash.com)
- Render environment variable might be wrong: double-check in Render dashboard

### "Gemini API error: 401"
**Problem:** `"Gemini API error: 401"`  
**Solution:**
- Your API key is invalid or expired
- Go to [Google AI Studio](https://aistudio.google.com)
- Regenerate the key
- Update `.env` locally and `.gitignore` (don't push)
- Update environment variable in Render dashboard

### "No response from Gemini"
**Problem:** Empty response or 500 error  
**Solution:**
- Check that the request format is correct
- Try a simpler prompt: `"What is AI?"`
- Check Render logs for the full error
- The Gemini model might be unavailable (rare)

### "Rate limit error even on first request"
**Problem:** Getting rate limit message immediately  
**Solution:**
- Check Redis connection is working
- Go to Render logs and look for Redis errors
- Try restarting the service in Render dashboard

### "Deployment fails"
**Problem:** Render deployment fails or crashes immediately  
**Solution:**
- Check Render logs (Dashboard → Logs)
- Verify `requirements.txt` has all dependencies
- Check that environment variables are set (not .env file)
- Make sure Python syntax is correct (run locally first)
- Try rebuilding: In Render, click "Manual Deploy"

### "Port issues"
**Problem:** "Port is already in use" locally  
**Solution:**
```bash
# Kill the process using port 8000
lsof -i :8000
kill -9 <PID>

# Or use a different port
uvicorn main:app --reload --port 8001
```

### "CORS errors in browser"
**Problem:** CORS error when extension calls backend  
**Solution:**
- Make sure CORS middleware is in `main.py`:
  ```python
  app.add_middleware(
      CORSMiddleware,
      allow_origins=["*"],
      allow_credentials=True,
      allow_methods=["*"],
      allow_headers=["*"],
  )
  ```
- Restart the server
- Check browser DevTools → Network → see the actual error

---

## Development Commands

```bash
# Setup (first time)
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Running
source venv/bin/activate
uvicorn main:app --reload

# Testing
curl http://localhost:8000/health
curl -X POST http://localhost:8000/explain \
  -H "Content-Type: application/json" \
  -d '{"text":"test","action":"explain","install_id":"test"}'

# Deployment
git add .
git commit -m "message"
git push origin main
# Render auto-deploys
```

---

## File Structure

```
samajhlo-backend/
├── main.py              ← All server code
├── requirements.txt     ← Python dependencies
├── .env                 ← Credentials (NEVER commit)
├── .gitignore           ← Includes .env
├── venv/                ← Virtual environment
└── .git/                ← Git repository
```

---

## Environment Variables

Store these in Render dashboard (NOT in code):

```
GEMINI_API_KEY=sk-...                           # From Google AI Studio
REDIS_URL=redis://default:password@host:port   # From Upstash
```

---

**Next:** When backend is deployed, go to [FRONTEND.md — Phase 6](./FRONTEND.md#phase-6-wire-extension-to-backend) to connect the extension! 🚀
