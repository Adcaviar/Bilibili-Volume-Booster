(function () {
  const EVENT_KEY_TO_COMMAND = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ",": "Comma",
    ".": "Period",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Delete: "Delete"
  };

  function supportsShortcutRecording() {
    if (typeof chrome?.commands?.update === "function") {
      return true;
    }

    const manifest = chrome?.runtime?.getManifest?.();

    return Boolean(
      manifest?.content_scripts?.some((entry) =>
        entry.js?.some((file) => file.includes("content.js"))
      )
    );
  }

  const DEFAULT_SHORTCUT = "Alt+Shift+U";

  function formatShortcutLabel(shortcut) {
    if (!shortcut) {
      return "未设置";
    }

    return shortcut.replaceAll("+", " + ");
  }

  function normalizeEventKey(key) {
    if (!key) {
      return "";
    }

    if (EVENT_KEY_TO_COMMAND[key]) {
      return EVENT_KEY_TO_COMMAND[key];
    }

    if (key.length === 1) {
      return key.toUpperCase();
    }

    if (/^f\d{1,2}$/i.test(key)) {
      return key.toUpperCase();
    }

    return key;
  }

  function eventToShortcutString(event) {
    if (!event || event.isComposing) {
      return null;
    }

    const normalizedKey = normalizeEventKey(event.key);

    if (!normalizedKey || ["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
      return null;
    }

    const parts = [];

    if (event.ctrlKey) {
      parts.push("Ctrl");
    }

    if (event.altKey) {
      parts.push("Alt");
    }

    if (event.shiftKey) {
      parts.push("Shift");
    }

    parts.push(normalizedKey);
    return parts.join("+");
  }

  function parseShortcut(shortcut) {
    if (!shortcut) {
      return null;
    }

    const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);

    if (parts.length === 0) {
      return null;
    }

    const key = parts[parts.length - 1];
    const modifiers = parts.slice(0, -1);

    return {
      ctrl: modifiers.some((part) => part === "Ctrl" || part === "MacCtrl"),
      alt: modifiers.some((part) => part === "Alt" || part === "Option"),
      shift: modifiers.includes("Shift"),
      meta: modifiers.includes("Command"),
      key: key.length === 1 ? key.toUpperCase() : key
    };
  }

  function matchesShortcut(event, shortcut) {
    const parsed = parseShortcut(shortcut);

    if (!parsed) {
      return false;
    }

    const eventKey = normalizeEventKey(event.key);
    const parsedKey = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key;

    if (eventKey !== parsedKey) {
      return false;
    }

    const ctrlOrMeta = event.ctrlKey || event.metaKey;

    if (parsed.ctrl || parsed.meta) {
      if (!ctrlOrMeta) {
        return false;
      }
    } else if (ctrlOrMeta) {
      return false;
    }

    if (Boolean(parsed.alt) !== Boolean(event.altKey)) {
      return false;
    }

    if (Boolean(parsed.shift) !== Boolean(event.shiftKey)) {
      return false;
    }

    return true;
  }

  function normalizeShortcut(shortcut) {
    if (!shortcut) {
      return "";
    }

    return shortcut
      .split("+")
      .map((part) => {
        const trimmed = part.trim();
        return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
      })
      .join("+");
  }

  function isValidShortcut(shortcut) {
    if (!shortcut) {
      return false;
    }

    const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);

    if (parts.length < 2) {
      return false;
    }

    const modifiers = parts.slice(0, -1);
    const hasCtrl = modifiers.some((part) =>
      ["Ctrl", "MacCtrl", "Command"].includes(part)
    );
    const hasAlt = modifiers.some((part) => ["Alt", "Option"].includes(part));

    if (!hasCtrl && !hasAlt) {
      return false;
    }

    if (modifiers.includes("Ctrl") && modifiers.includes("Alt")) {
      return false;
    }

    if (modifiers.includes("Ctrl") && modifiers.includes("Option")) {
      return false;
    }

    return true;
  }

  globalThis.BvbShortcut = {
    DEFAULT_SHORTCUT,
    STORAGE_KEY: "customShortcut",
    COMMAND_NAME: "toggle-boost",
    normalizeShortcut,
    supportsShortcutRecording,
    formatShortcutLabel,
    eventToShortcutString,
    matchesShortcut,
    isValidShortcut
  };
})();
