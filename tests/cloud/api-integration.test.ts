import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { phase1Tools } from '../../shared/phase1-tools.ts';
import {
  InMemoryAuthCache,
  InMemoryAuthStore,
  SESSION_COOKIE_NAME,
  createBrowserSession,
  createPat,
} from '../../src/auth/index.ts';
import { DEFAULT_PAT_SCOPES, type AuthContext } from '../../src/contracts/auth.ts';
import { CloudError } from '../../src/contracts/errors.ts';
import type { RenderWorkerHealth } from '../../src/contracts/events.ts';
import type {
  HeadObjectResult,
  ObjectStreamResult,
  PresignGetOptions,
  PresignPutOptions,
  StoragePort,
} from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';
import * as schema from '../../src/db/schema/index.ts';
import {
  createApiApp,
  type ApiEventBusPort,
  type ApiQueuesPort,
  type CreateApiAppDeps,
} from '../../src/entrypoints/api.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import { createLogger } from '../../src/infra/logger.ts';
import { InMemoryMcpSessionStore } from '../../src/mcp/index.ts';
import { MockModelGateway } from '../../src/services/mock-model-adapter.ts';
import type { WelcomeBootstrapService } from '../../src/services/welcome-bootstrap.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SILENT_LOGGER = createLogger({ level: 'error' });

// ---------------------------------------------------------------------------
// Deterministic In-Memory Drizzle PG + S3 + Redis + BullMQ Test Harness
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const UUID_TABLES = new Set([
  'workspaces',
  'sessions',
  'projects',
  'work_rounds',
  'project_versions',
  'project_history_entries',
  'assets',
  'asset_versions',
  'upload_tickets',
  'jobs',
]);

class ApiTestPgClient {
  readonly tables = new Map<string, Row[]>();
  private snap: Map<string, Row[]> | null = null;

  constructor() {
    for (const table of [
      'workspaces',
      'sessions',
      'session_messages',
      'projects',
      'work_rounds',
      'project_files',
      'project_versions',
      'project_version_files',
      'project_history_entries',
      'workspace_blobs',
      'catalog_templates',
      'catalog_template_files',
      'assets',
      'asset_versions',
      'upload_tickets',
      'jobs',
      'idempotency_receipts',
    ]) {
      this.tables.set(table, []);
    }
  }

  seed(table: string, row: Row): void {
    this.tables.get(table)!.push({ ...row });
  }

  rows(table: string): Row[] {
    return this.tables.get(table)!;
  }

  async query(
    config: string | { text: string; rowMode?: string },
    params: unknown[] = [],
  ): Promise<{ rows: unknown[] }> {
    const sqlText = (typeof config === 'string' ? config : config.text).trim();
    const rowMode = typeof config === 'string' ? undefined : config.rowMode;
    const upper = sqlText.toUpperCase();

    if (upper === 'SELECT 1') {
      return { rows: [rowMode === 'array' ? [1] : { '?column?': 1 }] };
    }
    if (upper === 'BEGIN' || upper.startsWith('BEGIN ')) {
      this.snap = new Map(
        [...this.tables.entries()].map(([k, v]) => [k, v.map((r) => structuredClone(r))]),
      );
      return { rows: [] };
    }
    if (upper === 'COMMIT') {
      this.snap = null;
      return { rows: [] };
    }
    if (upper === 'ROLLBACK') {
      if (this.snap) {
        this.tables.clear();
        for (const [k, v] of this.snap) this.tables.set(k, v);
        this.snap = null;
      }
      return { rows: [] };
    }
    if (upper.startsWith('SELECT ')) return this.select(sqlText, params, rowMode);
    if (upper.startsWith('INSERT INTO ')) return this.insert(sqlText, params, rowMode);
    if (upper.startsWith('UPDATE ')) return this.update(sqlText, params, rowMode);
    if (upper.startsWith('DELETE FROM ')) return this.del(sqlText, params, rowMode);
    throw new Error(`Unsupported SQL in ApiTestPgClient: ${sqlText}`);
  }

