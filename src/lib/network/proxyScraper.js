import { fetch as undiciFetch } from "undici";
import { testProxyUrl } from "@/lib/network/proxyTest";

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_CONCURRENT_TESTS = 6;

function normalizeProxyUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(trimmed)) {
      return `http://${trimmed}`;
    }
  }
  return null;
}

async function fetchText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseProxyListText(text) {
  if (!text) return [];
  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;
    const normalized = normalizeProxyUrl(clean);
    if (normalized) urls.push(normalized);
  }
  return [...new Set(urls)];
}

export const DEFAULT_FREE_PROXY_SOURCES = [
  {
    id: "proxy-list.download",
    url: "https://www.proxy-list.download/api/v1/get?type=http",
    expectedCount: 10,
  },
  {
    id: "geonode",
    url: "https://proxylist.geonode.com/api/proxy-list?limit=50&page=1&sort_by=lastChecked&sort_type=desc&protocols=http",
    parser: (text) => {
      try {
        const data = JSON.parse(text);
        return (data.data || [])
          .map((p) => `http://${p.ip}:${p.port}`)
          .filter(Boolean);
      } catch {
        return [];
      }
    },
    expectedCount: 10,
  },
];

async function testProxies({ urls, timeoutMs, maxConcurrent = MAX_CONCURRENT_TESTS }) {
  const limitedTimeoutMs = Math.max(500, Math.min(30000, timeoutMs || DEFAULT_TIMEOUT_MS));
  const results = [];

  for (let i = 0; i < urls.length; i += maxConcurrent) {
    const batch = urls.slice(i, i + maxConcurrent);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        const result = await testProxyUrl({ proxyUrl: url, timeoutMs: limitedTimeoutMs });
        return { url, ...result };
      })
    );

    for (const item of settled) {
      if (item.status === "fulfilled") results.push(item.value);
    }
  }

  return results;
}

function pickUrlsForTesting(urls, maxPerSource = 100) {
  return urls.slice(0, maxPerSource);
}

/**
 * Scrape and test free proxies from configured sources.
 *
 * @param {Object} options
 * @param {Array<{id:string,url:string,parser?:Function,expectedCount?:number}>} options.sources
 * @param {number} options.timeoutMs
 * @param {number} options.maxPerSource
 * @returns {Promise<{scraped:number, tested:number, alive:Array<{url,status,elapsedMs}>, dead:Array<{url,error}>, sources:Array}>}
 */
export async function scrapeAndTestFreeProxies(options = {}) {
  const sources = options.sources || DEFAULT_FREE_PROXY_SOURCES;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxPerSource = options.maxPerSource || 100;

  const sourceResults = [];
  const alive = [];
  const dead = [];
  let totalScraped = 0;

  for (const source of sources) {
    const text = await fetchText(source.url);
    if (!text) {
      sourceResults.push({ id: source.id, scraped: 0, alive: 0, error: "fetch failed" });
      continue;
    }

    const rawUrls = source.parser
      ? source.parser(text)
      : parseProxyListText(text);

    const uniqueUrls = [...new Set(rawUrls)];
    const toTest = pickUrlsForTesting(uniqueUrls, maxPerSource);
    totalScraped += toTest.length;

    const tested = toTest.length > 0
      ? await testProxies({ urls: toTest, timeoutMs })
      : [];

    const sourceAlive = [];
    const sourceDead = [];

    for (const r of tested) {
      if (r.ok) {
        alive.push({ url: r.url, status: r.status, elapsedMs: r.elapsedMs });
        sourceAlive.push(r.url);
      } else {
        dead.push({ url: r.url, error: r.error || `status ${r.status}` });
        sourceDead.push(r.url);
      }
    }

    sourceResults.push({
      id: source.id,
      scraped: toTest.length,
      alive: sourceAlive.length,
      dead: sourceDead.length,
    });
  }

  return {
    scraped: totalScraped,
    tested: alive.length + dead.length,
    alive: alive.slice(0, 200),
    dead: dead.slice(0, 200),
    sources: sourceResults,
  };
}
