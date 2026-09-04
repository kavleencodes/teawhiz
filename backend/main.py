import os
import re
import json
import time
import hashlib
import asyncio
import traceback
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import FastAPI, HTTPException, status, Header, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
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
    allow_headers=["Content-Type", "X-API-Key"],  # X-API-Key: see verify_api_key() below
)


# PROBLEM: CORS (ALLOWED_ORIGINS above) only stops *browser-enforced*
# cross-origin fetch() calls - it does nothing to stop a direct curl/script
# call straight to this backend's URL, bypassing CORS entirely. Combined
# with no rate limiting, anyone who finds this backend's URL could burn
# the Groq quota/bill with unlimited requests. See "CORS is not
# authentication" in CODE.md's Known Weaknesses.
# SOLUTION: a shared-secret header (BACKEND_API_KEY, checked by
# verify_api_key() below) plus a simple in-memory per-IP rate limit
# (rate_limiter() below), applied to every endpoint that costs Groq quota
# or is otherwise worth protecting from unlimited hammering.
#
# Honest caveat: BACKEND_API_KEY is embedded in the built extension's JS
# (frontend/src/background.ts) - anyone who unpacks the .crx/.zip can read
# it out. This is NOT real secrecy against a determined attacker; it raises
# the bar from "trivial to abuse" (just knowing the URL) to "have to
# inspect the extension bundle first" - a meaningful improvement for a
# personal/local project, not a substitute for real per-user auth if this
# is ever opened up to multiple untrusted users.
BACKEND_API_KEY = os.getenv("BACKEND_API_KEY", "")
if not BACKEND_API_KEY:
    print(
        "⚠️ WARNING: BACKEND_API_KEY not set in .env - /explain, "
        "/explain-stream, and /normalize-query are open to anyone who "
        "knows this backend's URL (no request auth at all). Set "
        "BACKEND_API_KEY in backend/.env AND the matching constant in "
        "frontend/src/background.ts, then rebuild the extension, to close "
        "this gap."
    )


async def verify_api_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    """FastAPI dependency: rejects the request with 401 unless
    BACKEND_API_KEY is configured and the caller supplied a matching
    `X-API-Key` header.

    Deliberately no-ops (allows the request through) if BACKEND_API_KEY
    isn't set at all, matching this file's existing pattern for optional-but-
    recommended config (see GROQ_API_KEY/ALLOWED_ORIGINS above) - a fresh
    checkout without the new env var configured doesn't immediately break,
    but see the startup warning above: this means auth is effectively
    disabled until you set it.
    """
    if not BACKEND_API_KEY:
        return
    if x_api_key != BACKEND_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid API key",
        )


# Simple in-memory sliding-window rate limiter, keyed by (scope, client IP).
# Deliberately dependency-free (no slowapi/redis) to match this backend's
# existing in-memory-dict style (see response_cache above) - fine for the
# single-process deployment this backend currently runs as.
#
# Known limitations (being upfront about them):
#   - `request.client.host` is the direct TCP peer. If this is ever put
#     behind a reverse proxy/load balancer, every caller would appear to
#     share the proxy's IP unless `X-Forwarded-For` is parsed with a
#     trusted-proxy allowlist (not implemented here).
#   - Bucket entries for IPs that stop making requests are never purged, so
#     memory grows slowly with the number of distinct IPs seen over the
#     process's lifetime. Not a concern at personal-project scale; would
#     need a periodic sweep before this backend serves many distinct users.
_rate_limit_buckets: dict[str, list[float]] = {}


def rate_limiter(scope: str, limit: int, window_seconds: int):
    """Returns a FastAPI dependency enforcing `limit` requests per
    `window_seconds` per client IP, independently for whichever endpoint
    passes a given `scope` name (so /explain-stream and /normalize-query
    don't share one budget).
    """
    async def _check(request: Request) -> None:
        client_ip = request.client.host if request.client else "unknown"
        key = f"{scope}:{client_ip}"
        now = time.monotonic()
        timestamps = [t for t in _rate_limit_buckets.get(key, []) if now - t < window_seconds]
        if len(timestamps) >= limit:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Rate limit exceeded: max {limit} requests per {window_seconds}s. Please slow down.",
            )
        timestamps.append(now)
        _rate_limit_buckets[key] = timestamps

    return _check



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



