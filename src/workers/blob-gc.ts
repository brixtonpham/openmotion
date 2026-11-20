import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { BlobGcJobName, BlobGcPayloadMap } from '../contracts/jobs.ts';
import type { StoragePort } from '../contracts/storage.ts';
import {
  finalizeBlobDeletion,
  markZeroRefForDeletion,
  resurrectBlobIfReferenced,
  type ClaimedGcBlob,
} from '../db/cas.ts';
import type { Database } from '../db/client.ts';
import { asUpdate } from '../db/helpers.ts';
import { uploadTickets } from '../db/schema/blobs-assets.ts';
import type { Logger } from '../infra/logger.ts';
import {
  blobDerivedPrefix,
  blobThumbnailsPrefix,
  workspaceBlobKey,
} from '../infra/storage.ts';

export interface BlobGcCasOps {
  markZeroRefForDeletion(
    db: Database,
    options: { graceSeconds: number; batchSize: number },
  ): Promise<ClaimedGcBlob[]>;
  finalizeBlobDeletion(db: Database, workspaceId: string, sha256: string): Promise<boolean>;
  resurrectBlobIfReferenced(db: Database, workspaceId: string, sha256: string): Promise<boolean>;
}

export interface BlobGcDeps {
  readonly db: Database;
  readonly storage: Pick<StoragePort, 'deleteObject' | 'deletePrefix'>;
  readonly logger: Logger;
  readonly casOps?: BlobGcCasOps;
}

export interface SweepUnreferencedBlobsResult {
  claimed: number;
  deleted: number;
  failed: number;
  thumbnailsDeleted: number;
  derivedDeleted: number;
}

export interface SweepExpiredUploadsResult {
  swept: number;
  failed: number;
}

export interface SweepExpiredReceiptsResult {
  deleted: number;
}

const DEFAULT_CAS_OPS: BlobGcCasOps = {
  markZeroRefForDeletion,
  finalizeBlobDeletion,
  resurrectBlobIfReferenced,
};

/**
 * Race-free two-phase CAS blob garbage collection:
 * 1. Phase 1: `markZeroRefForDeletion` transitions eligible `ref_count = 0` rows (`gc_state = 'active'`)
 *    whose grace period elapsed into `gc_state = 'deleting'` via `FOR UPDATE SKIP LOCKED`.
 * 2. Phase 2 (no PG tx held): Deletes S3 `workspaces/{wid}/blobs/{sha256}`,
 *    `workspaces/{wid}/thumbnails/{sha256}/`, and `workspaces/{wid}/derived/{sha256}/`.
 *    On transient S3 failure, restores `gc_state = 'active'` via `resurrectBlobIfReferenced`.
 * 3. Phase 3: Calls `finalizeBlobDeletion` to delete the PG row only if still `deleting` & `ref_count = 0`.
 */
export async function sweepUnreferencedBlobs(
  deps: BlobGcDeps,
  payload: BlobGcPayloadMap['sweep_unreferenced_blobs'],
): Promise<SweepUnreferencedBlobsResult> {
  const cas = deps.casOps ?? DEFAULT_CAS_OPS;
  const claimed = await cas.markZeroRefForDeletion(deps.db, {
    graceSeconds: payload.graceSeconds,
    batchSize: payload.batchSize,
  });

  let deleted = 0;
  let failed = 0;
  let thumbnailsDeleted = 0;
  let derivedDeleted = 0;

  for (const blob of claimed) {
    const blobKey = workspaceBlobKey(blob.workspaceId, blob.sha256);
    const thumbPrefix = blobThumbnailsPrefix(blob.workspaceId, blob.sha256);
    const derivedPrefix = blobDerivedPrefix(blob.workspaceId, blob.sha256);

    try {
      await deps.storage.deleteObject(blobKey);
      const [thumbsCount, derivedCount] = await Promise.all([
        deps.storage.deletePrefix(thumbPrefix),
        deps.storage.deletePrefix(derivedPrefix),
      ]);
      thumbnailsDeleted += thumbsCount;
      derivedDeleted += derivedCount;

      const finalized = await cas.finalizeBlobDeletion(deps.db, blob.workspaceId, blob.sha256);
      if (finalized) {
        deleted += 1;
      } else {
        deps.logger.warn('CAS GC finalize skipped (blob no longer deleting/zero-ref)', {
          workspaceId: blob.workspaceId,
          sha256: blob.sha256,
        });
      }
    } catch (error) {
      failed += 1;
      deps.logger.error('CAS GC S3 deletion failed; reverting gc_state to active', {
        workspaceId: blob.workspaceId,
        sha256: blob.sha256,
        error,
      });
      await cas.resurrectBlobIfReferenced(deps.db, blob.workspaceId, blob.sha256).catch((resErr) => {
        deps.logger.error('Failed to resurrect CAS blob after S3 GC error', {
          workspaceId: blob.workspaceId,
          sha256: blob.sha256,
          error: resErr,
        });
      });
    }
  }

  return {
    claimed: claimed.length,
    deleted,
    failed,
    thumbnailsDeleted,
    derivedDeleted,
  };
}

