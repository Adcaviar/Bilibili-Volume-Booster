const NOMINAL_RMS = 0.06;
const RMS_FLOOR = 0.005;
const SILENCE_RMS = 0.008;
const IDLE_GAIN = 1;
const ADAPT_MIN = 0.25;
const ADAPT_MAX = 2.5;
const MIN_GAIN = 0.01;
const MAX_GAIN = 5;

const controllers = new Map();

let audioContext;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") {
    return false;
  }

  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    return;
  }

  switch (message.type) {
    case "START_CAPTURE":
      return startCapture(message.tabId, message.streamId, message.gain, message.autoAdapt);
    case "STOP_CAPTURE":
      return stopCapture(message.tabId);
    case "SET_GAIN":
      return setGain(message.tabId, message.gain);
    case "SET_GAIN_ALL":
      return setGainAll(message.gain);
    case "SET_AUTO_ADAPT":
      return setAutoAdapt(message.tabId, message.autoAdapt);
    case "GET_STATUS":
      return getStatus(message.tabId);
    default:
      return;
  }
}

async function startCapture(tabId, streamId, gain, autoAdapt) {
  if (!Number.isInteger(tabId) || !streamId) {
    throw new Error("Missing tab capture information.");
  }

  await stopCapture(tabId);

  const context = await getAudioContext();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  const gainNode = context.createGain();

  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;

  source.connect(analyser);
  analyser.connect(gainNode);
  gainNode.connect(context.destination);

  const isAutoAdapt = autoAdapt !== false;
  const manualGain = normalizeGain(gain);

  const controller = {
    stream,
    source,
    analyser,
    gainNode,
    userTargetGain: manualGain,
    savedManualGain: manualGain,
    autoAdapt: isAutoAdapt,
    smoothedRms: NOMINAL_RMS,
    timerId: null
  };

  if (controller.autoAdapt) {
    controller.smoothedRms = getRms(controller.analyser);
    applyAdaptiveGain(controller, controller.smoothedRms);
  } else {
    applyGain(controller);
  }

  startAdaptiveLoop(controller);
  controllers.set(tabId, controller);

  return buildStatus(controller);
}

async function stopCapture(tabId) {
  const controller = controllers.get(tabId);

  if (!controller) {
    return {
      ok: true,
      active: false
    };
  }

  stopAdaptiveLoop(controller);
  controller.source.disconnect();
  controller.analyser.disconnect();
  controller.gainNode.disconnect();
  controller.stream.getTracks().forEach((track) => track.stop());
  controllers.delete(tabId);

  return {
    ok: true,
    active: false
  };
}

async function setGain(tabId, gain) {
  const controller = controllers.get(tabId);
  const nextGain = normalizeGain(gain);

  if (controller) {
    if (controller.autoAdapt) {
      return buildStatus(controller);
    }

    controller.userTargetGain = nextGain;
    controller.savedManualGain = nextGain;
    applyGain(controller);
  }

  return {
    ok: true,
    active: Boolean(controller),
    gain: controller?.autoAdapt ? getPlaybackGain(controller) : nextGain,
    effectiveGain: controller ? getEffectiveGain(controller) : nextGain,
    autoAdapt: Boolean(controller?.autoAdapt),
    smartRecommendGain: controller?.autoAdapt ? getLiveRecommendGain(controller) : null
  };
}

async function setGainAll(gain) {
  const nextGain = normalizeGain(gain);
  const activeTabIds = [];

  for (const [tabId, controller] of controllers.entries()) {
    if (controller.autoAdapt) {
      continue;
    }

    controller.userTargetGain = nextGain;
    controller.savedManualGain = nextGain;
    applyGain(controller);
    activeTabIds.push(tabId);
  }

  return {
    ok: true,
    activeTabIds,
    gain: nextGain
  };
}

