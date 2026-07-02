importScripts("shortcut.js");

const DEFAULT_GAIN = 2;
const MAX_GAIN = 5;
const MIN_GAIN = 0.01;
const DEFAULT_AUTO_ADAPT = false;
const OFFSCREEN_DOCUMENT_PATH = "src/offscreen.html";
const OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
const NOTIFICATION_ID = "boost-status";
const { DEFAULT_SHORTCUT, normalizeShortcut } = globalThis.BvbShortcut;
const SHORTCUT_STORAGE_KEY = globalThis.BvbShortcut.STORAGE_KEY;
const COMMAND_NAME = globalThis.BvbShortcut.COMMAND_NAME;
const SHORTCUTS_PAGE_URL = "chrome://extensions/shortcuts";
const CONTENT_SCRIPT_FILES = ["src/shortcut.js", "src/content.js"];
const BILIBILI_URL_PATTERNS = ["*://*.bilibili.com/*"];

const SHORTCUT_VIA_COMMAND_KEY = "shortcutViaCommand";

const activeTabs = new Set();
const toggleQueues = new Map();
const shortcutCoalesce = new Map();
const SHORTCUT_COALESCE_MS = 250;
let gainSaveTimer;

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    if (details.reason === "install") {
      await chrome.storage.sync.set({
        defaultGain: DEFAULT_GAIN,
        notify: true,
        autoAdapt: DEFAULT_AUTO_ADAPT,
        [SHORTCUT_STORAGE_KEY]: DEFAULT_SHORTCUT
      });
    }

    const bound = await syncShortcutHandlingMode();

    if (details.reason === "install" || details.reason === "update") {
      await ensureBilibiliContentScripts();
      await broadcastShortcutMode(bound);
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    const bound = await syncShortcutHandlingMode();
    await broadcastShortcutMode(bound);
  })();
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== COMMAND_NAME) {
    return;
  }

  // Request capture while the keyboard command's user gesture is still valid.
  const streamIdPromise = chrome.tabCapture.getMediaStreamId({});

  streamIdPromise
    .then((streamId) => toggleBoostForActiveTab(undefined, true, streamId))
    .catch(() => toggleBoostForActiveTab(undefined, true, null, true))
    .catch((error) => {
      console.error("Shortcut toggle failed:", error);
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") {
    return false;
  }

  if (message.type === "TOGGLE_BOOST") {
    const tabId = message.tabId ?? sender?.tab?.id;

    if (Number.isInteger(tabId) && activeTabs.has(tabId)) {
      toggleBoostForActiveTab(tabId, message.notify)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      return true;
    }

    const streamIdPromise = Number.isInteger(tabId)
      ? chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
      : chrome.tabCapture.getMediaStreamId({});

    streamIdPromise
      .then((streamId) => toggleBoostForActiveTab(tabId, message.notify, streamId))
      .catch(() => toggleBoostForActiveTab(tabId, message.notify, null, true))
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });

    return true;
  }

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTabs.has(tabId)) {
    stopBoost(tabId).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!activeTabs.has(tabId) || !changeInfo.url) {
    return;
  }

  if (!isBilibiliUrl(tab.url ?? changeInfo.url)) {
    stopBoost(tabId).catch(() => {});
  }
});

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") {
    throw new Error("Unknown message.");
  }

  switch (message.type) {
    case "GET_STATUS":
      return getStatus(message.tabId);
    case "START_BOOST":
      return startBoost(message.tabId, message.gain, message.notify);
    case "STOP_BOOST":
      return stopBoost(message.tabId, message.notify);
    case "SET_GAIN":
      return setGain(message.tabId, message.gain);
    case "APPLY_GAIN":
      return applyGainToAllActive(message.gain);
    case "SET_AUTO_ADAPT":
      return setAutoAdapt(message.autoAdapt);
    case "OPEN_SHORTCUTS_PAGE":
      return openShortcutsPage();
    case "SYNC_SHORTCUT_MODE":
      return syncShortcutHandlingMode().then(async (bound) => {
        await broadcastShortcutMode(bound);
        return { ok: true, bound };
      });
    default:
      throw new Error(`Unsupported message type: ${message.type}`);
  }
}

