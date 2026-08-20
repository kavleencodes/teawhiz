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
from groq import Groq
from groq import RateLimitError, APIError

load_dotenv()

app = FastAPI(
    title="TeaWhiz AI",
    version="0.1.0"
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



GROQ_API_KEY = os.getenv("GROK_API_KEY")
# Using openai/gpt-oss-120b (high quality, better for analysis)
PRIMARY_MODEL = "openai/gpt-oss-120b"
FALLBACK_MODEL = "allam-2-7b"  # Fallback to faster model if needed

client: Optional[Groq] = None
if GROQ_API_KEY:
    client = Groq(api_key=GROQ_API_KEY)
    print(f"✅ TeaWhiz AI - Groq API configured (Primary: {PRIMARY_MODEL}, Fallback: {FALLBACK_MODEL})")
else:
    print("⚠️ WARNING: GROK_API_KEY not set in .env file")



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



class ExplainRequest(BaseModel):
    text: str
    action: str = "explain"

class ExplainResponse(BaseModel):
    answer: str
    cached: bool = False



ACTION_PROMPTS = {
    "explain": "Analyze and explain the following webpage content in clear, concise terms. Focus on the main points and key information. Avoid repetition and be direct:\n\n{text}",
    "simplify": "Rewrite the following text in simpler language while preserving the original meaning and all key details:\n\n{text}",
    "summarize": "Provide a 2-3 sentence summary of the main points from this webpage content:\n\n{text}",
    "translate": "Translate the following text to Hindi. Return only the Hindi translation without explanation:\n\n{text}",
}

async def _call_groq_with_retry(model_name: str, prompt: str, max_retries: int = 2) -> str:
    """Invokes Groq API with exponential backoff on rate limit errors."""
    for attempt in range(max_retries + 1):
        try:
        
            response = await asyncio.to_thread(
                client.chat.completions.create,
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.7,
                max_tokens=2048
            )
            if not response.choices or not response.choices[0].message.content:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Groq returned an empty response"
                )
            return response.choices[0].message.content
        except RateLimitError as e:
            
            if attempt < max_retries:
                delay = (2 ** attempt) + 0.5  # 1.5s, 2.5s
                print(f"⚠️ Rate limited. Retrying in {delay}s...")
                await asyncio.sleep(delay)
                continue
            raise e
        except APIError as e:
            raise e

async def get_groq_response(text: str, action: str = "explain") -> str:
    if not client:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GROK_API_KEY is not configured on the server"
        )

    template = ACTION_PROMPTS.get(action, ACTION_PROMPTS["explain"])
    prompt = template.format(text=text)

    try:
        # Call Groq API with retry logic
        return await _call_groq_with_retry(PRIMARY_MODEL, prompt)
    except RateLimitError as e:
        print(f"⚠️ Rate limit exceeded: {e}")
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit reached. Please try again later."
        )
    except APIError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Groq API error: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected error: {str(e)}"
        )



@app.get("/")
async def root():
    return {
        "name": "TeaWhiz AI API (Groq)",
        "version": "0.1.0",
        "docs": "/docs",
        "health": "/health",
        "model": PRIMARY_MODEL,
        "endpoints": {"POST /explain": "Explain, simplify, summarize, or translate text"}
    }

@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "TeaWhiz AI API (Groq)",
        "groq_ready": client is not None
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
    answer = await get_groq_response(cleaned_text, request.action)

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

    # Get response from Groq and stream it
    async def stream_response():
        try:
            template = ACTION_PROMPTS.get(request.action, ACTION_PROMPTS["explain"])
            prompt = template.format(text=cleaned_text)

            # Get full response from Groq
            response = await asyncio.to_thread(
                client.chat.completions.create,
                model=PRIMARY_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.7,
                max_tokens=2048
            )

            full_response = response.choices[0].message.content
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