import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  QUEUE_NAMES,
  blobGcJobSchemas,
  mediaGenerateJobSchemas,
  mediaIngestJobSchemas,
  renderExportJobSchemas,
  type BlobGcJobName,
  type BlobGcPayloadMap,
  type MediaGenerateJobName,
  type MediaGeneratePayloadMap,
  type MediaIngestJobName,
  type MediaIngestPayloadMap,
  type QueueName,
  type RenderExportJobName,
  type RenderExportPayloadMap,
} from '../contracts/jobs.ts';
import { createRedisClient } from './redis.ts';

export const QUEUE_DEFAULT_JOB_OPTIONS: Readonly<Record<QueueName, JobsOptions>> = {
  [QUEUE_NAMES.mediaIngest]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400, count: 2_000 },
  },
  // Paid upstream model generations MUST NEVER auto-retry silently.
  [QUEUE_NAMES.mediaGenerate]: {
    attempts: 1,
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400, count: 2_000 },
  },
  // Export renders MUST NEVER auto-replay silently after worker failure.
  [QUEUE_NAMES.renderExport]: {
    attempts: 1,
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400, count: 2_000 },
  },
  [QUEUE_NAMES.blobGc]: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 200 },
    removeOnFail: { age: 86_400 * 7, count: 500 },
  },
};

export function validateMediaIngestPayload<K extends MediaIngestJobName>(
  name: K,
  payload: unknown,
): MediaIngestPayloadMap[K] {
  return mediaIngestJobSchemas[name].parse(payload) as MediaIngestPayloadMap[K];
}

export function validateMediaGeneratePayload<K extends MediaGenerateJobName>(
  name: K,
  payload: unknown,
): MediaGeneratePayloadMap[K] {
  return mediaGenerateJobSchemas[name].parse(payload) as MediaGeneratePayloadMap[K];
}

export function validateRenderExportPayload<K extends RenderExportJobName>(
  name: K,
  payload: unknown,
): RenderExportPayloadMap[K] {
  return renderExportJobSchemas[name].parse(payload) as RenderExportPayloadMap[K];
}

export function validateBlobGcPayload<K extends BlobGcJobName>(
  name: K,
  payload: unknown,
): BlobGcPayloadMap[K] {
  return blobGcJobSchemas[name].parse(payload) as BlobGcPayloadMap[K];
}

export function buildRenderThumbnailJobId(
  workspaceId: string,
  projectId: string,
  cacheKey: string,
): string {
  // BullMQ v5 rejects custom jobIds containing ':'.
  return `thumb__${workspaceId}__${projectId}__${cacheKey}`;
}

export class QueueService {
  readonly mediaIngest: Queue;
  readonly mediaGenerate: Queue;
  readonly renderExport: Queue;
  readonly blobGc: Queue;
  private readonly redisUrl: string;
  private readonly connection: Redis;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
    this.connection = createRedisClient(redisUrl, 'bullmq');

    this.mediaIngest = new Queue(QUEUE_NAMES.mediaIngest, {
      connection: this.connection,
      defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.mediaIngest],
    });
    this.mediaGenerate = new Queue(QUEUE_NAMES.mediaGenerate, {
      connection: this.connection,
      defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.mediaGenerate],
    });
    this.renderExport = new Queue(QUEUE_NAMES.renderExport, {
      connection: this.connection,
      defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.renderExport],
    });
    this.blobGc = new Queue(QUEUE_NAMES.blobGc, {
      connection: this.connection,
      defaultJobOptions: QUEUE_DEFAULT_JOB_OPTIONS[QUEUE_NAMES.blobGc],
    });
  }

  async enqueueMediaIngest<K extends MediaIngestJobName>(
    name: K,
    payload: MediaIngestPayloadMap[K],
    options?: JobsOptions,
  ) {
    const validated = validateMediaIngestPayload(name, payload);
    const jobId =
      options?.jobId ?? ('jobId' in validated && typeof validated.jobId === 'string' ? validated.jobId : undefined);
    return this.mediaIngest.add(name, validated, { ...options, ...(jobId ? { jobId } : {}) });
  }

  async enqueueMediaGenerate<K extends MediaGenerateJobName>(
    name: K,
    payload: MediaGeneratePayloadMap[K],
    options?: JobsOptions,
  ) {
    const validated = validateMediaGeneratePayload(name, payload);
    return this.mediaGenerate.add(name, validated, {
      ...options,
      jobId: options?.jobId ?? validated.jobId,
      attempts: 1,
    });
  }

  async enqueueRenderExport<K extends RenderExportJobName>(
    name: K,
    payload: RenderExportPayloadMap[K],
    options?: JobsOptions,
  ) {
    const validated = validateRenderExportPayload(name, payload);
    const defaultJobId =
      'jobId' in validated && typeof validated.jobId === 'string'
        ? validated.jobId
        : buildRenderThumbnailJobId(
            validated.workspaceId,
            validated.projectId,
            (validated as RenderExportPayloadMap['render_thumbnail']).cacheKey,
          );
    // Give export renders higher priority (1) than speculative composition thumbnails (5).
    const defaultPriority = name === 'export_render' ? 1 : 5;
    return this.renderExport.add(name, validated, {
      priority: defaultPriority,
      ...options,
      jobId: options?.jobId ?? defaultJobId,
      attempts: 1,
    });
  }

  async enqueueBlobGc<K extends BlobGcJobName>(
    name: K,
    payload: BlobGcPayloadMap[K],
    options?: JobsOptions,
  ) {
    const validated = validateBlobGcPayload(name, payload);
    return this.blobGc.add(name, validated, options);
  }

  async scheduleBlobGcRepeatable(graceSeconds: number): Promise<void> {
    await this.blobGc.upsertJobScheduler(
      'blob-gc-sweep-unreferenced',
      { every: 15 * 60_000 },
      {
        name: 'sweep_unreferenced_blobs',
        data: validateBlobGcPayload('sweep_unreferenced_blobs', { batchSize: 500, graceSeconds }),
      },
    );
    await this.blobGc.upsertJobScheduler(
      'blob-gc-sweep-uploads',
      { every: 15 * 60_000 },
      {
        name: 'sweep_expired_uploads',
        data: validateBlobGcPayload('sweep_expired_uploads', { batchSize: 500 }),
      },
    );
    await this.blobGc.upsertJobScheduler(
      'blob-gc-sweep-receipts',
      { every: 60 * 60_000 },
      {
        name: 'sweep_expired_receipts',
        data: validateBlobGcPayload('sweep_expired_receipts', { batchSize: 1000 }),
      },
    );
  }

  createQueueEvents(queueName: QueueName): { events: QueueEvents; close: () => Promise<void> } {
    const eventsConnection = createRedisClient(this.redisUrl, 'bullmq');
    const events = new QueueEvents(queueName, { connection: eventsConnection });
    return {
      events,
      close: async () => {
        await events.close();
        await eventsConnection.quit();
      },
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.mediaIngest.close(),
      this.mediaGenerate.close(),
      this.renderExport.close(),
      this.blobGc.close(),
    ]);
    await this.connection.quit();
  }
}