async function toggleBoostForActiveTab(tabId, notify = true, preStreamId = null, force = false) {
  let targetTabId = tabId;

  if (!Number.isInteger(targetTabId)) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tab?.id;
  }

  if (!Number.isInteger(targetTabId)) {
    throw new Error("没有找到当前标签页。");
  }

  if (!force && shouldCoalesceShortcut(targetTabId)) {
    return { ok: true };
  }

  return runToggleQueued(targetTabId, async () => {
    const tab = await getTab(targetTabId);

    if (!isBilibiliUrl(tab.url)) {
      throw new Error("请先打开哔哩哔哩网页。");
    }

    if (activeTabs.has(targetTabId)) {
      return stopBoost(targetTabId, notify);
    }

    const preferredGain = await getStoredDefaultGain();
    return startBoost(targetTabId, preferredGain, notify, preStreamId);
  });
}

function shouldCoalesceShortcut(tabId) {
  const now = Date.now();
  const last = shortcutCoalesce.get(tabId);

  if (last && now - last < SHORTCUT_COALESCE_MS) {
    return true;
  }

  shortcutCoalesce.set(tabId, now);
  return false;
}

async function syncShortcutHandlingMode() {
  const stored = await chrome.storage.sync.get({
    [SHORTCUT_STORAGE_KEY]: DEFAULT_SHORTCUT
  });
  const desired = stored[SHORTCUT_STORAGE_KEY] || DEFAULT_SHORTCUT;
  const commands = chrome.commands?.getAll ? await chrome.commands.getAll() : [];
  const command = commands.find((item) => item.name === COMMAND_NAME);
  const boundShortcut = command?.shortcut || "";
  const useCommand =
    Boolean(boundShortcut) &&
    normalizeShortcut(boundShortcut) === normalizeShortcut(desired);

  await chrome.storage.local.set({ [SHORTCUT_VIA_COMMAND_KEY]: useCommand });
  return useCommand;
}

async function broadcastShortcutMode(shortcutViaCommand) {
  const tabs = await chrome.tabs.query({ url: BILIBILI_URL_PATTERNS });

  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) {
      continue;
    }

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "BVB_SHORTCUT_MODE",
        shortcutViaCommand
      });
    } catch (_error) {
      // Ignore tabs without a ready content script.
    }
  }
}

async function tabHasContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "BVB_PING" });
    return response?.ok === true;
  } catch (_error) {
    return false;
  }
}

async function injectContentScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: CONTENT_SCRIPT_FILES
  });
}

async function ensureBilibiliContentScripts() {
  if (!chrome.scripting?.executeScript) {
    return;
  }

  const tabs = await chrome.tabs.query({ url: BILIBILI_URL_PATTERNS });

  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) {
      continue;
    }

    try {
      if (!(await tabHasContentScript(tab.id))) {
        await injectContentScripts(tab.id);
      }
    } catch (_error) {
      // Ignore tabs that are still loading.
    }
  }
}

async function acquireCaptureStreamId(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("没有找到当前标签页。");
  }

  if (chrome.scripting?.executeScript) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => undefined
      });
    } catch (_error) {
      // Fall through to tabCapture for the real error message.
    }
  }

  return chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
}

function runToggleQueued(tabId, task) {
  const previous = toggleQueues.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  toggleQueues.set(tabId, next);

  return next.finally(() => {
    if (toggleQueues.get(tabId) === next) {
      toggleQueues.delete(tabId);
    }
  });
}

async function getStatus(tabId) {
  const tab = await getTab(tabId);
  const defaultGain = await getStoredDefaultGain();
  const autoAdapt = await getStoredAutoAdapt();
  const canBoost = isBilibiliUrl(tab.url);
  let active = activeTabs.has(tabId);
  let gain = defaultGain;
  let effectiveGain = defaultGain;
  let offscreenStatus = null;

  if (await hasOffscreenDocument()) {
    offscreenStatus = await sendToOffscreen({
      type: "GET_STATUS",
      tabId
    });

    if (offscreenStatus?.ok) {
      active = offscreenStatus.active;
      if (active) {
        gain = offscreenStatus.effectiveGain ?? offscreenStatus.gain ?? defaultGain;
        effectiveGain = offscreenStatus.effectiveGain ?? gain;
      }
      syncActiveTab(tabId, active);
    }
  }

  let smartRecommendGain = null;

  if (autoAdapt && active) {
    smartRecommendGain = offscreenStatus?.smartRecommendGain ?? null;
  }

  return {
    ok: true,
    active,
    canBoost,
    gain,
    effectiveGain,
    defaultGain,
    autoAdapt,
    smartRecommendGain,
    tabTitle: tab.title ?? ""
  };
}

