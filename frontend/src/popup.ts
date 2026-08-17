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
const LOADING_DURATION = 5000; // 5 seconds before showing response

// Get page content when popup opens
async function loadPageContent() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(
        tabs[0].id,
        { type: "GET_PAGE_CONTENT" },
        (response) => {
          if (response?.success) {
            pageContent = response.content;
            promptInput.placeholder = "Ask about this page...";
          }
        }
      );
    }
  } catch (error) {
    console.log("Could not load page content:", error);
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

  showMessage(userQuestion, "user");

  submitBtn.disabled = true;
  submitBtn.textContent = "...";
  emptyState.style.display = "none";

  // Show loading animation
  showLoading();

  const fullPrompt = pageContent
    ? `${pageContent}\n\n---\n\nUser Question: ${userQuestion}`
    : userQuestion;

  chrome.runtime.sendMessage(
    { type: "GET_ANSWER", text: fullPrompt },
    (response) => {
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
    loadingMessageEl.remove();
    loadingMessageEl = null;
  }
}

// Listen for streaming chunks from background
chrome.runtime.onMessage.addListener((request) => {
  if (request.type === "RESPONSE_CHUNK") {
    // Wait 5 seconds before showing actual response chunks
    const elapsedTime = Date.now() - loadingStartTime;
    const remainingTime = Math.max(0, LOADING_DURATION - elapsedTime);

    setTimeout(() => {
      stopLoading();
      emptyState.style.display = "none";

      // Get or create response message
      let responseEl = messagesContainer.querySelector(".message.assistant:last-of-type .message-content");
      if (!responseEl) {
        const messageEl = document.createElement("div");
        messageEl.className = "message assistant";
        const contentEl = document.createElement("div");
        contentEl.className = "message-content";
        messageEl.appendChild(contentEl);
        messagesContainer.appendChild(messageEl);
        responseEl = contentEl;
      }

      // Add text chunk
      responseEl.textContent += request.text;
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }, remainingTime);
  } else if (request.type === "RESPONSE_DONE") {
    stopLoading();
    submitBtn.disabled = false;
    submitBtn.textContent = "⬆";
  } else if (request.type === "RESPONSE_ERROR") {
    stopLoading();
    showMessage(request.error, "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "⬆";
  }
});

promptInput.focus();
console.log("TeaWhiz AI popup loaded");
