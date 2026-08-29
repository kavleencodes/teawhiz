import { Readability } from "@mozilla/readability";

const MAX_CONTENT_LENGTH = 8000;

// Netflix content caching
let latestNetflixContent = "";
let extractionTimer: ReturnType<typeof setTimeout> | null = null;

// Gentle whitespace normalization - preserves markdown & structure
function cleanText(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")        // Collapse multiple spaces/tabs only
    .replace(/\n[ \t]+/g, "\n")     // Remove leading spaces on lines
    .replace(/[ \t]+\n/g, "\n")     // Remove trailing spaces on lines
    .replace(/\n{3,}/g, "\n\n")     // Normalize multiple newlines to double
    .trim();
}

// Use Readability to extract main content (like Defuddle)
function extractReadability(): string {
  try {
    // Clone document for Readability (it modifies the DOM)
    const documentClone = document.cloneNode(true) as Document;
    const reader = new Readability(documentClone);
    const article = reader.parse();

    if (article?.content) {
      // Extract text from HTML, converting structure to markdown-like format
      const htmlContent = article.content;

      // Convert HTML to text while preserving some structure
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = htmlContent;

      // Extract text with preserved line breaks from block elements
      const text = extractTextFromHTML(tempDiv);
      console.log("[TeaWhiz] Readability extraction succeeded, length:", text.length);
      return cleanText(text);
    }
  } catch (error) {
    console.error("[TeaWhiz] Readability extraction error:", error);
  }
  return "";
}

// Extract text from HTML while preserving structure (headings, lists, tables, paragraphs)
function extractTextFromHTML(element: HTMLElement): string {
  const lines: string[] = [];

  function traverse(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        lines.push(text);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();

      // Add line breaks for block elements
      if (["p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr"].includes(tag)) {
        lines.push("\n");
      }

      // Handle table structure
      if (tag === "table") {
        lines.push("\n");
      }

      for (const child of node.childNodes) {
        traverse(child);
      }

      if (["p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "table"].includes(tag)) {
        lines.push("\n");
      }
    }
  }

  traverse(element);
  return lines.join("").replace(/\n{2,}/g, "\n");
}

// Extract Netflix titles from DOM
function extractNetflixTitles(): string {
  try {
    const titles: string[] = [];

    // Look for aria-label attributes on Netflix elements
    const allWithAriaLabel = document.querySelectorAll('[aria-label]');

    for (const el of allWithAriaLabel) {
      const ariaLabel = el.getAttribute("aria-label") || "";

      // Filter out UI text
      const uiWords = ["See more", "Play", "Browse", "Next", "Previous", "More", "menu", "Menu", "Settings", "Search"];
      const isLikelyTitle = !ariaLabel.includes("http") &&
                           !uiWords.some(word => ariaLabel.includes(word)) &&
                           ariaLabel.length > 2 &&
                           ariaLabel.length < 150;

      if (isLikelyTitle) {
        const titleOnly = ariaLabel.split(" - ")[0].trim();

        if (!titles.includes(titleOnly) && titleOnly.length > 2) {
          titles.push(titleOnly);
        }
      }
    }

    if (titles.length > 0) {
      const listContent = titles
        .slice(0, 25)
        .map((title) => `- **${title}**`)
        .join("\n");

      return `## 🎬 Netflix Content\n\n${listContent}`;
    }

    return "";
  } catch (error) {
    console.error("[TeaWhiz] Netflix extraction error:", error);
    return "";
  }
}

// Update cached Netflix content (debounced)
function scheduleNetflixExtraction() {
  if (extractionTimer) {
    clearTimeout(extractionTimer);
  }

  extractionTimer = setTimeout(() => {
    const content = extractNetflixTitles();

    if (content && content !== latestNetflixContent) {
      latestNetflixContent = content;
      console.log("[TeaWhiz] Netflix content updated. Found titles:", content.split("\n").length - 2);
    }
  }, 1000); // Debounce for 1 second to wait for DOM to settle
}

// Netflix-specific extraction (returns cached content)
function extractNetflix(): string {
  const isNetflix = document.location.hostname.includes("netflix");

  if (!isNetflix) {
    console.log("[TeaWhiz] Not on Netflix");
    return "";
  }

  // Return cached content if available
  if (latestNetflixContent) {
    console.log("[TeaWhiz] Using cached Netflix content");
    return latestNetflixContent;
  }

  console.log("[TeaWhiz] No cached Netflix content yet");
  return "";
}

// Setup Netflix content monitoring (MutationObserver)
function setupNetflixMonitoring() {
  const isNetflix = document.location.hostname.includes("netflix");

  if (!isNetflix) {
    return;
  }

  console.log("[TeaWhiz] Setting up Netflix content monitoring...");

  // Initial extraction after page load
  window.addEventListener("load", () => {
    console.log("[TeaWhiz] Page load detected, scheduling extraction...");
    setTimeout(() => {
      scheduleNetflixExtraction();
    }, 2000); // Wait 2 seconds for Netflix to render content
  });

  // Watch for dynamic content changes
  const observer = new MutationObserver(() => {
    console.log("[TeaWhiz] DOM mutation detected on Netflix");
    scheduleNetflixExtraction();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log("[TeaWhiz] Netflix monitoring active");
}

function extractFallback(): string {
  try {
    const contentSelectors = [
      "article",
      "main",
      "[role='main']",
      ".main-content",
      ".article-content",
      ".post-content",
      ".entry-content",
    ];

    for (const selector of contentSelectors) {
      const element = document.querySelector(selector) as HTMLElement | null;
      if (element) {
        const text = element.innerText || element.textContent || "";
        if (text.length > 100) {
          console.log(`[TeaWhiz] Found content in selector: ${selector}`);
          return cleanText(text);
        }
      }
    }

    // Last resort: body text
    const bodyText = document.body.innerText || "";
    console.log("[TeaWhiz] Using body text, length:", bodyText.length);
    return cleanText(bodyText);
  } catch (error) {
    console.error("[TeaWhiz] Fallback extraction error:", error);
    return "";
  }
}

function getPageContent(): string {
  const title = document.title || "No title";

  let textContent = "";

  // Try Netflix extraction first (if on Netflix)
  console.log("[TeaWhiz] Starting content extraction pipeline...");
  textContent = extractNetflix();

  // If Netflix extraction fails/empty, try Readability
  if (!textContent || textContent.length < 50) {
    console.log("[TeaWhiz] Netflix extraction empty, trying Readability...");
    textContent = extractReadability();
  }

  // If Readability fails or returns empty, use DOM fallback
  if (!textContent || textContent.length < 100) {
    console.log("[TeaWhiz] Readability failed or too short, using DOM fallback");
    textContent = extractFallback();
  }

  const limitedContent = textContent.substring(0, MAX_CONTENT_LENGTH);

  if (textContent.length > MAX_CONTENT_LENGTH) {
    console.log(
      `[TeaWhiz] Content truncated from ${textContent.length} to ${MAX_CONTENT_LENGTH} chars`
    );
  }

  return `Page Title: ${title}\n\nContent:\n${limitedContent}`;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_PAGE_CONTENT") {
    try {
      const pageContent = getPageContent();
      sendResponse({ success: true, content: pageContent });
    } catch (error) {
      console.error("[TeaWhiz] Message handler error:", error);
      sendResponse({ success: false, error: String(error) });
    }
  }
});

// Setup Netflix monitoring immediately
setupNetflixMonitoring();

console.log("[TeaWhiz] Content script loaded with Netflix monitoring");
