// Background service worker - handles AI requests

const BACKEND_URL = "http://localhost:8000"; // Will update in Phase 6

// PROBLEM: the backend has no request auth of its own - CORS only stops
// *browser-enforced* cross-origin fetch() calls, so anyone who finds
// BACKEND_URL could call it directly (curl, a script, etc.) and burn the
// Groq quota/bill. See BACKEND_API_KEY / verify_api_key() in backend/main.py.
// SOLUTION: send this shared secret as `X-API-Key` on every backend
// request; the backend rejects requests with a missing/wrong key (401) as
// long as it has BACKEND_API_KEY configured on its side too.
// Honest caveat: this value ships inside the built extension's JS - anyone
// who unpacks the .crx/.zip can read it out. Not real secrecy against a
// determined attacker, but it raises the bar from "just know the URL" to
// "inspect the extension bundle first" - meaningful for a personal/local
// project. Must exactly match BACKEND_API_KEY in backend/.env, or every
// request will get rejected with 401 once the backend has one configured.
const BACKEND_API_KEY = ""; // set to match backend/.env's BACKEND_API_KEY, then rebuild

function backendHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (BACKEND_API_KEY) {
    headers["X-API-Key"] = BACKEND_API_KEY;
  }
  return headers;
}

interface MessageRequest {
  type: string;
  content: string;
  contentType?: "html" | "text";
  title?: string;
  question?: string;
  word?: string;
  url?: string;  // For CAPTURE_PAGE
  pageContextHash?: string;  // For GET_ANSWER
  // Phase 1 — conversation state, forwarded as-is from popup. Optional so
  // any non-conversation caller (one-off scripted GET_ANSWER) still works.
  conversationId?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  systemContext?: string;
}

// Storage key prefix for page context
const PAGE_CONTEXT_STORAGE_KEY_PREFIX = "pageContext:";

// Handle CAPTURE_PAGE: call backend to extract content, store in chrome.storage
async function handleCapturePage(content: string, contentType: "html" | "text", title: string, url: string) {
  try {
    console.log("[TeaWhiz] Background: Capturing page for URL:", url);

    const response = await fetch(`${BACKEND_URL}/extract-context`, {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify({
        text: content,
        content_type: contentType,
        title: title,
      }),
    });

    if (!response.ok) {
      console.error("[TeaWhiz] Background: extract-context failed:", response.status);
      return;
    }

    const data = await response.json();
    console.log("[TeaWhiz] Background: Extracted content, length:", data.extracted_content.length, "hash:", data.page_context_hash.substring(0, 8) + "...");

    // Store in chrome.storage.local
    const key = `${PAGE_CONTEXT_STORAGE_KEY_PREFIX}${url}`;
    await chrome.storage.local.set({
      [key]: {
        content: data.extracted_content,
        contentType: contentType,
        title: title,
        pageContextHash: data.page_context_hash,
      }
    });

    console.log("[TeaWhiz] Background: Stored page context for", url);
  } catch (error) {
    console.error("[TeaWhiz] Background: Failed to capture page:", error);
  }
}

// Stream answer from backend in real-time. `content` is either plain text
// (Netflix titles, DOM-text fallback) or the page's rendered outerHTML - the
// backend runs Trafilatura extraction itself when contentType is "html", and
// combines the result with `title`/`question` server-side. Phase 1 adds the
// optional conversation fields, which the backend passes straight through
// into the prompt + cache key.
async function streamAnswer(
  content: string,
  contentType: "html" | "text",
  title: string,
  question: string,
  tabId: number,
  pageContextHash?: string,
  conversationId?: string,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
  systemContext?: string,
) {
  try {
    console.log("[TeaWhiz] Background: Fetching from", `${BACKEND_URL}/explain-stream`);

    const response = await fetch(`${BACKEND_URL}/explain-stream`, {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify({
        text: content,
        content_type: contentType,
        title,
        question,
        action: "explain",
        page_context_hash: pageContextHash || undefined,
        conversation_id: conversationId || undefined,
        history: history || [],
        system_context: systemContext || undefined,
      }),
    });

    console.log("[TeaWhiz] Background: Got response status:", response.status);

    if (!response.ok) {
      // Read the error body so the user sees *why* the request failed,
      // not just a status code. Backend's 400/413 responses include a
      // JSON `detail` field (e.g. "Please reduce the length of the
      // messages or completion.") that's the only actionable signal -
      // surfacing it lets the user know when their page is too long vs
      // when the backend is actually down.
      let errorDetail = `Backend error: ${response.status}`;
      try {
        const errorBody = await response.json();
        if (errorBody?.detail) {
          errorDetail = `${response.status}: ${errorBody.detail}`;
        }
      } catch {
        // Body wasn't JSON - fall back to status code only
      }
      console.error("[TeaWhiz] Background: Backend error", errorDetail);
      broadcastResponse({
        type: "RESPONSE_ERROR",
        error: errorDetail,
      });
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      console.error("[TeaWhiz] Background: No reader available");
      return;
    }

    console.log("[TeaWhiz] Background: Starting to read stream");
    const decoder = new TextDecoder();
    let buffer = "";
    let chunkCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log("[TeaWhiz] Background: Stream done, sent", chunkCount, "chunks");
        broadcastResponse({ type: "RESPONSE_DONE" });
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      for (let i = 0; i < lines.length - 1; i++) {
        // Strip only a trailing CR (CRLF line endings); no other trimming -
        // leading/trailing whitespace here is meaningful markdown structure
        // (paragraph breaks, table row breaks) that the backend preserved on
        // purpose. Don't re-collapse it.
        const line = lines[i].replace(/\r$/, "");
        if (line.startsWith("data: ")) {
          const raw = line.slice(6);
          if (raw === "[DONE]") continue;
          // Backend JSON-encodes each chunk (json.dumps) so it survives a
          // single SSE `data:` line intact, newlines and all. Reverse it.
          let chunk: string;
          try {
            chunk = JSON.parse(raw);
          } catch (parseError) {
            console.error("[TeaWhiz] Background: Bad SSE chunk JSON:", raw, parseError);
            continue;
          }
          if (chunk) {
            console.log("[TeaWhiz] Background: Sending chunk:", chunk);
            broadcastResponse({
              type: "RESPONSE_CHUNK",
              text: chunk,
            });
            chunkCount++;
          }
        }
      }
      buffer = lines[lines.length - 1];
    }
  } catch (error) {
    console.error("[TeaWhiz] Background: Stream error:", error);
    broadcastResponse({
      type: "RESPONSE_ERROR",
      error: String(error),
    });
  }
}

