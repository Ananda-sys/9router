import { NextResponse } from "next/server";
import { createProxyPool, getProviderConnections, getProxyPools } from "@/models";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno"];
const VALID_ROTATION_MODES = ["round-robin", "weighted-round-robin", "random", "least-used", "latency"];

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function normalizeProxyPoolInput(body = {}) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
  const proxyUrls = normalizeStringArray(body?.proxyUrls);
  const noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  const isActive = body?.isActive === undefined ? true : body.isActive === true;
  const strictProxy = body?.strictProxy === true;
  const type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : "http";
  const rotationMode = VALID_ROTATION_MODES.includes(body?.rotationMode)
    ? body.rotationMode
    : "round-robin";
  const cooldownSec = Math.max(0, Math.min(3600, Number(body?.cooldownSec) || 30));
  const maxStrikes = Math.max(1, Math.min(100, Number(body?.maxStrikes) || 3));
  const recoverAfterSec = Math.max(10, Math.min(86400, Number(body?.recoverAfterSec) || 300));
  const requestTimeoutMs = Math.max(500, Math.min(30000, Number(body?.requestTimeoutMs) || 6000));
  const bypassRotation = body?.bypassRotation === true;
  const proxyWeights = Array.isArray(body?.proxyWeights)
    ? body.proxyWeights.map((w) => Math.max(1, Math.min(100, Number(w) || 1)))
    : undefined;
  const stickySec = Math.max(0, Math.min(3600, Number(body?.stickySec) || 0));
  const useLatencyTieBreaker = body?.useLatencyTieBreaker !== false;

  if (!name) {
    return { error: "Name is required" };
  }

  if (!proxyUrl && proxyUrls.length === 0) {
    return { error: "Proxy URL or proxyUrls array is required" };
  }

  return { name, proxyUrl, proxyUrls, noProxy, isActive, strictProxy, type,
    rotationMode, cooldownSec, maxStrikes, recoverAfterSec, requestTimeoutMs, bypassRotation,
    proxyWeights, stickySec, useLatencyTieBreaker };
}

function buildUsageMap(connections = []) {
  const usageMap = new Map();

  for (const connection of connections) {
    const proxyPoolId = connection?.providerSpecificData?.proxyPoolId;
    if (!proxyPoolId) continue;

    usageMap.set(proxyPoolId, (usageMap.get(proxyPoolId) || 0) + 1);
  }

  return usageMap;
}

// GET /api/proxy-pools - List proxy pools
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const isActive = toBoolean(searchParams.get("isActive"));
    const includeUsage = searchParams.get("includeUsage") === "true";

    const filter = {};
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    const proxyPools = await getProxyPools(filter);

    if (!includeUsage) {
      return NextResponse.json({ proxyPools });
    }

    const connections = await getProviderConnections();
    const usageMap = buildUsageMap(connections);

    const enrichedProxyPools = proxyPools.map((pool) => ({
      ...pool,
      boundConnectionCount: usageMap.get(pool.id) || 0,
    }));

    return NextResponse.json({ proxyPools: enrichedProxyPools });
  } catch (error) {
    console.log("Error fetching proxy pools:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pools" }, { status: 500 });
  }
}

// POST /api/proxy-pools - Create proxy pool
export async function POST(request) {
  try {
    const body = await request.json();
    const normalized = normalizeProxyPoolInput(body);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const proxyPool = await createProxyPool(normalized);
    return NextResponse.json({ proxyPool }, { status: 201 });
  } catch (error) {
    console.log("Error creating proxy pool:", error);
    return NextResponse.json({ error: "Failed to create proxy pool" }, { status: 500 });
  }
}
