function isWarcraftLogsPage() {
  return window.location.hostname === "www.warcraftlogs.com";
}

function getMedianPerfAvg() {
  const selector = "#top-box > div:nth-child(2) > div:nth-child(2) > table > tbody > tr:nth-child(1) > td:nth-child(2)";
  const element = document.querySelector(selector);
  return element ? parseFloat(element.textContent.replace(/[^\d.]/g, "")) : null;
}

function getBestPerfAvg() {
  const selector = "#top-box > div.stats > div.best-perf-avg > b";
  const element = document.querySelector(selector);
  return element ? parseFloat(element.textContent.replace(/[^\d.]/g, "")) : null;
}

let checkInterval = null;

function checkAndCloseWarcraftLogsTab() {
  const medianPerfAvg = getMedianPerfAvg();
  const bestPerfAvg = getBestPerfAvg();

  if (medianPerfAvg === null && bestPerfAvg === null) {
    return;
  }

  chrome.storage.sync.get(["parseThreshold", "bestParseThreshold"], function(options) {
    const parseThreshold = options.parseThreshold || 0;
    const bestParseThreshold = options.bestParseThreshold || 0;

    const belowThreshold =
      (medianPerfAvg !== null && medianPerfAvg < parseThreshold) ||
      (bestPerfAvg !== null && bestPerfAvg < bestParseThreshold);

    // Stop polling once a decision can be made — values are present
    clearInterval(checkInterval);

    if (belowThreshold) {
      sendMessageToBackground('parseThresholdFailed', { warcraftLogsUrl: window.location.href });
    }
  });
}

function waitForPageLoad() {
  if (document.readyState === "complete") {
    checkInterval = setInterval(checkAndCloseWarcraftLogsTab, 1000);
  } else {
    window.addEventListener("load", () => {
      checkInterval = setInterval(checkAndCloseWarcraftLogsTab, 1000);
    });
  }
}

if (isWarcraftLogsPage()) {
  waitForPageLoad();
}