async function startBoost(tabId, gain, notify, preStreamId = null) {
  const tab = await getTab(tabId);

  if (!isBilibiliUrl(tab.url)) {
    throw new Error("Please open a bilibili.com page before enabling boost.");
  }

  const streamId = preStreamId ?? await acquireCaptureStreamId(tabId);

  const autoAdapt = await getStoredAutoAdapt();
  const defaultGain = await getStoredDefaultGain();
  const captureGain = normalizeGain(gain ?? defaultGain);

  await ensureOffscreenDocument();

  const result = await sendToOffscreen({
    type: "START_CAPTURE",
    tabId,
    streamId,
    gain: captureGain,
    autoAdapt
  });
  ensureOk(result, "Unable to start audio boost.");

  syncActiveTab(tabId, true);

  const displayGain = normalizeGain(
    result.effectiveGain ?? result.gain ?? captureGain
  );

  if (notify) {
    void showBoostNotification(true, displayGain, tabId);
  }

  return {
    ok: true,
    active: true,
    gain: displayGain,
    effectiveGain: displayGain,
    autoAdapt,
    smartRecommendGain: result.smartRecommendGain ?? null,
    defaultGain: await getStoredDefaultGain()
  };
}

async function stopBoost(tabId, notify) {
  const wasActive = activeTabs.has(tabId);

  if (await hasOffscreenDocument()) {
    const result = await sendToOffscreen({
      type: "STOP_CAPTURE",
      tabId
    });
    ensureOk(result, "Unable to stop audio boost.");
  }

  syncActiveTab(tabId, false);

  if (notify && wasActive) {
    void showBoostNotification(false, undefined, tabId);
  }

  const defaultGain = await getStoredDefaultGain();

  return {
    ok: true,
    active: false,
    gain: defaultGain,
    defaultGain,
    autoAdapt: await getStoredAutoAdapt(),
    smartRecommendGain: null
  };
}

async function setGain(tabId, gain) {
  const autoAdapt = await getStoredAutoAdapt();
  const nextGain = normalizeGain(gain);
  await persistGain(nextGain);

  if (!(await hasOffscreenDocument())) {
    return {
      ok: true,
      active: false,
      gain: nextGain,
      effectiveGain: nextGain,
      defaultGain: nextGain,
      autoAdapt,
      smartRecommendGain: null
    };
  }

  const currentStatus = await sendToOffscreen({
    type: "GET_STATUS",
    tabId
  });

  if (autoAdapt && currentStatus?.active && currentStatus?.autoAdapt) {
    const defaultGain = await getStoredDefaultGain();
    return {
      ok: true,
      active: true,
      gain: currentStatus.gain,
      effectiveGain: currentStatus.effectiveGain ?? currentStatus.gain,
      defaultGain,
      autoAdapt: true,
      smartRecommendGain: currentStatus.smartRecommendGain ?? null
    };
  }

  const result = await sendToOffscreen({
    type: "SET_GAIN",
    tabId,
    gain: nextGain
  });

  if (result?.active) {
    syncActiveTab(tabId, true);
    return {
      ok: true,
      active: true,
      gain: nextGain,
      effectiveGain: result.effectiveGain ?? nextGain,
      defaultGain: nextGain,
      autoAdapt,
      smartRecommendGain: null
    };
  }

  return {
    ok: true,
    active: false,
    gain: nextGain,
    effectiveGain: nextGain,
    defaultGain: nextGain,
    autoAdapt,
    smartRecommendGain: null
  };
}

async function applyGainToAllActive(gain) {
  const nextGain = normalizeGain(gain);
  await persistGain(nextGain);

  if (!(await hasOffscreenDocument())) {
    return {
      ok: true,
      active: false,
      gain: nextGain,
      effectiveGain: nextGain
    };
  }

  const result = await sendToOffscreen({
    type: "SET_GAIN_ALL",
    gain: nextGain
  });

  for (const tabId of result?.activeTabIds ?? []) {
    syncActiveTab(tabId, true);
  }

  return {
    ok: true,
    active: (result?.activeTabIds?.length ?? 0) > 0,
    gain: nextGain,
    effectiveGain: nextGain,
    defaultGain: nextGain
  };
}

