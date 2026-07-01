const gainInput = document.querySelector("#gain");
const gainValue = document.querySelector("#gainValue");
const autoAdaptInput = document.querySelector("#autoAdapt");
const toggleButton = document.querySelector("#toggle");
const settingsButton = document.querySelector("#settings");
const statusText = document.querySelector("#status");

let activeTabId;
let boostActive = false;
let canBoost = false;
let autoAdapt = true;
let statusPollTimer = null;
let isGainDragging = false;

const STATUS_POLL_MS = 50;

document.addEventListener("DOMContentLoaded", init);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  if (changes.autoAdapt) {
    applyAutoAdaptState(changes.autoAdapt.newValue !== false, { refreshStatus: boostActive });
    return;
  }

  if (!changes.defaultGain || isGainLocked() || isGainDragging) {
    return;
  }

  const nextGain = Number(changes.defaultGain.newValue);

  if (!Number.isFinite(nextGain)) {
    return;
  }

  gainInput.value = Math.min(Math.max(Math.round(nextGain * 100), 1), 500);
  renderGain();
});

gainInput.addEventListener("pointerdown", () => {
  if (!isGainLocked()) {
    isGainDragging = true;
  }
});

gainInput.addEventListener("pointerup", () => {
  isGainDragging = false;
});

gainInput.addEventListener("pointercancel", () => {
  isGainDragging = false;
});

gainInput.addEventListener("input", () => {
  if (isGainLocked()) {
    return;
  }

  renderGain();
});

gainInput.addEventListener("change", () => {
  if (isGainLocked()) {
    return;
  }

  updateGain().catch(showError);
});

toggleButton.addEventListener("click", () => {
  toggleBoost().catch(showError);
});

autoAdaptInput.addEventListener("change", () => {
  updateAutoAdapt().catch(showError);
});

settingsButton.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/options.html") });
  }
  window.close();
});

setupEditablePercent(gainValue, {
  getPercent: () => Number(gainInput.value),
  onApply: applyGainPercent,
  isLocked: isGainLocked
});

async function init() {
  toggleButton.disabled = true;

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  activeTabId = tab?.id;

  if (!Number.isInteger(activeTabId)) {
    showError("没有找到当前标签页。");
    return;
  }

  const status = await sendToBackground({
    type: "GET_STATUS",
    tabId: activeTabId
  });

  if (!status.ok) {
    showError(status.error || "读取状态失败。");
    return;
  }

  gainInput.min = 1;
  gainInput.max = 500;
  document.querySelector("#popupGainMax").textContent = "500%";

  applyStatus(status);
}

async function toggleBoost() {
  if (!canBoost) {
    return;
  }

  toggleButton.disabled = true;

  try {
    const response = await sendToBackground({
      type: boostActive ? "STOP_BOOST" : "START_BOOST",
      tabId: activeTabId,
      gain: Number(gainInput.value) / 100,
      notify: true
    });

    if (!response.ok) {
      throw new Error(response.error || "操作失败。");
    }

    applyStatus(response);
  } catch (error) {
    toggleButton.disabled = !canBoost;
    showError(error);
  }
}

function isGainLocked() {
  return boostActive && autoAdapt;
}

function applyStatus(status) {
  if (typeof status.canBoost === "boolean") {
    canBoost = status.canBoost;
  }

  boostActive = status.active;
  autoAdapt = status.autoAdapt !== false;
  autoAdaptInput.checked = autoAdapt;

  const displayGain = autoAdapt && status.active
    ? (status.effectiveGain ?? status.gain)
    : (status.defaultGain ?? status.gain ?? 2);

  if (!isGainDragging) {
    gainInput.value = Math.min(
      Math.max(Math.round(displayGain * 100), 1),
      500
    );
  }

  updateGainControls();
  renderGain();
  renderState();
  toggleButton.disabled = !canBoost;
  syncStatusPolling();
}

function applyAutoAdaptState(nextAutoAdapt, { refreshStatus = false } = {}) {
  autoAdapt = nextAutoAdapt !== false;
  autoAdaptInput.checked = autoAdapt;
  updateGainControls();
  renderState();
  syncStatusPolling();

  if (!refreshStatus || !Number.isInteger(activeTabId)) {
    if (!autoAdapt && !boostActive) {
      return sendToBackground({
        type: "GET_STATUS",
        tabId: activeTabId
      }).then((status) => {
        if (status?.ok) {
          gainInput.value = Math.min(
            Math.max(Math.round((status.defaultGain ?? 2) * 100), 1),
            500
          );
          renderGain();
        }
      });
    }

    return Promise.resolve();
  }

  return sendToBackground({
    type: "GET_STATUS",
    tabId: activeTabId
  }).then((status) => {
    if (status?.ok) {
      applyStatus(status);
    }
  });
}

