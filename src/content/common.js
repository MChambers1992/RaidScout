// Function to send a message to the background script
function sendMessageToBackground(action, data = {}) {
    chrome.runtime.sendMessage({ action, ...data });
  }