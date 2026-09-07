// Popup script - conversation-style messaging
import { marked } from "marked";

// GFM (tables, etc.) is on by default in marked v13+, but be explicit.
marked.setOptions({ gfm: true, breaks: true });

// Phase 1 — conversation state, persisted in chrome.storage.local so the
// conversation survives popup close/reopen while staying scoped to the page
// it was started on. The frontend owns this (the backend is still stateless
// — it just receives `history` + `system_context` per request).
interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface ConversationState {
  conversationId: string;
  messages: Message[];
  pageId: string;       // fingerprint of current page (URL + title) — drives restore-vs-reset
  pageContext: string;  // page-context block the backend sees; rebuilt on every submit in Phase 1
  pageTitle: string;
}

const CONVERSATION_KEY = "conversation_state";
const CONVERSATION_SCHEMA_VERSION = 1; // bump if ConversationState shape changes incompatibly

interface StoredConversation {
  schemaVersion: number;
  state: ConversationState;
}

function fingerprintPageId(url: string, title: string): string {
  // Cheap, stable per-page identifier. URL alone would collide on SPA route
  // changes; title alone is too volatile (some sites rewrite it constantly).
  // Combining both gives a "this is the same article" signal without
  // pulling in a real hash of content.
  return `${url}::${title}`;
}

function newConversation(pageId: string, pageContext: string, pageTitle: string): ConversationState {
  return {
    conversationId: (crypto as any).randomUUID
      ? (crypto as any).randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    messages: [],
    pageId,
    pageContext,
    pageTitle,
  };
}

let conversationState: ConversationState | null = null;

async function loadConversation(pageId: string): Promise<ConversationState> {
  const result = await chrome.storage.local.get(CONVERSATION_KEY);
  const stored = result[CONVERSATION_KEY] as StoredConversation | undefined;

  if (stored?.schemaVersion === CONVERSATION_SCHEMA_VERSION && stored.state?.pageId === pageId) {
    // Same page as last time — restore the in-progress conversation so the
    // user sees their prior turns and the LLM gets the history next ask.
    return stored.state;
  }
  // Different page (or first ever open, or schema upgrade) — fresh conversation.
  return newConversation(pageId, "", "");
}

async function persistConversation() {
  if (!conversationState) return;
  const payload: StoredConversation = {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    state: conversationState,
  };
  await chrome.storage.local.set({ [CONVERSATION_KEY]: payload });
}

function buildSystemContext(): string {
  if (!conversationState) return "";
  const title = conversationState.pageTitle || "Untitled";
  const content = conversationState.pageContext || "";
  if (!content) return `Page Title: ${title}`;
  return `Page Title: ${title}\n\nPage Content:\n${content}`;
}

const promptInput = document.getElementById("prompt") as HTMLTextAreaElement;
const submitBtn = document.getElementById("submit") as HTMLButtonElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const messagesContainer = document.getElementById("messagesContainer") as HTMLDivElement;
const responseContainer = document.getElementById("responseContainer") as HTMLDivElement;
const convIdEl = document.getElementById("convId") as HTMLDivElement;
const convIdValueEl = document.getElementById("convIdValue") as HTMLSpanElement;

// Reflect the current conversation's ID in the corner badge. Shows the
// first 8 chars of the UUID (enough to tell conversations apart at a
// glance, without making the badge noisy) and exposes the full ID via
// the title attribute / click-to-copy handler below.
function updateConvIdBadge() {
  if (!conversationState || !convIdValueEl) return;
  const id = conversationState.conversationId;
  convIdValueEl.textContent = id.slice(0, 8);
  convIdEl.title = `Conversation ID: ${id}\nClick to copy`;
}

// Beautiful dark session-start banner shown only above the first user
// message of a brand-new conversation. The full UUID is on display (and
// selectable in one click) so the user has a clear "this is the session"
// anchor at the top of the thread.
function renderConvStartBanner() {
  if (!conversationState) return;
  const banner = document.createElement("div");
  banner.className = "conv-start";

  const label = document.createElement("div");
  label.className = "conv-start-label";
  label.textContent = "New conversation";

  const id = document.createElement("div");
  id.className = "conv-start-id";
  id.textContent = conversationState.conversationId;

  const hint = document.createElement("div");
  hint.className = "conv-start-hint";
  hint.textContent = "Click to copy";

  banner.appendChild(label);
  banner.appendChild(id);
  banner.appendChild(hint);

  banner.addEventListener("click", () => {
    if (!conversationState) return;
    void navigator.clipboard.writeText(conversationState.conversationId).catch(() => {
      /* clipboard unavailable - user can still select manually via user-select:all */
    });
    const original = hint.textContent;
    hint.textContent = "Copied!";
    setTimeout(() => { hint.textContent = original; }, 1200);
  });

  messagesContainer.appendChild(banner);
}

