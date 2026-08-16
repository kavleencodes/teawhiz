// Background service worker - handles AI requests

const BACKEND_URL = "http://localhost:8000"; // Will update in Phase 6

interface MessageRequest {
  type: string;
  text: string;
}

// Stream answer from backend in real-time
async function streamAnswer(text: string, tabId: number) {
  try {
    const response = await fetch(`${BACKEND_URL}/explain-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, action: "explain" }),
    });

    if (!response.ok) {
      chrome.tabs.sendMessage(tabId, {
        type: "RESPONSE_ERROR",
        error: "Backend error",
      });
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        chrome.tabs.sendMessage(tabId, { type: "RESPONSE_DONE" });
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (line.startsWith("data: ")) {
          const chunk = line.slice(6).trim();
          if (chunk && chunk !== "[DONE]") {
            chrome.tabs.sendMessage(tabId, {
              type: "RESPONSE_CHUNK",
              text: chunk + " ",
            });
          }
        }
      }
      buffer = lines[lines.length - 1];
    }
  } catch (error) {
    chrome.tabs.sendMessage(tabId, {
      type: "RESPONSE_ERROR",
      error: String(error),
    });
  }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener(
  (request: MessageRequest, sender) => {
    if (request.type === "GET_ANSWER") {
      // Use streaming for real-time response
      streamAnswer(request.text, sender.tab?.id || 0);
      return true;
    }
  }
);

console.log("TeaWhiz AI background worker loaded");
