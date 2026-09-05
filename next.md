# TeaWhiz AI — Next Phase Plan

**Goal:** Evolve from single-turn Q&A to a full conversation-capable AI assistant with persistent storage and semantic memory.

**Guiding principles:**
- Build incrementally — each phase should work end-to-end before adding the next
- Ship early, iterate — don't over-engineer Phase 1 to death
- Context window management is the hard part — plan for it early
- Semantic memory is the payoff; everything before it is foundation

---

## Table of Contents

1. [Phase 1 — Fix Conversation State](#phase-1--fix-conversation-state)
2. [Phase 2 — Cache Extracted Page Content](#phase-2--cache-extracted-page-content)
3. [Phase 3 — Context Window Management](#phase-3--context-window-management)
4. [Phase 4 — Persistent Storage](#phase-4--persistent-storage)
5. [Phase 5 — Semantic Memory](#phase-5--semantic-memory)
6. [Production Architecture](#production-architecture)
7. [Migration Path](#migration-path)
8. [Rollback Triggers](#rollback-triggers)

---

## Phase 1 — Fix Conversation State

### Goal
Every `/explain-stream` request is conversation-aware. The LLM sees prior messages, enabling follow-up questions like "elaborate on that" or "give me an example".

### What Changes

#### Frontend (`popup.ts`)

Add conversation state to the popup:

```typescript
interface ConversationState {
  conversationId: string;
  messages: Message[];
  pageId: string;       // fingerprint of page URL + title
  pageContext: string;  // extracted page text (Phase 2)
}

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// Persist across popup opens (chrome.storage.local)
const CONVERSATION_KEY = "conversation_state";
```

**On popup open:**
```typescript
async function loadConversation() {
  const result = await chrome.storage.local.get(CONVERSATION_KEY);
  if (result[CONVERSATION_KEY]?.pageId === currentPageId) {
    // Same page — restore conversation
    conversationState = result[CONVERSATION_KEY];
  } else {
    // New page — new conversation
    conversationState = {
      conversationId: crypto.randomUUID(),
      messages: [],
      pageId: currentPageId,
      pageContext: "",  // filled Phase 2
    };
  }
}
```

**On submit:**
```typescript
// Build message history for LLM
const history = conversationState.messages.map(m => ({
  role: m.role,
  content: m.content,
}));

// Include page context on EVERY turn (Phase 1: reliable, temporarily redundant)
// Phase 2 will optimize this by caching extracted content
const systemContext = `Page Title: ${pageTitle}\n\nPage Content:\n${conversationState.pageContext}\n\n---\n\n`;

// Send to backend
chrome.runtime.sendMessage({
  type: "GET_ANSWER",
  conversationId: conversationState.conversationId,
  content: pageContent,
  contentType: pageContentType,
  title: pageTitle,
  question: userQuestion,
  history,        // prior messages
  systemContext,  // page context (every turn in Phase 1)
});
```

**On response chunk:**
```typescript
// Append to conversation state, persist
conversationState.messages.push({ role: "user", content: userQuestion });
// (assistant message appended on RESPONSE_DONE)

await chrome.storage.local.set({
  [CONVERSATION_KEY]: conversationState,
});
```

**On clear:**
```typescript
// Start fresh conversation for same page
conversationState = {
  conversationId: crypto.randomUUID(),
  messages: [],
  pageId: currentPageId,
  pageContext: conversationState.pageContext,  // keep page context
};
```

#### Backend (`main.py`)

**New request model:**
```python
class ExplainRequest(BaseModel):
    text: str = Field(..., max_length=MAX_HTML_LENGTH)
    action: str = "explain"
    content_type: str = "text"
    question: Optional[str] = Field(default=None, max_length=MAX_QUESTION_LENGTH)
    title: Optional[str] = Field(default=None, max_length=MAX_TITLE_LENGTH)
    # Phase 1 additions:
    conversation_id: Optional[str] = None
    history: list[dict] = Field(default_factory=list)  # [{"role": "user"|"assistant", "content": "..."}]
    system_context: Optional[str] = None  # page title + content (every turn)
```

**New prompts:**
```python
ACTION_PROMPTS = {
    "explain": (
        "You are a helpful assistant answering questions about webpage content.\n"
        "{system_context}"
        "Conversation history:\n{history}"
        "User Question: {question}\n\n"
        "Answer based on the conversation history and page content above:"
    ),
    # ... simplify, summarize, translate unchanged (single-turn for now)
}
```

**Build prompt with history:**
```python
def build_prompt(request: "ExplainRequest", cleaned_text: str) -> str:
    history_section = ""
    if request.history:
        history_lines = [
            f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}"
            for m in request.history
        ]
        history_section = "\n".join(history_lines) + "\n\n"

    template = ACTION_PROMPTS.get(request.action, ACTION_PROMPTS["explain"])
    return template.format(
        system_context=request.system_context or "",
        history=history_section,
        question=request.question,
        text=cleaned_text,
    )
```

**Response cache key:**
```python
# Cache key includes context, history, action, and model version.
# conversation_id is NOT included — two identical conversations with
# different IDs should theoretically share cached answers.
# Including a cache version prevents old answers from surviving prompt changes.
CACHE_VERSION = "v1"  # increment when prompting changes

def get_cache_key(
    action: str,
    system_context: str,
    history: list[dict],
    question: str,
) -> str:
    parts = [
        CACHE_VERSION,
        action,
        system_context.strip(),
        json.dumps(history, sort_keys=True),
        question.strip(),
    ]
    return hashlib.sha256(":".join(parts).encode()).hexdigest()
```

#### Background (`background.ts`)

Forward new fields to backend:
```typescript
chrome.runtime.sendMessage({
  type: "GET_ANSWER",
  content: pageContent,
  contentType: pageContentType,
  title: pageTitle,
  question: userQuestion,
  conversationId: conversationState.conversationId,
  history: conversationState.messages.map(m => ({
    role: m.role,
    content: m.content,
  })),
  systemContext: buildSystemContext(), // page context every turn (Phase 1)
});
```

### Verification Checklist
- [ ] Open popup on a page, ask a question
- [ ] Ask a follow-up question referencing the first answer ("elaborate on point 2")
- [ ] LLM responds with context from previous turn
- [ ] Close and reopen popup on same page — conversation persists
- [ ] Navigate to new page — fresh conversation starts
- [ ] Clear button starts new conversation but keeps page context
- [ ] Cache hits don't reuse old history (system_context + question in cache key)

---

## Phase 2 — Cache Extracted Page Content

### Goal
Trafilatura runs **once per page**, not once per question. Page context is extracted once, stored, and reused for all questions in the conversation.

### Why This Matters
Today: every `/explain-stream` call runs Trafilatura on the full HTML. For a user asking 5 follow-up questions, that's 5 identical extractions. Caching page content eliminates that waste and reduces latency.

### What Changes

#### Backend — Page Context Cache

```python
# In-memory page content cache (separate from response cache)
_page_context_cache: dict[str, dict] = {}

MAX_PAGE_CONTEXT_ENTRIES = 1000  # per-instance; per-user in Phase 4

# Phase 2: Cache key uses extracted content SHA256, not html[:50_000]
def get_page_context_cache_key(cleaned_text: str, url_hint: str = "") -> str:
    # SHA256 of extracted clean content
    # This is more reliable than html[:50_000] which can be misleading
    return hashlib.sha256(f"{url_hint}:{cleaned_text}".encode()).hexdigest()

async def get_or_extract_page_context(
    html: str,
    url_hint: str = "",
) -> str:
    # Extract the clean text once for cache key
    cleaned = await asyncio.to_thread(extract_clean_text, html)
    if not cleaned:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Could not extract readable content from the page HTML",
        )
    
    key = get_page_context_cache_key(cleaned, url_hint)

    if key in _page_context_cache:
        entry = _page_context_cache[key]
        if is_cache_valid(entry["timestamp"]):
            print(f"[PageContext] Cache hit for key {key[:8]}...")
            return entry["content"]
        del _page_context_cache[key]

    _page_context_cache[key] = {
        "content": cleaned,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    print(f"[PageContext] Extracted and cached {len(cleaned)} chars")
    return cleaned
```

#### Backend — Use cached context in `build_cleaned_text`

```python
async def build_cleaned_text(request: "ExplainRequest") -> str:
    raw = request.text.strip()

    if request.content_type == "html":
        if not raw:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Text cannot be empty")
        # Use cached extraction
        content = await get_or_extract_page_context(raw, url_hint=request.title)
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
```

#### Frontend — Pass page context once, reuse

```typescript
interface ConversationState {
  conversationId: string;
  messages: Message[];
  pageId: string;
  pageContext: string;      // ← extracted once, reused
  pageContextTimestamp: number;
}

// On popup open (if pageId matches, pageContext is already populated)
async function loadConversation() {
  // ...
  if (result[CONVERSATION_KEY]?.pageId === currentPageId) {
    conversationState = result[CONVERSATION_KEY];
    // pageContext already populated from Phase 1's first-turn extraction
  }
  // ...
}

// On first submit of a new conversation:
// The backend returns pageContext in the response headers or first SSE event
// so the frontend can cache it for the conversation lifetime
```

**Alternative (simpler):** Backend returns `page_context` in a `X-Page-Context-Hash` response header. Frontend stores `{ pageId, pageContext, pageContextHash }`. Subsequent requests send `page_context_hash` — if backend sees a hit, it skips extraction and uses cached context.

### Verification Checklist
- [ ] First question on a page: extraction happens (see backend log)
- [ ] Second question on same page: cache hit, no extraction (see backend log)
- [ ] Different page: new extraction
- [ ] Page context cache TTL works (7 days default)
- [ ] Cache eviction when hitting MAX_PAGE_CONTEXT_ENTRIES

---

## Phase 3 — Context Window Management

### Goal
Manage the context window so it doesn't grow unbounded. Implement:
- Recent messages (last N turns)
- Conversation summary (when history exceeds window)
- Page context (always included, but truncated if too large)

### Context Window Budget

Groq's context window for `openai/gpt-oss-120b` is large (~128K tokens), but we still need to manage it. We explicitly separate INPUT context (what we send to the LLM) from OUTPUT budget (reserved for the response):

**INPUT CONTEXT BUDGET** (managed by Context Manager):
| Component | Budget (tokens) | Notes |
|-----------|-----------------|-------|
| System instructions | ~100 | Minimal prompt framing |
| Page context | ~4,000 | Truncate to first 2000 words if longer |
| Recent messages | ~3,000 | Last 5-8 turns (~500 tokens each) |
| Summary | ~500 | When conversation is long |
| Current question | ~200 | User's current input |

**OUTPUT BUDGET** (separate):
| Component | Budget (tokens) |
|-----------|-----------------|
| MAX_OUTPUT_TOKENS | ~1,000 |

The context manager calculates `input_tokens + max_output_tokens < MODEL_CONTEXT_WINDOW` and enforces truncation.

> Note: The `4 chars ≈ 1 token` approximation is acceptable for Phase 3. Production should use proper token counting.

### Implementation

#### Backend — Context Manager

```python
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class ConversationContext:
    conversation_id: str
    page_context: str           # extracted page text
    title: str = ""
    messages: list[dict] = field(default_factory=list)  # [{"role": ..., "content": ...}]
    summary: Optional[str] = None  # "So far we've discussed X and Y..."

    # Token budget constants (char-based for now, ~4 chars/token)
    MODEL_CONTEXT_WINDOW = 128_000
    MAX_OUTPUT_TOKENS = 1_000
    CHARS_PER_TOKEN = 4

    def get_context_window(self, question: str) -> str:
        """
        Build a context-aware prompt within token budget.
        Strategy:
          1. Always include page context (truncated if needed)
          2. Include summary (if any) as bridge between older messages and recent ones
          3. Include recent messages (as many as fit)
          4. Include current question
        """
        # Input budget = total window - output reserve
        input_token_budget = self.MODEL_CONTEXT_WINDOW - self.MAX_OUTPUT_TOKENS
        char_budget = input_token_budget * self.CHARS_PER_TOKEN

        parts: list[str] = []
        remaining = char_budget

        # 1. Page context (highest priority, but cap at 2000 words)
        page_words = self.page_context.split()[:2000]
        page_text = " ".join(page_words)
        page_section = f"Page Title: {self.title or 'Unknown'}\n\nPage Content:\n{page_text}"
        if len(page_section) > remaining * 0.5:  # cap page at 50% of budget
            page_text = " ".join(page_words[:int(len(page_words) * remaining * 0.5 / len(page_section))])
            page_section = f"Page Title: {self.title or 'Unknown'}\n\nPage Content:\n{page_text}"
        parts.append(page_section)
        remaining -= len(page_section)

        # 2. Summary (if conversation is long)
        if self.summary:
            summary_section = f"\n[Earlier in this conversation: {self.summary}]\n"
            if len(summary_section) < remaining:
                parts.append(summary_section)
                remaining -= len(summary_section)

        # 3. Recent messages (fit as many as possible)
        recent_section = self._build_recent_section(remaining)
        parts.append(recent_section)
        remaining -= len(recent_section)

        # 4. Current question
        question_section = f"\nUser Question: {question}"
        parts.append(question_section)

        return "\n\n---\n\n".join(parts)

    def _build_recent_section(self, char_budget: int) -> str:
        """Build recent messages section fitting within budget."""
        lines: list[str] = []
        used_chars = 0

        # Iterate backwards through messages
        for msg in reversed(self.messages):
            line = f"{'User' if msg['role'] == 'user' else 'Assistant'}: {msg['content']}"
            if used_chars + len(line) + 2 > char_budget:
                break
            lines.insert(0, line)  # prepend to maintain order
            used_chars += len(line) + 1

        return "\n".join(lines) if lines else ""

    def should_summarize(self) -> bool:
        """
        Summarize when estimated context size exceeds threshold.
        This is context-size-based, not message-count-based.
        """
        # Estimate tokens: page + messages + summary + question
        estimated_chars = (
            len(self.page_context) +
            sum(len(m['content']) for m in self.messages) +
            len(self.summary or "") +
            500  # buffer for question + prompt overhead
        )
        estimated_tokens = estimated_chars / self.CHARS_PER_TOKEN
        # Trigger when we'd exceed ~75% of input budget
        return estimated_tokens > (self.MODEL_CONTEXT_WINDOW - self.MAX_OUTPUT_TOKENS) * 0.75

    def update_summary(self, summary: str):
        self.summary = summary
```

#### Backend — Auto-summarize Trigger

```python
async def check_and_summarize(context: ConversationContext) -> Optional[str]:
    """If context size exceeds threshold, summarize older messages via LLM."""
    if not context.should_summarize():
        return None

    # Build condensed history for summary
    # Keep last 5 messages as "recent" (they're still fresh in context)
    old_messages = context.messages[:-5]
    history_for_summary = "\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}"
        for m in old_messages
    )

    summary_prompt = (
        "Summarize this conversation briefly, capturing the key topics and questions discussed. "
        "Return a 2-3 sentence summary in the style: 'In this conversation we discussed X, Y, and Z.'\n\n"
        f"{history_for_summary}"
    )

    try:
        summary = await _call_groq_with_fallback(summary_prompt)
        context.update_summary(summary)
        # Trim old messages we just summarized
        context.messages = context.messages[-5:]
        return summary
    except Exception as e:
        print(f"⚠️ Summary generation failed: {e}")
        return None
```

#### Update `build_prompt` to use context manager

```python
def build_prompt(context: ConversationContext, question: str, action: str) -> str:
    context_text = context.get_context_window(question)

    action_templates = {
        "explain": "Analyze and explain the following webpage content in clear, concise terms:\n\n{context}",
        "simplify": "Rewrite the following in simpler language:\n\n{context}",
        "summarize": "Provide a 2-3 sentence summary:\n\n{context}",
        "translate": "Translate to Hindi:\n\n{context}",
    }

    template = action_templates.get(action, action_templates["explain"])
    return template.format(context=context_text)
```

### Per-Conversation In-Memory Store

```python
# Simple in-memory store for active conversations
# Phase 4 replaces this with PostgreSQL
_active_conversations: dict[str, ConversationContext] = {}

def get_or_create_conversation(conversation_id: str, page_context: str, title: str = "") -> ConversationContext:
    if conversation_id not in _active_conversations:
        _active_conversations[conversation_id] = ConversationContext(
            conversation_id=conversation_id,
            page_context=page_context,
            title=title,
        )
    return _active_conversations[conversation_id]
```

### Verification Checklist
- [ ] Context window budget: input tokens + MAX_OUTPUT_TOKENS < MODEL_CONTEXT_WINDOW
- [ ] Very long page: truncated to ~2000 words, doesn't overflow context
- [ ] Context manager enforces truncation and respects output budget
- [ ] LLM answers reference summarized history correctly
- [ ] Summary trigger based on context size (~75% of input budget), not message count

---

## Phase 4 — Persistent Storage

### Goal
Replace in-memory stores with PostgreSQL. Enable multi-user, multi-device, and conversation persistence across server restarts.

### Key Design Decision

The frontend sends `conversation_id` directly. The backend loads that conversation and verifies it belongs to the user. This matches the Clear/New Conversation UI concept and production expectations.

**Why not "find latest active for this page":**
The plan's original query `WHERE user_id = $1 AND page_id = $2 AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1` implicitly assumes one conversation per page. But users can have multiple conversations on the same page (e.g., one for research, one for a different task). The frontend's `conversation_id` is the source of truth — the backend simply loads and verifies ownership.

**Correct flow:**
```
Frontend
   ↓
conversation_id
   ↓
Backend
   ↓
verify conversation belongs to user
   ↓
load that conversation
```

### Schema

```sql
-- Users (optional for v1 — anonymous by install_id)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    install_id VARCHAR(255) UNIQUE NOT NULL,  -- from chrome.storage.local
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pages (content cache, keyed by content hash)
CREATE TABLE pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url_hash VARCHAR(64) NOT NULL,  -- SHA256 of URL + content prefix
    url_hint TEXT,
    title TEXT,
    content TEXT NOT NULL,         -- Trafilatura-extracted markdown
    extracted_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(url_hash)
);

CREATE INDEX idx_pages_url_hash ON pages(url_hash);

-- Conversations
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    page_id UUID REFERENCES pages(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    summary TEXT,                 -- Phase 3 summary
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_conversations_user ON conversations(user_id);
CREATE INDEX idx_conversations_page ON conversations(page_id);

-- Messages
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    action VARCHAR(50) DEFAULT 'explain',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_created ON messages(created_at);
```

### Backend Changes

```python
import asyncpg

DATABASE_URL = os.getenv("DATABASE_URL")  # postgresql://...

pool: Optional[asyncpg.Pool] = None

@app.on_event("startup")
async def startup():
    global pool
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)

@app.on_event("shutdown")
async def shutdown():
    await pool.close()
```

**Page cache (DB-backed):**
```python
async def get_or_extract_page_context(
    html: str,
    url_hint: str = "",
) -> str:
    key = get_page_context_cache_key(html, url_hint)

    async with pool.acquire() as conn:
        # Try DB cache
        row = await conn.fetchrow(
            "SELECT content, extracted_at FROM pages WHERE url_hash = $1", key
        )
        if row and is_cache_valid(row["extracted_at"].isoformat()):
            print(f"[PageContext] DB cache hit for {key[:8]}...")
            return row["content"]

        # Extract
        content = await asyncio.to_thread(extract_clean_text, html)
        if not content:
            raise HTTPException(422, "Could not extract readable content")

        # Store in DB
        await conn.execute("""
            INSERT INTO pages (url_hash, url_hint, content)
            VALUES ($1, $2, $3)
            ON CONFLICT (url_hash) DO UPDATE SET
                content = EXCLUDED.content,
                extracted_at = NOW()
        """, key, url_hint, content)

        return content
```

**Conversation persistence:**
```python
async def get_or_create_conversation(
    conn: asyncpg.Connection,
    user_id: str,
    conversation_id: str,
    page_id: Optional[str] = None,
) -> Optional[dict]:
    """
    Load conversation by ID and verify ownership.
    If not found, create a new one.
    """
    row = await conn.fetchrow("""
        SELECT * FROM conversations
        WHERE id = $1 AND user_id = $2
    """, conversation_id, user_id)

    if not row and page_id:
        # Create new conversation if it doesn't exist
        row = await conn.fetchrow("""
            INSERT INTO conversations (id, user_id, page_id)
            VALUES ($1, $2, $3)
            RETURNING *
        """, conversation_id, user_id, page_id)

    return dict(row) if row else None

async def save_message(
    conn: asyncpg.Connection,
    conversation_id: str,
    role: str,
    content: str,
    action: str,
):
    await conn.execute("""
        INSERT INTO messages (conversation_id, role, content, action)
        VALUES ($1, $2, $3, $4)
    """, conversation_id, role, content, action)

    await conn.execute("""
        UPDATE conversations SET updated_at = NOW() WHERE id = $1
    """, conversation_id)
```

### Redis (Optional, Phase 4b)

For fast session state and hot cache:

```python
import redis.asyncio as redis

redis_client: Optional[redis.Redis] = None

@app.on_event("startup")
async def startup():
    global redis_client
    redis_url = os.getenv("REDIS_URL")
    if redis_url:
        redis_client = redis.from_url(redis_url)

# Use Redis for:
# - Active conversation context (TTL: 1 hour)
# - Rate limiting (already in-memory, but Redis enables multi-worker)
# - Page context cache hot tier (before PostgreSQL)
```

### Verification Checklist
- [ ] Fresh server start: conversations load from DB
- [ ] Restart during active conversation: context preserved
- [ ] Page context cache hits DB on first request, serves from DB on subsequent
- [ ] Multiple conversations per user work independently
- [ ] Redis hot cache (if deployed) serves faster than DB

---

## Phase 5 — Semantic Memory

### Goal
Retrieve relevant information from past conversations based on semantic similarity, not just recency.

### When to Start This
Only after Phases 1-4 are stable. Semantic memory adds meaningful complexity — it needs the conversation/conversation-context infrastructure working first.

### Architecture

```
Current question
      │
      ▼
┌─────────────────┐
│ Embed question  │  (via OpenAI / text-embedding-3-small or similar)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Vector search   │  Query pgvector for top-k similar past messages
│ (pgvector)      │  WHERE user_id = current_user
└────────┬────────┘
         │
         ▼
Relevant past messages
         │
         ▼
┌─────────────────┐
│ Inject into     │  "Based on your previous conversation on [date]: ..."
│ context window  │
└─────────────────┘
         │
         ▼
LLM response (with memory context)
```

### PostgreSQL Setup (with pgvector)

```sql
-- Enable extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to messages
ALTER TABLE messages ADD COLUMN embedding vector(1536);

-- Create index for similarity search
CREATE INDEX idx_messages_embedding ON messages
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Or use HNSW for better performance (PG 16+):
-- CREATE INDEX idx_messages_embedding ON messages
-- USING hnsw (embedding vector_cosine_ops);
```

### Backend — Embedding & Retrieval

```python
# Embedding provider is chosen independently from the LLM provider.
# OpenAI embeddings are recommended for quality, but the client is abstracted
# so you can swap providers (e.g. Google, Cohere, or open-source local) without
# changing retrieval logic. Do NOT copy openai.Embedding.create() literally —
# use the current SDK/API for whichever provider is chosen.

EMBEDDING_MODEL = "text-embedding-3-small"  # 1536 dimensions, cheap

async def embed_text(text: str) -> list[float]:
    """Get embedding for a piece of text.

    Uses whichever embedding provider is configured. Truncates to ~8000 chars
    to stay within provider limits.
    """
    text = text[:8000]

    # Example: OpenAI SDK (current API)
    # response = await asyncio.to_thread(
    #     openai_client.embeddings.create,
    #     model=EMBEDDING_MODEL,
    #     input=text,
    # )
    # return response.data[0].embedding

    # Example: Google Gemini SDK (alternative)
    # result = await asyncio.to_thread(
    #     gemini_client.embed_content,
    #     model=EMBEDDING_MODEL,
    #     content=text,
    #     task_type="RETRIEVAL_DOCUMENT",
    # )
    # return result["values"]

    # TODO: Implement with chosen provider's current SDK/API
    raise NotImplementedError("Configure embedding provider")


async def retrieve_relevant_memory(
    conn: asyncpg.Connection,
    user_id: str,
    question: str,
    top_k: int = 5,
    similarity_threshold: float = 0.7,
) -> list[dict]:
    """Find past messages semantically similar to the current question."""
    question_embedding = await embed_text(question)

    rows = await conn.fetch("""
        SELECT
            m.content,
            m.role,
            m.created_at,
            m.conversation_id,
            c.id as conversation_id,
            1 - (m.embedding <=> $1) as similarity
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        WHERE c.user_id = $2
          AND m.embedding IS NOT NULL
          AND 1 - (m.embedding <=> $1) > $3
        ORDER BY m.embedding <=> $1
        LIMIT $4
    """, question_embedding, user_id, similarity_threshold, top_k)

    return [dict(row) for row in rows]


### Memory Injection into Context
```

### Memory Injection into Context

```python
async def build_context_with_memory(
    request: "ExplainRequest",
    conversation: ConversationContext,
) -> str:
    context = conversation.get_context_window(request.question)

    # Retrieve relevant past conversations
    if request.user_id and request.include_memory:
        relevant = await retrieve_relevant_memory(
            conn, request.user_id, request.question
        )
        if relevant:
            memory_section = "\n\n[Relevant past conversations]:\n"
            for item in relevant:
                memory_section += (
                    f"- ({item['created_at'].date()}) "
                    f"{item['role']}: {item['content'][:200]}...\n"
                )
            context += memory_section

    return context
```

### What Gets Embedded

| What | When | Why |
|------|------|-----|
| User messages | On every submit | User intent/questions are most searchable |
| Assistant answers | On every response | Captures key explanations and findings |
| Summaries | On summarization | Summaries are dense, high-value for retrieval |

### Verification Checklist
- [ ] Ask a question about "REST APIs" on Page A
- [ ] Later, on a different page, ask about "how do REST APIs work"
- [ ] System retrieves the relevant past message (even though different page)
- [ ] LLM incorporates past context into answer
- [ ] Similarity threshold filters out unrelated past messages

---

## Production Architecture

```
                    ┌─────────────────────┐
                    │  Chrome Extension    │
                    │  (popup.ts)         │
                    └──────────┬──────────┘
                               │
                    conversation_id
                    question
                    page_id
                    user_id (install_id)
                               │
                               ▼
                    ┌─────────────────────┐
                    │  FastAPI            │
                    │  (main.py)          │
                    │                     │
                    │  • Auth middleware   │
                    │  • Rate limiting    │
                    │  • Context manager  │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
   ┌────────────┐     ┌──────────────┐     ┌─────────────┐
   │ PostgreSQL │     │    Redis      │     │ Page Context │
   │            │     │              │     │    Cache     │
   │ users      │     │ • Rate limit │     │ (hot tier)  │
   │ pages      │     │   counters  │     │             │
   │ convos     │     │ • Session    │     │             │
   │ messages   │     │   state     │     │             │
   │ (vectors)  │     │ • Response   │     │             │
   │            │     │   cache      │     │             │
   └─────┬──────┘     └──────┬───────┘     └──────┬──────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │  Context Manager    │
                    │                     │
                    │  • Page context     │
                    │  • Recent messages  │
                    │  • Summary          │
                    │  • Relevant memory  │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Groq API           │
                    │  (gpt-oss-120b)     │
                    └──────────┬──────────┘
                               │
                               ▼
                    SSE streamed answer
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    ▼                     ▼
            Save message          Save to Redis
            to PostgreSQL         (response cache)
                    │
                    ▼
            Embed + store
            in pgvector
                    │
                    ▼
              Chrome popup
```

### Key Services

| Service | Purpose | Free Tier? |
|---------|---------|-----------|
| **PostgreSQL + pgvector** | Persistent storage, vector search | Railway ($5/mo), Supabase (free tier) |
| **Redis** | Rate limiting, hot cache, session state | Upstash (free tier) |
| **Groq** | LLM inference | Free tier (60 req/min) |
| **Render** | Backend hosting | Free tier (750 hrs/mo) |

---

## Migration Path

### Phase 1-3: In-Memory (no new dependencies)
- Start with in-memory conversation store
- No DB, no Redis
- Works on single-instance deployment
- Risk: data lost on restart (acceptable for Phase 1-3)

### Phase 4a: Add PostgreSQL only
- Keep in-memory page cache + conversation store as fallback
- PostgreSQL becomes source of truth
- Single-worker deployment initially

### Phase 4b: Add Redis
- Redis for hot page cache + rate limiting
- Enables multi-worker deployment
- Redis replaces in-memory rate limiter

### Phase 5: Add pgvector
- Enable semantic memory
- Requires PostgreSQL with `pgvector` extension
- Most cloud providers support this (Supabase, Railway, Neon)

### Feature Flags

Control rollout at runtime:

```python
FEATURE_CONVERSATION = os.getenv("FEATURE_CONVERSATION", "true").lower() == "true"
FEATURE_CONTEXT_CACHE = os.getenv("FEATURE_CONTEXT_CACHE", "true").lower() == "true"
FEATURE_SUMMARY = os.getenv("FEATURE_SUMMARY", "true").lower() == "true"
FEATURE_MEMORY = os.getenv("FEATURE_MEMORY", "false").lower() == "true"
FEATURE_PERSISTENCE = os.getenv("FEATURE_PERSISTENCE", "false").lower() == "true"
```

---

## Rollback Triggers

Define clear rollback criteria before shipping each phase:

| Phase | Rollback If |
|-------|------------|
| Phase 1 | LLM produces nonsensical answers when given history; conversation state causes cache collisions |
| Phase 2 | Page context cache produces stale/outdated content; cache invalidation bugs |
| Phase 3 | Summary distorts conversation meaning; context window truncation drops critical info |
| Phase 4 | Database connection errors spike; latency increases significantly |
| Phase 5 | Vector search retrieves irrelevant results; semantic memory introduces hallucinated context |

### Rollback Procedure

```bash
# Phase 1 rollback
git checkout <previous-commit>
# Set env: FEATURE_CONVERSATION=false
# Rebuild extension, redeploy backend

# Phase 4 rollback
# Point DATABASE_URL to empty/invalid
# Fallback to in-memory stores (already coded as fallback)
```

---

## Implementation Order

```
Week 1-2: Phase 1 — Conversation state (frontend + backend)
           - Add history to requests
           - Build prompt with conversation context
           - Persist in chrome.storage.local

Week 3-4: Phase 2 — Page context caching
           - Extract once, reuse for conversation
           - Add X-Page-Context-Hash header
           - Backend page context cache

Week 5-6: Phase 3 — Context window management
           - Implement ConversationContext class
           - Add summarization trigger
           - Token budget enforcement

Week 7-8: Phase 4a — PostgreSQL persistence
           - Schema migration
           - Swap in-memory stores for DB
           - Add user/install_id tracking

Week 9-10: Phase 4b — Redis
            - Hot cache tier
            - Multi-worker rate limiting

Week 11-12: Phase 5 — Semantic memory
             - pgvector setup
             - Embedding pipeline
             - Retrieval + injection
```

---

## Testing Strategy

### Unit Tests
- `query_normalizer.normalize_query()` — existing, highest value
- `chunk_preserving_whitespace()` — regression protection
- `build_cleaned_text()` — title/question/content combination
- `ConversationContext.get_context_window()` — truncation logic

### Integration Tests
```bash
# Backend only (curl)
curl -X POST http://localhost:8000/explain-stream \
  -H "Content-Type: application/json" \
  -d '{
    "text": "<html>...</html>",
    "content_type": "html",
    "title": "Test Page",
    "question": "What is this about?",
    "history": [{"role": "user", "content": "Earlier question"}]
  }'
```

### Manual QA Checklist
- [ ] Phase 1: Multi-turn conversation on same page
- [ ] Phase 1: Follow-up referencing previous answer
- [ ] Phase 2: Cache hit logged on second request
- [ ] Phase 3: 10+ turn conversation triggers summary
- [ ] Phase 4: Conversation survives server restart
- [ ] Phase 5: Semantic search retrieves relevant past conversation

---

**Last Updated:** September 4, 2026
**Status:** Plan complete. Ready to begin Phase 1 implementation.
