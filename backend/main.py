import os
import re
import json
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
import trafilatura

from query_normalizer import normalize_query

load_dotenv()

app = FastAPI(
    title="TeaWhiz AI",
    version="0.1.0"
)


# Comma-separated list of allowed origins, e.g.
#   ALLOWED_ORIGINS=chrome-extension://ipdijelcjjejlciopnfipgicdmcpbafj
# Find your extension's actual id at chrome://extensions (enable Developer
# mode) - don't trust a computed guess without checking it there.
# allow_origins=["*"] let ANY website's JS call this backend directly and
# burn your Groq quota; it isn't needed for a Chrome extension anyway (the
# only real caller is our own background service worker).
_allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS = [origin.strip() for origin in _allowed_origins_env.split(",") if origin.strip()]

if not ALLOWED_ORIGINS:
    print(
        "⚠️ WARNING: ALLOWED_ORIGINS not set in .env - CORS will reject every "
        "browser request until you set it to your extension's "
        "chrome-extension://<id> origin (see chrome://extensions)."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,  # no cookies/auth are used, so this isn't needed
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)



# Query Normalizer feature flag - local, LLM-free spell correction for the
# user's typed question (see query_normalizer.py for the "why no LLM").
#   off    - disabled entirely (default): zero normalization overhead.
#   shadow - normalize and log original vs. corrected for comparison, but
#            still send the user's original (uncorrected) question to the
#            LLM. Use this to build confidence before flipping to active.
#   active - actually send the normalized question to the LLM.
# Roll out shadow -> active only after shadow-mode logs show it isn't
# mangling real queries.
QUERY_NORMALIZER_MODE = os.getenv("QUERY_NORMALIZER_MODE", "off").strip().lower()
if QUERY_NORMALIZER_MODE not in ("off", "shadow", "active"):
    print(f"⚠️ WARNING: invalid QUERY_NORMALIZER_MODE={QUERY_NORMALIZER_MODE!r} - defaulting to 'off'")
    QUERY_NORMALIZER_MODE = "off"


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
    # "text": `text` is already clean text (or the Netflix title list, etc).
    # "html": `text` is the browser's rendered outerHTML (post-JS) - the content
    # script grabs the DOM *after* the page's own JS has hydrated it, so this
    # works for SPA/React pages (Netflix, etc.) where a server-side
    # `requests.get` would only ever see the near-empty initial HTML shell.
    content_type: str = "text"
    question: Optional[str] = None  # user's question, appended after extraction
    title: Optional[str] = None  # page title, prepended before the extracted content

class ExplainResponse(BaseModel):
    answer: str
    cached: bool = False


class NormalizeRequest(BaseModel):
    text: str  # a single word (or short fragment) - sent on every space-bar
    # press while the user types their question in the popup. Kept as its
    # own request/response pair, separate from ExplainRequest, so this never
    # touches the LLM or the answer cache.


class NormalizeResponse(BaseModel):
    original_query: str
    normalized_query: str
    corrected: bool


# Guard against pathological SPA payloads (e.g. huge unbounded DOMs) blowing up
# Trafilatura's parse time / memory.
MAX_HTML_LENGTH = 2_000_000


def extract_clean_text(html: str) -> str:
    """Runs Trafilatura over browser-rendered HTML to pull out the main content.

    Deliberately does NOT fetch the page itself (no `requests.get` here) -
    the caller already rendered it in a real browser and handed us the
    resulting DOM, which is the only way to get real content out of
    JS-heavy pages.
    """
    extracted = trafilatura.extract(
        html,
        output_format="markdown",
        include_tables=True,
        include_links=False,
        include_comments=False,
        favor_recall=True,
    )
    return extracted or ""


def resolve_question(question: str) -> str:
    """Returns the question text to actually put in the LLM prompt, honoring
    QUERY_NORMALIZER_MODE. Always logs any correction found (in both shadow
    and active mode) so shadow-mode behavior is actually observable before
    flipping the flag - that's the whole point of having a shadow mode.

    `question` itself is never mutated - this only ever returns a new string
    for the caller to use, per query_normalizer's "never destroy the user's
    original input" rule.
    """
    if QUERY_NORMALIZER_MODE == "off" or not question:
        return question

    result = normalize_query(question)
    if result.changed:
        for correction in result.corrections:
            print(
                f"[QueryNormalizer:{QUERY_NORMALIZER_MODE}] "
                f"'{correction.original_word}' -> '{correction.corrected_word}' "
                f"(confidence={correction.confidence}, edit_distance={correction.edit_distance})"
            )
        print(
            f"[QueryNormalizer:{QUERY_NORMALIZER_MODE}] "
            f"original_query={result.original_query!r} normalized_query={result.normalized_query!r}"
        )

    if QUERY_NORMALIZER_MODE == "active":
        return result.normalized_query
    return question  # shadow mode: logged above, original still used downstream


