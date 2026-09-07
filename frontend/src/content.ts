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
    // YouTube-specific: extract video titles from ytd- elements
    const isYouTube = window.location.hostname.includes("youtube.com");
    if (isYouTube) {
      const titles: string[] = [];
      const videoElements = document.querySelectorAll(
        'ytd-video-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer'
      );
      for (const el of videoElements) {
        // Look for video title elements (they contain the text we want)
        const titleEl = el.querySelector('a#video-title-link, span[title]');
        if (titleEl) {
          const title = titleEl.textContent || titleEl.getAttribute("title") || "";
          if (title.length > 2 && !titles.includes(title)) {
            titles.push(title);
          }
        }
      }
      if (titles.length > 3) {
        const listContent = titles
          .slice(0, 50)
          .map((title) => `- ${title.trim()}`)
          .join("\n");
        console.log(`[TeaWhiz] Extracted ${titles.length} YouTube video titles`);
        return `YouTube Videos:\n\n${listContent}`;
      }
    }

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

  if (html && html.length > MAX_HTML_LENGTH) {
    console.log(
      `[TeaWhiz] Rendered HTML too large (${html.length} chars), falling back to DOM text extraction`
    );
  } else if (!html) {
    console.log("[TeaWhiz] Rendered HTML capture returned empty, falling back to DOM text extraction");
  }

  // Last resort: plain DOM text (huge pages, or HTML capture failed)
  const fallbackText = extractFallback().substring(0, MAX_CONTENT_LENGTH);
  return { title, contentType: "text", content: fallbackText };
}

// Capture page content on load and send to background for extraction.
// Fire-and-forget: background does the async fetch + storage write, no
// response is required. Using a callback here only produced a cosmetic
// "message port closed" warning on pages whose context dies before the
// background finishes (YouTube SPAs, fast navigations).
async function capturePageOnLoad() {
  try {
    const pageContent = getPageContent();
    console.log("[TeaWhiz] Content: Captured page on load, type:", pageContent.contentType, "length:", pageContent.content.length);

    try {
      chrome.runtime.sendMessage({
        type: "CAPTURE_PAGE",
        content: pageContent.content,
        contentType: pageContent.contentType,
        title: pageContent.title,
        url: window.location.href,
      });
    } catch (sendError) {
      // Service worker may have just been torn down between page load and
      // this call. Logged, not fatal - the popup will fall back to asking
      // the content script directly via GET_PAGE_CONTENT if storage is empty.
      console.log("[TeaWhiz] Content: sendMessage threw (worker reloading?):", String(sendError));
    }
  } catch (error) {
    console.error("[TeaWhiz] Content: Failed to capture page on load:", error);
  }
}

// Heuristic: does the current page have "real" content yet, or is it still
// the pre-hydration skeleton? YouTube's Polymer web components render
// their actual content (video titles, descriptions, channel names) into
// the DOM only after JS runs - the initial HTML is just <ytd-app>... with
// empty <ytd-rich-grid-renderer> etc. We consider a page "hydrated" when
// it has enough visible text to be useful for an LLM. This is a rough
// signal (counts text in main + body) but it's good enough to skip the
// pre-hydration snapshot without having to know about every site's
// custom-element internals.
//
// Site-specific overrides: YouTube's pre-hydration header + sidebar text
// already exceeds 500 chars, so the generic threshold would fire on the
// skeleton. For YouTube, we require *actual video links* (the thing the
// user is asking about) before declaring the page hydrated. Other
// Polymer-heavy sites get a much higher generic threshold.
function pageHasMeaningfulContent(): boolean {
  const isYouTube = window.location.hostname.includes("youtube.com");

  if (isYouTube) {
    // The thing we want the LLM to see is the list of videos. YouTube uses
    // custom elements (ytd-video-renderer, ytd-rich-item-renderer) to wrap
    // videos, so check for those. Also look for title elements inside them
    // (which contain the video name the LLM needs to see).
    const videoElements = document.querySelectorAll(
      'ytd-video-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer'
    );
    if (videoElements.length >= 3) {
      // Also verify at least one has a title (not just empty containers)
      for (const el of videoElements) {
        const titleEl = el.querySelector('a#video-title-link, [id*="video-title"], h3 a, span[title]');
        if (titleEl) return true;
      }
    }

    // Fallback: look for watch links as before
    const watchLinks = document.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]');
    if (watchLinks.length >= 3) return true;
    // On a single watch page there may be 0-2 links (related sidebar
    // hasn't loaded yet). Fall back to: did the title and channel render?
    // <h1> with non-trivial text + an #owner / ytd-video-owner-renderer
    // are the canonical "watch page is ready" signals.
    const h1 = document.querySelector("h1");
    const owner = document.querySelector("ytd-video-owner-renderer, #owner");
    if (h1 && h1.textContent && h1.textContent.trim().length > 5 && owner) {
      return true;
    }
    return false;
  }

  // Generic site: 5000 chars of visible text in main/article/body.
  // Lower thresholds (e.g. 500) trip on nav/header chrome alone, which
  // for some sites is fully pre-hydration content. 5K is enough to know
  // the page has its main body rendered without being so high it
  // excludes short articles.
  const containers = [
    document.querySelector("main"),
    document.querySelector("article"),
    document.body,
  ].filter((el): el is HTMLElement => !!el);

  let total = 0;
  for (const el of containers) {
    // textContent on the element includes its descendants - exactly what
    // we want. innerText would force layout, which is expensive.
    total += (el.textContent || "").length;
    if (total > 5000) return true;
  }
  return false;
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

