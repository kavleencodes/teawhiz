// Popup script - conversation-style messaging

const promptInput = document.getElementById("prompt") as HTMLTextAreaElement;
const submitBtn = document.getElementById("submit") as HTMLButtonElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const messagesContainer = document.getElementById("messagesContainer") as HTMLDivElement;
const emptyState = document.getElementById("emptyState") as HTMLDivElement;

let pageContent = "";
const loadingWords = ["boiling", "brewing", "teaying", "sipping", "vibing"];
let currentLoadingIndex = 0;
let loadingInterval: any = null;
let loadingMessageEl: HTMLElement | null = null;
let loadingStartTime = 0;
let hasStoppedLoading = false; // Track if we've already stopped loading
const LOADING_DURATION = 5000; // 5 seconds before showing response

// Get page content when popup opens
async function loadPageContent() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log("[TeaWhiz] Popup: Querying active tab...", tabs[0]?.id);

    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(
        tabs[0].id,
        { type: "GET_PAGE_CONTENT" },
        (response) => {
          console.log("[TeaWhiz] Popup: Got content response:", response);
          if (response?.success) {
            pageContent = response.content;
            promptInput.placeholder = "Ask about this page...";
            console.log("[TeaWhiz] Popup: Page content loaded, length:", pageContent.length);
          } else {
            console.log("[TeaWhiz] Popup: Content request failed", response);
          }
        }
      );
    }
  } catch (error) {
    console.log("[TeaWhiz] Popup: Could not load page content:", error);
  }
}

loadPageContent();

// Load saved prompt
chrome.storage.local.get("savedPrompt", (result: any) => {
  if (result.savedPrompt) {
    promptInput.value = result.savedPrompt;
  }
});

// Auto-expand textarea and save
promptInput.addEventListener("input", () => {
  chrome.storage.local.set({ savedPrompt: promptInput.value });
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(promptInput.scrollHeight, 100) + "px";
});

// Clear button
clearBtn.addEventListener("click", () => {
  promptInput.value = "";
  messagesContainer.innerHTML = "";
  emptyState.style.display = "flex";
  chrome.storage.local.set({ savedPrompt: "" });
  promptInput.focus();
});

// Submit on button click
submitBtn.addEventListener("click", submit);

// Submit on Ctrl+Enter
promptInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    submit();
  }
});

function submit() {
  const userQuestion = promptInput.value.trim();

  if (!userQuestion) {
    showMessage(userQuestion, "user");
    showMessage("Please type a question to ask about this page.", "error");
    return;
  }

  console.log("[TeaWhiz] Popup: Submit button clicked, clearing previous response");
  // Clear the response content ID when submitting new question
  const oldResponse = document.getElementById("responseContent");
  if (oldResponse) {
    oldResponse.parentElement?.remove();
  }

  showMessage(userQuestion, "user");

  submitBtn.disabled = true;
  submitBtn.textContent = "...";
  emptyState.style.display = "none";

  // Show loading animation
  showLoading();

  const fullPrompt = pageContent
    ? `${pageContent}\n\n---\n\nUser Question: ${userQuestion}`
    : userQuestion;

  console.log("[TeaWhiz] Popup: Sending GET_ANSWER to background", {
    hasPageContent: !!pageContent,
    pageContentLength: pageContent.length,
    userQuestion: userQuestion,
  });

  chrome.runtime.sendMessage(
    { type: "GET_ANSWER", text: fullPrompt },
    (response) => {
      console.log("[TeaWhiz] Popup: Got callback response:", response);
      stopLoading();
      submitBtn.disabled = false;
      submitBtn.textContent = "⬆";

      if (response?.success) {
        // Response will come as chunks
      } else {
        showMessage(response?.error || "Failed to get response", "error");
      }
    }
  );
}

