// Popup script - conversation-style messaging
import { marked } from "marked";

// GFM (tables, etc.) is on by default in marked v13+, but be explicit.
marked.setOptions({ gfm: true, breaks: true });

const promptInput = document.getElementById("prompt") as HTMLTextAreaElement;
const submitBtn = document.getElementById("submit") as HTMLButtonElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const messagesContainer = document.getElementById("messagesContainer") as HTMLDivElement;
const responseContainer = document.getElementById("responseContainer") as HTMLDivElement;

// Reveal the response area (it starts hidden so only the search bar shows)
// and let the popup expand underneath the search bar.
function expandResponseArea() {
  responseContainer.classList.add("active");
}

// The content script now hands over the page's own rendered DOM (or, for
// Netflix/fallback cases, plain text) rather than pre-extracted article
// text - extraction itself (Trafilatura, for HTML) happens on the backend.
// So we keep content/contentType/title separate instead of one flattened
// prompt string; they're combined server-side with the user's question.
let pageContent = "";
let pageContentType: "html" | "text" = "text";
let pageTitle = "";
const loadingWords = ["boiling", "brewing", "teaying", "sipping", "vibing"];
let currentLoadingIndex = 0;
let loadingInterval: any = null;
let loadingMessageEl: HTMLElement | null = null;
let hasStoppedLoading = false; // Track if we've already stopped loading

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
            pageContentType = response.contentType === "html" ? "html" : "text";
            pageTitle = response.title || "";
            promptInput.placeholder = "Ask about this page...";
            console.log(
              "[TeaWhiz] Popup: Page content loaded, type:",
              pageContentType,
              "length:",
              pageContent.length
            );
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

// Markdown rendering function, with a hand-rolled fallback if marked throws
function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { async: false }) as string;
  } catch (error) {
    console.error("[TeaWhiz] Markdown rendering error:", error);
    return basicMarkdownToHTML(text);
  }
}

// Basic markdown to HTML converter (fallback when marked library isn't available)
function basicMarkdownToHTML(text: string): string {
  let html = text
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Headers
  html = html.replace(/^### (.*?)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*?)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*?)$/gm, "<h1>$1</h1>");

  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
  html = html.replace(/_(.*?)_/g, "<em>$1</em>");

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Lists
  html = html.replace(/^\* (.*?)$/gm, "<li>$1</li>");
  html = html.replace(/^- (.*?)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>");

  // GFM-style pipe tables, e.g.:
  //   | Question | Answer |
  //   |---|---|
  //   | Does X? | No. |
  const tableBlock =
    /^\|(.+)\|[ \t]*\n\|[ \t\-:|]+\|[ \t]*\n((?:\|.*\|[ \t]*\n?)+)/gm;
  const splitRow = (row: string) =>
    row
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
  html = html.replace(tableBlock, (_match, headerRow: string, bodyRows: string) => {
    const headerCells = splitRow(headerRow)
      .map((cell) => `<th>${cell}</th>`)
      .join("");
    const bodyHtml = bodyRows
      .trim()
      .split("\n")
      .map((row) => {
        const cells = splitRow(row)
          .map((cell) => `<td>${cell}</td>`)
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");
    return `<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyHtml}</tbody></table>\n`;
  });

  // Line breaks to paragraphs
  const paragraphs = html.split("\n\n");
  html = paragraphs
    .map((p) => {
      if (!p.match(/^<(h[1-6]|ul|ol|li|pre|blockquote|table)/)) {
        return `<p>${p}</p>`;
      }
      return p;
    })
    .join("\n");

  // Fix nested ul/ol
  html = html.replace(/<\/ul>\n<ul>/g, "\n").replace(/<\/ol>\n<ol>/g, "\n");

  return html;
}

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
  responseContainer.classList.remove("active");
  chrome.storage.local.set({ savedPrompt: "" });
  promptInput.focus();
});

// Submit on button click
submitBtn.addEventListener("click", submit);

// Live, as-you-type word correction (triggered on space-bar press) -
// mirrors what phone keyboards/search boxes do: fix the word you just
// finished typing the moment you hit space. Deliberately doesn't block or
// delay the space itself (see the keydown handler below) - only fast,
// local, non-LLM correction (query_normalizer.py on the backend) is cheap
// enough to run on every single space press.
let normalizeSeq = 0;

function requestWordCorrection(word: string): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "NORMALIZE_WORD", word }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        resolve(null); // backend unreachable, or normalization failed - leave the word as typed
        return;
      }
      resolve(response.normalized as string);
    });
  });
}