// Capture page on load (after a short delay to let the page render).
// Listen for both `load` (full page load) and `pageshow` (catches bfcache
// restoration - back/forward navigation on SPA-heavy pages where the
// content script is restored from cache and would otherwise miss the
// re-capture window).
let initialCaptureDone = false;
function scheduleCapture(delayMs: number, force: boolean) {
  setTimeout(() => {
    if (force || !initialCaptureDone) {
      initialCaptureDone = true;
      void capturePageOnLoad();
    }
  }, delayMs);
}

window.addEventListener("load", () => {
  const isYouTube = window.location.hostname.includes("youtube.com");

  // YouTube's 1.5s snapshot almost always catches the pre-hydration
  // skeleton (no video links in the DOM yet), so on YouTube we *skip*
  // the initial capture entirely and rely on the hydration-aware
  // observer below. Other sites keep the standard 1.5s initial
  // capture for snappier first-question latency.
  if (!isYouTube) {
    console.log("[TeaWhiz] Content: Page loaded, scheduling capture...");
    scheduleCapture(1500, false);
  } else {
    console.log("[TeaWhiz] Content: YouTube detected, skipping initial 1.5s capture (skeleton-prone), using hydration observer");
  }

  // Slow-hydrating pages (YouTube home/watch, Polymer/SPA apps):
  // wait for actual rendered content, capped at 8s, with a
  // MutationObserver as a "content appeared" trigger. Replaces a fixed
  // 3.5s delay that was both too late for some pages and too early
  // for others.
  if (isYouTube) {
    scheduleHydrationAwareCapture(8000);
  }
});

// Watch the DOM for content arriving after the initial 1.5s snapshot, then
// re-capture as soon as the page actually has visible text. Caps at
// `timeoutMs` so a page that never hydrates doesn't keep the observer
// alive forever.
let hydrationObserver: MutationObserver | null = null;
let hydrationTimeoutId: ReturnType<typeof setTimeout> | null = null;
let hydrationCaptureDone = false;

function scheduleHydrationAwareCapture(timeoutMs: number) {
  if (hydrationCaptureDone) return;

  // If content is already there by the time we run, capture immediately.
  if (pageHasMeaningfulContent()) {
    hydrationCaptureDone = true;
    void capturePageOnLoad();
    return;
  }

  // Otherwise, watch for DOM mutations and re-check the heuristic.
  hydrationObserver = new MutationObserver(() => {
    if (hydrationCaptureDone) return;
    if (pageHasMeaningfulContent()) {
      hydrationCaptureDone = true;
      if (hydrationObserver) {
        hydrationObserver.disconnect();
        hydrationObserver = null;
      }
      if (hydrationTimeoutId) {
        clearTimeout(hydrationTimeoutId);
        hydrationTimeoutId = null;
      }
      void capturePageOnLoad();
    }
  });

  hydrationObserver.observe(document.body, { childList: true, subtree: true });

  // Hard timeout - if the page never hydrates within `timeoutMs`, capture
  // whatever we have (the pre-hydration skeleton) so the user at least
  // gets *something* rather than a permanently-stale storage entry.
  hydrationTimeoutId = setTimeout(() => {
    if (hydrationCaptureDone) return;
    hydrationCaptureDone = true;
    if (hydrationObserver) {
      hydrationObserver.disconnect();
      hydrationObserver = null;
    }
    console.log(`[TeaWhiz] Content: Hydration timeout (${timeoutMs}ms) reached, capturing current state`);
    void capturePageOnLoad();
  }, timeoutMs);
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    // bfcache restore - re-capture because the DOM may have changed
    // since the original capture, and storage may be stale.
    console.log("[TeaWhiz] Content: Page restored from bfcache, re-capturing...");
    scheduleCapture(500, true);
  }
});

// YouTube SPA navigation: when the user clicks from the home grid to a
// watch page (or back), the content script survives but the page content
// has changed. Hook pushState/replaceState/popstate to re-arm the
// hydration observer so the new page's content gets captured too.
if (window.location.hostname.includes("youtube.com")) {
  const rearmOnYouTubeNav = () => {
    hydrationCaptureDone = false;
    if (hydrationObserver) {
      hydrationObserver.disconnect();
      hydrationObserver = null;
    }
    if (hydrationTimeoutId) {
      clearTimeout(hydrationTimeoutId);
      hydrationTimeoutId = null;
    }
    scheduleHydrationAwareCapture(8000);
  };
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);
  history.pushState = (...args) => {
    const result = origPushState(...args);
    rearmOnYouTubeNav();
    return result;
  };
  history.replaceState = (...args) => {
    const result = origReplaceState(...args);
    rearmOnYouTubeNav();
    return result;
  };
  window.addEventListener("popstate", rearmOnYouTubeNav);
}

// Setup Netflix monitoring
setupNetflixMonitoring();

console.log("[TeaWhiz] Content script loaded with page capture on load");