function showMessage(text: string, type: "user" | "assistant" | "error") {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${type}`;

  const contentEl = document.createElement("div");
  contentEl.className = "message-content";
  contentEl.textContent = text;

  messageEl.appendChild(contentEl);
  messagesContainer.appendChild(messageEl);

  // Scroll to bottom
  setTimeout(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }, 0);
}

function showLoading() {
  // Create loading message with teacup icon
  const messageEl = document.createElement("div");
  messageEl.className = "message assistant";
  messageEl.id = "loadingMessage";

  const contentEl = document.createElement("div");
  contentEl.className = "message-content loading-content";

  // Add teacup icon
  const iconEl = document.createElement("img");
  iconEl.src = "../public/icon.png";
  iconEl.className = "loading-icon";
  iconEl.alt = "Loading";

  // Add loading text
  const textEl = document.createElement("span");
  textEl.className = "loading-text-inline";
  textEl.textContent = "Tea is boiling...";

  contentEl.appendChild(iconEl);
  contentEl.appendChild(textEl);
  messageEl.appendChild(contentEl);
  messagesContainer.appendChild(messageEl);

  loadingMessageEl = messageEl;
  currentLoadingIndex = 0;
  loadingStartTime = Date.now(); // Track when loading started

  loadingInterval = setInterval(() => {
    const word = loadingWords[currentLoadingIndex % loadingWords.length];
    if (textEl) {
      textEl.textContent = `Tea is ${word}...`;
    }
    currentLoadingIndex++;
  }, 600);

  // Scroll to bottom
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function stopLoading() {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
  }
  // Remove loading message
  if (loadingMessageEl) {
    console.log("[TeaWhiz] Popup: Removing loading message element");
    loadingMessageEl.remove();
    loadingMessageEl = null;
  }
  hasStoppedLoading = true;
}

// Listen for streaming chunks from background
chrome.runtime.onMessage.addListener((request) => {
  console.log("[TeaWhiz] Popup: Received message:", request.type);

  if (request.type === "RESPONSE_CHUNK") {
    console.log("[TeaWhiz] Popup: Got chunk:", request.text);

    const displayChunk = () => {
      // Stop loading only once
      if (!hasStoppedLoading) {
        console.log("[TeaWhiz] Popup: Stopping loading animation");
        stopLoading();
      }

      emptyState.style.display = "none";

      // Get or create response message - use a stable ID
      let responseEl = document.getElementById("responseContent");
      if (!responseEl) {
        console.log("[TeaWhiz] Popup: Creating new response message element");
        const messageEl = document.createElement("div");
        messageEl.className = "message assistant";
        const contentEl = document.createElement("div");
        contentEl.className = "message-content";
        contentEl.id = "responseContent";
        messageEl.appendChild(contentEl);
        messagesContainer.appendChild(messageEl);
        responseEl = contentEl;
      }

      // Add text chunk
      console.log("[TeaWhiz] Popup: Appending chunk to response element, current text length:", responseEl.textContent.length);
      responseEl.textContent += request.text;
      console.log("[TeaWhiz] Popup: After chunk, text length:", responseEl.textContent.length, "content preview:", responseEl.textContent.substring(0, 50));
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    };

    // Only delay first chunk by remaining 5-second duration
    if (!hasStoppedLoading) {
      const elapsedTime = Date.now() - loadingStartTime;
      const remainingTime = Math.max(0, LOADING_DURATION - elapsedTime);
      console.log("[TeaWhiz] Popup: Delaying first chunk by", remainingTime, "ms");
      setTimeout(displayChunk, remainingTime);
    } else {
      // Display subsequent chunks immediately
      displayChunk();
    }
  } else if (request.type === "RESPONSE_DONE") {
    console.log("[TeaWhiz] Popup: Response complete");
    stopLoading();
    submitBtn.disabled = false;
    submitBtn.textContent = "⬆";
  } else if (request.type === "RESPONSE_ERROR") {
    console.log("[TeaWhiz] Popup: Got error:", request.error);
    stopLoading();
    showMessage(request.error, "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "⬆";
  }
});

promptInput.focus();
console.log("TeaWhiz AI popup loaded");