async function updateAutoAdapt() {
  const nextAutoAdapt = autoAdaptInput.checked;
  autoAdaptInput.disabled = true;

  try {
    const response = await sendToBackground({
      type: "SET_AUTO_ADAPT",
      autoAdapt: nextAutoAdapt
    });

    if (!response.ok) {
      throw new Error(response.error || "更新智能音量失败。");
    }

    await applyAutoAdaptState(response.autoAdapt, { refreshStatus: true });
  } catch (error) {
    autoAdaptInput.checked = autoAdapt;
    throw error;
  } finally {
    autoAdaptInput.disabled = false;
  }
}

function updateGainControls() {
  const locked = isGainLocked();

  gainInput.classList.toggle("locked", locked);
  gainInput.toggleAttribute("aria-disabled", locked);
  gainValue.classList.toggle("locked", locked);
  gainValue.title = locked ? "" : "点击输入倍率";
}

function syncStatusPolling() {
  clearInterval(statusPollTimer);
  statusPollTimer = null;

  if (!boostActive || !autoAdapt || !Number.isInteger(activeTabId)) {
    return;
  }

  statusPollTimer = setInterval(() => {
    pollLiveStatus().catch(() => {});
  }, STATUS_POLL_MS);
}

async function pollLiveStatus() {
  if (isGainDragging) {
    return;
  }

  const status = await sendToBackground({
    type: "GET_STATUS",
    tabId: activeTabId
  });

  if (!status.ok || !status.active) {
    return;
  }

  const liveGain = status.effectiveGain ?? status.gain;

  if (Number.isFinite(liveGain)) {
    const percent = Math.min(Math.max(Math.round(liveGain * 100), 1), 500);

    if (Number(gainInput.value) !== percent) {
      gainInput.value = percent;
      renderGain();
    }
  }
}

async function applyGainPercent(percent) {
  if (isGainLocked()) {
    return;
  }

  gainInput.value = percent;
  renderGain();
  await updateGain();
}

async function updateGain() {
  if (isGainLocked()) {
    return;
  }

  const response = await sendToBackground({
    type: "SET_GAIN",
    tabId: activeTabId,
    gain: Number(gainInput.value) / 100
  });

  if (!response.ok) {
    throw new Error(response.error || "更新倍率失败。");
  }

  if (!autoAdapt && Number.isFinite(response.defaultGain) && !isGainDragging) {
    gainInput.value = Math.min(
      Math.max(Math.round(response.defaultGain * 100), 1),
      500
    );
    renderGain();
  }
}

function renderGain() {
  gainValue.textContent = `${gainInput.value}%`;
}

function renderState() {
  toggleButton.classList.toggle("active", boostActive);
  toggleButton.textContent = boostActive ? "关闭增强" : "开启增强";
  statusText.classList.remove("error");

  if (!canBoost) {
    statusText.textContent = "请先打开哔哩哔哩网页，再从扩展按钮开启增强。";
    return;
  }

  statusText.textContent = boostActive
    ? (autoAdapt
      ? "智能音量全自动调节中，滑块已锁定。"
      : "当前标签页音频会按上方倍率放大。")
    : "点击按钮后会增强当前哔哩哔哩标签页。";
}

function setupEditablePercent(button, { getPercent, onApply, isLocked }) {
  button.addEventListener("click", () => {
    if (isLocked?.() || button.querySelector("input")) {
      return;
    }

    const previousPercent = getPercent();

    if (!Number.isFinite(previousPercent)) {
      return;
    }

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.className = "gain-value-input";
    input.value = String(previousPercent);
    button.textContent = "";
    button.appendChild(input);
    input.focus();
    input.select();

    let finished = false;

    const restore = () => {
      if (Number.isFinite(previousPercent)) {
        button.textContent = `${previousPercent}%`;
      }
    };

    const commit = async () => {
      if (finished) {
        return;
      }

      finished = true;
      const raw = input.value.trim().replace(/%/g, "");

      if (!raw) {
        restore();
        return;
      }

      const numericValue = Number(raw);

      if (!Number.isFinite(numericValue)) {
        restore();
        return;
      }

      const percent = Math.min(Math.max(Math.round(numericValue), 1), 500);
      button.textContent = `${percent}%`;

      try {
        await onApply(percent);
      } catch (error) {
        restore();
        throw error;
      }
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit().catch(showError);
      }

      if (event.key === "Escape") {
        finished = true;
        restore();
      }
    });

    input.addEventListener("blur", () => {
      commit().catch(showError);
    });
  });
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);

  toggleButton.disabled = !canBoost;
  statusText.textContent = message;
  statusText.classList.add("error");
}

function sendToBackground(message) {
  return chrome.runtime.sendMessage({
    ...message,
    target: "background"
  });
}
