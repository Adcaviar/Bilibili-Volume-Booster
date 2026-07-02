const MIN_GAIN_PERCENT = 1;
const MAX_GAIN_PERCENT = 500;

const {
  DEFAULT_SHORTCUT,
  STORAGE_KEY,
  COMMAND_NAME,
  supportsShortcutRecording,
  formatShortcutLabel,
  eventToShortcutString,
  isValidShortcut
} = globalThis.BvbShortcut;

const DEFAULTS = {
  defaultGain: 2,
  notify: true,
  autoAdapt: false,
  [STORAGE_KEY]: DEFAULT_SHORTCUT
};

const defaultGainInput = document.querySelector("#defaultGain");
const defaultGainValue = document.querySelector("#defaultGainValue");
const autoAdaptInput = document.querySelector("#autoAdapt");
const notifyInput = document.querySelector("#notify");
const shortcutValue = document.querySelector("#shortcutValue");
const shortcutDesc = document.querySelector("#shortcutDesc");
const shortcutInline = document.querySelector("#shortcutInline");
const shortcutRecordButton = document.querySelector("#shortcutRecord");
const shortcutClearButton = document.querySelector("#shortcutClear");
const shortcutOpenButton = document.querySelector("#shortcutOpen");
const resetButton = document.querySelector("#reset");
const statusText = document.querySelector("#status");

const canRecordShortcut = supportsShortcutRecording();

let statusTimer;
let saveTimer;
let isRecordingShortcut = false;

init().catch(showError);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadShortcutDisplay().catch(() => {});
    reloadStoredSettings().catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  if (changes.autoAdapt) {
    autoAdaptInput.checked = changes.autoAdapt.newValue === true;
    return;
  }

  if (changes[STORAGE_KEY]) {
    renderShortcutValue(changes[STORAGE_KEY].newValue || "");
    return;
  }

  if (!changes.defaultGain) {
    return;
  }

  const nextGain = Number(changes.defaultGain.newValue);

  if (!Number.isFinite(nextGain)) {
    return;
  }

  const defaultGainPercent = normalizePercent(
    Math.round(nextGain * 100),
    MIN_GAIN_PERCENT,
    MAX_GAIN_PERCENT,
    Math.round(DEFAULTS.defaultGain * 100)
  );

  defaultGainInput.value = defaultGainPercent;
  renderValues();
});

defaultGainInput.addEventListener("input", () => {
  renderValues();
  scheduleSave();
});

defaultGainInput.addEventListener("change", () => {
  save().catch(showError);
});

autoAdaptInput.addEventListener("change", () => {
  saveAutoAdapt().catch(showError);
});

notifyInput.addEventListener("change", () => {
  save().catch(showError);
});

shortcutRecordButton.addEventListener("click", () => {
  if (isRecordingShortcut) {
    stopShortcutRecording();
    return;
  }

  startShortcutRecording();
});

shortcutClearButton.addEventListener("click", () => {
  saveShortcut(DEFAULT_SHORTCUT).catch(showError);
});

shortcutOpenButton.addEventListener("click", () => {
  openShortcutSettings().catch(showError);
});

resetButton.addEventListener("click", () => {
  applySettings({
    defaultGain: Math.round(DEFAULTS.defaultGain * 100),
    notify: DEFAULTS.notify,
    autoAdapt: DEFAULTS.autoAdapt
  });
  renderValues();
  save("已恢复默认设置")
    .then(() => saveShortcut(DEFAULT_SHORTCUT, false))
    .catch(showError);
});

async function init() {
  configureShortcutUi();

  const stored = await chrome.storage.sync.get({
    defaultGain: DEFAULTS.defaultGain,
    notify: DEFAULTS.notify,
    autoAdapt: DEFAULTS.autoAdapt,
    [STORAGE_KEY]: DEFAULT_SHORTCUT
  });

  const defaultGainPercent = normalizePercent(
    Math.round(stored.defaultGain * 100),
    MIN_GAIN_PERCENT,
    MAX_GAIN_PERCENT,
    Math.round(DEFAULTS.defaultGain * 100)
  );

  applySettings({
    defaultGain: defaultGainPercent,
    notify: stored.notify !== false,
    autoAdapt: stored.autoAdapt === true
  });
  renderValues();
  await loadShortcutDisplay();
}

function configureShortcutUi() {
  if (canRecordShortcut) {
    shortcutInline.hidden = false;
    shortcutOpenButton.hidden = true;
    shortcutDesc.textContent =
      "点击下方按钮录制快捷键。若与浏览器默认快捷键相同，将直接由扩展命令处理；自定义组合键需刷新哔哩哔哩页面后生效。";
    return;
  }

  shortcutInline.hidden = true;
  shortcutOpenButton.hidden = false;
  shortcutDesc.textContent =
    "当前浏览器不支持在扩展内录制快捷键，请前往系统快捷键页面修改。";
}

async function reloadStoredSettings() {
  const stored = await chrome.storage.sync.get({
    defaultGain: DEFAULTS.defaultGain,
    autoAdapt: DEFAULTS.autoAdapt,
    [STORAGE_KEY]: DEFAULT_SHORTCUT
  });
  const defaultGainPercent = normalizePercent(
    Math.round(stored.defaultGain * 100),
    MIN_GAIN_PERCENT,
    MAX_GAIN_PERCENT,
    Math.round(DEFAULTS.defaultGain * 100)
  );

  defaultGainInput.value = defaultGainPercent;
  autoAdaptInput.checked = stored.autoAdapt === true;
  renderValues();
}

