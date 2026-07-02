(function () {
  const { DEFAULT_SHORTCUT, STORAGE_KEY, matchesShortcut } =
    globalThis.BvbShortcut;

  let activeShortcut = DEFAULT_SHORTCUT;

  initShortcutListener().catch(() => {});

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[STORAGE_KEY]) {
      return;
    }

    activeShortcut = changes[STORAGE_KEY].newValue || DEFAULT_SHORTCUT;
  });

  async function initShortcutListener() {
    const stored = await chrome.storage.sync.get({
      [STORAGE_KEY]: DEFAULT_SHORTCUT
    });
    activeShortcut = stored[STORAGE_KEY] || DEFAULT_SHORTCUT;

    window.addEventListener(
      "keydown",
      (event) => {
        if (event.repeat || !document.hasFocus()) {
          return;
        }

        if (!activeShortcut || !matchesShortcut(event, activeShortcut)) {
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        chrome.runtime.sendMessage({
          target: "background",
          type: "TOGGLE_BOOST",
          source: "content"
        });
      },
      true
    );
  }
})();
