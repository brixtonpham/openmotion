import { and, eq, sql } from 'drizzle-orm';
import { CloudError } from '../contracts/errors.ts';
import type { BlobMetadata } from '../contracts/storage.ts';
import { isSha256Hex, isUuid } from '../../shared/project-validation.ts';
import type { Database, DbExecutor } from './client.ts';
import { asInsert, asUpdate } from './helpers.ts';
import { workspaceBlobs } from './schema/blobs-assets.ts';

export interface BlobRefDelta {
  sha256: string;
  delta: number;
  sizeBytes?: number;
  mimeType?: string;
  s3Key?: string;
  metadata?: BlobMetadata | null;
}

export interface NormalizedBlobRefDelta {
  readonly sha256: string;
  readonly delta: number;
  readonly sizeBytes?: number;
  readonly mimeType?: string;
  readonly s3Key?: string;
  readonly metadata?: BlobMetadata | null;
}

export interface ClaimedGcBlob {
  workspaceId: string;
  sha256: string;
  s3Key: string;
}

/**
 * Aggregate duplicate SHA-256 deltas and sort lexicographically ascending by `sha256`.
 * Every transaction acquires `workspace_blobs` row locks in this canonical order to prevent
 * PostgreSQL deadlocks (`40P01`) across concurrent multi-file commits and deletes.
 */
export function normalizeBlobRefDeltas(deltas: readonly BlobRefDelta[]): NormalizedBlobRefDelta[] {
  const merged = new Map<
    string,
    {
      delta: number;
      sizeBytes?: number;
      mimeType?: string;
      s3Key?: string;
      metadata?: BlobMetadata | null;
    }
  >();

  for (const item of deltas) {
    if (!isSha256Hex(item.sha256)) {
      throw new CloudError('INVALID_ARGUMENT', `Invalid CAS blob sha256 digest: ${String(item.sha256)}`, {
        status: 400,
        applied: false,
      });
    }
    if (!Number.isInteger(item.delta)) {
      throw new CloudError('INVALID_ARGUMENT', `CAS refcount delta must be an integer: ${String(item.delta)}`, {
        status: 400,
        applied: false,
      });
    }
    const existing = merged.get(item.sha256);
    if (!existing) {
      merged.set(item.sha256, {
        delta: item.delta,
        sizeBytes: item.sizeBytes,
        mimeType: item.mimeType,
        s3Key: item.s3Key,
        metadata: item.metadata ?? undefined,
      });
    } else {
      existing.delta += item.delta;
      if (item.sizeBytes !== undefined) existing.sizeBytes = item.sizeBytes;
      if (item.mimeType !== undefined) existing.mimeType = item.mimeType;
      if (item.s3Key !== undefined) existing.s3Key = item.s3Key;
      if (item.metadata !== undefined && item.metadata !== null) {
        existing.metadata = existing.metadata ? { ...existing.metadata, ...item.metadata } : { ...item.metadata };
      }
    }
  }

  return [...merged.entries()]
    .filter(([, entry]) => entry.delta !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sha256, entry]) => ({
      sha256,
      delta: entry.delta,
      sizeBytes: entry.sizeBytes,
      mimeType: entry.mimeType,
      s3Key: entry.s3Key,
      metadata: entry.metadata,
    }));
}

function assertWorkspaceId(workspaceId: string): void {
  if (!isUuid(workspaceId)) {
    throw new CloudError('INVALID_ARGUMENT', 'workspaceId must be a valid UUID', {
      status: 400,
      applied: false,
    });
  }
}

/**
 * Apply positive and negative workspace CAS refcount deltas inside an open transaction.
 * Locks are acquired in strict lexicographical `sha256` order.
 *
 * For positive deltas, callers MUST have already uploaded the object to S3 (`workspaces/{wid}/blobs/{sha256}`).
 * If a target blob row is currently in `gc_state = 'deleting'`, throws `BLOB_GC_IN_PROGRESS` (409)
 * so the caller aborts the tx, waits briefly, re-uploads to S3, and retries.
 */