function applySettings({ defaultGain, notify, autoAdapt }) {
  defaultGainInput.value = defaultGain;
  notifyInput.checked = notify;
  autoAdaptInput.checked = autoAdapt;
}

function renderValues() {
  defaultGainValue.textContent = `${defaultGainInput.value}%`;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    save().catch(showError);
  }, 300);
}

async function save(successMessage = "设置已保存") {
  clearTimeout(saveTimer);
  saveTimer = undefined;

  const defaultGainPercent = normalizePercent(
    Number(defaultGainInput.value),
    MIN_GAIN_PERCENT,
    MAX_GAIN_PERCENT,
    Math.round(DEFAULTS.defaultGain * 100)
  );
  defaultGainInput.value = defaultGainPercent;
  const autoAdapt = autoAdaptInput.checked;

  await chrome.storage.sync.set({
    defaultGain: defaultGainPercent / 100,
    notify: notifyInput.checked,
    autoAdapt
  });

  if (chrome.runtime?.sendMessage) {
    await chrome.runtime.sendMessage({
      target: "background",
      type: "APPLY_GAIN",
      gain: defaultGainPercent / 100
    });
    await chrome.runtime.sendMessage({
      target: "background",
      type: "SET_AUTO_ADAPT",
      autoAdapt
    });
  }

  showStatus(successMessage);
}

async function saveAutoAdapt() {
  const autoAdapt = autoAdaptInput.checked;

  await chrome.storage.sync.set({ autoAdapt });

  if (chrome.runtime?.sendMessage) {
    await chrome.runtime.sendMessage({
      target: "background",
      type: "SET_AUTO_ADAPT",
      autoAdapt
    });
  }

  showStatus("设置已保存");
}

async function loadShortcutDisplay() {
  if (canRecordShortcut) {
    const stored = await chrome.storage.sync.get({
      [STORAGE_KEY]: DEFAULT_SHORTCUT
    });
    renderShortcutValue(stored[STORAGE_KEY] || DEFAULT_SHORTCUT);
    return;
  }

  if (!chrome.commands?.getAll) {
    renderShortcutValue(DEFAULT_SHORTCUT);
    return;
  }

  const commands = await chrome.commands.getAll();
  const command = commands.find((item) => item.name === COMMAND_NAME);
  renderShortcutValue(command?.shortcut || DEFAULT_SHORTCUT);
}

async function saveShortcut(shortcut, showSavedStatus = true) {
  const normalizedShortcut = shortcut || DEFAULT_SHORTCUT;

  if (!isValidShortcut(normalizedShortcut)) {
    throw new Error("快捷键无效，需包含 Ctrl 或 Alt，且不能使用 Ctrl+Alt 组合。");
  }

  await chrome.storage.sync.set({ [STORAGE_KEY]: normalizedShortcut });

  if (chrome.runtime?.sendMessage) {
    await chrome.runtime.sendMessage({
      target: "background",
      type: "SYNC_SHORTCUT_MODE"
    });
  }

  renderShortcutValue(normalizedShortcut);

  if (showSavedStatus) {
    showStatus("快捷键已保存");
  }
}

function renderShortcutValue(shortcut) {
  shortcutValue.textContent = formatShortcutLabel(shortcut || DEFAULT_SHORTCUT);
}

function startShortcutRecording() {
  isRecordingShortcut = true;
  shortcutRecordButton.textContent = "请按下快捷键…";
  shortcutRecordButton.classList.add("recording");
  document.addEventListener("keydown", handleShortcutRecord, true);
}

function stopShortcutRecording() {
  isRecordingShortcut = false;
  shortcutRecordButton.textContent = "点击设置快捷键";
  shortcutRecordButton.classList.remove("recording");
  document.removeEventListener("keydown", handleShortcutRecord, true);
}

function handleShortcutRecord(event) {
  event.preventDefault();
  event.stopPropagation();

  if (event.key === "Escape") {
    stopShortcutRecording();
    return;
  }

  const shortcut = eventToShortcutString(event);

  if (!shortcut) {
    return;
  }

  if (!isValidShortcut(shortcut)) {
    showError(new Error("快捷键无效，需包含 Ctrl 或 Alt，且不能使用 Ctrl+Alt 组合。"));
    return;
  }

  stopShortcutRecording();
  saveShortcut(shortcut).catch(showError);
}

async function openShortcutSettings() {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "OPEN_SHORTCUTS_PAGE"
  });

  if (response?.ok) {
    return;
  }

  throw new Error(response?.error || "无法打开快捷键设置页面。");
}

function showStatus(message) {
  statusText.textContent = message;
  statusText.classList.remove("error");
  statusText.classList.add("visible");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusText.classList.remove("visible");
  }, 1500);
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  statusText.textContent = message;
  statusText.classList.add("error", "visible");
}

function normalizePercent(value, min, max, fallback) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(Math.max(numericValue, min), max);
}