async def build_cleaned_text(request: "ExplainRequest") -> str:
    """Resolves an ExplainRequest down to the plain-text prompt content.

    Handles both content types (raw text, or rendered HTML needing
    Trafilatura extraction), prepends the optional page title, and appends
    the optional user question - so both /explain and /explain-stream share
    one code path. Content and question are handled independently: if page
    extraction comes back empty (or wasn't attempted) but a question was
    asked, the question alone is still a valid prompt.

    Trafilatura's parse is synchronous/CPU-bound and can take a while on
    large pages, so it's offloaded to a worker thread via `asyncio.to_thread`
    - otherwise it would block the single asyncio event loop for the whole
    process (stalling every other in-flight request, including other users'
    SSE streams) for as long as parsing takes.
    """
    raw = request.text.strip()

    if request.content_type == "html":
        if not raw:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Text cannot be empty")
        if len(raw) > MAX_HTML_LENGTH:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Rendered HTML exceeds {MAX_HTML_LENGTH} characters",
            )
        content = await asyncio.to_thread(extract_clean_text, raw)
        if not content:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Could not extract readable content from the page HTML",
            )
    else:
        content = raw

    title = (request.title or "").strip()
    if title:
        content = f"Page Title: {title}\n\nContent:\n{content}" if content else f"Page Title: {title}"

    question = (request.question or "").strip()
    if question:
        question = resolve_question(question)
        content = f"{content}\n\n---\n\nUser Question: {question}" if content else f"User Question: {question}"

    if not content.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Text cannot be empty")

    return content



ACTION_PROMPTS = {
    "explain": "Analyze and explain the following webpage content in clear, concise terms. Focus on the main points and key information. Avoid repetition and be direct:\n\n{text}",
    "simplify": "Rewrite the following text in simpler language while preserving the original meaning and all key details:\n\n{text}",
    "summarize": "Provide a 2-3 sentence summary of the main points from this webpage content:\n\n{text}",
    "translate": "Translate the following text to Hindi. Return only the Hindi translation without explanation:\n\n{text}",
}


def chunk_preserving_whitespace(text: str, words_per_chunk: int = 15):
    """Split text into ~words_per_chunk-word pieces without discarding whitespace.

    `text.split()` + `" ".join(...)` (the old approach) collapses every space,
    newline, and blank line to a single space, which destroys markdown
    structure (paragraph breaks, table rows) before it ever reaches the
    client. This keeps every original whitespace character exactly where it
    was, so the streamed-and-reassembled text is byte-for-byte the same as
    `text`.
    """
    tokens = re.split(r"(\s+)", text)
    buffer = []
    word_count = 0
    for token in tokens:
        if token == "":
            continue
        buffer.append(token)
        if not token.isspace():
            word_count += 1
            if word_count >= words_per_chunk:
                yield "".join(buffer)
                buffer = []
                word_count = 0
    if buffer:
        yield "".join(buffer)


def to_sse_data(chunk: str) -> str:
    """JSON-encode the chunk so it survives a single SSE `data:` line intact.

    A raw chunk can contain newlines (breaks the `data:` line framing) as
    well as backslashes, quotes, or other characters a hand-rolled escaper
    would mangle (e.g. code blocks, Windows paths). `json.dumps` handles all
    of that correctly and the client reverses it with a plain `JSON.parse`.
    """
    return json.dumps(chunk)

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

@app.post("/normalize-query", response_model=NormalizeResponse)
async def normalize_query_endpoint(request: NormalizeRequest):
    """Live, as-you-type spell correction for the popup's question input -
    called on every space-bar press, independent of QUERY_NORMALIZER_MODE
    (that flag only gates whether the *submitted* question is silently
    corrected before going to the LLM; this endpoint is the explicit,
    visible-to-the-user typing-assist feature and is always on). No LLM
    involved - the same local SymSpell lookup `resolve_question()` uses.
    """
    result = normalize_query(request.text)
    return NormalizeResponse(
        original_query=result.original_query,
        normalized_query=result.normalized_query,
        corrected=result.changed,
    )


@app.post("/explain", response_model=ExplainResponse)
async def explain(request: ExplainRequest):
    if request.action not in ACTION_PROMPTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid action '{request.action}'. Supported: {', '.join(ACTION_PROMPTS.keys())}"
        )

    cleaned_text = await build_cleaned_text(request)

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
    if request.action not in ACTION_PROMPTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid action '{request.action}'. Supported: {', '.join(ACTION_PROMPTS.keys())}"
        )

    cleaned_text = await build_cleaned_text(request)

    # Check cache
    cached_answer, from_cache = get_from_cache(cleaned_text, request.action)
    if from_cache:
        # Stream cached response in word chunks (like Claude)
        async def stream_cached():
            for chunk in chunk_preserving_whitespace(cached_answer, 15):
                yield f"data: {to_sse_data(chunk)}\n\n"
                await asyncio.sleep(0.05)  # Shorter pause for smooth flow
            yield "data: [DONE]\n\n"
        return StreamingResponse(stream_cached(), media_type="text/event-stream")

    if not client:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GROK_API_KEY is not configured on the server"
        )

    # Get response from Groq and stream it
    async def stream_response():
        try:
            template = ACTION_PROMPTS.get(request.action, ACTION_PROMPTS["explain"])
            prompt = template.format(text=cleaned_text)

            # Get full response from Groq, with the same rate-limit
            # retry/backoff used by the non-streaming /explain path - without
            # this, a transient 429 fails the whole streamed answer instead
            # of transparently retrying.
            full_response = await _call_groq_with_retry(PRIMARY_MODEL, prompt)
            save_to_cache(cleaned_text, request.action, full_response)

            # Stream it in word chunks (like Claude)
            for chunk in chunk_preserving_whitespace(full_response, 15):
                yield f"data: {to_sse_data(chunk)}\n\n"
                await asyncio.sleep(0.05)  # Shorter pause for smooth flow

            yield "data: [DONE]\n\n"

        except RateLimitError as e:
            print(f"⚠️ Rate limit exceeded: {e}")
            yield f"data: {to_sse_data('ERROR: Rate limit reached. Please try again later.')}\n\n"
        except Exception as e:
            print(f"❌ Stream error: {e}")
            yield f"data: {to_sse_data(f'ERROR: {e}')}\n\n"

    return StreamingResponse(stream_response(), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)