// Simple popup script

const promptInput = document.getElementById("prompt") as HTMLTextAreaElement;
const submitBtn = document.getElementById("submit") as HTMLButtonElement;
const responseDiv = document.getElementById("response") as HTMLDivElement;
const errorDiv = document.getElementById("error") as HTMLDivElement;

// Load saved prompt
chrome.storage.local.get("savedPrompt", (result: any) => {
  if (result.savedPrompt) {
    promptInput.value = result.savedPrompt;
  }
});

// Auto-expand textarea and save
promptInput.addEventListener("input", () => {
  // Auto-expand
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(promptInput.scrollHeight, 100) + "px";

  // Save
  chrome.storage.local.set({ savedPrompt: promptInput.value });
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
  const prompt = promptInput.value.trim();

  if (!prompt) {
    showError("Please enter a prompt");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Loading...";
  responseDiv.classList.add("hidden");
  errorDiv.classList.add("hidden");

  chrome.runtime.sendMessage(
    { type: "GET_ANSWER", text: prompt },
    (response) => {
      submitBtn.disabled = false;
      submitBtn.textContent = "Ask";

      if (response?.success) {
        showResponse(response.answer);
      } else {
        showError(response?.error || "Failed to get response");
      }
    }
  );
}

function showResponse(answer: string) {
  responseDiv.textContent = answer;
  responseDiv.classList.remove("hidden");
  errorDiv.classList.add("hidden");
}

function showError(error: string) {
  errorDiv.textContent = error;
  errorDiv.classList.remove("hidden");
  responseDiv.classList.add("hidden");
}

promptInput.focus();
console.log("TeaWhiz AI popup loaded");
