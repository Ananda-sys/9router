import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { fetch as undiciFetch } from "undici";

async function testVercelRelay(relayUrl, timeoutMs = 10000) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(relayUrl, {
      method: "GET",
      headers: {
        "x-relay-target": "https://httpbin.org",
        "x-relay-path": "/get",
      },
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.name === "AbortError" ? "Relay test timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const proxyUrls = normalizeStringArray(proxyPool.proxyUrls);
    const singleUrl = proxyPool.proxyUrl;
    const urlsToTest = proxyUrls.length > 0
      ? proxyUrls
      : (singleUrl ? [singleUrl] : []);

    if (urlsToTest.length === 0) {
      return NextResponse.json({ error: "Proxy pool has no proxy URLs" }, { status: 400 });
    }

    const timeoutMs = Math.max(500, Math.min(30000, Number(proxyPool.requestTimeoutMs) || 10000));
    const isRelay = proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno";

    const urlResults = await Promise.all(
      urlsToTest.map(async (url) => {
        const result = isRelay
          ? await testVercelRelay(url, timeoutMs)
          : await testProxyUrl({ proxyUrl: url, timeoutMs });
        return { url, ...result };
      })
    );

    const now = new Date().toISOString();
    const anyOk = urlResults.some((r) => r.ok);
    const firstError = urlResults.find((r) => !r.ok && r.error)?.error || null;

    await updateProxyPool(id, {
      testStatus: anyOk ? "active" : "error",
      lastTestedAt: now,
      lastError: anyOk ? null : firstError,
      isActive: anyOk,
    });

    return NextResponse.json({
      ok: anyOk,
      testedAt: now,
      urlResults: urlResults.map((r) => ({
        url: r.url,
        ok: r.ok,
        status: r.status,
        statusText: r.statusText || null,
        error: r.error || null,
        elapsedMs: r.elapsedMs || 0,
      })),
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