// Click badge to copy the full conversation UUID to the clipboard.
// Brief "Copied!" affordance via a class swap, then reverts after 1s.
convIdEl.addEventListener("click", async () => {
  if (!conversationState) return;
  try {
    await navigator.clipboard.writeText(conversationState.conversationId);
  } catch {
    // Fallback for environments without the async clipboard API.
    const ta = document.createElement("textarea");
    ta.value = conversationState.conversationId;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    document.body.removeChild(ta);
  }
  const original = convIdValueEl.textContent;
  convIdEl.classList.add("copied");
  convIdValueEl.textContent = "Copied!";
  setTimeout(() => {
    convIdEl.classList.remove("copied");
    if (conversationState) convIdValueEl.textContent = conversationState.conversationId.slice(0, 8);
    else convIdValueEl.textContent = original;
  }, 1000);
});

// Reveal the response area (it starts hidden so only the search bar shows)
// and let the popup expand underneath the search bar.
function expandResponseArea() {
  responseContainer.classList.add("active");
}

const loadingWords = ["boiling", "brewing", "teaying", "sipping", "vibing"];
let currentLoadingIndex = 0;
let loadingInterval: any = null;
let loadingMessageEl: HTMLElement | null = null;
let hasStoppedLoading = false; // Track if we've already stopped loading

// Storage key prefix for page context
const PAGE_CONTEXT_STORAGE_KEY_PREFIX = "pageContext:";

let currentPageContext: { content: string; contentType: "html" | "text"; title: string; pageContextHash: string } | null = null;
let currentPageUrl = "";

// Load page context from storage (populated by background on page load).
// Also kicks off conversation restore — both come from chrome.storage.local
// and we want them loaded before the user can submit.
async function loadPageContext() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id) return;

    currentPageUrl = tabs[0].url || "";
    const key = `${PAGE_CONTEXT_STORAGE_KEY_PREFIX}${currentPageUrl}`;

    const [pageResult] = await Promise.all([
      chrome.storage.local.get(key),
    ]);

    if (pageResult[key]) {
      currentPageContext = pageResult[key] as typeof currentPageContext;
      console.log("[TeaWhiz] Popup: Loaded page context from storage:", {
        contentType: currentPageContext?.contentType,
        length: currentPageContext?.content?.length,
        hasHash: !!currentPageContext?.pageContextHash,
      });
      promptInput.placeholder = "Ask about this page...";
    } else {
      // Fallback: request from content script if not yet in storage
      console.log("[TeaWhiz] Popup: No cached context, requesting from content script...");
      chrome.tabs.sendMessage(
        tabs[0].id,
        { type: "GET_PAGE_CONTENT" },
        (response) => {
          if (response?.success) {
            currentPageContext = {
              content: response.content,
              contentType: response.contentType === "html" ? "html" : "text",
              title: response.title || "",
              pageContextHash: "",
            };
            promptInput.placeholder = "Ask about this page...";
            console.log("[TeaWhiz] Popup: Page content loaded from content script");
            // Conversation depends on title — re-resolve now that we have it.
            void initializeConversation();
          }
        }
      );
    }

    // Initialise / restore conversation immediately if we already have the title.
    await initializeConversation();
  } catch (error) {
    console.log("[TeaWhiz] Popup: Could not load page context:", error);
  }
}

// Resolves conversation state for the current page and re-renders any prior
// turns so reopening the popup shows the user where they left off. Called
// once after page-context is known (and again from the GET_PAGE_CONTENT
// fallback if the title wasn't available synchronously).
async function initializeConversation() {
  const title = currentPageContext?.title || "";
  const pageId = fingerprintPageId(currentPageUrl, title);

  conversationState = await loadConversation(pageId);

  // Phase 1: rebuild pageContext from the cached page context blob every
  // turn in submit() — no need to seed it here. We just stash the title so
  // the clear button / re-render paths can read it without re-querying.
  conversationState.pageTitle = title;
  conversationState.pageId = pageId;

  // Re-render any previously persisted turns so the popup reflects the
  // restored conversation immediately on open.
  if (conversationState.messages.length > 0) {
    messagesContainer.innerHTML = "";
    for (const msg of conversationState.messages) {
      showMessage(msg.content, msg.role, /*persist*/ false);
    }
  }

  updateConvIdBadge();
  await persistConversation();
}

loadPageContext();

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