  private select(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const cleaned = sqlText.replace(/\s+for\s+update\s*$/i, '').trim();
    const m = /^select\s+([\s\S]+?)\s+from\s+"([^"]+)"([\s\S]*)$/i.exec(cleaned);
    if (!m) throw new Error(`Unsupported SELECT: ${sqlText}`);
    const selectList = m[1].trim();
    const table = m[2];
    let rem = m[3].trim();
    let limit: number | null = null;
    let offset = 0;
    let order = '';
    let where = '';

    const offM = /\s+offset\s+(\$\d+|\d+)\s*$/i.exec(rem);
    if (offM) {
      offset = offM[1].startsWith('$') ? Number(params[Number(offM[1].slice(1)) - 1]) : Number(offM[1]);
      rem = rem.slice(0, offM.index).trim();
    }
    const limM = /\s+limit\s+(\$\d+|\d+)\s*$/i.exec(rem);
    if (limM) {
      limit = limM[1].startsWith('$') ? Number(params[Number(limM[1].slice(1)) - 1]) : Number(limM[1]);
      rem = rem.slice(0, limM.index).trim();
    }
    const ordM = /\s+order\s+by\s+([\s\S]+)$/i.exec(rem);
    if (ordM) {
      order = ordM[1].trim();
      rem = rem.slice(0, ordM.index).trim();
    }
    const whM = /^where\s+([\s\S]+)$/i.exec(rem);
    if (whM) where = whM[1].trim();

    let matched = this.rows(table).filter((r) => (where ? evalW(r, where, params) : true));
    if (/^COALESCE\s*\(\s*MAX\s*\(/i.test(selectList)) {
      const col = /MAX\s*\(\s*"([^"]+)"\s*\)/i.exec(selectList)![1];
      const maxVal = matched.reduce((acc, r) => Math.max(acc, Number(r[col] ?? 0)), 0);
      return { rows: [rowMode === 'array' ? [maxVal] : { maxVal }] };
    }
    if (/^count\s*\(/i.test(selectList)) {
      return { rows: [rowMode === 'array' ? [matched.length] : { count: matched.length }] };
    }
    if (order) {
      const specs = splitTop(order, ',').map((p) => {
        const parts = p.trim().split(/\s+/);
        return { col: colName(parts[0]), dir: parts[1]?.toLowerCase() === 'desc' ? -1 : 1 };
      });
      matched = [...matched].sort((a, b) => {
        for (const s of specs) {
          const av = sortVal(a[s.col]);
          const bv = sortVal(b[s.col]);
          if (av < bv) return -s.dir;
          if (av > bv) return s.dir;
        }
        return 0;
      });
    }
    if (offset > 0) matched = matched.slice(offset);
    if (limit !== null) matched = matched.slice(0, limit);
    const cols = splitTop(selectList, ',').map(colName);
    return { rows: fmtRows(matched, cols, rowMode) };
  }

  private insert(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const retM = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const retCols = retM ? splitTop(retM[1], ',').map(colName) : null;
    const noRet = retM ? sqlText.slice(0, retM.index).trim() : sqlText;
    const confM = /\s+on\s+conflict\s*\(([^)]+)\)\s+do\s+(nothing|update\s+set\s+([\s\S]+))$/i.exec(noRet);
    const target = confM ? splitTop(confM[1], ',').map(colName) : null;
    const doNothing = Boolean(confM && confM[2].toLowerCase() === 'nothing');
    let setC = '';
    let whereC = '';
    if (confM && confM[3]) {
      const idx = findKw(confM[3].trim(), 'where');
      setC = idx >= 0 ? confM[3].trim().slice(0, idx).trim() : confM[3].trim();
      whereC = idx >= 0 ? confM[3].trim().slice(idx + 5).trim() : '';
    }
    const base = confM ? noRet.slice(0, confM.index).trim() : noRet;
    const hM = /^insert\s+into\s+"([^"]+)"\s*\(([^)]+)\)\s+values\s+([\s\S]+)$/i.exec(base);
    if (!hM) throw new Error(`Unsupported INSERT: ${sqlText}`);
    const table = hM[1];
    const cols = splitTop(hM[2], ',').map(colName);
    const tuples = splitTuples(hM[3].trim());
    const rows = this.rows(table);
    const out: Row[] = [];

    for (const tuple of tuples) {
      const exprs = splitTop(tuple, ',');
      const row: Row = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = evalInsVal(table, cols[i], exprs[i].trim(), params);
      }
      if (UUID_TABLES.has(table) && !row.id) row.id = randomUUID();
      if (table === 'projects') {
        if (!row.artifact_id) row.artifact_id = randomUUID();
        if (row.asset_name_allocations === undefined) row.asset_name_allocations = {};
        if (row.reviews === undefined) row.reviews = [];
        if (row.trashed === undefined) row.trashed = false;
        if (row.trashed_at === undefined) row.trashed_at = null;
      }
      if (table === 'workspace_blobs' && !row.gc_state) row.gc_state = 'active';
      if (target) {
        const existing = rows.find((r) => target.every((k) => r[k] === row[k]));
        if (existing) {
          if (doNothing) continue;
          if (whereC && !evalW(existing, whereC, params)) continue;
          applySet(existing, setC, params);
          out.push(existing);
          continue;
        }
      }
      rows.push(row);
      out.push(row);
    }
    return { rows: retCols ? fmtRows(out, retCols, rowMode) : [] };
  }

  private update(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const retM = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const retCols = retM ? splitTop(retM[1], ',').map(colName) : null;
    const noRet = retM ? sqlText.slice(0, retM.index).trim() : sqlText;
    const m = /^update\s+"([^"]+)"\s+set\s+([\s\S]+)$/i.exec(noRet);
    if (!m) throw new Error(`Unsupported UPDATE: ${sqlText}`);
    const table = m[1];
    const body = m[2].trim();
    const wIdx = findKw(body, 'where');
    const setC = wIdx >= 0 ? body.slice(0, wIdx).trim() : body;
    const whereC = wIdx >= 0 ? body.slice(wIdx + 5).trim() : '';
    const matched = this.rows(table).filter((r) => (whereC ? evalW(r, whereC, params) : true));
    for (const r of matched) applySet(r, setC, params);
    return { rows: retCols ? fmtRows(matched, retCols, rowMode) : [] };
  }

  private del(sqlText: string, params: unknown[], rowMode?: string): { rows: unknown[] } {
    const retM = /\s+returning\s+([\s\S]+)$/i.exec(sqlText);
    const retCols = retM ? splitTop(retM[1], ',').map(colName) : null;
    const noRet = retM ? sqlText.slice(0, retM.index).trim() : sqlText;
    const m = /^delete\s+from\s+"([^"]+)"(?:\s+where\s+([\s\S]+))?$/i.exec(noRet);
    if (!m) throw new Error(`Unsupported DELETE: ${sqlText}`);
    const table = m[1];
    const whereC = m[2]?.trim() ?? '';
    const kept: Row[] = [];
    const removed: Row[] = [];
    for (const r of this.rows(table)) {
      if (!whereC || evalW(r, whereC, params)) removed.push(r);
      else kept.push(r);
    }
    this.tables.set(table, kept);
    return { rows: retCols ? fmtRows(removed, retCols, rowMode) : [] };
  }
}