export async function applyWorkspaceBlobRefDeltas(
  tx: DbExecutor,
  workspaceId: string,
  deltas: readonly BlobRefDelta[],
): Promise<void> {
  assertWorkspaceId(workspaceId);
  const normalized = normalizeBlobRefDeltas(deltas);

  for (const item of normalized) {
    if (item.delta > 0) {
      const s3Key = item.s3Key ?? `workspaces/${workspaceId}/blobs/${item.sha256}`;
      const sizeBytes = item.sizeBytes;
      const mimeType = item.mimeType ?? 'application/octet-stream';
      if (sizeBytes === undefined || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
        throw new CloudError(
          'INVALID_ARGUMENT',
          `Positive CAS refcount delta for ${item.sha256} requires non-negative sizeBytes`,
          { status: 400, applied: false },
        );
      }

      const rows = await tx
        .insert(workspaceBlobs)
        .values(
          asInsert(workspaceBlobs, {
            workspaceId,
            sha256: item.sha256,
            sizeBytes,
            mimeType,
            s3Key,
            metadata: item.metadata ?? null,
            refCount: item.delta,
            zeroRefSince: null,
            gcState: 'active',
          }),
        )
        .onConflictDoUpdate({
          target: [workspaceBlobs.workspaceId, workspaceBlobs.sha256],
          set: asUpdate(workspaceBlobs, {
            refCount: sql`${workspaceBlobs.refCount} + ${item.delta}`,
            zeroRefSince: null,
            ...(item.metadata !== undefined && item.metadata !== null
              ? {
                  metadata: sql`COALESCE(${workspaceBlobs.metadata}, '{}'::jsonb) || ${JSON.stringify(item.metadata)}::jsonb`,
                }
              : {}),
          }),
          setWhere: eq(workspaceBlobs.gcState, 'active'),
        })
        .returning({ sha256: workspaceBlobs.sha256 });

      if (rows.length === 0) {
        throw new CloudError(
          'BLOB_GC_IN_PROGRESS',
          `Blob ${item.sha256} is currently being garbage-collected; re-upload and retry.`,
          { status: 409, applied: false, details: { sha256: item.sha256 } },
        );
      }
    } else {
      const dec = Math.abs(item.delta);
      const rows = await tx
        .update(workspaceBlobs)
        .set(
          asUpdate(workspaceBlobs, {
            refCount: sql`${workspaceBlobs.refCount} - ${dec}`,
            zeroRefSince: sql`CASE WHEN ${workspaceBlobs.refCount} - ${dec} = 0 THEN now() ELSE NULL END`,
          }),
        )
        .where(
          and(
            eq(workspaceBlobs.workspaceId, workspaceId),
            eq(workspaceBlobs.sha256, item.sha256),
            sql`${workspaceBlobs.refCount} >= ${dec}`,
          ),
        )
        .returning({ sha256: workspaceBlobs.sha256 });

      if (rows.length === 0) {
        throw new CloudError(
          'STORAGE_ERROR',
          `CAS refcount underflow or missing workspace blob ${item.sha256}`,
          { status: 500, applied: false, details: { workspaceId, sha256: item.sha256, delta: item.delta } },
        );
      }
    }
  }
}