async function openShortcutsPage() {
  await chrome.tabs.create({ url: SHORTCUTS_PAGE_URL });
  return { ok: true };
}

async function setAutoAdapt(autoAdapt) {
  const nextAutoAdapt = Boolean(autoAdapt);
  await chrome.storage.sync.set({ autoAdapt: nextAutoAdapt });

  if (await hasOffscreenDocument()) {
    for (const tabId of [...activeTabs]) {
      await sendToOffscreen({
        type: "SET_AUTO_ADAPT",
        tabId,
        autoAdapt: nextAutoAdapt
      });
    }
  }

  return {
    ok: true,
    autoAdapt: nextAutoAdapt
  };
}

async function getStoredDefaultGain() {
  const result = await chrome.storage.sync.get({
    defaultGain: DEFAULT_GAIN,
    lastGain: undefined
  });

  if (Number.isFinite(result.lastGain)) {
    const migratedGain = normalizeGain(result.lastGain);
    await chrome.storage.sync.set({ defaultGain: migratedGain });
    await chrome.storage.sync.remove("lastGain");
    return migratedGain;
  }

  return normalizeGain(result.defaultGain);
}

function persistGain(gain) {
  const nextGain = normalizeGain(gain);

  clearTimeout(gainSaveTimer);
  gainSaveTimer = undefined;
  return chrome.storage.sync.set({ defaultGain: nextGain }).then(() => nextGain);
}

async function getStoredAutoAdapt() {
  const result = await chrome.storage.sync.get({ autoAdapt: DEFAULT_AUTO_ADAPT });
  return result.autoAdapt === true;
}

function normalizeGain(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return Math.min(DEFAULT_GAIN, MAX_GAIN);
  }

  return Math.min(Math.max(numericValue, MIN_GAIN), MAX_GAIN);
}

async function getTab(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("No active tab was found.");
  }

  return chrome.tabs.get(tabId);
}

function isBilibiliUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const { hostname, protocol } = new URL(url);
    return (protocol === "http:" || protocol === "https:")
      && (hostname === "bilibili.com" || hostname.endsWith(".bilibili.com"));
  } catch (_error) {
    return false;
  }
}

function ensureOk(response, fallbackMessage) {
  if (response?.ok) {
    return;
  }

  throw new Error(response?.error || fallbackMessage);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capture and amplify Bilibili tab audio."
  });
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [OFFSCREEN_DOCUMENT_URL]
    });

    return contexts.length > 0;
  }

  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }

  return false;
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({
    ...message,
    target: "offscreen"
  });
}

function syncActiveTab(tabId, active) {
  if (active) {
    activeTabs.add(tabId);
  } else {
    activeTabs.delete(tabId);
  }
}

async function showBoostNotification(active, gain, tabId) {
  if (!chrome.notifications?.create) {
    return;
  }

  const { notify } = await chrome.storage.sync.get({ notify: true });

  if (notify === false) {
    return;
  }

  const tabTitle = await getTabTitle(tabId);
  const gainPercent = Math.round((gain ?? DEFAULT_GAIN) * 100);
  const message = tabTitle;

  await createNotification({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: active ? `🔊 增强已开启（${gainPercent}%）✅` : "🔇 增强已关闭 ❌",
    message,
    priority: 2
  });
}

async function getTabTitle(tabId) {
  if (!Number.isInteger(tabId)) {
    return "当前标签页";
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const title = tab.title?.trim();

    if (!title) {
      return "当前标签页";
    }

    return title.length > 80 ? `${title.slice(0, 80)}…` : title;
  } catch (_error) {
    return "当前标签页";
  }
}

function createNotification(options) {
  return new Promise((resolve) => {
    chrome.notifications.clear(NOTIFICATION_ID, () => {
      chrome.notifications.create(NOTIFICATION_ID, options, () => {
        if (chrome.runtime.lastError) {
          console.error("Notification failed:", chrome.runtime.lastError.message);
        }
        resolve();
      });
    });
  });
}