function colName(expr: string): string {
  const m = [...expr.trim().replace(/\s+as\s+"[^"]+"$/i, '').matchAll(/"([^"]+)"/g)];
  return m.length > 0 ? m[m.length - 1][1] : expr.trim();
}
function splitTop(input: string, sep: string): string[] {
  const out: string[] = [];
  let d = 0, sq = false, dq = false, st = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (d === 0 && input.slice(i, i + sep.length) === sep) {
        out.push(input.slice(st, i));
        st = i + sep.length;
        i += sep.length - 1;
      }
    }
  }
  out.push(input.slice(st));
  return out;
}
function splitTuples(input: string): string[] {
  const out: string[] = [];
  let d = 0, sq = false, dq = false, st = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') { if (d === 0) st = i + 1; d++; }
      else if (c === ')') { d--; if (d === 0 && st >= 0) { out.push(input.slice(st, i)); st = -1; } }
    }
  }
  return out;
}
function findKw(input: string, kw: string): number {
  const lo = input.toLowerCase();
  let d = 0, sq = false, dq = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (
        d === 0 &&
        lo.slice(i, i + kw.length) === kw &&
        (i === 0 || /\s/.test(input[i - 1])) &&
        (i + kw.length === input.length || /\s/.test(input[i + kw.length]))
      ) return i;
    }
  }
  return -1;
}
function evalSc(expr: string, params: unknown[]): unknown {
  const t = expr.trim();
  if (/^\$\d+$/.test(t)) {
    const v = params[Number(t.slice(1)) - 1];
    if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  }
  if (/^null$/i.test(t)) return null;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^now\(\)$/i.test(t)) return new Date().toISOString();
  if (/^'([^']*)'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t;
}
function evalInsVal(table: string, col: string, expr: string, params: unknown[]): unknown {
  if (/^default$/i.test(expr)) {
    if (col === 'id' && UUID_TABLES.has(table)) return randomUUID();
    if (col === 'artifact_id') return randomUUID();
    if (col.endsWith('_at') || col === 'started_at' || col === 'ended_at') return new Date().toISOString();
    if (col === 'expires_at') return new Date(Date.now() + 86_400_000).toISOString();
    if (['pinned', 'undone', 'trashed', 'remote_terminal', 'save_pending'].includes(col)) return false;
    if (['current_version_number', 'current_history_seq', 'progress'].includes(col)) return 0;
    if (['asset_name_allocations', 'input_payload', 'default_models'].includes(col)) return {};
    if (col === 'reviews') return [];
    if (col === 'gc_state') return 'active';
    if (col === 'state') return table === 'jobs' ? 'queued' : 'pending';
    if (col === 'mode') return 'motion';
    return null;
  }
  return evalSc(expr, params);
}
function stripP(s: string): string {
  let out = s.trim();
  while (out.startsWith('(') && out.endsWith(')')) {
    let d = 0, ok = true;
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i] === '(') d++;
      else if (out[i] === ')') d--;
      if (d === 0) { ok = false; break; }
    }
    if (!ok) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}
function splitAnd(expr: string): string[] {
  const parts: string[] = [];
  let d = 0, sq = false, dq = false, st = 0;
  const lo = expr.toLowerCase();
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (!sq && !dq) {
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (
        d === 0 &&
        lo.slice(i, i + 3) === 'and' &&
        i > 0 && /\s/.test(expr[i - 1]) &&
        i + 3 < expr.length && /\s/.test(expr[i + 3])
      ) {
        parts.push(expr.slice(st, i).trim());
        st = i + 3;
        i += 2;
      }
    }
  }
  parts.push(expr.slice(st).trim());
  return parts;
}
function evalW(row: Row, raw: string, params: unknown[]): boolean {
  const terms = splitAnd(stripP(raw));
  if (terms.length > 1) return terms.every((t) => evalW(row, t, params));
  const term = stripP(terms[0]);
  let m: RegExpExecArray | null;
  if ((m = /^([\s\S]+?)\s+is\s+null$/i.exec(term))) return row[colName(m[1])] == null;
  if ((m = /^([\s\S]+?)\s+is\s+not\s+null$/i.exec(term))) return row[colName(m[1])] != null;
  if ((m = /^([\s\S]+?)\s+in\s*\(([\s\S]+)\)$/i.exec(term))) {
    return splitTop(m[2], ',').map((v) => evalSc(v, params)).includes(row[colName(m[1])]);
  }
  if ((m = /^([\s\S]+?)\s*>=\s*([\s\S]+)$/.exec(term))) return Number(row[colName(m[1])]) >= Number(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*>\s*([\s\S]+)$/.exec(term))) return Number(row[colName(m[1])]) > Number(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*<\s*([\s\S]+)$/.exec(term))) return Number(row[colName(m[1])]) < Number(evalSc(m[2], params));
  if ((m = /^([\s\S]+?)\s*=\s*([\s\S]+)$/.exec(term))) return row[colName(m[1])] === evalSc(m[2], params);
  throw new Error(`Unsupported WHERE: ${term}`);
}
function applySet(row: Row, setC: string, params: unknown[]): void {
  for (const a of splitTop(setC, ',')) {
    const eq = a.indexOf('=');
    if (eq < 0) continue;
    const col = colName(a.slice(0, eq));
    const rhs = a.slice(eq + 1).trim();
    let m: RegExpExecArray | null;
    if ((m = /"ref_count"\s*\+\s*(\$\d+)/i.exec(rhs))) {
      row[col] = Number(row.ref_count ?? 0) + Number(evalSc(m[1], params));
    } else if (!/^CASE\b/i.test(rhs) && (m = /"ref_count"\s*-\s*(\$\d+)/i.exec(rhs))) {
      row[col] = Number(row.ref_count ?? 0) - Number(evalSc(m[1], params));
    } else if (/CASE\s+WHEN[\s\S]*?"ref_count"/i.test(rhs)) {
      row[col] = Number(row.ref_count ?? 0) === 0 ? new Date().toISOString() : null;
    } else if ((m = /COALESCE\([\s\S]*?"metadata"[\s\S]*?\)\s*\|\|\s*(\$\d+)::jsonb/i.exec(rhs))) {
      const inc = evalSc(m[1], params);
      row[col] = { ...((row[col] as Record<string, unknown>) ?? {}), ...((inc as Record<string, unknown>) ?? {}) };
    } else {
      row[col] = evalSc(rhs, params);
    }
  }
}
function sortVal(v: unknown): string | number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return Date.parse(v);
  return String(v ?? '');
}
function fmtRows(rows: readonly Row[], cols: readonly string[], rowMode?: string): unknown[] {
  return rows.map((r) =>
    rowMode === 'array'
      ? cols.map((c) => r[c] ?? null)
      : Object.fromEntries(cols.map((c) => [c, r[c] ?? null])),
  );
}

