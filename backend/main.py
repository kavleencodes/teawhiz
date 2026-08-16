import os
import hashlib
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from google import genai
from google.genai.errors import APIError

load_dotenv()

app = FastAPI(
    title="TeaWhiz AI API",
    version="0.1.0"
)

# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# Gemini Configuration & Async Client
# ============================================================

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
PRIMARY_MODEL = "gemini-3.7-flash"
FALLBACK_MODEL = "gemini-3.5-flash-lite"

client: Optional[genai.Client] = None
if GEMINI_API_KEY:
    client = genai.Client(api_key=GEMINI_API_KEY)
    print(f"✅ TeaWhiz AI - Gemini API configured (Primary: {PRIMARY_MODEL}, Fallback: {FALLBACK_MODEL})")
else:
    print("⚠️ WARNING: GEMINI_API_KEY not set in .env file")

# ============================================================
# In-Memory Cache (UTC-aware & simple size guard)
# ============================================================

MAX_CACHE_ENTRIES = 5000
response_cache: dict[str, dict] = {}

def get_cache_key(text: str, action: str) -> str:
    value = f"{action}:{text.strip()}"
    return hashlib.sha256(value.encode()).hexdigest()

def is_cache_valid(timestamp_iso: str, days: int = 7) -> bool:
    try:
        cached_time = datetime.fromisoformat(timestamp_iso)
        return (datetime.now(timezone.utc) - cached_time) < timedelta(days=days)
    except Exception:
        return False

def get_from_cache(text: str, action: str):
    key = get_cache_key(text, action)
    if key in response_cache:
        entry = response_cache[key]
        if is_cache_valid(entry["timestamp"]):
            return entry["answer"], True
        del response_cache[key]
    return None, False

def save_to_cache(text: str, action: str, answer: str):
    if len(response_cache) >= MAX_CACHE_ENTRIES:
        # Evict oldest 10% entries if cache is full
        keys_to_remove = list(response_cache.keys())[:500]
        for k in keys_to_remove:
            response_cache.pop(k, None)

    key = get_cache_key(text, action)
    response_cache[key] = {
        "answer": answer,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

# ============================================================
# Request / Response Schemas
# ============================================================

class ExplainRequest(BaseModel):
    text: str
    action: str = "explain"

class ExplainResponse(BaseModel):
    answer: str
    cached: bool = False

# ============================================================
# Gemini Service with Exponential Backoff & Model Fallback
# ============================================================

ACTION_PROMPTS = {
    "explain": "Explain the following text in simple, clear terms without unnecessary repetition:\n\n{text}",
    "simplify": "Rewrite the following text in simpler language while preserving the original meaning:\n\n{text}",
    "summarize": "Summarize the following text in 2-3 concise sentences:\n\n{text}",
    "translate": "Translate the following text to Hindi. Return only the Hindi translation without explanation:\n\n{text}",
}

async def _call_gemini_with_retry(model_name: str, prompt: str, max_retries: int = 2) -> str:
    """Invokes client.aio with exponential backoff on 503 / 429."""
    for attempt in range(max_retries + 1):
        try:
            # Native async generation via client.aio
            response = await client.aio.models.generate_content(
                model=model_name,
                contents=prompt
            )
            if not response.text:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Gemini returned an empty response"
                )
            return response.text
        except APIError as e:
            # Check for transient server errors (503 Unavailable / 429 Rate Limit)
            if e.code in (503, 429) and attempt < max_retries:
                delay = (2 ** attempt) + 0.5  # 1.5s, 2.5s
                await asyncio.sleep(delay)
                continue
            raise e

async def get_gemini_response(text: str, action: str = "explain") -> str:
    if not client:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GEMINI_API_KEY is not configured on the server"
        )

    template = ACTION_PROMPTS.get(action, ACTION_PROMPTS["explain"])
    prompt = template.format(text=text)

    try:
        # Try Primary Model
        return await _call_gemini_with_retry(PRIMARY_MODEL, prompt)
    except APIError as e:
        if e.code == 503:
            print(f"⚠️ {PRIMARY_MODEL} overloaded (503). Retrying with fallback: {FALLBACK_MODEL}")
            try:
                # Failover to Fallback Model
                return await _call_gemini_with_retry(FALLBACK_MODEL, prompt)
            except Exception as fallback_err:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=f"Gemini capacity limit reached across primary and fallback models: {fallback_err}"
                )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Gemini API error ({e.code}): {e.message}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected error: {str(e)}"
        )

# ============================================================
# Routes
# ============================================================

@app.get("/")
async def root():
    return {
        "name": "TeaWhiz AI API",
        "version": "0.1.0",
        "docs": "/docs",
        "health": "/health",
        "endpoints": {"POST /explain": "Explain, simplify, summarize, or translate text"}
    }

@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "TeaWhiz AI API",
        "gemini_ready": client is not None
    }

@app.post("/explain", response_model=ExplainResponse)
async def explain(request: ExplainRequest):
    cleaned_text = request.text.strip()
    if not cleaned_text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Text cannot be empty")

    if request.action not in ACTION_PROMPTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid action '{request.action}'. Supported: {', '.join(ACTION_PROMPTS.keys())}"
        )

    # Check cache
    cached_answer, from_cache = get_from_cache(cleaned_text, request.action)
    if from_cache:
        return ExplainResponse(answer=cached_answer, cached=True)

    # Generate response
    answer = await get_gemini_response(cleaned_text, request.action)

    # Save to cache
    save_to_cache(cleaned_text, request.action, answer)

    return ExplainResponse(answer=answer, cached=False)

@app.post("/explain-stream")
async def explain_stream(request: ExplainRequest):
    """Stream response word by word"""
    cleaned_text = request.text.strip()
    if not cleaned_text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Text cannot be empty")

    if request.action not in ACTION_PROMPTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid action '{request.action}'. Supported: {', '.join(ACTION_PROMPTS.keys())}"
        )

    # Check cache
    cached_answer, from_cache = get_from_cache(cleaned_text, request.action)
    if from_cache:
        # Stream cached response in word chunks (like Claude)
        async def stream_cached():
            words = cached_answer.split()
            for i in range(0, len(words), 3):  # 3 words at a time
                chunk = " ".join(words[i:i+3])
                yield f"data: {chunk} \n\n"
                await asyncio.sleep(0.1)  # Natural pause
            yield "data: [DONE]\n\n"
        return StreamingResponse(stream_cached(), media_type="text/event-stream")

    # Get response from Gemini and stream it
    async def stream_response():
        try:
            template = ACTION_PROMPTS.get(request.action, ACTION_PROMPTS["explain"])
            prompt = template.format(text=cleaned_text)

            # Get full response first
            response = client.models.generate_content(
                model="gemini-3.7-flash",
                contents=prompt
            )

            full_response = response.text
            save_to_cache(cleaned_text, request.action, full_response)

            # Stream it in word chunks (like Claude)
            words = full_response.split()
            for i in range(0, len(words), 3):  # 3 words at a time
                chunk = " ".join(words[i:i+3])
                yield f"data: {chunk} \n\n"
                await asyncio.sleep(0.1)  # Natural pause

            yield "data: [DONE]\n\n"

        except Exception as e:
            print(f"❌ Stream error: {e}")
            yield f"data: ERROR: {str(e)}\n\n"

    return StreamingResponse(stream_response(), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)