export async function updateWorkspaceBlobMetadata(
  tx: DbExecutor,
  workspaceId: string,
  sha256: string,
  metadata: BlobMetadata,
): Promise<boolean> {
  assertWorkspaceId(workspaceId);
  if (!isSha256Hex(sha256)) {
    throw new CloudError('INVALID_ARGUMENT', `Invalid sha256 digest: ${sha256}`, { status: 400, applied: false });
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new CloudError('INVALID_ARGUMENT', 'Blob metadata must be a non-null JSON object', {
      status: 400,
      applied: false,
    });
  }
  const rows = await tx
    .update(workspaceBlobs)
    .set(
      asUpdate(workspaceBlobs, {
        metadata: sql`COALESCE(${workspaceBlobs.metadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
      }),
    )
    .where(and(eq(workspaceBlobs.workspaceId, workspaceId), eq(workspaceBlobs.sha256, sha256)))
    .returning({ sha256: workspaceBlobs.sha256 });
  return rows.length > 0;
}

/**
 * Phase 1 of two-phase CAS GC: atomically claim up to `batchSize` zero-ref blobs whose
 * grace window has elapsed, transitioning them to `gc_state = 'deleting'` without holding
 * a transaction open across subsequent S3 deletions.
 */
export async function markZeroRefForDeletion(
  db: Database,
  options: { graceSeconds: number; batchSize: number },
): Promise<ClaimedGcBlob[]> {
  const graceSeconds = Math.max(0, Math.floor(options.graceSeconds));
  const batchSize = Math.max(1, Math.min(2000, Math.floor(options.batchSize)));

  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT workspace_id, sha256
      FROM workspace_blobs
      WHERE ref_count = 0
        AND gc_state = 'active'
        AND zero_ref_since IS NOT NULL
        AND zero_ref_since <= now() - make_interval(secs => ${graceSeconds})
      ORDER BY zero_ref_since ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE workspace_blobs wb
    SET gc_state = 'deleting'
    FROM candidates c
    WHERE wb.workspace_id = c.workspace_id
      AND wb.sha256 = c.sha256
    RETURNING wb.workspace_id AS "workspaceId", wb.sha256 AS "sha256", wb.s3_key AS "s3Key"
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    workspaceId: String(row.workspaceId),
    sha256: String(row.sha256),
    s3Key: String(row.s3Key),
  }));
}

/**
 * Phase 3 of two-phase CAS GC: after S3 object + thumbnail + derived cleanup succeeds,
 * delete the PG row only if it is still `gc_state = 'deleting'` and `ref_count = 0`.
 */
export async function finalizeBlobDeletion(
  db: DbExecutor,
  workspaceId: string,
  sha256: string,
): Promise<boolean> {
  assertWorkspaceId(workspaceId);
  if (!isSha256Hex(sha256)) {
    throw new CloudError('INVALID_ARGUMENT', `Invalid sha256 digest: ${sha256}`, { status: 400, applied: false });
  }
  const rows = await db
    .delete(workspaceBlobs)
    .where(
      and(
        eq(workspaceBlobs.workspaceId, workspaceId),
        eq(workspaceBlobs.sha256, sha256),
        eq(workspaceBlobs.gcState, 'deleting'),
        eq(workspaceBlobs.refCount, 0),
      ),
    )
    .returning({ sha256: workspaceBlobs.sha256 });
  return rows.length > 0;
}

/**
 * Recovery helper: if S3 deletion failed transiently or a blob was resurrected with `ref_count > 0`,
 * return `gc_state` back to `'active'` so the row is never stranded in `'deleting'`.
 */
export async function resurrectBlobIfReferenced(
  db: DbExecutor,
  workspaceId: string,
  sha256: string,
): Promise<boolean> {
  assertWorkspaceId(workspaceId);
  if (!isSha256Hex(sha256)) {
    throw new CloudError('INVALID_ARGUMENT', `Invalid sha256 digest: ${sha256}`, { status: 400, applied: false });
  }
  const rows = await db
    .update(workspaceBlobs)
    .set(
      asUpdate(workspaceBlobs, {
        gcState: 'active',
        zeroRefSince: sql`CASE WHEN ${workspaceBlobs.refCount} > 0 THEN NULL ELSE COALESCE(${workspaceBlobs.zeroRefSince}, now()) END`,
      }),
    )
    .where(
      and(
        eq(workspaceBlobs.workspaceId, workspaceId),
        eq(workspaceBlobs.sha256, sha256),
        eq(workspaceBlobs.gcState, 'deleting'),
      ),
    )
    .returning({ sha256: workspaceBlobs.sha256 });
  return rows.length > 0;
}