# PROBLEM (fixed): `MAX_HTML_LENGTH` used to only be checked manually, and
# only when `content_type == "html"`. Plain-text `text` (the default
# content_type), `question`, and `title` had NO length limit at all - not
# even the client's own 8,000-char fallback cap. Since CORS is not
# authentication (see Known Weaknesses in CODE.md), anyone who found this
# backend URL could send an unbounded payload straight into a cached,
# billed Groq prompt, or just balloon server memory.
# SOLUTION: `Field(max_length=...)` on `ExplainRequest` below enforces all
# three limits (text/question/title) at the Pydantic request-body
# validation layer - an over-limit request never even reaches a route
# handler; FastAPI returns 422 automatically before any code here runs.
# `MAX_HTML_LENGTH` is reused as `text`'s cap regardless of content_type,
# so it now also covers what used to be a separate manual html-only check
# (see the removed check in build_cleaned_text() below).
MAX_HTML_LENGTH = 2_000_000
MAX_QUESTION_LENGTH = 2_000  # a typed question is a sentence or two, not an essay
MAX_TITLE_LENGTH = 500  # page <title> values are short; generous headroom either way


class ExplainRequest(BaseModel):
    text: str = Field(..., max_length=MAX_HTML_LENGTH)
    action: str = "explain"
    # "text": `text` is already clean text (or the Netflix title list, etc).
    # "html": `text` is the browser's rendered outerHTML (post-JS) - the content
    # script grabs the DOM *after* the page's own JS has hydrated it, so this
    # works for SPA/React pages (Netflix, etc.) where a server-side
    # `requests.get` would only ever see the near-empty initial HTML shell.
    content_type: str = "text"
    question: Optional[str] = Field(default=None, max_length=MAX_QUESTION_LENGTH)  # user's question, appended after extraction
    title: Optional[str] = Field(default=None, max_length=MAX_TITLE_LENGTH)  # page title, prepended before the extracted content

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

    PROBLEM (fixed): this function used to be synchronous (`def`, not
    `async def`) and called `extract_clean_text()` directly. Trafilatura's
    parse is synchronous/CPU-bound, so running it inline blocked FastAPI's
    single asyncio event loop for the *whole process* while it parsed large
    rendered pages (up to 2MB of HTML) - stalling every other in-flight
    request on that worker, including other users' SSE streams, for as long
    as parsing took.
    SOLUTION: made this function `async` and offloaded the extraction call
    to a worker thread via `await asyncio.to_thread(...)` below - the same
    pattern already used for the Groq API call - so the event loop stays
    free while Trafilatura runs.
    """
    raw = request.text.strip()

    if request.content_type == "html":
        if not raw:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Text cannot be empty")
        # No manual length check here anymore - `ExplainRequest.text`'s
        # `Field(max_length=MAX_HTML_LENGTH)` already rejects an over-limit
        # payload at the request-body validation layer (a clean 422 before
        # this function ever runs), so a redundant check here would be dead
        # code that could never actually trigger.
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

async def _call_groq_with_fallback(prompt: str) -> str:
    """Calls PRIMARY_MODEL (with its own rate-limit retry/backoff), and if
    that's still rate-limited past its retry budget or hits a hard API
    error, falls back once to FALLBACK_MODEL instead of failing outright.

    FALLBACK_MODEL is a smaller/faster model, so it gets only a single
    retry of its own - the point is resilience against the primary model
    being briefly unavailable, not a second full retry budget.

    PROBLEM (fixed): two separate issues used to exist here.
      1. `/explain-stream` used to call `client.chat.completions.create`
         directly with zero retry/backoff logic - only the non-streaming
         `/explain` (via `get_groq_response`) had `_call_groq_with_retry`.
         A transient 429 failed the *entire* streamed answer immediately.
      2. `FALLBACK_MODEL = "allam-2-7b"` (near the top of this file) was
         defined and even printed in the startup log, but no code path
         ever actually called it - there was no real fallback if the
         primary Groq model errored or rate-limited past its retry budget.
    SOLUTION: this function is the single place both endpoints now go
    through (`get_groq_response()` below, and `explain_stream()`'s
    `stream_response()`), so both `/explain` and `/explain-stream` get the
    same retry/backoff *and* a real fallback to `FALLBACK_MODEL`. The
    unused `redis==5.0.1` dependency (also flagged alongside `FALLBACK_MODEL`
    as dead infra) was removed from `requirements.txt` entirely instead of
    wired up - actually integrating a Redis-backed cache needs external
    infra (an Upstash/Redis instance + `REDIS_URL`), which is a deployment
    decision, not a code fix.
    """
    try:
        return await _call_groq_with_retry(PRIMARY_MODEL, prompt)
    except (RateLimitError, APIError) as primary_error:
        print(f"⚠️ Primary model '{PRIMARY_MODEL}' failed ({primary_error}); falling back to '{FALLBACK_MODEL}'")
        return await _call_groq_with_retry(FALLBACK_MODEL, prompt, max_retries=1)

async def get_groq_response(text: str, action: str = "explain") -> str:
    if not client:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GROK_API_KEY is not configured on the server"
        )

    template = ACTION_PROMPTS.get(action, ACTION_PROMPTS["explain"])
    prompt = template.format(text=text)

    try:
        # Call Groq API with retry logic, falling back to FALLBACK_MODEL if
        # the primary model can't serve the request.
        return await _call_groq_with_fallback(prompt)
    except RateLimitError as e:
        print(f"⚠️ Rate limit exceeded: {e}")
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit reached. Please try again later."
        )
    # PROBLEM (fixed): `str(e)` is an empty string for several real
    # exception types (e.g. some httpx transport errors raised with no
    # message). `detail=f"...: {str(e)}"` used to render as a completely
    # blank message ("Groq API error: " / "Unexpected error: ") - both to
    # whoever called this API, and with no traceback logged anywhere, so a
    # real failure here was previously undiagnosable after the fact.
    # SOLUTION: always include `type(e).__name__` and fall back to the
    # literal string "(no message)" when `str(e)` is empty, and log a full
    # `traceback.print_exc()` server-side (never sent to the client/caller)
    # so a repeat occurrence is actually debuggable. See the matching fix
    # in explain_stream()'s `except Exception` below.
    except APIError as e:
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Groq API error: {type(e).__name__}: {str(e) or '(no message)'}"
        )
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unexpected error: {type(e).__name__}: {str(e) or '(no message)'}"
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
async def normalize_query_endpoint(
    request: NormalizeRequest,
    _auth: None = Depends(verify_api_key),
    _rate_limit: None = Depends(rate_limiter("normalize_query", limit=60, window_seconds=60)),
):
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
async def explain(
    request: ExplainRequest,
    _auth: None = Depends(verify_api_key),
    _rate_limit: None = Depends(rate_limiter("explain", limit=20, window_seconds=60)),
):
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
async def explain_stream(
    request: ExplainRequest,
    _auth: None = Depends(verify_api_key),
    _rate_limit: None = Depends(rate_limiter("explain_stream", limit=20, window_seconds=60)),
):
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

            # Get full response from Groq, with the same retry/backoff +
            # fallback-model behavior used by the non-streaming /explain
            # path - without this, a transient 429 (or the primary model
            # being unavailable) fails the whole streamed answer instead of
            # transparently retrying/falling back.
            full_response = await _call_groq_with_fallback(prompt)
            save_to_cache(cleaned_text, request.action, full_response)

            # Stream it in word chunks (like Claude)
            for chunk in chunk_preserving_whitespace(full_response, 15):
                yield f"data: {to_sse_data(chunk)}\n\n"
                await asyncio.sleep(0.05)  # Shorter pause for smooth flow

            yield "data: [DONE]\n\n"

        except RateLimitError as e:
            print(f"⚠️ Rate limit exceeded: {e}")
            yield f"data: {to_sse_data('ERROR: Rate limit reached. Please try again later.')}\n\n"
        # PROBLEM (fixed): a real incident hit this exact except block with
        # `str(e)` empty - the server log printed literally "❌ Stream
        # error:" with nothing after the colon, and the popup received an
        # equally blank "ERROR: " SSE payload. No exception type, no
        # traceback, nothing to debug from - see the matching fix in
        # get_groq_response()'s except blocks above (same root cause: some
        # exception types stringify to "").
        # SOLUTION: always include `type(e).__name__` and fall back to the
        # literal string "(no message)" when `str(e)` is empty, in both the
        # server log line and the SSE payload sent to the client, and log a
        # full `traceback.print_exc()` server-side (never sent to the
        # client) so a repeat occurrence is actually debuggable.
        except Exception as e:
            error_detail = str(e) or "(no message)"
            print(f"❌ Stream error: {type(e).__name__}: {error_detail}")
            traceback.print_exc()
            yield f"data: {to_sse_data(f'ERROR: {type(e).__name__}: {error_detail}')}\n\n"

    return StreamingResponse(stream_response(), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)