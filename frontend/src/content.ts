

const MAX_CONTENT_LENGTH = 8000; 

function getPageContent(): string {
  // Get page title
  const title = document.title || "No title";


  const mainContent = Array.from(
    document.querySelectorAll("p, h1, h2, h3, h4, li, article, main, .content")
  )
    .map((el) => el.textContent?.trim())
    .filter((text) => text && text.length > 0)
    .join("\n");

  
  const textContent = mainContent || document.body.innerText || "";

  const limitedContent = textContent.substring(0, MAX_CONTENT_LENGTH);

  
  if (textContent.length > MAX_CONTENT_LENGTH) {
    console.warn(
      `[TeaWhiz] Page content truncated from ${textContent.length} to ${MAX_CONTENT_LENGTH} characters`
    );
  }

  return `Page Title: ${title}\n\nContent:\n${limitedContent}`;
}


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_PAGE_CONTENT") {
    const pageContent = getPageContent();
    sendResponse({ success: true, content: pageContent });
  }
});

console.log("TeaWhiz AI content script loaded");