// Clear button — start a fresh conversation on the SAME page. We drop
// every prior turn (so the LLM stops seeing them on the next ask) but
// keep the cached page context blob, so re-extraction isn't needed and
// the popup doesn't suddenly lose its "Ask about this page..." placeholder.
clearBtn.addEventListener("click", async () => {
  promptInput.value = "";
  messagesContainer.innerHTML = "";
  responseContainer.classList.remove("active");
  chrome.storage.local.set({ savedPrompt: "" });

  if (currentPageContext) {
    conversationState = newConversation(
      fingerprintPageId(currentPageUrl, currentPageContext.title),
      currentPageContext.content,
      currentPageContext.title,
    );
    updateConvIdBadge();
    await persistConversation();
  }
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

// In-flight assistant reply, accumulated as chunks arrive so we can append
// the full text to conversationState on RESPONSE_DONE (instead of trying
// to reverse-engineer it from the rendered DOM).
let currentAssistantText = "";

function submit() {
  const userQuestion = promptInput.value.trim();

  if (!userQuestion) {
    showMessage(userQuestion, "user");
    showMessage("Please type a question to ask about this page.", "error");
    return;
  }

  if (!currentPageContext || !conversationState) {
    showMessage("Please wait - page content not yet loaded.", "error");
    return;
  }

  console.log("[TeaWhiz] Popup: Submit button clicked, clearing previous response");
  const oldResponse = document.getElementById("responseContent");
  if (oldResponse) {
    oldResponse.parentElement?.remove();
  }

  // Stash the latest page context + title on the conversation so the backend
  // sees a consistent systemContext on every turn in this conversation.
  conversationState.pageContext = currentPageContext.content;
  conversationState.pageTitle = currentPageContext.title;
  conversationState.pageId = fingerprintPageId(currentPageUrl, currentPageContext.title);

  showMessage(userQuestion, "user");

  promptInput.value = "";
  promptInput.style.height = "auto";
  chrome.storage.local.set({ savedPrompt: "" });
  promptInput.focus();

  submitBtn.disabled = true;
  submitBtn.textContent = "...";

  showLoading();

  // History sent to the backend = the conversation *so far*, before the
  // turn we're about to submit. (The current question is already in
  // `question`; sending it again in `history` would double-count.)
  const history = conversationState.messages
    .filter((m) => m.content !== userQuestion) // safety: user message is already pushed via showMessage
    .map((m) => ({ role: m.role, content: m.content }));

  const systemContext = buildSystemContext();

  console.log("[TeaWhiz] Popup: Sending GET_ANSWER to background", {
    hasPageContext: !!currentPageContext,
    contentType: currentPageContext.contentType,
    contentLength: currentPageContext.content.length,
    userQuestion: userQuestion,
    pageContextHash: currentPageContext.pageContextHash,
    conversationId: conversationState.conversationId,
    historyLength: history.length,
    systemContextLength: systemContext.length,
  });

  currentAssistantText = "";

  // Fire-and-forget: the response itself arrives as RESPONSE_CHUNK /
  // RESPONSE_DONE messages on the onMessage listener below, NOT as the
  // callback to sendMessage. Passing a callback (and returning true from
  // background) just produces the "channel closed before response" warning.
  chrome.runtime.sendMessage({
    type: "GET_ANSWER",
    content: currentPageContext.content,
    contentType: currentPageContext.contentType,
    title: currentPageContext.title,
    question: userQuestion,
    pageContextHash: currentPageContext.pageContextHash,
    conversationId: conversationState.conversationId,
    history,
    systemContext,
  });
}

function showMessage(text: string, type: "user" | "assistant" | "error", persist: boolean = true) {
  // If this is the very first user turn of a brand-new conversation, drop a
  // dark "session start" banner above the message. The banner lives only in
  // the DOM (not in conversationState.messages), so reopening the popup
  // won't re-show it - we only render when the container is currently empty
  // AND it's a user message (loading/assistant/error shouldn't trigger it).
  if (type === "user" && messagesContainer.children.length === 0) {
    renderConvStartBanner();
  }

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

  // Persist user/assistant turns to conversation state so the popup can be
  // closed/reopened and pick back up. Errors stay in-memory only — they
  // aren't part of the conversation the LLM should see on the next ask.
  if (persist && conversationState && (type === "user" || type === "assistant")) {
    conversationState.messages.push({
      role: type,
      content: text,
      timestamp: Date.now(),
    });
    void persistConversation();
  }

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
      // Mirror the rendered text into the module-level accumulator so
      // RESPONSE_DONE can persist it to conversation history (we don't
      // parse it back out of the DOM).
      currentAssistantText = fullText;
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

    // Persist the just-completed assistant turn so the next ask's history
    // includes it. showMessage() with persist=true also pushes a copy, so
    // we append only if the rendered DOM exists and the accumulator has
    // something fresh — guards against double-pushing on re-emits.
    if (conversationState && currentAssistantText) {
      const alreadyPersisted = conversationState.messages.some(
        (m) => m.role === "assistant" && m.content === currentAssistantText
      );
      if (!alreadyPersisted) {
        conversationState.messages.push({
          role: "assistant",
          content: currentAssistantText,
          timestamp: Date.now(),
        });
        void persistConversation();
      }
    }
    currentAssistantText = "";
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
