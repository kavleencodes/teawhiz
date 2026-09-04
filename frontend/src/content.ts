// Content extraction is now split across two layers:
//   Browser (this content script) -> Backend (FastAPI + Trafilatura)
// This script's only job is to hand over the *already-rendered* DOM - after
// this page's own JS/React/hydration has run - as HTML. Readability-style
// article extraction happens server-side with Trafilatura instead, because
// a `requests.get` on the backend would only ever see the pre-render HTML
// shell for SPA pages (Netflix, React apps, etc). Sending the rendered DOM
// is what makes those pages work at all.
const MAX_CONTENT_LENGTH = 8000; // cap for plain-text fallbacks (Netflix titles, body-text fallback)
const MAX_HTML_LENGTH = 2_000_000; // keep in sync with backend MAX_HTML_LENGTH in main.py

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

// PROBLEM: this content script runs on `"matches": ["<all_urls>"]`
// (manifest.json) - every page the user ever asks about, including
// banking/webmail/internal tools. getRenderedHTML() below sends the
// *entire* rendered DOM to the backend -> Groq, not just visible article
// text (see "Wider data-exposure surface" in CODE.md's Known Weaknesses).
// That DOM can include password/form values, hidden/aria-hidden content,
// and <template> markup a user never intended to share - none of which a
// real browser ever shows them, but a raw-HTML parser (Trafilatura) or a
// framework that live-reflects state into attributes can still see.
// SOLUTION: strip the most obviously dangerous, invisible-to-the-user leak
// paths client-side, before the HTML ever leaves the browser. This is not
// a full fix (the pipeline still sends the entire *visible* DOM, and
// CSS-class-based hiding via an external stylesheet isn't detected here) -
// see the caveat in CODE.md - but it closes the worst, easiest-to-hit cases:
//   - form values the user typed/selected (not just the page's original
//     markup - some frameworks, e.g. React controlled inputs, re-render the
//     `value`/`selected` attribute to reflect live input)
//   - password fields, entirely
//   - elements deliberately hidden from view (`hidden`, `aria-hidden`,
//     inline `display:none`/`visibility:hidden` - the common way JS toggles
//     modals/dropdowns/tooltips)
//   - <template> markup, which is inert and never rendered in a live DOM,
//     but survives as plain text in outerHTML - an HTML parser like
//     Trafilatura reads it as ordinary content, unlike a real browser
function stripSensitiveContent(clone: Document): void {
  // Password fields: never send, regardless of value.
  clone.querySelectorAll('input[type="password"]').forEach((el) => el.remove());

  // Hidden inputs typically carry CSRF tokens / session / internal IDs -
  // purely functional, never meant to be read, so remove outright rather
  // than just clearing the value.
  clone.querySelectorAll('input[type="hidden"]').forEach((el) => el.remove());

  // Remaining form values: strip what the user typed or selected.
  clone.querySelectorAll("input, textarea").forEach((el) => {
    el.removeAttribute("value");
    if (el.tagName === "TEXTAREA") el.textContent = "";
  });
  clone.querySelectorAll("option[selected]").forEach((el) => el.removeAttribute("selected"));

  // Elements deliberately hidden from the user.
  clone.querySelectorAll('[hidden], [aria-hidden="true"]').forEach((el) => el.remove());
  clone.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style") || "";
    if (/display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)) {
      el.remove();
    }
  });

  // Inert <template> content - never rendered, but a raw-HTML parser still
  // sees the markup between the tags as plain text.
  clone.querySelectorAll("template").forEach((el) => el.remove());
}

// Grab the current, post-render DOM as HTML for the backend to run
// Trafilatura on. Strips script/style tags client-side purely to shrink the
// payload - Trafilatura ignores them anyway. Also strips sensitive/hidden
// content via stripSensitiveContent() before serializing (see above).
function getRenderedHTML(): string {
  try {
    const clone = document.cloneNode(true) as Document;
    clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
    stripSensitiveContent(clone);
    return clone.documentElement.outerHTML;
  } catch (error) {
    console.error("[TeaWhiz] Failed to capture rendered HTML:", error);
    return "";
  }
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
      // No small cap here on purpose: a homepage has many rows (Top 10, US TV
      // Shows, Japanese Movies & TV, etc.) stacked in DOM order, and an early
      // cap silently drops whole categories that render further down before
      // the user ever asks about them. Netflix content also isn't truncated
      // downstream (unlike the generic HTML/fallback paths), so the full list
      // reaches the model. Still bounded generously so a pathological page
      // (hundreds of stray aria-label elements) can't blow up the payload.
      const listContent = titles
        .slice(0, 300)
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

  if (!isNetflix) return "";

  const liveContent = extractNetflixTitles();

  if (liveContent && liveContent.trim().length > 0) {
    latestNetflixContent = liveContent;

    console.log(
      "[TeaWhiz] Extracted Netflix content live. Characters:",
      liveContent.length
    );

    console.log(
      "[TeaWhiz] LIVE NETFLIX CONTENT:",
      liveContent
    );

    return liveContent;
  }

  if (latestNetflixContent && latestNetflixContent.trim().length > 0) {
    console.log(
      "[TeaWhiz] Using cached Netflix content. Characters:",
      latestNetflixContent.length
    );

    console.log(
      "[TeaWhiz] CACHED NETFLIX CONTENT:",
      latestNetflixContent
    );

    return latestNetflixContent;
  }

  console.log("[TeaWhiz] No Netflix content available");

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

interface PageContentResult {
  title: string;
  contentType: "html" | "text";
  content: string;
}

function getPageContent(): PageContentResult {
  const title = document.title || "No title";

  console.log("[TeaWhiz] Starting content extraction pipeline...");

  // Netflix's UI isn't an "article" - a generic extractor (Trafilatura
  // included) can't make sense of it, so it keeps its own DOM-scraping path
  // and is sent to the backend as plain text, unlike everything else below.
  const netflixContent = extractNetflix();
  if (netflixContent && netflixContent.length >= 50) {
    return { title, contentType: "text", content: netflixContent };
  }

  // Hand the backend the live, already-rendered DOM. Trafilatura extracts
  // the main content server-side - this is what makes SPA/React pages work,
  // since this is the actual post-JS DOM, not a fresh unrendered fetch.
  const html = getRenderedHTML();
  if (html && html.length > 0 && html.length <= MAX_HTML_LENGTH) {
    return { title, contentType: "html", content: html };
  }

  if (html.length > MAX_HTML_LENGTH) {
    console.log(
      `[TeaWhiz] Rendered HTML too large (${html.length} chars), falling back to DOM text extraction`
    );
  }

  // Last resort: plain DOM text (huge pages, or HTML capture failed)
  const fallbackText = extractFallback().substring(0, MAX_CONTENT_LENGTH);
  return { title, contentType: "text", content: fallbackText };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === "GET_PAGE_CONTENT") {
    try {
      const pageContent = getPageContent();
      sendResponse({ success: true, ...pageContent });
    } catch (error) {
      console.error("[TeaWhiz] Message handler error:", error);
      sendResponse({ success: false, error: String(error) });
    }
  }
});

// Setup Netflix monitoring immediately
setupNetflixMonitoring();

console.log("[TeaWhiz] Content script loaded with Netflix monitoring");