// Submit on Enter; Shift+Enter inserts a newline instead of submitting
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
    return;
  }

  if (e.key === " " && promptInput.selectionStart === promptInput.selectionEnd) {
    const cursor = promptInput.selectionStart ?? promptInput.value.length;
    const wordMatch = promptInput.value.slice(0, cursor).match(/([A-Za-z']+)$/);
    if (!wordMatch) return; // nothing word-like right before the cursor

    const word = wordMatch[1];
    const wordStart = cursor - word.length;
    const seq = ++normalizeSeq;

    // No preventDefault, no await here on purpose - the space (and anything
    // typed after it) appears immediately, exactly like normal typing. The
    // correction only ever swaps the word that's already behind the cursor
    // once it comes back; it never blocks input.
    requestWordCorrection(word).then((corrected) => {
      if (seq !== normalizeSeq) return; // a newer space press superseded this one
      if (!corrected || corrected === word) return;
      // Re-check the word is still exactly where we found it - the user may
      // have kept typing further on (fine, unaffected) or edited/deleted
      // this exact range while the request was in flight (then skip rather
      // than guess and corrupt unrelated text).
      if (promptInput.value.slice(wordStart, wordStart + word.length) !== word) return;

      promptInput.setRangeText(corrected, wordStart, wordStart + word.length, "preserve");
      // setRangeText doesn't fire an `input` event - replay the existing
      // autosize/save listener manually so it stays in sync.
      promptInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
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

  // Clear the input now that the question has been posted as a message,
  // so the user isn't left staring at their already-asked question.
  promptInput.value = "";
  promptInput.style.height = "auto";
  chrome.storage.local.set({ savedPrompt: "" });
  promptInput.focus();

  submitBtn.disabled = true;
  submitBtn.textContent = "...";

  // Show loading animation
  showLoading();

  console.log("[TeaWhiz] Popup: Sending GET_ANSWER to background", {
    hasPageContent: !!pageContent,
    pageContentType,
    pageContentLength: pageContent.length,
    userQuestion: userQuestion,
  });

  // Page content and the question travel separately - the backend combines
  // them (after running Trafilatura extraction, if contentType is "html")
  // rather than the popup gluing raw HTML and a question into one string.
  chrome.runtime.sendMessage(
    {
      type: "GET_ANSWER",
      content: pageContent,
      contentType: pageContentType,
      title: pageTitle,
      question: userQuestion,
    },
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

  // Render markdown for assistant and error messages, plain text for user
  if (type === "assistant") {
    contentEl.innerHTML = renderMarkdown(text);
  } else {
    contentEl.textContent = text;
  }

  messageEl.appendChild(contentEl);
  messagesContainer.appendChild(messageEl);
  expandResponseArea();

  // Scroll to bottom
  setTimeout(() => {
    responseContainer.scrollTop = responseContainer.scrollHeight;
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
  expandResponseArea();

  loadingMessageEl = messageEl;
  currentLoadingIndex = 0;

  loadingInterval = setInterval(() => {
    const word = loadingWords[currentLoadingIndex % loadingWords.length];
    if (textEl) {
      textEl.textContent = `Tea is ${word}...`;
    }
    currentLoadingIndex++;
  }, 600);

  // Scroll to bottom
  responseContainer.scrollTop = responseContainer.scrollHeight;
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

      expandResponseArea();

      // Get or create response message - use a stable ID
      let responseEl = document.getElementById("responseContent") as HTMLElement | null;
      if (!responseEl) {
        console.log("[TeaWhiz] Popup: Creating new response message element");
        const messageEl = document.createElement("div");
        messageEl.className = "message assistant";
        const contentEl = document.createElement("div");
        contentEl.className = "message-content";
        contentEl.id = "responseContent";
        contentEl.setAttribute("data-raw-text", "");
        messageEl.appendChild(contentEl);
        messagesContainer.appendChild(messageEl);
        responseEl = contentEl;
      }

      // Get accumulated text and add new chunk
      let fullText = responseEl.getAttribute("data-raw-text") || "";
      fullText += request.text;
      console.log("[TeaWhiz] Popup: Accumulated text length:", fullText.length);

      // Store raw text and render markdown
      responseEl.setAttribute("data-raw-text", fullText);
      responseEl.innerHTML = renderMarkdown(fullText);
      console.log("[TeaWhiz] Popup: Rendered markdown, preview:", fullText.substring(0, 50));

      responseContainer.scrollTop = responseContainer.scrollHeight;
    };

    // Display chunks immediately (no delay)
    displayChunk();
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
