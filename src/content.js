(function () {
  const { DEFAULT_SHORTCUT, STORAGE_KEY, COMMAND_NAME, matchesShortcut } =
    globalThis.BvbShortcut;

  let activeShortcut = null;

  initShortcutListener().catch(() => {});

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[STORAGE_KEY]) {
      return;
    }

    resolveActiveShortcut(changes[STORAGE_KEY].newValue).then((shortcut) => {
      activeShortcut = shortcut;
    });
  });

  async function initShortcutListener() {
    const stored = await chrome.storage.sync.get({
      [STORAGE_KEY]: DEFAULT_SHORTCUT
    });
    activeShortcut = await resolveActiveShortcut(stored[STORAGE_KEY]);

    window.addEventListener(
      "keydown",
      (event) => {
        if (!activeShortcut || !matchesShortcut(event, activeShortcut)) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        chrome.runtime.sendMessage({
          target: "background",
          type: "TOGGLE_BOOST"
        });
      },
      true
    );
  }

  async function resolveActiveShortcut(storedShortcut) {
    const shortcut = storedShortcut || DEFAULT_SHORTCUT;

    if (!shortcut) {
      return null;
    }

    if (!chrome.commands?.getAll) {
      return shortcut === DEFAULT_SHORTCUT ? null : shortcut;
    }

    const commands = await chrome.commands.getAll();
    const command = commands.find((item) => item.name === COMMAND_NAME);
    const manifestShortcut = command?.shortcut || DEFAULT_SHORTCUT;

    if (shortcut === manifestShortcut) {
      return null;
    }

    return shortcut;
  }
})();