class InMemoryStorage implements StoragePort {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async putObject(key: string, body: Buffer | Uint8Array | Readable | string, contentType: string): Promise<void> {
    let buf: Buffer;
    if (Buffer.isBuffer(body)) {
      buf = Buffer.from(body);
    } else if (typeof body === 'string') {
      buf = Buffer.from(body, 'utf8');
    } else if (body instanceof Uint8Array) {
      buf = Buffer.from(body);
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      buf = Buffer.concat(chunks);
    }
    this.objects.set(key, { body: buf, contentType });
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    if (this.objects.has(key)) return { uploaded: false };
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return { uploaded: true };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(found.body);
  }

  async getObjectStream(key: string): Promise<ObjectStreamResult> {
    const buf = await this.getObjectBuffer(key);
    return { stream: Readable.from([buf]), contentLength: buf.byteLength };
  }

  async headObject(key: string): Promise<HeadObjectResult | null> {
    const found = this.objects.get(key);
    if (!found) return null;
    const sha = createHash('sha256').update(found.body).digest('hex');
    return {
      contentLength: found.body.byteLength,
      contentType: found.contentType,
      etag: `"${sha}"`,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let count = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        count++;
      }
    }
    return count;
  }

  async presignPut(key: string, _opts: PresignPutOptions): Promise<string> {
    return `https://s3.local.test/${encodeURIComponent(key)}?sig=put`;
  }

  async presignGet(key: string, opts?: PresignGetOptions): Promise<string> {
    const query = opts?.responseContentType
      ? `&ct=${encodeURIComponent(opts.responseContentType)}`
      : '';
    return `https://s3.local.test/${encodeURIComponent(key)}?sig=get${query}`;
  }

  async ensureBucketAndCors(): Promise<void> {}
}

class InMemoryEventBus implements ApiEventBusPort {
  readonly published: Array<{ channel: string; payload: unknown }> = [];
  workersHealth: RenderWorkerHealth[] = [
    {
      workerId: 'render-worker-1',
      ffmpeg: true,
      ffprobe: true,
      chromium: true,
      concurrency: 2,
      activeJobs: 0,
      updatedAt: Date.now(),
    },
  ];
  healthy = true;
  private readonly channels = new Map<string, Set<(payload: unknown, ch: string) => void>>();

  async publish(channel: string, payload: unknown): Promise<number> {
    this.published.push({ channel, payload });
    const listeners = this.channels.get(channel);
    if (!listeners) return 0;
    for (const listener of listeners) listener(payload, channel);
    return listeners.size;
  }

  async subscribe(
    channel: string,
    listener: (payload: unknown, channel: string) => void,
  ): Promise<() => Promise<void>> {
    let bucket = this.channels.get(channel);
    if (!bucket) {
      bucket = new Set();
      this.channels.set(channel, bucket);
    }
    bucket.add(listener);
    return async () => {
      bucket?.delete(listener);
    };
  }

  async getRenderWorkersHealth(): Promise<RenderWorkerHealth[]> {
    return this.workersHealth;
  }

  async checkHealth(): Promise<boolean> {
    return this.healthy;
  }
}

function createFakeQueues(): { queues: ApiQueuesPort; enqueued: Array<{ queue: string; payload: unknown }> } {
  const enqueued: Array<{ queue: string; payload: unknown }> = [];
  const fakeQueue = {
    async getJob() {
      return null;
    },
  };
  const queues = {
    renderExport: fakeQueue as unknown as ApiQueuesPort['renderExport'],
    async enqueueMediaIngest(payload: unknown) {
      enqueued.push({ queue: 'media-ingest', payload });
      return { id: randomUUID() } as never;
    },
    async enqueueMediaGenerate(payload: unknown) {
      enqueued.push({ queue: 'media-generate', payload });
      return { id: randomUUID() } as never;
    },
    async enqueueRenderExport(payload: unknown) {
      enqueued.push({ queue: 'render-export', payload });
      return { id: randomUUID() } as never;
    },
  } as unknown as ApiQueuesPort;
  return { queues, enqueued };
}

function makeConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: 'dev',
    DEV_PAT: 'om_pat_devlocal_123456789012345678901234',
    OIDC_ISSUER: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'openmotion-cloud-client',
    OIDC_CLIENT_SECRET: 'ephemeral-test-client-secret',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  });
}

