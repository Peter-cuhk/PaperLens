function relayPairingToken(event) {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.type !== "paperlens:extension-pair" || typeof event.data.token !== "string") return;
  void chrome.runtime.sendMessage({ type: "paperlens:pair", token: event.data.token });
}

window.addEventListener("message", relayPairingToken);
window.postMessage({ type: "paperlens:extension-ready" }, location.origin);
