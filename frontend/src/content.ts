const MAX_CONTENT_LENGTH = 8000;

// Markdown-preserving text cleaning
// Only collapses spaces/tabs, preserves newlines and markdown syntax (|, **, etc.)
function cleanText(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")        // Collapse multiple spaces/tabs only
    .replace(/\n[ \t]+/g, "\n")     // Remove leading spaces on lines
    .replace(/[ \t]+\n/g, "\n")     // Remove trailing spaces on lines
    .replace(/\n{3,}/g, "\n\n")     // Normalize multiple newlines to double
    .trim();
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

  // TEMP: Skip Readability to prevent page distortion, use fallback directly
  console.log("[TeaWhiz] Using fallback extraction to prevent page distortion");
  let textContent = extractFallback();

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

console.log("[TeaWhiz] Content script loaded - Readability enabled with debugging");
