import { testProxyUrl } from "@/lib/network/proxyTest";

const SECOND_MS = 1000;
const POOL_STATES = new Map();
let recoveryTimer = null;

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function normalizeWeights(value, urlCount) {
  if (!Array.isArray(value) || value.length === 0 || urlCount === 0) {
    return Array.from({ length: urlCount }, () => 1);
  }
  return Array.from({ length: urlCount }, (_, i) => {
    const n = Number(value[i]);
    return Number.isFinite(n) && n > 0 ? n : 1;
  });
}

function ensureNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min ?? n, Math.min(max ?? n, n));
}

class UrlState {
  constructor() {
    this.failCount = 0;
    this.ejected = false;
    this.lastFailAt = 0;
    this.successCount = 0;
    this.lastSuccessAt = 0;
    this.avgLatencyMs = 0; // exponential moving average
    this.pickCount = 0;
  }
}

function getOrCreateState(poolId, poolData = {}) {
  const urls = normalizeStringArray(poolData.proxyUrls);
  const weights = normalizeWeights(poolData.proxyWeights, urls.length);
  if (POOL_STATES.has(poolId)) {
    const state = POOL_STATES.get(poolId);
    const fresh = !arraysEqual(state.urls, urls) || !arraysEqual(state.weights, weights);
    if (fresh) {
      state.urls = urls;
      state.weights = weights;
      const existing = state.byUrl;
      state.byUrl = new Map();
      for (const url of urls) {
        state.byUrl.set(url, existing.get(url) || new UrlState());
      }
    }
    // Refresh config (weights aside) without recreating
    state.config.cooldownSec = ensureNumber(poolData.cooldownSec, 30, 0, 3600);
    state.config.maxStrikes = ensureNumber(poolData.maxStrikes, 3, 1, 100);
    state.config.recoverAfterSec = ensureNumber(poolData.recoverAfterSec, 300, 10, 86400);
    state.config.requestTimeoutMs = ensureNumber(poolData.requestTimeoutMs, 6000, 500, 30000);
    state.config.rotationMode = ["round-robin", "weighted-round-robin", "random", "least-used", "latency"]
      .includes(poolData.rotationMode)
      ? poolData.rotationMode
      : "round-robin";
    state.config.bypassRotation = poolData.bypassRotation === true;
    state.config.useLatencyTieBreaker = poolData.useLatencyTieBreaker !== false;
    state.config.stickySec = ensureNumber(poolData.stickySec, 0, 0, 3600);
    return state;
  }

  const config = {
    cooldownSec: ensureNumber(poolData.cooldownSec, 30, 0, 3600),
    maxStrikes: ensureNumber(poolData.maxStrikes, 3, 1, 100),
    recoverAfterSec: ensureNumber(poolData.recoverAfterSec, 300, 10, 86400),
    requestTimeoutMs: ensureNumber(poolData.requestTimeoutMs, 6000, 500, 30000),
    rotationMode: ["round-robin", "weighted-round-robin", "random", "least-used", "latency"]
      .includes(poolData.rotationMode)
      ? poolData.rotationMode
      : "round-robin",
    bypassRotation: poolData.bypassRotation === true,
    useLatencyTieBreaker: poolData.useLatencyTieBreaker !== false,
    stickySec: ensureNumber(poolData.stickySec, 0, 0, 3600),
  };

  const state = {
    id: poolId,
    urls,
    weights,
    config,
    cursor: 0,
    currentWeight: 0,
    lastPick: null,
    byUrl: new Map(urls.map((url) => [url, new UrlState()])),
    sticky: new Map(), // targetKey -> { url, expiresAt }
  };

  POOL_STATES.set(poolId, state);
  maybeStartRecoveryLoop();
  return state;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function isInCooldown(urlState, cooldownMs) {
  if (urlState.ejected) return true;
  if (urlState.lastFailAt === 0) return false;
  return Date.now() - urlState.lastFailAt < cooldownMs;
}

function getHealthyUrls(state) {
  const cooldownMs = state.config.cooldownSec * SECOND_MS;
  return state.urls.filter((url) => {
    const us = state.byUrl.get(url);
    return us && !isInCooldown(us, cooldownMs);
  });
}

function setLastPick(state, url, targetKey = null) {
  state.lastPick = { url, at: Date.now() };
  const us = state.byUrl.get(url);
  if (us) us.pickCount += 1;
  if (targetKey && state.config.stickySec > 0) {
    state.sticky.set(targetKey, { url, expiresAt: Date.now() + state.config.stickySec * SECOND_MS });
  }
  return url;
}

function expireSticky(state) {
  const now = Date.now();
  for (const [key, entry] of state.sticky.entries()) {
    if (entry.expiresAt <= now) state.sticky.delete(key);
  }
}

function pickWithLatencyTieBreaker(state, candidates, basePick) {
  if (!state.config.useLatencyTieBreaker || candidates.length === 0) return basePick;
  // Among candidates that are within one slot of basePick in pickCount/weight terms,
  // prefer lower avgLatencyMs.
  const latencyWindow = 1; // slots
  const baseIndex = candidates.indexOf(basePick);
  if (baseIndex < 0) return basePick;
  const windowStart = Math.max(0, baseIndex - latencyWindow);
  const windowEnd = Math.min(candidates.length, baseIndex + latencyWindow + 1);
  let best = basePick;
  let bestLatency = state.byUrl.get(basePick)?.avgLatencyMs || Infinity;
  for (let i = windowStart; i < windowEnd; i++) {
    const url = candidates[i];
    const latency = state.byUrl.get(url)?.avgLatencyMs || Infinity;
    if (latency < bestLatency) {
      bestLatency = latency;
      best = url;
    }
  }
  return best;
}

function buildWeightedCandidates(healthy, weights) {
  const candidates = [];
  for (let i = 0; i < healthy.length; i++) {
    const url = healthy[i];
    const weight = weights[i] || 1;
    for (let w = 0; w < weight; w++) candidates.push(url);
  }
  return candidates;
}

export function nextProxyUrl(poolId, poolData, targetKey = null) {
  const state = getOrCreateState(poolId, poolData);
  if (state.urls.length === 0) return null;

  expireSticky(state);

  // Sticky window wins if active
  if (targetKey && state.config.stickySec > 0) {
    const sticky = state.sticky.get(targetKey);
    if (sticky) {
      const us = state.byUrl.get(sticky.url);
      const cooldownMs = state.config.cooldownSec * SECOND_MS;
      if (us && !isInCooldown(us, cooldownMs)) {
        return setLastPick(state, sticky.url, targetKey);
      }
    }
  }

  const healthy = getHealthyUrls(state);
  if (healthy.length === 0) {
    return setLastPick(state, state.urls[0], targetKey);
  }

  if (state.config.rotationMode === "random") {
    const pick = healthy[Math.floor(Math.random() * healthy.length)];
    return setLastPick(state, pick, targetKey);
  }

  if (state.config.rotationMode === "least-used") {
    const pick = healthy.reduce((a, b) => {
      const sa = state.byUrl.get(a);
      const sb = state.byUrl.get(b);
      const scoreA = sa.failCount * 1000 + sa.pickCount;
      const scoreB = sb.failCount * 1000 + sb.pickCount;
      return scoreA <= scoreB ? a : b;
    });
    return setLastPick(state, pick, targetKey);
  }

  if (state.config.rotationMode === "latency") {
    const pick = healthy.reduce((a, b) => {
      const la = state.byUrl.get(a)?.avgLatencyMs || Infinity;
      const lb = state.byUrl.get(b)?.avgLatencyMs || Infinity;
      return la <= lb ? a : b;
    });
    return setLastPick(state, pick, targetKey);
  }

  // Weighted round-robin or plain round-robin: build weighted candidate ring
  const healthyWeights = healthy.map((url) => state.weights[state.urls.indexOf(url)] || 1);
  const candidates = buildWeightedCandidates(healthy, healthyWeights);

  if (state.config.rotationMode === "weighted-round-robin") {
    const pick = candidates[state.cursor % candidates.length];
    state.cursor = (state.cursor + 1) % candidates.length;
    const finalPick = pickWithLatencyTieBreaker(state, candidates, pick);
    return setLastPick(state, finalPick, targetKey);
  }

  // Plain round-robin: uniform distribution across healthy URLs
  let pick = null;
  for (let i = 0; i < healthy.length; i++) {
    const candidate = healthy[(state.cursor + i) % healthy.length];
    pick = candidate;
    state.cursor = (state.cursor + i + 1) % healthy.length;
    break;
  }
  return setLastPick(state, pick || healthy[0], targetKey);
}

export function markProxyUrlSuccess(poolId, url, latencyMs = 0) {
  const state = POOL_STATES.get(poolId);
  if (!state || !url) return;

  const us = state.byUrl.get(url);
  if (!us) return;

  us.failCount = 0;
  us.ejected = false;
  us.successCount += 1;
  us.lastSuccessAt = Date.now();
  if (latencyMs > 0) {
    us.avgLatencyMs = us.avgLatencyMs === 0
      ? latencyMs
      : Math.round(us.avgLatencyMs * 0.7 + latencyMs * 0.3);
  }
}

export function markProxyUrlFailed(poolId, url) {
  const state = POOL_STATES.get(poolId);
  if (!state || !url) return;

  const us = state.byUrl.get(url);
  if (!us) return;

  us.failCount += 1;
  us.lastFailAt = Date.now();
  if (us.failCount >= state.config.maxStrikes) {
    us.ejected = true;
  }
}

export function getProxyPoolStats(poolId) {
  const state = POOL_STATES.get(poolId);
  if (!state) return null;

  const now = Date.now();
  const cooldownMs = state.config.cooldownSec * SECOND_MS;

  return {
    poolId,
    mode: state.config.rotationMode,
    bypassRotation: state.config.bypassRotation,
    config: { ...state.config },
    urls: state.urls.map((url, i) => {
      const us = state.byUrl.get(url) || new UrlState();
      return {
        url,
        weight: state.weights[i] ?? 1,
        state: us.ejected ? "ejected" : (now - us.lastFailAt < cooldownMs ? "cooling" : "healthy"),
        failCount: us.failCount,
        successCount: us.successCount,
        pickCount: us.pickCount,
        lastFailAt: us.lastFailAt > 0 ? new Date(us.lastFailAt).toISOString() : null,
        lastSuccessAt: us.lastSuccessAt > 0 ? new Date(us.lastSuccessAt).toISOString() : null,
        avgLatencyMs: us.avgLatencyMs,
      };
    }),
    lastPick: state.lastPick,
    stickyCount: state.sticky.size,
  };
}

export function resetPoolRotator(poolId) {
  POOL_STATES.delete(poolId);
}

/** Force rotator to re-read pool data (URLs, weights, config) from DB-level state. */
export function syncPoolState(poolData) {
  if (!poolData || !poolData.id) return;
  getOrCreateState(poolData.id, poolData);
}

export function shouldBypassRotation(poolData) {
  return poolData?.bypassRotation === true;
}

function maybeStartRecoveryLoop() {
  if (recoveryTimer) return;

  const RECOVER_INTERVAL_MS = 30 * SECOND_MS;
  recoveryTimer = setInterval(async () => {
    const jobs = [];
    for (const state of POOL_STATES.values()) {
      expireSticky(state);
      const ejected = state.urls.filter((url) => state.byUrl.get(url)?.ejected);
      if (ejected.length === 0) continue;

      const now = Date.now();
      const recoverAfterMs = state.config.recoverAfterSec * SECOND_MS;

      for (const url of ejected) {
        const us = state.byUrl.get(url);
        if (!us || now - us.lastFailAt < recoverAfterMs) continue;

        jobs.push(
          testProxyUrl({ proxyUrl: url, timeoutMs: state.config.requestTimeoutMs })
            .then((result) => {
              if (result.ok) {
                markProxyUrlSuccess(state.id, url, result.elapsedMs);
              } else {
                us.lastFailAt = now;
              }
            })
            .catch(() => {
              us.lastFailAt = now;
            })
        );
      }
    }

    if (jobs.length > 0) {
      await Promise.allSettled(jobs);
    }
  }, RECOVER_INTERVAL_MS);

  recoveryTimer.unref?.();
}

// Self-check: quick assertions for core rotator logic
export function _selfCheck() {
  const poolId = "check-" + Date.now();
  const data = {
    proxyUrls: ["http://a", "http://b", "http://c"],
    rotationMode: "round-robin",
    maxStrikes: 2,
    cooldownSec: 0,
  };
  const picks = [
    nextProxyUrl(poolId, data),
    nextProxyUrl(poolId, data),
    nextProxyUrl(poolId, data),
    nextProxyUrl(poolId, data),
  ];
  if (picks.join(",") !== "http://a,http://b,http://c,http://a") {
    throw new Error(`Round-robin self-check failed: ${picks.join(",")}`);
  }

  // Weighted round-robin: a=3, b=1 => a,a,a,b,a,a,a,b...
  resetPoolRotator(poolId);
  const wData = {
    proxyUrls: ["http://a", "http://b"],
    proxyWeights: [3, 1],
    rotationMode: "weighted-round-robin",
    cooldownSec: 0,
  };
  const wPicks = Array.from({ length: 8 }, () => nextProxyUrl(poolId, wData));
  if (wPicks.join(",") !== "http://a,http://a,http://a,http://b,http://a,http://a,http://a,http://b") {
    throw new Error(`Weighted round-robin self-check failed: ${wPicks.join(",")}`);
  }

  markProxyUrlFailed(poolId, "http://b");
  markProxyUrlFailed(poolId, "http://b");
  if (!getProxyPoolStats(poolId).urls.find((u) => u.url === "http://b").state === "ejected") {
    throw new Error("Eject self-check failed");
  }

  resetPoolRotator(poolId);
  return true;
}
