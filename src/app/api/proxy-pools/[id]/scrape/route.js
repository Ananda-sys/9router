import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { scrapeAndTestFreeProxies } from "@/lib/network/proxyScraper";

// POST /api/proxy-pools/[id]/scrape — scrape free proxies into this pool
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const timeoutMs = Math.max(500, Math.min(30000, Number(proxyPool.requestTimeoutMs) || 6000));
    const body = await request.json().catch(() => ({}));

    const result = await scrapeAndTestFreeProxies({
      sources: body.sources || undefined,
      timeoutMs,
      maxPerSource: Math.min(body.maxPerSource || 100, 200),
    });

    const newUrls = result.alive.map((p) => p.url);
    if (newUrls.length === 0) {
      return NextResponse.json({
        ok: false,
        message: "No alive proxies found from any source",
        ...result,
      });
    }

    const existingUrls = Array.isArray(proxyPool.proxyUrls)
      ? proxyPool.proxyUrls.filter((u) => typeof u === "string" && u.trim())
      : [];
    if (proxyPool.proxyUrl && !existingUrls.includes(proxyPool.proxyUrl)) {
      existingUrls.unshift(proxyPool.proxyUrl);
    }

    const merged = [...existingUrls];
    let added = 0;
    let skipped = 0;
    for (const url of newUrls) {
      if (!merged.includes(url)) {
        merged.push(url);
        added++;
      } else {
        skipped++;
      }
    }

    await updateProxyPool(id, { proxyUrls: merged, testStatus: merged.length > 0 ? "active" : "unknown" });

    return NextResponse.json({
      ok: true,
      added,
      skipped,
      totalUrls: merged.length,
      aliveCount: result.alive.length,
      proxies: result.alive.slice(0, 20),
      sources: result.sources,
    });
  } catch (error) {
    console.log("Error scraping proxies:", error);
    return NextResponse.json({ error: "Failed to scrape proxies" }, { status: 500 });
  }
}
