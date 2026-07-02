(function () {
  if (globalThis.__BVB_CONTENT_LOADED__) {
    return;
  }

  globalThis.__BVB_CONTENT_LOADED__ = true;

  const { DEFAULT_SHORTCUT, STORAGE_KEY, matchesShortcut } =
    globalThis.BvbShortcut;

  let activeShortcut = DEFAULT_SHORTCUT;
  let useCommandShortcut = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "BVB_PING") {
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "BVB_SHORTCUT_MODE") {
      useCommandShortcut = message.shortcutViaCommand === true;
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  initShortcutListener().catch(() => {});

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.shortcutViaCommand) {
      useCommandShortcut = changes.shortcutViaCommand.newValue === true;
      return;
    }

    if (areaName !== "sync" || !changes[STORAGE_KEY]) {
      return;
    }

    activeShortcut = changes[STORAGE_KEY].newValue || DEFAULT_SHORTCUT;
  });

  async function initShortcutListener() {
    const [storedShortcut, localMode] = await Promise.all([
      chrome.storage.sync.get({ [STORAGE_KEY]: DEFAULT_SHORTCUT }),
      chrome.storage.local.get({ shortcutViaCommand: false })
    ]);

    activeShortcut = storedShortcut[STORAGE_KEY] || DEFAULT_SHORTCUT;
    useCommandShortcut = localMode.shortcutViaCommand === true;

    window.addEventListener(
      "keydown",
      (event) => {
        if (useCommandShortcut || event.repeat || !document.hasFocus()) {
          return;
        }

        if (!activeShortcut || !matchesShortcut(event, activeShortcut)) {
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        chrome.runtime.sendMessage({
          target: "background",
          type: "TOGGLE_BOOST"
        });
      },
      true
    );
  }
})();