function createApiFixture(overrides: {
  config?: Record<string, string | undefined>;
  deps?: Partial<CreateApiAppDeps>;
} = {}) {
  const config = makeConfig(overrides.config);
  const pgClient = new ApiTestPgClient();
  const db = drizzle({ client: pgClient as never, schema }) as unknown as Database;
  const storage = new InMemoryStorage();
  const eventBus = new InMemoryEventBus();
  const { queues, enqueued } = createFakeQueues();
  const authStore = new InMemoryAuthStore();
  const authCache = new InMemoryAuthCache();
  const gateway = new MockModelGateway();
  const mcpSessionStore = new InMemoryMcpSessionStore();

  // Seed default workspace row in PG for services that query `workspaces` directly.
  pgClient.seed('workspaces', {
    id: config.DEV_WORKSPACE_ID,
    slug: 'dev-workspace',
    name: 'Local Dev Workspace',
    owner_user_id: config.DEV_USER_ID,
    active_project_id: null,
    default_models: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const welcomeCalls: string[] = [];
  let welcomeThrowNotFound = false;
  const fakeWelcomeBootstrap = {
    async ensureWelcomeProject(auth: AuthContext) {
      welcomeCalls.push(auth.workspaceId);
      if (welcomeThrowNotFound) {
        throw new CloudError('NOT_FOUND', 'Welcome template not synced', { status: 404, applied: false });
      }
      return { created: false, projectId: '00000000-0000-4000-8000-000000000099' };
    },
  } as unknown as WelcomeBootstrapService;

  const { app, services } = createApiApp({
    config,
    db,
    storage,
    queues,
    eventBus,
    authStore,
    authCache,
    gateway,
    mcpSessionStore,
    welcomeBootstrap: fakeWelcomeBootstrap,
    logger: SILENT_LOGGER,
    runtimeRoot: REPO_ROOT,
    ...overrides.deps,
  });

  return {
    app,
    services,
    config,
    pgClient,
    storage,
    eventBus,
    enqueued,
    authStore,
    authCache,
    welcomeCalls,
    setWelcomeThrowNotFound(value: boolean) {
      welcomeThrowNotFound = value;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Unauthenticated Health Probes
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Health Probes', () => {
  it('serves /api/health/live (200), /api/health/ready (200 healthy, 503 degraded), and /api/health', async () => {
    let pgOk = true;
    let redisOk = true;
    let s3Ok = true;

    const { app } = createApiFixture({
      config: { AUTH_MODE: 'oidc' },
      deps: {
        checkDbHealth: async () => pgOk,
        checkRedisHealth: async () => redisOk,
        checkStorageHealth: async () => s3Ok,
      },
    });

    const liveRes = await app.request('/api/health/live');
    assert.equal(liveRes.status, 200);
    const live = (await liveRes.json()) as { ok: boolean; status: string; service: string };
    assert.equal(live.ok, true);
    assert.equal(live.status, 'live');
    assert.equal(live.service, 'api');

    const readyRes = await app.request('/api/health/ready');
    assert.equal(readyRes.status, 200);
    const ready = (await readyRes.json()) as {
      ok: boolean;
      status: string;
      checks: { postgres: boolean; redis: boolean; storage: boolean };
    };
    assert.equal(ready.ok, true);
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.checks, { postgres: true, redis: true, storage: true });

    const healthRes = await app.request('/api/health');
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      mcp: { protocol: number; tools: string[] };
    };
    assert.equal(health.ok, true);
    assert.equal(health.mcp.protocol, 1);
    assert.equal(health.mcp.tools.length, 22);

    // Degrade Redis -> /api/health/ready must return 503 while /api/health/live stays 200.
    redisOk = false;
    const degradedRes = await app.request('/api/health/ready');
    assert.equal(degradedRes.status, 503);
    const degraded = (await degradedRes.json()) as {
      ok: boolean;
      status: string;
      checks: { postgres: boolean; redis: boolean; storage: boolean };
    };
    assert.equal(degraded.ok, false);
    assert.equal(degraded.status, 'not_ready');
    assert.deepEqual(degraded.checks, { postgres: true, redis: false, storage: true });

    const stillLive = await app.request('/api/health/live');
    assert.equal(stillLive.status, 200);

    // Degrade Postgres and S3 as well.
    pgOk = false;
    s3Ok = false;
    const allDown = await app.request('/api/health/ready');
    assert.equal(allDown.status, 503);
  });
});

// ---------------------------------------------------------------------------
// 2. Dual-Mode Auth, OAuth 2.1 Discovery, Bearer-Only /mcp & Welcome Bootstrap
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Auth Isolation & First-Access Welcome Bootstrap', () => {
  it('enforces AUTH_MODE=oidc on protected APIs, rejects browser cookie on /mcp, and accepts PAT Bearer', async () => {
    const fixture = createApiFixture({ config: { AUTH_MODE: 'oidc' } });
    const { app, authStore, pgClient } = fixture;

    // Unauthenticated API requests -> 401
    for (const url of [
      '/motion-api/projects',
      '/api/projects',
      '/motion-api/models',
      '/motion-api/account/summary',
      '/motion-api/integration',
    ]) {
      const res = await app.request(url);
      assert.equal(res.status, 401, `expected 401 for unauthenticated ${url}`);
    }

    // OAuth 2.1 discovery endpoints are public
    const prmRes = await app.request('/.well-known/oauth-protected-resource');
    assert.equal(prmRes.status, 200);
    const prm = (await prmRes.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(prm.resource, 'https://motion.example.test/mcp');
    assert.ok(prm.authorization_servers.length >= 1);

    const asMetaRes = await app.request('/.well-known/oauth-authorization-server');
    assert.equal(asMetaRes.status, 200);

    // Provision an OIDC user + workspace
    const userId = randomUUID();
    const workspaceId = randomUUID();
    authStore.seedWorkspace({
      workspaceId,
      userId,
      oidcSub: 'oidc-sub-integration-1',
      email: 'creator@example.test',
      displayName: 'Creator One',
      role: 'owner',
      slug: 'creator-ws',
      name: 'Creator Workspace',
    });
    pgClient.seed('workspaces', {
      id: workspaceId,
      slug: 'creator-ws',
      name: 'Creator Workspace',
      owner_user_id: userId,
      active_project_id: null,
      default_models: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Browser session cookie works on product & Studio APIs
    const browserSession = await createBrowserSession(authStore, { userId, workspaceId });
    const projectsRes = await app.request('/motion-api/projects', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` },
    });
    assert.equal(projectsRes.status, 200);

    // First-access welcome bootstrap ran exactly once for workspaceId and cached for subsequent requests
    assert.deepEqual(fixture.welcomeCalls, [workspaceId]);
    const secondRes = await app.request('/motion-api/account/summary', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}` },
    });
    assert.equal(secondRes.status, 200);
    assert.deepEqual(fixture.welcomeCalls, [workspaceId]);

    // Browser cookie is STRICTLY REJECTED on /mcp (RFC 9728 Bearer challenge)
    const mcpCookieRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${browserSession.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(mcpCookieRes.status, 401);
    assert.match(
      mcpCookieRes.headers.get('www-authenticate') ?? '',
      /Bearer\s+resource_metadata="https:\/\/motion\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
    );

    // PAT Bearer token succeeds on /mcp AND /motion-api/projects
    const ownerAuth: AuthContext = {
      workspaceId,
      userId,
      role: 'owner',
      scopes: [...DEFAULT_PAT_SCOPES],
      authMode: 'oidc',
      authMethod: 'session_cookie',
    };
    const createdPat = await createPat(authStore, ownerAuth, {
      name: 'Integration Test PAT',
      scopes: [...DEFAULT_PAT_SCOPES],
    });

    const mcpPatRes = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createdPat.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(mcpPatRes.status, 200);
    assert.ok(mcpPatRes.headers.get('mcp-session-id'));
  });

  it('survives unsynced welcome template (NOT_FOUND) gracefully during AUTH_MODE=dev workspace access', async () => {
    const fixture = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    fixture.setWelcomeThrowNotFound(true);

    const res = await fixture.app.request('/motion-api/projects');
    assert.equal(res.status, 200);
    assert.equal(fixture.welcomeCalls.length, 1);

    // Since welcome template was not synced, it was NOT cached as bootstrapped.
    fixture.setWelcomeThrowNotFound(false);
    const res2 = await fixture.app.request('/motion-api/projects');
    assert.equal(res2.status, 200);
    assert.equal(fixture.welcomeCalls.length, 2);

    // Once bootstrapped, subsequent requests hit the in-memory cache.
    const res3 = await fixture.app.request('/motion-api/projects');
    assert.equal(res3.status, 200);
    assert.equal(fixture.welcomeCalls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-End Wired Product + Diskless Studio + Streamable HTTP /mcp
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — End-to-End Product, Studio & Streamable HTTP /mcp', () => {
  it('creates a project, edits via /mcp, reads via Diskless Studio, and enforces MCP limits & P2 codes', async () => {
    const { app, config } = createApiFixture({ config: { AUTH_MODE: 'dev' } });
    const mcpHeaders = {
      Authorization: `Bearer ${config.DEV_PAT}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    // 1. Create a project via /motion-api/projects
    const createRes = await app.request('/motion-api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Cloud API E2E Video' }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      projectId: string;
      title: string;
      revision: string;
      versionId: string;
    };
    const projectId = created.projectId;
    assert.ok(projectId);
    assert.equal(created.title, 'Cloud API E2E Video');
    assert.ok(created.revision);
    assert.ok(created.versionId);

    // 2. Verify Diskless Studio sees the project and serves index.html with ETag
    const studioListRes = await app.request('/api/projects');
    assert.equal(studioListRes.status, 200);
    const studioList = (await studioListRes.json()) as { projects: Array<{ id: string }> };
    assert.ok(studioList.projects.some((p) => p.id === projectId));

    const indexRes = await app.request(`/api/projects/${projectId}/files/index.html`);
    assert.equal(indexRes.status, 200);
    assert.ok(indexRes.headers.get('etag'));
    const indexHtml = await indexRes.text();
    assert.match(indexHtml, /<html/i);

    // 3. Initialize Streamable HTTP MCP session
    const initRes = await app.request('/mcp', {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'api-e2e-client', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get('mcp-session-id');
    assert.ok(sessionId, 'Mcp-Session-Id header must be issued on initialize');

    const callMcp = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { ...mcpHeaders, 'Mcp-Session-Id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      assert.equal(res.status, 200, `MCP ${method} expected 200, got ${res.status}`);
      return (await res.json()) as {
        jsonrpc: string;
        id: number;
        result?: Record<string, unknown>;
        error?: { code: number; message: string };
      };
    };

    // 4. tools/list must advertise all 22 registered domain openmotion_* tools
    const listPayload = await callMcp(2, 'tools/list');
    const tools = (listPayload.result?.tools ?? []) as Array<{ name: string }>;
    assert.equal(tools.length, phase1Tools.length);
    assert.equal(tools.length, 22);

    // 5. openmotion_get_project (without projectId) lists workspace projects including our created one
    const listProjectsRes = await callMcp(3, 'tools/call', {
      name: 'openmotion_get_project',
      arguments: {},
    });
    assert.equal(listProjectsRes.result?.isError, undefined);
    const listStructured = listProjectsRes.result?.structuredContent as {
      projects: Array<{ projectId?: string; id?: string }>;
    };
    assert.ok(listStructured.projects.some((p) => (p.projectId ?? p.id) === projectId));

    // 6. openmotion_edit_project writes notes.txt and advances revision
    const editRes = await callMcp(4, 'tools/call', {
      name: 'openmotion_edit_project',
      arguments: {
        projectId,
        requestId: 'req-e2e-edit-1',
        expectedRevision: created.revision,
        expectedVersionId: created.versionId,
        summary: 'Add integration test notes',
        files: [{ path: 'notes.txt', content: 'Hello from cloud MCP' }],
      },
    });
    assert.equal(editRes.result?.isError, undefined);
    const editStructured = editRes.result?.structuredContent as {
      revision: string;
      version: { versionId: string; versionNumber: number };
    };
    assert.notEqual(editStructured.revision, created.revision);
    assert.ok(editStructured.version.versionNumber >= 2);

    // 7. openmotion_get_project reads back notes.txt written via MCP
    const readRes = await callMcp(5, 'tools/call', {
      name: 'openmotion_get_project',
      arguments: { projectId, file: { path: 'notes.txt' } },
    });
    assert.equal(readRes.result?.isError, undefined);
    const readStructured = readRes.result?.structuredContent as {
      file?: { content?: string };
      content?: string;
    };
    assert.equal(readStructured.file?.content ?? readStructured.content, 'Hello from cloud MCP');

    // 8. openmotion_media_use(models) returns MockModelGateway models
    const mediaModels = await callMcp(6, 'tools/call', {
      name: 'openmotion_media_use',
      arguments: { action: 'models' },
    });
    assert.equal(mediaModels.result?.isError, undefined);
    const mediaStructured = mediaModels.result?.structuredContent as {
      provider: string;
      models: unknown[];
    };
    assert.equal(mediaStructured.provider, 'opendesign');
    assert.ok(Array.isArray(mediaStructured.models) && mediaStructured.models.length > 0);

    // 9. openmotion_list_skills & openmotion_open_preview(templates)
    const skillsRes = await callMcp(7, 'tools/call', {
      name: 'openmotion_list_skills',
      arguments: {},
    });
    assert.equal(skillsRes.result?.isError, undefined);

    const previewRes = await callMcp(8, 'tools/call', {
      name: 'openmotion_open_preview',
      arguments: { target: 'templates' },
    });
    assert.equal(previewRes.result?.isError, undefined);
    const previewStructured = previewRes.result?.structuredContent as {
      url?: string;
      previewUrl?: string;
    };
    assert.ok(
      (previewStructured.url ?? previewStructured.previewUrl ?? '').startsWith(
        'https://motion.example.test/',
      ),
    );

    // 10. Legacy sourcePath on openmotion_import_assets -> LOCAL_PATH_UNSUPPORTED_IN_CLOUD
    const legacyImport = await callMcp(9, 'tools/call', {
      name: 'openmotion_import_assets',
      arguments: {
        projectId,
        requestId: 'req-e2e-legacy-import',
        items: [{ itemId: 'item-1', sourcePath: '/tmp/local-file.png' }],
      },
    });
    assert.equal(legacyImport.result?.isError, true);
    const legacyStructured = legacyImport.result?.structuredContent as { error: { code: string } };
    assert.equal(legacyStructured.error.code, 'LOCAL_PATH_UNSUPPORTED_IN_CLOUD');

    // 11. P2 deferred MCP tools return structured FEATURE_DEFERRED_P2
    const designRes = await callMcp(10, 'tools/call', {
      name: 'openmotion_design_project',
      arguments: { action: 'list' },
    });
    assert.equal(designRes.result?.isError, true);
    assert.equal(
      (designRes.result?.structuredContent as { error: { code: string } }).error.code,
      'FEATURE_DEFERRED_P2',
    );

    const commentsRes = await callMcp(11, 'tools/call', {
      name: 'openmotion_manage_project',
      arguments: { action: 'comments', projectId },
    });
    assert.equal(commentsRes.result?.isError, true);
    assert.equal(
      (commentsRes.result?.structuredContent as { error: { code: string } }).error.code,
      'FEATURE_DEFERRED_P2',
    );

    // 12. MCP_MAX_BODY_BYTES limit enforcement (413)
    const smallLimitFixture = createApiFixture({
      config: { AUTH_MODE: 'dev', MCP_MAX_BODY_BYTES: '1048576' },
    });
    const oversizedRes = await smallLimitFixture.app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${smallLimitFixture.config.DEV_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1_050_000) }),
    });
    assert.equal(oversizedRes.status, 413);

    // 13. DELETE /mcp tears down session cleanly
    const deleteRes = await app.request('/mcp', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${config.DEV_PAT}`,
        'Mcp-Session-Id': sessionId,
      },
    });
    assert.equal(deleteRes.status, 204);
  });
});

// ---------------------------------------------------------------------------
// 4. Models, Account, Catalog, Integration, Environment & P2 Deferred Routes
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Models, Account, Catalog, Integration & P2 Routes', () => {
  it('wires /motion-api/models, /motion-api/account, /motion-api/integration, catalog & P2 501 routes', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });

    // Models & account
    const modelsRes = await app.request('/motion-api/models');
    assert.equal(modelsRes.status, 200);
    const modelsBody = (await modelsRes.json()) as { provider: string; mode: string; models: unknown[] };
    assert.equal(modelsBody.provider, 'opendesign');
    assert.equal(modelsBody.mode, 'mock');
    assert.ok(modelsBody.models.length > 0);

    const accountRes = await app.request('/motion-api/account/summary');
    assert.equal(accountRes.status, 200);
    const account = (await accountRes.json()) as {
      authenticated: boolean;
      modelGateway: { provider: string; mode: string };
    };
    assert.equal(account.authenticated, true);
    assert.equal(account.modelGateway.provider, 'opendesign');

    // Integration & connect endpoints
    const integrationRes = await app.request('/motion-api/integration');
    assert.equal(integrationRes.status, 200);
    const integration = (await integrationRes.json()) as {
      transport?: { type?: string; url?: string };
      tools?: unknown[];
    };
    assert.equal(integration.transport?.type, 'streamable-http');
    assert.equal(integration.transport?.url, 'https://motion.example.test/mcp');
    assert.equal(integration.tools?.length, 22);

    const cfgRes = await app.request('/connect/config?host=codex');
    assert.equal(cfgRes.status, 200);
    assert.match(await cfgRes.text(), /https:\/\/motion\.example\.test\/mcp/);

    const guideRes = await app.request('/connect/guide?host=codex');
    assert.equal(guideRes.status, 200);
    assert.match(await guideRes.text(), /motion\.example\.test/);

    // Public catalog listing on BOTH /api/templates and /motion-api/templates
    const apiTemplatesRes = await app.request('/api/templates');
    assert.equal(apiTemplatesRes.status, 200);
    const motionTemplatesRes = await app.request('/motion-api/templates');
    assert.equal(motionTemplatesRes.status, 200);

    // Runtime & Diskless environment probes
    const runtimeRes = await app.request('/motion-api/runtime');
    assert.equal(runtimeRes.status, 200);
    assert.equal(((await runtimeRes.json()) as { mode: string }).mode, 'cloud-container');

    const ffmpegRes = await app.request('/api/environment/ffmpeg');
    assert.equal(ffmpegRes.status, 200);
    const ffmpeg = (await ffmpegRes.json()) as { available: boolean; workerCount?: number };
    assert.equal(ffmpeg.available, true);

    const desktopGet = await app.request('/api/open-in-desktop');
    assert.equal(desktopGet.status, 200);
    assert.equal(((await desktopGet.json()) as { available: boolean }).available, false);

    const desktopPost = await app.request('/api/open-in-desktop', { method: 'POST' });
    assert.equal(desktopPost.status, 501);

    // Explicit P2 501 FEATURE_DEFERRED_P2 HTTP routes
    for (const [method, url] of [
      ['GET', '/motion-api/design/projects'],
      ['POST', '/motion-api/brand-kits'],
      ['GET', '/motion-api/transcripts'],
      ['GET', '/motion-api/review-comments'],
    ] as const) {
      const res = await app.request(url, { method });
      assert.equal(res.status, 501, `expected 501 for ${method} ${url}`);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'FEATURE_DEFERRED_P2');
    }

    // Static read-only Brand Kit catalog JSON remains available (200)
    const brandCatalogRes = await app.request('/motion-api/brand-kits/catalog');
    assert.equal(brandCatalogRes.status, 200);
    const brandCatalog = (await brandCatalogRes.json()) as { entries: unknown[] };
    assert.ok(Array.isArray(brandCatalog.entries));
  });
});