/**
 * Clean up abandoned upload staging objects whose tickets expired before confirmation.
 */
export async function sweepExpiredUploads(
  deps: BlobGcDeps,
  payload: BlobGcPayloadMap['sweep_expired_uploads'],
): Promise<SweepExpiredUploadsResult> {
  const now = new Date();
  const expiredTickets = await deps.db
    .select()
    .from(uploadTickets)
    .where(and(inArray(uploadTickets.state, ['issued', 'uploaded']), lte(uploadTickets.expiresAt, now)))
    .limit(payload.batchSize);

  let swept = 0;
  let failed = 0;

  for (const ticket of expiredTickets) {
    try {
      await deps.storage.deleteObject(ticket.s3StagingKey).catch(() => {});
      if (ticket.licenseS3StagingKey) {
        await deps.storage.deleteObject(ticket.licenseS3StagingKey).catch(() => {});
      }
      await deps.db
        .update(uploadTickets)
        .set(asUpdate(uploadTickets, { state: 'expired', updatedAt: new Date() }))
        .where(
          and(
            eq(uploadTickets.id, ticket.id),
            eq(uploadTickets.workspaceId, ticket.workspaceId),
            inArray(uploadTickets.state, ['issued', 'uploaded']),
          ),
        );
      swept += 1;
    } catch (error) {
      failed += 1;
      deps.logger.error('Failed to sweep expired upload ticket', {
        workspaceId: ticket.workspaceId,
        uploadId: ticket.id,
        error,
      });
    }
  }

  return { swept, failed };
}

/** Delete expired `idempotency_receipts` rows in bounded batches. */
export async function sweepExpiredReceipts(
  deps: BlobGcDeps,
  payload: BlobGcPayloadMap['sweep_expired_receipts'],
): Promise<SweepExpiredReceiptsResult> {
  const batchSize = Math.max(1, Math.min(5000, Math.floor(payload.batchSize)));
  const result = await deps.db.execute(sql`
    WITH doomed AS (
      SELECT ctid
      FROM idempotency_receipts
      WHERE expires_at <= now()
      LIMIT ${batchSize}
    )
    DELETE FROM idempotency_receipts r
    USING doomed d
    WHERE r.ctid = d.ctid
    RETURNING 1
  `);
  return { deleted: result.rows.length };
}

export async function processBlobGcJob<K extends BlobGcJobName>(
  deps: BlobGcDeps,
  name: K,
  payload: BlobGcPayloadMap[K],
): Promise<SweepUnreferencedBlobsResult | SweepExpiredUploadsResult | SweepExpiredReceiptsResult> {
  if (name === 'sweep_unreferenced_blobs') {
    return sweepUnreferencedBlobs(deps, payload as BlobGcPayloadMap['sweep_unreferenced_blobs']);
  }
  if (name === 'sweep_expired_uploads') {
    return sweepExpiredUploads(deps, payload as BlobGcPayloadMap['sweep_expired_uploads']);
  }
  if (name === 'sweep_expired_receipts') {
    return sweepExpiredReceipts(deps, payload as BlobGcPayloadMap['sweep_expired_receipts']);
  }
  throw new Error(`Unknown blob-gc job: ${String(name)}`);
}
