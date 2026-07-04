import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { getProxyPoolStats } from "@/lib/network/proxyRotator";

// GET /api/proxy-pools/[id]/stats - Per-pool URL health & rotation stats
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const stats = getProxyPoolStats(id);

    // If rotator hasn't been initialized yet, return static pool info
    if (!stats) {
      return NextResponse.json({
        poolId: id,
        mode: proxyPool.rotationMode || "round-robin",
        urls: (proxyPool.proxyUrls || [proxyPool.proxyUrl].filter(Boolean)).map((url) => ({
          url,
          state: "unknown",
          failCount: 0,
          successCount: 0,
          lastFailAt: null,
          lastSuccessAt: null,
          avgLatencyMs: 0,
        })),
        config: {
          rotationMode: proxyPool.rotationMode || "round-robin",
          cooldownSec: proxyPool.cooldownSec ?? 30,
          maxStrikes: proxyPool.maxStrikes ?? 3,
          recoverAfterSec: proxyPool.recoverAfterSec ?? 300,
          requestTimeoutMs: proxyPool.requestTimeoutMs ?? 6000,
          bypassRotation: proxyPool.bypassRotation === true,
        },
        lastPick: null,
      });
    }

    return NextResponse.json({ stats });
  } catch (error) {
    console.log("Error fetching proxy pool stats:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pool stats" }, { status: 500 });
  }
}