// Live, as-you-type word correction (triggered on space-bar press in the
// popup's input). Independent of streamAnswer/GET_ANSWER - no LLM involved,
// just one fast local-dictionary lookup on the backend, and it's a plain
// request/response, not a stream.
async function normalizeWord(word: string): Promise<string> {
  const response = await fetch(`${BACKEND_URL}/normalize-query`, {
    method: "POST",
    headers: backendHeaders(),
    body: JSON.stringify({ text: word }),
  });

  if (!response.ok) {
    throw new Error(`Backend error: ${response.status}`);
  }

  const data = await response.json();
  return data.normalized_query as string;
}

// Broadcast response to all listeners (popup will receive it)
function broadcastResponse(message: any) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Silently ignore if no listener
    console.log("Broadcast sent:", message.type);
  });
}

// Handle messages from popup
chrome.runtime.onMessage.addListener(
  (request: MessageRequest, sender, sendResponse) => {
    console.log("[TeaWhiz] Background: Received message:", request.type);
    if (request.type === "GET_ANSWER") {
      console.log(
        "[TeaWhiz] Background: Starting stream for content of length:",
        request.content.length,
        "type:",
        request.contentType
      );
      // Fire-and-forget: the actual answer chunks arrive back to the popup
      // via `chrome.runtime.sendMessage({type:"RESPONSE_CHUNK", ...})`
      // broadcasts from inside streamAnswer(), which the popup's
      // onMessage listener picks up. There is no synchronous/async
      // sendResponse payload for the popup's submit() callback - returning
      // `true` here just keeps the channel open for nothing and produces
      // the "listener indicated an asynchronous response by returning
      // true, but the message channel closed before a response was
      // received" warning in the popup console.
      streamAnswer(
        request.content,
        request.contentType || "text",
        request.title || "",
        request.question || "",
        sender.tab?.id || 0,
        request.pageContextHash,
        request.conversationId,
        request.history,
        request.systemContext,
      );
      return false;
    }

    if (request.type === "NORMALIZE_WORD") {
      normalizeWord(request.word || "")
        .then((normalized) => sendResponse({ success: true, normalized }))
        .catch((error) => {
          console.log("[TeaWhiz] Background: word normalize failed", error);
          sendResponse({ success: false, error: String(error) });
        });
      return true; // keep the message channel open for the async sendResponse
    }

    if (request.type === "CAPTURE_PAGE") {
      console.log("[TeaWhiz] Background: Capturing page for URL:", request.url);
      // Fire-and-forget: don't gate the work on a sendResponse callback. On
      // SPAs (YouTube, etc.) the content script can unload before the
      // callback fires, producing a spurious "message port closed" error
      // even though the storage write still succeeds. Kick off the async
      // work and let it run to completion in the service worker.
      handleCapturePage(
        request.content || "",
        request.contentType || "text",
        request.title || "",
        request.url || ""
      );
      // Returning `true` keeps the channel open for any *other* message
      // types that might need an async sendResponse. For CAPTURE_PAGE
      // specifically, we don't call sendResponse at all.
      return false;
    }
  }
);

console.log("TeaWhiz AI background worker loaded");
