import { NextResponse } from "next/server";
import {
  deleteProxyPool,
  getProviderConnections,
  getProxyPoolById,
  updateProxyPool,
} from "@/models";

const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno"];
const VALID_ROTATION_MODES = ["round-robin", "random", "least-used"];

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeProxyPoolUpdate(body = {}) {
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return { error: "Name is required" };
    }
    updates.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(body, "proxyUrl")) {
    updates.proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
  }

  if (Object.prototype.hasOwnProperty.call(body, "proxyUrls")) {
    updates.proxyUrls = normalizeStringArray(body?.proxyUrls);
  }

  if (Object.prototype.hasOwnProperty.call(body, "noProxy")) {
    updates.noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  }

  if (Object.prototype.hasOwnProperty.call(body, "isActive")) {
    updates.isActive = body?.isActive === true;
  }

  if (Object.prototype.hasOwnProperty.call(body, "strictProxy")) {
    updates.strictProxy = body?.strictProxy === true;
  }

  if (Object.prototype.hasOwnProperty.call(body, "type")) {
    updates.type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : "http";
  }

  if (Object.prototype.hasOwnProperty.call(body, "rotationMode")) {
    updates.rotationMode = VALID_ROTATION_MODES.includes(body?.rotationMode)
      ? body.rotationMode
      : "round-robin";
  }

  if (Object.prototype.hasOwnProperty.call(body, "cooldownSec")) {
    updates.cooldownSec = Math.max(0, Math.min(3600, Number(body?.cooldownSec) || 30));
  }

  if (Object.prototype.hasOwnProperty.call(body, "maxStrikes")) {
    updates.maxStrikes = Math.max(1, Math.min(100, Number(body?.maxStrikes) || 3));
  }

  if (Object.prototype.hasOwnProperty.call(body, "recoverAfterSec")) {
    updates.recoverAfterSec = Math.max(10, Math.min(86400, Number(body?.recoverAfterSec) || 300));
  }

  if (Object.prototype.hasOwnProperty.call(body, "requestTimeoutMs")) {
    updates.requestTimeoutMs = Math.max(500, Math.min(30000, Number(body?.requestTimeoutMs) || 6000));
  }

  if (Object.prototype.hasOwnProperty.call(body, "bypassRotation")) {
    updates.bypassRotation = body?.bypassRotation === true;
  }

  return { updates };
}

function countBoundConnections(connections = [], proxyPoolId) {
  return connections.filter((connection) => connection?.providerSpecificData?.proxyPoolId === proxyPoolId).length;
}

// GET /api/proxy-pools/[id] - Get proxy pool
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    return NextResponse.json({ proxyPool });
  } catch (error) {
    console.log("Error fetching proxy pool:", error);
    return NextResponse.json({ error: "Failed to fetch proxy pool" }, { status: 500 });
  }
}

// PUT /api/proxy-pools/[id] - Update proxy pool
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);

    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const body = await request.json();
    const normalized = normalizeProxyPoolUpdate(body);

    if (normalized.error) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const updated = await updateProxyPool(id, normalized.updates);
    return NextResponse.json({ proxyPool: updated });
  } catch (error) {
    console.log("Error updating proxy pool:", error);
    return NextResponse.json({ error: "Failed to update proxy pool" }, { status: 500 });
  }
}

// DELETE /api/proxy-pools/[id] - Delete proxy pool
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);

    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const connections = await getProviderConnections();
    const boundConnectionCount = countBoundConnections(connections, id);

    if (boundConnectionCount > 0) {
      return NextResponse.json(
        {
          error: "Proxy pool is currently in use",
          boundConnectionCount,
        },
        { status: 409 }
      );
    }

    await deleteProxyPool(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting proxy pool:", error);
    return NextResponse.json({ error: "Failed to delete proxy pool" }, { status: 500 });
  }
}
