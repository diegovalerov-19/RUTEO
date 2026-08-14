(function exposeGpsSpeed(global) {
  "use strict";

  const BUFFER_SIZE = 12;
  const STOP_THRESHOLD_KMH = 1.5;
  const MAX_REASONABLE_SPEED_KMH = 110;
  const RECOVERY_ALPHAS = [0.25, 0.4, 0.55, 0.7];
  const SIGNAL_STATES = new Set(["active", "lost", "recovering", "stopped"]);

  function finiteSpeed(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function create(source = {}) {
    const recentSpeedsKmh = (Array.isArray(source.recentSpeedsKmh) ? source.recentSpeedsKmh : [])
      .map(value => finiteSpeed(value, NaN))
      .filter(Number.isFinite)
      .slice(-BUFFER_SIZE);
    return {
      signal: SIGNAL_STATES.has(source.signal) ? source.signal : "active",
      currentSpeedKmh: finiteSpeed(source.currentSpeedKmh),
      heldSpeedKmh: finiteSpeed(source.heldSpeedKmh),
      recentSpeedsKmh,
      recoveryReadings: Math.max(0, Math.floor(Number(source.recoveryReadings) || 0)),
      stoppedDuringLoss: Boolean(source.stoppedDuringLoss),
      lastSignalAt: Number.isFinite(Number(source.lastSignalAt)) ? Number(source.lastSignalAt) : null
    };
  }

  function average(state) {
    if (!state?.recentSpeedsKmh?.length) return 0;
    return state.recentSpeedsKmh.reduce((sum, value) => sum + value, 0) / state.recentSpeedsKmh.length;
  }

  function pushSample(state, speedKmh) {
    state.recentSpeedsKmh.push(speedKmh);
    if (state.recentSpeedsKmh.length > BUFFER_SIZE) state.recentSpeedsKmh.shift();
  }

  function rejectSpike(rawSpeedKmh, baselineKmh, accuracyMeters) {
    if (rawSpeedKmh > MAX_REASONABLE_SPEED_KMH) return baselineKmh || MAX_REASONABLE_SPEED_KMH;
    if (baselineKmh > STOP_THRESHOLD_KMH) {
      const dynamicLimit = Math.max(baselineKmh + 35, baselineKmh * 2.5);
      if (rawSpeedKmh > dynamicLimit) return baselineKmh;
      if (accuracyMeters > 40 && Math.abs(rawSpeedKmh - baselineKmh) > 25) return baselineKmh;
    }
    return rawSpeedKmh;
  }

  function record(state, rawSpeedKmh, options = {}) {
    const timestamp = Number.isFinite(Number(options.timestamp)) ? Number(options.timestamp) : Date.now();
    const accuracyMeters = Math.max(0, Number(options.accuracyMeters) || 0);
    const raw = finiteSpeed(rawSpeedKmh);
    const baseline = average(state) || state.currentSpeedKmh || state.heldSpeedKmh;
    const accepted = rejectSpike(raw, baseline, accuracyMeters);
    const recovering = state.signal === "lost" || state.signal === "recovering" || state.signal === "stopped";
    let effective = accepted;

    if (recovering) {
      if (state.stoppedDuringLoss && accepted <= STOP_THRESHOLD_KMH) {
        state.recentSpeedsKmh = [];
        effective = 0;
        state.signal = "active";
        state.recoveryReadings = 0;
        state.stoppedDuringLoss = false;
      } else {
        const base = state.recoveryReadings
          ? state.currentSpeedKmh
          : state.stoppedDuringLoss ? 0 : state.heldSpeedKmh || baseline;
        const alpha = RECOVERY_ALPHAS[Math.min(state.recoveryReadings, RECOVERY_ALPHAS.length - 1)];
        effective = base + (accepted - base) * alpha;
        state.recoveryReadings += 1;
        state.signal = state.recoveryReadings >= RECOVERY_ALPHAS.length ? "active" : "recovering";
        if (state.signal === "active") state.stoppedDuringLoss = false;
      }
    }

    if (effective <= STOP_THRESHOLD_KMH) effective = 0;
    state.currentSpeedKmh = effective;
    state.lastSignalAt = timestamp;
    if (!recovering || effective > 0) pushSample(state, effective);
    if (state.signal === "active") state.heldSpeedKmh = 0;

    return {
      speedKmh: effective,
      rawSpeedKmh: raw,
      acceptedSpeedKmh: accepted,
      spikeRejected: accepted !== raw,
      signal: state.signal
    };
  }

  function loseSignal(state, options = {}) {
    const mean = average(state);
    const heldSpeedKmh = state.currentSpeedKmh > STOP_THRESHOLD_KMH
      ? mean || state.currentSpeedKmh
      : 0;
    state.signal = "lost";
    state.heldSpeedKmh = heldSpeedKmh;
    state.currentSpeedKmh = heldSpeedKmh;
    state.recoveryReadings = 0;
    state.stoppedDuringLoss = heldSpeedKmh === 0;
    if (state.stoppedDuringLoss) state.recentSpeedsKmh = [];
    if (Number.isFinite(Number(options.timestamp))) state.lastSignalAt = Number(options.timestamp);
    return heldSpeedKmh;
  }

  function stop(state, options = {}) {
    state.recentSpeedsKmh = [];
    state.currentSpeedKmh = 0;
    state.heldSpeedKmh = 0;
    state.recoveryReadings = 0;
    state.stoppedDuringLoss = true;
    state.signal = options.duringSignalLoss ? "lost" : "stopped";
    return 0;
  }

  const api = {
    BUFFER_SIZE,
    STOP_THRESHOLD_KMH,
    MAX_REASONABLE_SPEED_KMH,
    create,
    average,
    record,
    loseSignal,
    stop
  };

  global.GpsSpeed = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
