// Content script - extracts webpage information

function getPageContent(): string {
  // Get page title
  const title = document.title || "No title";

  // Get main content (body text, headings, paragraphs)
  const textContent = document.body.innerText || "";

  // Limit to first 3000 characters to avoid token limits
  const limitedContent = textContent.substring(0, 3000);

  return `Page Title: ${title}\n\nContent:\n${limitedContent}`;
}

// Send page content when popup requests it
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_PAGE_CONTENT") {
    const pageContent = getPageContent();
    sendResponse({ success: true, content: pageContent });
  }
});

console.log("TeaWhiz AI content script loaded");
