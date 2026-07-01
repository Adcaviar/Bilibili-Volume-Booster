const DEFAULT_GAIN = 2;
const MAX_GAIN = 5;
const MIN_GAIN = 0.01;
const DEFAULT_AUTO_ADAPT = true;
const OFFSCREEN_DOCUMENT_PATH = "src/offscreen.html";
const OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
const NOTIFICATION_ID = "boost-status";
const DEFAULT_SHORTCUT = "Alt+Shift+U";
const SHORTCUT_STORAGE_KEY = "customShortcut";
const SHORTCUTS_PAGE_URL = "chrome://extensions/shortcuts";

const activeTabs = new Set();
let gainSaveTimer;

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install" || details.reason === "update") {
    chrome.storage.sync.get({ [SHORTCUT_STORAGE_KEY]: null }, (stored) => {
      if (stored[SHORTCUT_STORAGE_KEY] == null) {
        chrome.storage.sync.set({ [SHORTCUT_STORAGE_KEY]: DEFAULT_SHORTCUT });
      }
    });
  }

  if (details.reason === "install") {
    chrome.storage.sync.set({
      defaultGain: DEFAULT_GAIN,
      notify: true,
      autoAdapt: DEFAULT_AUTO_ADAPT,
      [SHORTCUT_STORAGE_KEY]: DEFAULT_SHORTCUT
    });
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-boost") {
    toggleBoostForActiveTab().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") {
    return false;
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
    case "TOGGLE_BOOST":
      return toggleBoostForActiveTab(message.tabId ?? sender?.tab?.id, message.notify);
    case "OPEN_SHORTCUTS_PAGE":
      return openShortcutsPage();
    default:
      throw new Error(`Unsupported message type: ${message.type}`);
  }
}

async function toggleBoostForActiveTab(tabId, notify = true) {
  let targetTabId = tabId;

  if (!Number.isInteger(targetTabId)) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tab?.id;
  }

  if (!Number.isInteger(targetTabId)) {
    throw new Error("没有找到当前标签页。");
  }

  const tab = await getTab(targetTabId);

  if (!isBilibiliUrl(tab.url)) {
    throw new Error("请先打开哔哩哔哩网页。");
  }

  if (activeTabs.has(targetTabId)) {
    return stopBoost(targetTabId, notify);
  }

  const preferredGain = await getStoredDefaultGain();
  return startBoost(targetTabId, preferredGain, notify);
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

async function startBoost(tabId, gain, notify) {
  const tab = await getTab(tabId);

  if (!isBilibiliUrl(tab.url)) {
    throw new Error("Please open a bilibili.com page before enabling boost.");
  }

  const autoAdapt = await getStoredAutoAdapt();
  const defaultGain = await getStoredDefaultGain();
  const captureGain = normalizeGain(gain ?? defaultGain);

  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });

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
    await showBoostNotification(true, displayGain, tabId);
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
    await showBoostNotification(false, undefined, tabId);
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
  return result.autoAdapt !== false;
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
