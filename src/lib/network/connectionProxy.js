import { getProxyPoolById } from "@/models";
import {
  nextProxyUrl,
  shouldBypassRotation,
} from "@/lib/network/proxyRotator";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function toVercelPayload(proxyPool) {
  const proxyUrl = normalizeString(proxyPool?.proxyUrl);
  const noProxy = normalizeString(proxyPool?.noProxy);
  return {
    source: proxyPool.type,

    proxyPoolId: proxyPool.id,
    proxyPool,

    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: noProxy,

    strictProxy: proxyPool.strictProxy === true,

    vercelRelayUrl: proxyUrl,
  };
}

function toStandardPayload(proxyPool, proxyUrl) {
  const noProxy = normalizeString(proxyPool?.noProxy);
  return {
    source: "pool",

    proxyPoolId: proxyPool.id,
    proxyPool,

    connectionProxyEnabled: true,
    connectionProxyUrl: proxyUrl,
    connectionNoProxy: noProxy,

    strictProxy: proxyPool.strictProxy === true,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const proxyUrls = normalizeStringArray(proxyPool?.proxyUrls);
      const effectiveProxyUrls = proxyUrls.length > 0 ? proxyUrls : (proxyUrl ? [proxyUrl] : []);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        effectiveProxyUrls.length > 0;

      if (isValidPool) {
        /**
         * APIs that have global rate-limits gain nothing from IP rotation.
         * bypassRotation=true makes the resolver skip the pool entirely.
         */
        if (shouldBypassRotation(proxyPool)) {
          return {
            source: "pool-bypass",
            proxyPoolId,
            proxyPool,
            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: normalizeString(proxyPool?.noProxy),
            strictProxy: proxyPool.strictProxy === true,
            rotationSkipped: true,
          };
        }

        /**
         * Vercel/Cloudflare/Deno relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
          // Single relay URL remains the legacy path
          if (proxyUrls.length === 0) {
            return toVercelPayload(proxyPool);
          }
          // Multi-URL relay pools pick one via the rotator and expose it as
          // the primary proxyUrl while still flagging the relay type.
          const pickedUrl = nextProxyUrl(proxyPool.id, proxyPool) || effectiveProxyUrls[0];
          return {
            source: proxyPool.type,
            proxyPoolId,
            proxyPool,
            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: normalizeString(proxyPool?.noProxy),
            strictProxy: proxyPool.strictProxy === true,
            vercelRelayUrl: pickedUrl,
            rotationEnabled: proxyUrls.length > 1,
          };
        }

        /**
         * Standard proxy pool
         */
        if (proxyUrls.length >= 1) {
          const pickedUrl = nextProxyUrl(proxyPool.id, proxyPool);
          if (pickedUrl) {
            return {
              ...toStandardPayload(proxyPool, pickedUrl),
              rotationEnabled: true,
            };
          }
        }

        return toStandardPayload(proxyPool, proxyUrl || effectiveProxyUrls[0]);
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}