// ---------------------------------------------------------------------------
// 5. Static Design System, Read-Only GSAP Vendor, Studio Runtime & SPA Fallback
// ---------------------------------------------------------------------------

describe('Cloud API Entrypoint — Static Assets, Read-Only GSAP & API 404 vs SPA Fallback', () => {
  it('serves design-system assets, GSAP vendor bundle, runtime.js, inline-video.html, and separates API 404 from SPA fallback', async () => {
    const { app } = createApiFixture({ config: { AUTH_MODE: 'dev' } });

    const tokensRes = await app.request('/design-system/tokens.css');
    assert.equal(tokensRes.status, 200);
    assert.match(tokensRes.headers.get('content-type') ?? '', /^text\/css/);

    const fontRes = await app.request('/web/design-system/fonts/AlbertSans-VariableFont_wght.ttf');
    assert.equal(fontRes.status, 200);
    assert.equal(fontRes.headers.get('access-control-allow-origin'), '*');

    const runtimeJsRes = await app.request('/api/runtime.js');
    assert.equal(runtimeJsRes.status, 200);
    assert.match(runtimeJsRes.headers.get('content-type') ?? '', /javascript/);

    const gsapRes = await app.request('/api/vendor/gsap/gsap.min.js');
    assert.equal(gsapRes.status, 200);
    assert.match(gsapRes.headers.get('content-type') ?? '', /javascript/);

    const gsapTraversal = await app.request('/api/vendor/gsap/%2e%2e/%2e%2e/package.json');
    assert.ok(gsapTraversal.status === 400 || gsapTraversal.status === 404);

    const hfConfigRes = await app.request('/__hyperframes_config');
    assert.equal(hfConfigRes.status, 200);
    const hfConfig = (await hfConfigRes.json()) as { diskless?: boolean };
    assert.equal(hfConfig.diskless, true);

    const inlineVideoJs = await app.request('/web/inline-video.js');
    assert.equal(inlineVideoJs.status, 200);
    assert.match(inlineVideoJs.headers.get('content-type') ?? '', /javascript/);

    const finalVideoComp = await app.request('/web/final-video-component.js');
    assert.equal(finalVideoComp.status, 200);
    assert.match(finalVideoComp.headers.get('content-type') ?? '', /javascript/);

    const mcpUiFragment = await app.request('/mcp-ui/template-recommendations/inline.fragment.html');
    assert.equal(mcpUiFragment.status, 200);
    assert.match(mcpUiFragment.headers.get('content-type') ?? '', /^text\/html/);

    // Unknown API paths MUST return JSON 404 (never SPA HTML)
    for (const apiPath of ['/api/does-not-exist', '/motion-api/does-not-exist']) {
      const res = await app.request(apiPath);
      assert.equal(res.status, 404, `expected 404 for ${apiPath}`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'NOT_FOUND');
    }

    // SPA client-side route serves studio/build/index.html (200) or clean 503 if unbuilt
    const spaRes = await app.request('/projects/client-route');
    const studioBuilt = existsSync(path.join(REPO_ROOT, 'studio/build/index.html'));
    assert.equal(spaRes.status, studioBuilt ? 200 : 503);
  });
});