async function setAutoAdapt(tabId, autoAdapt) {
  const controller = controllers.get(tabId);

  if (controller) {
    const nextAutoAdapt = Boolean(autoAdapt);

    if (nextAutoAdapt && !controller.autoAdapt) {
      rememberManualGain(
        controller,
        controller.savedManualGain ?? controller.userTargetGain
      );
    }

    controller.autoAdapt = nextAutoAdapt;

    if (controller.autoAdapt) {
      applyAdaptiveGain(controller, controller.smoothedRms);
    } else {
      restoreManualGain(controller);
    }
  }

  return controller
    ? buildStatus(controller)
    : {
      ok: true,
      active: false,
      autoAdapt: Boolean(autoAdapt)
    };
}

async function getStatus(tabId) {
  const controller = controllers.get(tabId);

  if (!controller) {
    return {
      ok: true,
      active: false
    };
  }

  return buildStatus(controller);
}

function buildStatus(controller) {
  const effectiveGain = controller.autoAdapt
    ? getPlaybackGain(controller)
    : controller.userTargetGain;
  const liveRecommendGain = getLiveRecommendGain(controller);

  return {
    ok: true,
    active: true,
    gain: controller.autoAdapt ? effectiveGain : controller.userTargetGain,
    effectiveGain,
    autoAdapt: controller.autoAdapt,
    inputLevel: controller.smoothedRms,
    smartRecommendGain: liveRecommendGain
  };
}

function getLiveRecommendGain(controller) {
  if (!controller.autoAdapt) {
    return null;
  }

  return computeAutoGain(controller.smoothedRms);
}

const ADAPT_TICK_MS = 16;

function startAdaptiveLoop(controller) {
  stopAdaptiveLoop(controller);

  const tick = () => {
    const currentRms = getRms(controller.analyser);
    controller.smoothedRms = controller.smoothedRms * 0.7 + currentRms * 0.3;

    if (controller.autoAdapt) {
      applyAdaptiveGain(controller, currentRms);
    }

    controller.timerId = setTimeout(tick, ADAPT_TICK_MS);
  };

  controller.timerId = setTimeout(tick, ADAPT_TICK_MS);
}

function stopAdaptiveLoop(controller) {
  if (controller.timerId !== null) {
    clearTimeout(controller.timerId);
    controller.timerId = null;
  }
}

function applyGain(controller) {
  setPlaybackGain(controller, controller.userTargetGain, false);
}

function restoreManualGain(controller) {
  const restoredGain = normalizeGain(
    controller.savedManualGain ?? controller.userTargetGain
  );

  controller.userTargetGain = restoredGain;
  setPlaybackGain(controller, restoredGain, true);
}

function applyAdaptiveGain(controller, sampledRms = controller.smoothedRms) {
  const adaptedGain = computeAutoGain(sampledRms);

  controller.userTargetGain = adaptedGain;
  setPlaybackGain(controller, adaptedGain, true);
}

function setPlaybackGain(controller, gain, immediate) {
  const targetGain = normalizeGain(gain);

  if (audioContext) {
    controller.gainNode.gain.cancelScheduledValues(audioContext.currentTime);

    if (!immediate) {
      controller.gainNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, 0.08);
      return;
    }
  }

  controller.gainNode.gain.value = targetGain;
}

function getPlaybackGain(controller) {
  return normalizeGain(controller.gainNode.gain.value);
}

function rememberManualGain(controller, gain) {
  controller.savedManualGain = normalizeGain(gain);
}

function computeAutoGain(sampledRms) {
  if (sampledRms < SILENCE_RMS) {
    return normalizeGain(IDLE_GAIN);
  }

  const safeRms = Math.max(sampledRms, RMS_FLOOR);
  const adaptMultiplier = Math.min(
    Math.max(NOMINAL_RMS / safeRms, ADAPT_MIN),
    ADAPT_MAX
  );

  return normalizeGain(adaptMultiplier);
}

function getEffectiveGain(controller) {
  return getPlaybackGain(controller);
}

function getRms(analyser) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);

  let sum = 0;

  for (let index = 0; index < data.length; index += 1) {
    sum += data[index] * data[index];
  }

  return Math.sqrt(sum / data.length);
}

async function getAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return audioContext;
}

function normalizeGain(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 2;
  }

  return Math.min(Math.max(numericValue, MIN_GAIN), MAX_GAIN);
}
