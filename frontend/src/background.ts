// Background service worker - handles AI requests

const BACKEND_URL = "http://localhost:8000"; // Will update in Phase 6

interface MessageRequest {
  type: string;
  text: string;
}

// Check if Chrome Gemini Nano is available
async function isNanoAvailable(): Promise<boolean> {
  try {
    const canCreate = await (window as any).ai?.canCreateTextSession?.();
    return canCreate === "readily";
  } catch {
    return false;
  }
}

// Get answer from Gemini Nano or backend
async function getAnswer(text: string): Promise<string> {
  const prompt = `Answer this question or request concisely:\n\n${text}`;

  // Try Gemini Nano first
  if (await isNanoAvailable()) {
    try {
      const session = await (window as any).ai.createTextSession();
      const response = await session.prompt(prompt);
      session.destroy();
      return response;
    } catch (error) {
      console.log("Nano failed, falling back to backend:", error);
    }
  }

  // Fallback to backend API
  try {
    const response = await fetch(`${BACKEND_URL}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, action: "explain" }),
    });

    if (!response.ok) throw new Error("Backend request failed");
    const data = await response.json();
    return data.answer;
  } catch (error) {
    throw new Error("Failed to connect to AI service");
  }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener(
  (request: MessageRequest, sender, sendResponse) => {
    if (request.type === "GET_ANSWER") {
      getAnswer(request.text)
        .then((answer) => {
          sendResponse({ success: true, answer });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error.message });
        });

      // Return true to indicate async response
      return true;
    }
  }
);

console.log("TeaWhiz AI background worker loaded");
