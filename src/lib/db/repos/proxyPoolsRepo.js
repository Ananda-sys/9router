import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProxyPools(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  const sql = `SELECT * FROM proxyPools${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map(rowToPool);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getProxyPoolById(id) {
  const db = await getAdapter();
  return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]));
}

export async function createProxyPool(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const proxyUrls = Array.isArray(data.proxyUrls)
    ? data.proxyUrls.filter((u) => typeof u === "string" && u.trim()).map((u) => u.trim())
    : undefined;
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    proxyUrls,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    rotationMode: ["round-robin", "random", "least-used"].includes(data.rotationMode)
      ? data.rotationMode
      : "round-robin",
    cooldownSec: Math.max(0, Math.min(3600, Number(data.cooldownSec) || 30)),
    maxStrikes: Math.max(1, Math.min(100, Number(data.maxStrikes) || 3)),
    recoverAfterSec: Math.max(10, Math.min(86400, Number(data.recoverAfterSec) || 300)),
    requestTimeoutMs: Math.max(500, Math.min(30000, Number(data.requestTimeoutMs) || 6000)),
    bypassRotation: data.bypassRotation === true,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, pool);
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    const existing = rowToPool(row);
    const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };

    // Normalize numeric/new fields if they were sent in `data`
    if (data.proxyUrls !== undefined) {
      merged.proxyUrls = Array.isArray(data.proxyUrls)
        ? data.proxyUrls.filter((u) => typeof u === "string" && u.trim()).map((u) => u.trim())
        : existing.proxyUrls;
    }
    if (data.rotationMode !== undefined) {
      merged.rotationMode = ["round-robin", "random", "least-used"].includes(data.rotationMode)
        ? data.rotationMode
        : "round-robin";
    }
    if (data.cooldownSec !== undefined) {
      merged.cooldownSec = Math.max(0, Math.min(3600, Number(data.cooldownSec) || 30));
    }
    if (data.maxStrikes !== undefined) {
      merged.maxStrikes = Math.max(1, Math.min(100, Number(data.maxStrikes) || 3));
    }
    if (data.recoverAfterSec !== undefined) {
      merged.recoverAfterSec = Math.max(10, Math.min(86400, Number(data.recoverAfterSec) || 300));
    }
    if (data.requestTimeoutMs !== undefined) {
      merged.requestTimeoutMs = Math.max(500, Math.min(30000, Number(data.requestTimeoutMs) || 6000));
    }
    if (data.bypassRotation !== undefined) {
      merged.bypassRotation = data.bypassRotation === true;
    }

    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToPool(row);
    db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
  });
  return removed;
}
