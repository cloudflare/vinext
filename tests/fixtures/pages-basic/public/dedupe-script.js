if (document.currentScript?.src.includes("before=")) {
  window.__vinextBeforeScriptExecutions = (window.__vinextBeforeScriptExecutions || 0) + 1;
} else {
  window.__vinextScriptDedupeExecutions = (window.__vinextScriptDedupeExecutions || 0) + 1;
}
