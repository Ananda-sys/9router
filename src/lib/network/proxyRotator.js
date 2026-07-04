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
  }
}

function getOrCreateState(poolId, poolData = {}) {
  if (POOL_STATES.has(poolId)) return POOL_STATES.get(poolId);

  const urls = normalizeStringArray(poolData.proxyUrls);
  const config = {
    cooldownSec: ensureNumber(poolData.cooldownSec, 30, 0, 3600),
    maxStrikes: ensureNumber(poolData.maxStrikes, 3, 1, 100),
    recoverAfterSec: ensureNumber(poolData.recoverAfterSec, 300, 10, 86400),
    requestTimeoutMs: ensureNumber(poolData.requestTimeoutMs, 6000, 500, 30000),
    rotationMode: ["round-robin", "random", "least-used"].includes(poolData.rotationMode)
      ? poolData.rotationMode
      : "round-robin",
    bypassRotation: poolData.bypassRotation === true,
  };

  const state = {
    id: poolId,
    urls,
    config,
    cursor: 0,
    lastPick: null,
    byUrl: new Map(urls.map((url) => [url, new UrlState()])),
  };

  POOL_STATES.set(poolId, state);
  maybeStartRecoveryLoop();
  return state;
}

function isInCooldown(urlState, cooldownMs) {
  if (urlState.ejected) return true; // ejected URLs skip until explicitly recovered
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

function setLastPick(state, url) {
  state.lastPick = { url, at: Date.now() };
  return url;
}

export function nextProxyUrl(poolId, poolData) {
  const state = getOrCreateState(poolId, poolData);
  if (state.urls.length === 0) return null;

  const healthy = getHealthyUrls(state);
  if (healthy.length === 0) {
    // All URLs cooling/ejected -> fallback to all URLs (existing behavior)
    return setLastPick(state, state.urls[0]);
  }

  if (state.config.rotationMode === "random") {
    const pick = healthy[Math.floor(Math.random() * healthy.length)];
    return setLastPick(state, pick);
  }

  if (state.config.rotationMode === "least-used") {
    const pick = healthy.reduce((a, b) => {
      const sa = state.byUrl.get(a);
      const sb = state.byUrl.get(b);
      const scoreA = sa.failCount * 1000 + sa.successCount;
      const scoreB = sb.failCount * 1000 + sb.successCount;
      return scoreA <= scoreB ? a : b;
    });
    return setLastPick(state, pick);
  }

  // Default round-robin: advance cursor until a healthy URL is found
  let pick = null;
  for (let i = 0; i < state.urls.length; i++) {
    const candidate = state.urls[(state.cursor + i) % state.urls.length];
    if (healthy.includes(candidate)) {
      pick = candidate;
      state.cursor = (state.cursor + i + 1) % state.urls.length;
      break;
    }
  }
  return setLastPick(state, pick || state.urls[0]);
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
    urls: state.urls.map((url) => {
      const us = state.byUrl.get(url) || new UrlState();
      return {
        url,
        state: us.ejected ? "ejected" : (now - us.lastFailAt < cooldownMs ? "cooling" : "healthy"),
        failCount: us.failCount,
        successCount: us.successCount,
        lastFailAt: us.lastFailAt > 0 ? new Date(us.lastFailAt).toISOString() : null,
        lastSuccessAt: us.lastSuccessAt > 0 ? new Date(us.lastSuccessAt).toISOString() : null,
        avgLatencyMs: us.avgLatencyMs,
      };
    }),
    lastPick: state.lastPick,
  };
}

export function resetPoolRotator(poolId) {
  POOL_STATES.delete(poolId);
}

/**
 * Check whether a pool should bypass proxy rotation entirely.
 */
export function shouldBypassRotation(poolData) {
  return poolData?.bypassRotation === true;
}

function maybeStartRecoveryLoop() {
  if (recoveryTimer) return;

  const RECOVER_INTERVAL_MS = 30 * SECOND_MS;
  recoveryTimer = setInterval(async () => {
    const jobs = [];
    for (const state of POOL_STATES.values()) {
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
                us.lastFailAt = now; // extend wait period
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

  // Node timer keeps process alive; fine for Next.js server runtime.
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

  markProxyUrlFailed(poolId, "http://b");
  markProxyUrlFailed(poolId, "http://b");
  if (!getProxyPoolStats(poolId).urls.find((u) => u.url === "http://b").state === "ejected") {
    throw new Error("Eject self-check failed");
  }

  resetPoolRotator(poolId);
  return true;
}
