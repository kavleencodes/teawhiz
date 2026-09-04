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
}

// Stream answer from backend in real-time. `content` is either plain text
// (Netflix titles, DOM-text fallback) or the page's rendered outerHTML - the
// backend runs Trafilatura extraction itself when contentType is "html", and
// combines the result with `title`/`question` server-side.
async function streamAnswer(
  content: string,
  contentType: "html" | "text",
  title: string,
  question: string,
  tabId: number
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
      }),
    });

    console.log("[TeaWhiz] Background: Got response status:", response.status);

    if (!response.ok) {
      console.error("[TeaWhiz] Background: Backend error", response.status);
      broadcastResponse({
        type: "RESPONSE_ERROR",
        error: `Backend error: ${response.status}`,
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
      // Use streaming for real-time response
      streamAnswer(
        request.content,
        request.contentType || "text",
        request.title || "",
        request.question || "",
        sender.tab?.id || 0
      );
      return true;
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
  }
);

console.log("TeaWhiz AI background worker loaded");
