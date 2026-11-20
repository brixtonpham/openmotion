import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import type { StoragePort } from '../../src/contracts/storage.ts';
import type { Database } from '../../src/db/client.ts';
import { uploadTickets } from '../../src/db/schema/blobs-assets.ts';
import { jobs } from '../../src/db/schema/jobs.ts';
import { createLogger } from '../../src/infra/logger.ts';
import { jobChannel } from '../../src/infra/redis.ts';
import {
  blobDerivedPrefix,
  blobThumbnailsPrefix,
  derivedAssetKey,
  thumbnailKey,
  uploadLicenseStagingKey,
  uploadStagingKey,
  workspaceBlobKey,
} from '../../src/infra/storage.ts';
import {
  sweepExpiredUploads,
  sweepUnreferencedBlobs,
} from '../../src/workers/blob-gc.ts';
import {
  processMediaGenerateJob,
  type PlatformModelGateway,
} from '../../src/workers/media-generate.ts';
import {
  handleExtractWaveformPeaksJob,
  handleFreezeFrameJob,
  handleImageThumbnailJob,
  handleLoudnessNormalizeJob,
  handleUploadCommitJob,
  handleUrlFetchJob,
  safePublicHttpsFetchToFile,
} from '../../src/workers/media-ingest.ts';

const WID_A = '11111111-1111-4111-8111-111111111111';
const PID_A = '22222222-2222-4222-8222-222222222222';
const UID_A = '33333333-3333-4333-8333-333333333333';
const JID_A = '44444444-4444-4444-8444-444444444444';
const JID_B = '55555555-5555-4555-8555-555555555555';
const SHA_A = 'a'.repeat(64);

const SILENT_LOGGER = createLogger({ level: 'error', sink: () => {} });

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Build a valid PNG with an explicit SDR gAMA chunk so stripSdrPngColourTags actually transforms it. */
async function buildPngWithSdrGamaChunk(): Promise<Buffer> {
  const basePng = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 40, g: 120, b: 220, alpha: 1 } },
  })
    .png()
    .toBuffer();

  // Insert gAMA chunk right after PNG signature (8 bytes) + IHDR chunk (25 bytes = 4 len + 4 type + 13 data + 4 crc).
  const gamaData = Buffer.alloc(4);
  gamaData.writeUInt32BE(45455, 0); // standard sRGB gamma 1/2.2
  const gamaChunk = makePngChunk('gAMA', gamaData);
  const insertOffset = 8 + 25;
  return Buffer.concat([basePng.subarray(0, insertOffset), gamaChunk, basePng.subarray(insertOffset)]);
}

class InMemoryStorage implements StoragePort {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly trace: string[] = [];
  failDeleteKey?: string;

  async putObject(
    key: string,
    body: Buffer | Uint8Array | Readable | string,
    contentType: string,
  ): Promise<void> {
    this.trace.push(`put:${key}`);
    const bytes = Buffer.isBuffer(body)
      ? Buffer.from(body)
      : body instanceof Uint8Array
        ? Buffer.from(body)
        : typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : await (async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of body) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
              }
              return Buffer.concat(chunks);
            })();
    this.objects.set(key, { bytes, contentType });
  }

  async putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }> {
    this.trace.push(`putBlobIfAbsent:${key}`);
    if (this.objects.has(key)) return { uploaded: false };
    this.objects.set(key, { bytes: Buffer.from(body), contentType });
    return { uploaded: true };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const item = this.objects.get(key);
    if (!item) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(item.bytes);
  }

  async getObjectStream(key: string) {
    const item = this.objects.get(key);
    if (!item) throw new Error(`NoSuchKey: ${key}`);
    return {
      stream: Readable.from([Buffer.from(item.bytes)]),
      contentLength: item.bytes.byteLength,
      contentType: item.contentType,
    };
  }

  async headObject(key: string) {
    const item = this.objects.get(key);
    if (!item) return null;
    return { contentLength: item.bytes.byteLength, contentType: item.contentType };
  }

  async deleteObject(key: string): Promise<void> {
    this.trace.push(`deleteObject:${key}`);
    if (this.failDeleteKey === key) {
      throw new Error(`Simulated S3 delete error for ${key}`);
    }
    this.objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    this.trace.push(`deletePrefix:${prefix}`);
    let count = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        count += 1;
      }
    }
    return count;
  }

  async presignPut(key: string): Promise<string> {
    return `https://s3.test/${key}`;
  }

  async presignGet(key: string): Promise<string> {
    return `https://s3.test/${key}`;
  }

  async ensureBucketAndCors(): Promise<void> {}
}

function createFakeDb(options: {
  selectQueue?: unknown[][];
  onUpdate?: (table: unknown, values: unknown) => unknown[];
  onInsert?: (table: unknown, values: unknown) => unknown[];
  trace?: string[];
}) {
  const queue = [...(options.selectQueue ?? [])];
  const trace = options.trace ?? [];
  const makeSelect = () => {
    let rows: unknown[] | null = null;
    const resolve = () => {
      if (rows === null) rows = queue.shift() ?? [];
      return Promise.resolve(rows);
    };
    const chain: Record<string, unknown> = {
      from() {
        return chain;
      },
      innerJoin() {
        return chain;
      },
      leftJoin() {
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return chain;
      },
      for() {
        return chain;
      },
      then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) {
        return resolve().then(ok, err);
      },
    };
    return chain;
  };

  const exec: Record<string, unknown> = {
    select: () => makeSelect(),
    insert: (table: unknown) => ({
      values(values: unknown) {
        trace.push(`db:insert`);
        const run = () => Promise.resolve(options.onInsert ? options.onInsert(table, values) : [values]);
        const chain: Record<string, unknown> = {
          onConflictDoUpdate: () => chain,
          returning: () => run(),
          then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err),
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set(values: unknown) {
        trace.push(`db:update`);
        const run = () => Promise.resolve(options.onUpdate ? options.onUpdate(table, values) : [{ id: JID_A }]);
        const chain: Record<string, unknown> = {
          where: () => chain,
          returning: () => run(),
          then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => run().then(ok, err),
        };
        return chain;
      },
    }),
    delete: () => {
      const chain: Record<string, unknown> = {
        where: () => chain,
        returning: () => Promise.resolve([]),
        then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve([]).then(ok, err),
      };
      return chain;
    },
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
      trace.push('db:tx:begin');
      const res = await fn(exec as unknown as Database);
      trace.push('db:tx:commit');
      return res;
    },
  };
  return exec as unknown as Database;
}

describe('worker-media: upload_commit, SDR PNG stripping, Upload-Before-Reference CAS & /tmp cleanup', () => {
  it('streams staged PNG, strips SDR gAMA tag, generates sharp thumbnail, uploads CAS BEFORE PG tx, deletes staging, and cleans /tmp', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-media-'));
    try {
      const storage = new InMemoryStorage();
      const rawPng = await buildPngWithSdrGamaChunk();
      assert.ok(rawPng.includes(Buffer.from('gAMA', 'ascii')), 'Test fixture must contain gAMA chunk');
      const rawSha = createHash('sha256').update(rawPng).digest('hex');

      const stagingKey = uploadStagingKey(WID_A, UID_A);
      await storage.putObject(stagingKey, rawPng, 'image/png');
      storage.trace.length = 0;

      const published: Array<{ channel: string; payload: unknown }> = [];
      const orderTrace: string[] = [];
      const recordedMetas: Array<Record<string, unknown>> = [];

      const ticketRow = {
        id: UID_A,
        workspaceId: WID_A,
        userId: UID_A,
        purpose: 'library_asset',
        targetProjectId: null,
        targetAssetId: null,
        targetPath: null,
        filename: 'photo.png',
        expectedMimeType: 'image/png',
        expectedModality: 'image',
        expectedSha256: rawSha,
        maxBytes: 1_000_000,
        s3StagingKey: stagingKey,
        licenseS3StagingKey: null,
        licenseFilename: null,
        licenseMaxBytes: null,
        state: 'uploaded',
        requestId: 'req-1',
        resultPayload: null,
        error: null,
        expiresAt: new Date(Date.now() + 60_000),
      };

      const db = createFakeDb({
        selectQueue: [[ticketRow]],
        trace: orderTrace,
      });

      const originalPutBlob = storage.putBlobIfAbsent.bind(storage);
      storage.putBlobIfAbsent = async (key, body, ct) => {
        orderTrace.push(`s3:putBlobIfAbsent:${key}`);
        return originalPutBlob(key, body, ct);
      };

      const result = await handleUploadCommitJob(
        {
          db,
          storage,
          eventBus: {
            publish: async (channel, payload) => {
              published.push({ channel, payload });
              return 1;
            },
          },
          logger: SILENT_LOGGER,
          workerId: 'media-test-1',
          tmpBaseDir: tmpRoot,
          probeMedia: async (filePath) => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: (await stat(filePath)).size,
            width: 32,
            height: 32,
          }),
          applyBlobDeltas: async (_tx, _wid, deltas) => {
            orderTrace.push(`cas:applyDeltas:${deltas[0].sha256}`);
            if (deltas[0].metadata) {
              recordedMetas.push(deltas[0].metadata as Record<string, unknown>);
            }
          },
        },
        {
          jobId: JID_A,
          workspaceId: WID_A,
          uploadId: UID_A,
          purpose: 'library_asset',
          name: 'Hero Photo',
        },
      );

      const finalSha = String(result.sha256);
      assert.notEqual(finalSha, rawSha, 'Stripping SDR gAMA chunk must change the stored CAS sha256');
      assert.equal(recordedMetas[0]?.sdrNormalized, true);

      // Verify stored CAS PNG no longer has the gAMA chunk.
      const storedCas = storage.objects.get(workspaceBlobKey(WID_A, finalSha));
      assert.ok(storedCas);
      assert.equal(storedCas.bytes.includes(Buffer.from('gAMA', 'ascii')), false);

      // Verify thumbnail was generated via sharp and uploaded.
      const thumb = storage.objects.get(thumbnailKey(WID_A, finalSha, 'w320'));
      assert.ok(thumb && thumb.bytes.byteLength > 0);
      assert.equal(thumb.contentType, 'image/jpeg');

      // Verify Upload-Before-Reference invariant: S3 putBlobIfAbsent happened BEFORE db:tx:begin & cas:applyDeltas!
      const s3UploadIdx = orderTrace.findIndex((entry) => entry.startsWith('s3:putBlobIfAbsent:'));
      const txBeginIdx = orderTrace.indexOf('db:tx:begin');
      const casDeltaIdx = orderTrace.findIndex((entry) => entry.startsWith('cas:applyDeltas:'));
      assert.ok(s3UploadIdx >= 0 && txBeginIdx > s3UploadIdx && casDeltaIdx > txBeginIdx);

      // Verify staging object was deleted after commit and Redis ready event was published.
      assert.equal(storage.objects.has(stagingKey), false);
      assert.ok(published.some((e) => e.channel === jobChannel(JID_A) && (e.payload as { state: string }).state === 'completed'));

      // Verify /tmp/om-ingest-<jobId> was wiped.
      await assert.rejects(() => access(path.join(tmpRoot, `om-ingest-${JID_A}`)));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('promotes project_asset WOFF2 font + companion license without ffprobe and rejects project_archive', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-font-'));
    try {
      const storage = new InMemoryStorage();
      const fontBytes = Buffer.concat([Buffer.from('wOF2', 'ascii'), Buffer.alloc(64, 0x2a)]);
      const licenseBytes = Buffer.from('SIL Open Font License 1.1\n', 'utf8');
      const fontSha = createHash('sha256').update(fontBytes).digest('hex');
      const licenseSha = createHash('sha256').update(licenseBytes).digest('hex');

      const mainStagingKey = uploadStagingKey(WID_A, UID_A);
      const licStagingKey = uploadLicenseStagingKey(WID_A, UID_A);
      await storage.putObject(mainStagingKey, fontBytes, 'font/woff2');
      await storage.putObject(licStagingKey, licenseBytes, 'text/plain; charset=utf-8');

      const ticketRow = {
        id: UID_A,
        workspaceId: WID_A,
        userId: UID_A,
        purpose: 'project_asset',
        targetProjectId: PID_A,
        targetAssetId: null,
        targetPath: 'assets/fonts/Inter-Bold.woff2',
        filename: 'Inter-Bold.woff2',
        expectedMimeType: 'font/woff2',
        expectedModality: null,
        expectedSha256: fontSha,
        maxBytes: 100_000,
        s3StagingKey: mainStagingKey,
        licenseS3StagingKey: licStagingKey,
        licenseFilename: 'OFL.txt',
        licenseMaxBytes: 10_000,
        state: 'uploaded',
        requestId: 'req-font-upload',
        resultPayload: null,
        error: null,
        expiresAt: new Date(Date.now() + 60_000),
      };

      const appliedDeltas: Array<{ sha256: string; delta: number }> = [];
      let ffprobeCalled = false;
      const db = createFakeDb({
        selectQueue: [
          [ticketRow], // load ticket
          [{ id: PID_A, trashed: false }], // lock parent project row FOR UPDATE
          [], // existing font project_files
          [], // existing license project_files
        ],
      });

      const res = await handleUploadCommitJob(
        {
          db,
          storage,
          eventBus: { publish: async () => 1 },
          logger: SILENT_LOGGER,
          workerId: 'media-font-1',
          tmpBaseDir: tmpRoot,
          probeMedia: async () => {
            ffprobeCalled = true;
            throw new Error('ffprobe must not run for WOFF2 font uploads');
          },
          applyBlobDeltas: async (_tx, _wid, deltas) => {
            for (const d of deltas) appliedDeltas.push({ sha256: d.sha256, delta: d.delta });
          },
        },
        {
          jobId: JID_A,
          workspaceId: WID_A,
          uploadId: UID_A,
          purpose: 'project_asset',
          targetProjectId: PID_A,
          targetPath: 'assets/fonts/Inter-Bold.woff2',
          name: 'Inter-Bold.woff2',
        },
      );

      assert.equal(ffprobeCalled, false);
      assert.equal(res.modality, 'font');
      assert.equal(res.mimeType, 'font/woff2');
      assert.equal(res.projectPath, 'assets/fonts/Inter-Bold.woff2');
      assert.equal(res.licenseProjectPath, 'assets/fonts/OFL.txt');
      assert.ok(storage.objects.has(workspaceBlobKey(WID_A, fontSha)));
      assert.ok(storage.objects.has(workspaceBlobKey(WID_A, licenseSha)));
      assert.equal(storage.objects.has(mainStagingKey), false);
      assert.equal(storage.objects.has(licStagingKey), false);
      assert.equal(appliedDeltas.length, 2);

      // Explicit rejection of purpose === 'project_archive' (must never fall through into library_asset).
      const archiveTicket = { ...ticketRow, purpose: 'project_archive', licenseS3StagingKey: null, expectedSha256: null };
      await storage.putObject(mainStagingKey, Buffer.from('PK\x03\x04dummy-zip-content'), 'application/zip');
      const archiveDb = createFakeDb({ selectQueue: [[archiveTicket]] });
      await assert.rejects(
        () =>
          handleUploadCommitJob(
            {
              db: archiveDb,
              storage,
              eventBus: { publish: async () => 1 },
              logger: SILENT_LOGGER,
              workerId: 'media-font-1',
              tmpBaseDir: tmpRoot,
            },
            {
              jobId: JID_B,
              workspaceId: WID_A,
              uploadId: UID_A,
              purpose: 'project_archive',
              name: 'export.zip',
            },
          ),
        { code: 'INVALID_ARGUMENT' },
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('worker-media: url_fetch SSRF & DNS-Pinning Checks', () => {
  it('blocks private IP and Fake-IP DNS answers when ALLOW_DOH_FAKEIP_FALLBACK=false', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-ssrf-'));
    try {
      const dest = path.join(tmpRoot, 'out.bin');
      await assert.rejects(
        () =>
          safePublicHttpsFetchToFile('https://public.example.com/clip.mp4', dest, {
            allowDohFakeIpFallback: false,
            resolveDns: async () => [{ address: '127.0.0.1', family: 4 }],
          }),
        { code: 'SSRF_BLOCKED' },
      );

      await assert.rejects(
        () =>
          safePublicHttpsFetchToFile('https://public.example.com/clip.mp4', dest, {
            allowDohFakeIpFallback: false,
            resolveDns: async () => [{ address: '169.254.169.254', family: 4 }],
          }),
        { code: 'SSRF_BLOCKED' },
      );

      await assert.rejects(
        () =>
          safePublicHttpsFetchToFile('https://public.example.com/clip.mp4', dest, {
            allowDohFakeIpFallback: false,
            resolveDns: async () => [{ address: '198.18.0.2', family: 4 }],
          }),
        { code: 'SSRF_BLOCKED' },
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('promotes validated url_fetch downloads into CAS identically to upload_commit', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-urlfetch-'));
    try {
      const storage = new InMemoryStorage();
      const pngBytes = await sharp({
        create: { width: 16, height: 16, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
      })
        .png()
        .toBuffer();

      const db = createFakeDb({});
      const published: Array<{ channel: string; payload: unknown }> = [];
      let appliedDeltaCount = 0;

      const promoted = await handleUrlFetchJob(
        {
          db,
          storage,
          eventBus: {
            publish: async (channel, payload) => {
              published.push({ channel, payload });
              return 1;
            },
          },
          logger: SILENT_LOGGER,
          workerId: 'media-test-1',
          tmpBaseDir: tmpRoot,
          fetchPublicUrlToFile: async (_url, destPath) => {
            await writeFile(destPath, pngBytes);
            return {
              finalUrl: 'https://cdn.example.com/image.png',
              bytes: pngBytes.byteLength,
              sha256: createHash('sha256').update(pngBytes).digest('hex'),
            };
          },
          probeMedia: async () => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: pngBytes.byteLength,
            width: 16,
            height: 16,
          }),
          applyBlobDeltas: async (_tx, _wid, deltas) => {
            appliedDeltaCount += deltas.length;
          },
        },
        {
          jobId: JID_B,
          workspaceId: WID_A,
          url: 'https://cdn.example.com/image.png',
          name: 'Remote Image',
          requestId: 'req-url-ok',
        },
      );

      assert.equal(appliedDeltaCount, 1);
      assert.ok(storage.objects.has(workspaceBlobKey(WID_A, String(promoted.sha256))));
      assert.ok(published.some((p) => p.channel === jobChannel(JID_B)));
      await assert.rejects(() => access(path.join(tmpRoot, `om-ingest-${JID_B}`)));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('worker-media: Offloaded Studio Jobs (#11 §3)', () => {
  it('handles image_thumbnail, extract_waveform_peaks, loudness_normalize, and freeze_frame writing derived S3 keys', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-studio-media-'));
    try {
      const storage = new InMemoryStorage();
      const pngBytes = await sharp({
        create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 1 } },
      })
        .png()
        .toBuffer();
      const pngSha = createHash('sha256').update(pngBytes).digest('hex');
      await storage.putObject(workspaceBlobKey(WID_A, pngSha), pngBytes, 'image/png');
      await storage.putObject(workspaceBlobKey(WID_A, SHA_A), Buffer.from('fake-av-stream'), 'video/mp4');

      const db = createFakeDb({});
      const published: Array<{ channel: string; payload: unknown }> = [];
      const baseDeps = {
        db,
        storage,
        eventBus: {
          publish: async (channel: string, payload: unknown) => {
            published.push({ channel, payload });
            return 1;
          },
        },
        logger: SILENT_LOGGER,
        workerId: 'media-test-1',
        tmpBaseDir: tmpRoot,
      };

      // 1. image_thumbnail
      const thumbRes = await handleImageThumbnailJob(
        {
          ...baseDeps,
          probeMedia: async () => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: pngBytes.byteLength,
            width: 64,
            height: 64,
          }),
        },
        {
          workspaceId: WID_A,
          blobScope: 'workspace',
          sha256: pngSha,
          spec: 'w32',
          width: 32,
        },
      );
      assert.equal(thumbRes.key, thumbnailKey(WID_A, pngSha, 'w32'));
      assert.ok(storage.objects.has(thumbRes.key));

      // 2. extract_waveform_peaks
      const peaksRes = await handleExtractWaveformPeaksJob(
        {
          ...baseDeps,
          probeMedia: async () => ({
            modality: 'audio',
            mimeType: 'audio/wav',
            extension: 'wav',
            sizeBytes: 100,
            durationSec: 2,
          }),
          runFfmpegCommand: async (_bin, args) => {
            const outFile = args.at(-1)!;
            const pcm = Buffer.alloc(64);
            pcm.writeInt16LE(16384, 0);
            pcm.writeInt16LE(-32768, 2);
            await writeFile(outFile, pcm);
            return { code: 0, stdout: '', stderr: '' };
          },
        },
        {
          workspaceId: WID_A,
          blobScope: 'workspace',
          sha256: SHA_A,
          samples: 16,
        },
      );
      assert.equal(peaksRes.key, derivedAssetKey(WID_A, SHA_A, 'waveform-peaks.json'));
      assert.equal(peaksRes.peaks.length, 16);
      assert.ok(peaksRes.peaks[0] >= 0.5);
      assert.ok(storage.objects.has(peaksRes.key));

      // 3. loudness_normalize
      const eburStderr = `
Summary:
  Integrated loudness:
    I:         -22.4 LUFS
    Threshold: -32.4 LUFS
  Loudness range:
    LRA:         4.2 LU
  True peak:
    Peak:       -4.1 dBFS
`;
      const loudRes = await handleLoudnessNormalizeJob(
        {
          ...baseDeps,
          runFfmpegCommand: async () => ({ code: 0, stdout: '', stderr: eburStderr }),
        },
        {
          jobId: JID_A,
          workspaceId: WID_A,
          projectId: PID_A,
          blobScope: 'workspace',
          sha256: SHA_A,
          targetPath: 'assets/voice.wav',
          targetLufs: -16,
        },
      );
      assert.equal(loudRes.measuredLufs, -22.4);
      assert.equal(loudRes.derivedKey, derivedAssetKey(WID_A, SHA_A, 'loudness.json'));
      assert.ok(storage.objects.has(String(loudRes.derivedKey)));

      // 4. freeze_frame (locks parent project row FOR UPDATE before checking existing project_files)
      const freezeDb = createFakeDb({
        selectQueue: [
          [{ id: PID_A, trashed: false }], // locked project row
          [], // existing project_files
        ],
      });
      const freezeRes = await handleFreezeFrameJob(
        {
          ...baseDeps,
          db: freezeDb,
          probeMedia: async () => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: pngBytes.byteLength,
            width: 64,
            height: 64,
          }),
          runFfmpegCommand: async (_bin, args) => {
            await writeFile(args.at(-1)!, pngBytes);
            return { code: 0, stdout: '', stderr: '' };
          },
          applyBlobDeltas: async () => {},
        },
        {
          jobId: JID_B,
          workspaceId: WID_A,
          projectId: PID_A,
          blobScope: 'workspace',
          sha256: SHA_A,
          timestampSec: 1.5,
          targetPath: 'assets/freeze-1500.png',
        },
      );
      assert.equal(freezeRes.path, 'assets/freeze-1500.png');
      assert.equal(freezeRes.derivedKey, derivedAssetKey(WID_A, SHA_A, 'freeze-1500ms.png'));
      assert.ok(storage.objects.has(workspaceBlobKey(WID_A, String(freezeRes.sha256))));
      assert.ok(storage.objects.has(String(freezeRes.derivedKey)));
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('worker-media: media-generate (remote_id persisted BEFORE polling + resume skips submit)', () => {
  it('persists remote_id in PG BEFORE polling PlatformModelGateway and never re-submits on resume', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-gen-'));
    try {
      const storage = new InMemoryStorage();
      const pngBytes = await sharp({
        create: { width: 16, height: 16, channels: 4, background: { r: 255, g: 255, b: 0, alpha: 1 } },
      })
        .png()
        .toBuffer();

      const timeline: string[] = [];
      let persistedRemoteId: string | null = null;
      let submitCount = 0;

      const gateway: PlatformModelGateway = {
        providerId: 'opendesign',
        async listMediaModels() {
          return [];
        },
        async uploadReference() {
          return { remoteAssetId: 'ref_1' };
        },
        async submitTask() {
          submitCount += 1;
          timeline.push('gateway:submitTask');
          return { remoteTaskId: 'remote_task_42' };
        },
        async pollTask() {
          timeline.push(`gateway:pollTask(persistedRemoteId=${persistedRemoteId})`);
          return {
            remoteTaskId: 'remote_task_42',
            status: 'succeeded',
            outputs: [{ inlineBytes: pngBytes, mimeType: 'image/png', sizeBytes: pngBytes.byteLength }],
          };
        },
        async downloadOutput() {
          throw new Error('inlineBytes path used');
        },
      };

      let capturedClaimToken = '';
      const db = createFakeDb({
        selectQueue: [
          // Transaction fencing check: returns claimToken captured during claim update
          [{ state: 'running', get claimToken() { return capturedClaimToken; } }],
        ],
        onUpdate(table, values) {
          const v = values as Record<string, unknown>;
          if (table === jobs && typeof v.claimToken === 'string') {
            capturedClaimToken = v.claimToken;
            return [
              {
                id: JID_A,
                workspaceId: WID_A,
                projectId: null,
                state: 'running',
                claimToken: capturedClaimToken,
                remoteId: null,
                inputPayload: {
                  modality: 'image',
                  mode: 'text-to-image',
                  modelId: 'mock-image-1',
                  prompt: 'A sunrise over mountains',
                  parameters: {},
                  assetName: 'Sunrise',
                },
              },
            ];
          }
          if (table === jobs && typeof v.remoteId === 'string') {
            persistedRemoteId = v.remoteId;
            timeline.push(`db:persist_remote_id:${v.remoteId}`);
            return [{ id: JID_A }];
          }
          return [{ id: JID_A }];
        },
      });

      const published: Array<{ channel: string; payload: unknown }> = [];
      const res = await processMediaGenerateJob(
        {
          db,
          storage,
          eventBus: {
            publish: async (channel, payload) => {
              published.push({ channel, payload });
              return 1;
            },
            subscribe: async () => async () => {},
          },
          logger: SILENT_LOGGER,
          workerId: 'media-gen-1',
          gateway,
          pollIntervalMs: 1,
          tmpBaseDir: tmpRoot,
          probeMedia: async () => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: pngBytes.byteLength,
            width: 16,
            height: 16,
          }),
          applyBlobDeltas: async () => {},
        },
        'generate_media',
        { jobId: JID_A, workspaceId: WID_A },
      );

      assert.equal(res.state, 'completed');
      assert.equal(submitCount, 1);
      assert.equal(persistedRemoteId, 'remote_task_42');
      // Verify strict chronological order: submit -> db persist remote_id -> poll!
      assert.deepEqual(timeline, [
        'gateway:submitTask',
        'db:persist_remote_id:remote_task_42',
        'gateway:pollTask(persistedRemoteId=remote_task_42)',
      ]);
      assert.ok(published.some((e) => e.channel === jobChannel(JID_A)));

      // Resume with existing remote_id MUST NOT call submitTask again.
      let resumeClaimToken = '';
      const resumeDb = createFakeDb({
        selectQueue: [[{ state: 'running', get claimToken() { return resumeClaimToken; } }]],
        onUpdate(table, values) {
          const v = values as Record<string, unknown>;
          if (table === jobs && typeof v.claimToken === 'string') {
            resumeClaimToken = v.claimToken;
            return [
              {
                id: JID_B,
                workspaceId: WID_A,
                projectId: null,
                state: 'running',
                claimToken: resumeClaimToken,
                remoteId: 'remote_task_42',
                inputPayload: {
                  modality: 'image',
                  mode: 'text-to-image',
                  modelId: 'mock-image-1',
                  prompt: 'A sunrise over mountains',
                  parameters: {},
                  assetName: 'Sunrise',
                },
              },
            ];
          }
          return [{ id: JID_B }];
        },
      });
      await processMediaGenerateJob(
        {
          db: resumeDb,
          storage,
          eventBus: { publish: async () => 1, subscribe: async () => async () => {} },
          logger: SILENT_LOGGER,
          workerId: 'media-gen-1',
          gateway,
          pollIntervalMs: 1,
          tmpBaseDir: tmpRoot,
          probeMedia: async () => ({
            modality: 'image',
            mimeType: 'image/png',
            extension: 'png',
            sizeBytes: pngBytes.byteLength,
            width: 16,
            height: 16,
          }),
          applyBlobDeltas: async () => {},
        },
        'resume_generation',
        { jobId: JID_B, workspaceId: WID_A, remoteId: 'remote_task_42' },
      );
      assert.equal(submitCount, 1, 'resume_generation must NEVER re-submit paid upstream task');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('maps upstream cancelled status to cancelled and emits exactly one failed SSE event on upstream failure', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'om-test-gen-term-'));
    try {
      const storage = new InMemoryStorage();

      // 1. Upstream cancelled -> state: 'cancelled', single cancelled event.
      const cancelEvents: Array<Record<string, unknown>> = [];
      const cancelDbUpdates: Array<Record<string, unknown>> = [];
      const cancelDb = createFakeDb({
        onUpdate(table, values) {
          const v = values as Record<string, unknown>;
          if (table === jobs && typeof v.claimToken === 'string') {
            return [
              {
                id: JID_A,
                workspaceId: WID_A,
                projectId: null,
                state: 'running',
                claimToken: v.claimToken,
                remoteId: 'remote_cancel_1',
                inputPayload: {
                  modality: 'image',
                  mode: 'text-to-image',
                  modelId: 'mock-image-1',
                  prompt: 'Cancel test',
                  parameters: {},
                  assetName: 'Cancel Test',
                },
              },
            ];
          }
          cancelDbUpdates.push(v);
          return [{ id: JID_A }];
        },
      });
      const cancelGateway: PlatformModelGateway = {
        providerId: 'opendesign',
        async listMediaModels() { return []; },
        async uploadReference() { return { remoteAssetId: 'r' }; },
        async submitTask() { throw new Error('must not submit'); },
        async pollTask() {
          return {
            remoteTaskId: 'remote_cancel_1',
            status: 'cancelled',
            error: { code: 'USER_CANCELLED', message: 'Cancelled upstream' },
          };
        },
        async downloadOutput() { throw new Error('no output'); },
      };

      const cancelRes = await processMediaGenerateJob(
        {
          db: cancelDb,
          storage,
          eventBus: {
            publish: async (_ch, payload) => {
              cancelEvents.push(payload as Record<string, unknown>);
              return 1;
            },
            subscribe: async () => async () => {},
          },
          logger: SILENT_LOGGER,
          workerId: 'media-gen-2',
          gateway: cancelGateway,
          pollIntervalMs: 1,
          tmpBaseDir: tmpRoot,
        },
        'resume_generation',
        { jobId: JID_A, workspaceId: WID_A, remoteId: 'remote_cancel_1' },
      );
      assert.equal(cancelRes.state, 'cancelled');
      assert.ok(cancelDbUpdates.some((u) => u.state === 'cancelled'));
      assert.equal(cancelEvents.filter((e) => e.state === 'cancelled').length, 1);
      assert.equal(cancelEvents.filter((e) => e.state === 'failed').length, 0);

      // 2. Upstream failed -> exactly ONE failed SSE event carrying upstream errorCode (never duplicate STORAGE_ERROR).
      const failEvents: Array<Record<string, unknown>> = [];
      const failDb = createFakeDb({
        onUpdate(table, values) {
          const v = values as Record<string, unknown>;
          if (table === jobs && typeof v.claimToken === 'string') {
            return [
              {
                id: JID_B,
                workspaceId: WID_A,
                projectId: null,
                state: 'running',
                claimToken: v.claimToken,
                remoteId: 'remote_fail_1',
                inputPayload: {
                  modality: 'image',
                  mode: 'text-to-image',
                  modelId: 'mock-image-1',
                  prompt: 'Fail test',
                  parameters: {},
                  assetName: 'Fail Test',
                },
              },
            ];
          }
          return [{ id: JID_B }];
        },
      });
      const failGateway: PlatformModelGateway = {
        ...cancelGateway,
        async pollTask() {
          return {
            remoteTaskId: 'remote_fail_1',
            status: 'failed',
            error: { code: 'insufficient_balance', message: 'Insufficient balance' },
          };
        },
      };

      await assert.rejects(() =>
        processMediaGenerateJob(
          {
            db: failDb,
            storage,
            eventBus: {
              publish: async (_ch, payload) => {
                failEvents.push(payload as Record<string, unknown>);
                return 1;
              },
              subscribe: async () => async () => {},
            },
            logger: SILENT_LOGGER,
            workerId: 'media-gen-2',
            gateway: failGateway,
            pollIntervalMs: 1,
            tmpBaseDir: tmpRoot,
          },
          'resume_generation',
          { jobId: JID_B, workspaceId: WID_A, remoteId: 'remote_fail_1' },
        ),
      );
      const failedPublished = failEvents.filter((e) => e.state === 'failed');
      assert.equal(failedPublished.length, 1, 'Must emit exactly one failed event (no duplicate catch event)');
      assert.equal(failedPublished[0].errorCode, 'insufficient_balance');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('worker-media: Two-Phase CAS blob-gc & Expired Upload Sweeper', () => {
  it('deletes blob + thumbnails/{sha256}/ + derived/{sha256}/ and resurrects on transient S3 failure', async () => {
    const storage = new InMemoryStorage();
    const shaOk = 'a'.repeat(64);
    const shaFail = 'b'.repeat(64);

    await storage.putObject(workspaceBlobKey(WID_A, shaOk), Buffer.from('blob-ok'), 'video/mp4');
    await storage.putObject(thumbnailKey(WID_A, shaOk, 'w320'), Buffer.from('thumb'), 'image/jpeg');
    await storage.putObject(derivedAssetKey(WID_A, shaOk, 'waveform-peaks.json'), Buffer.from('{}'), 'application/json');

    await storage.putObject(workspaceBlobKey(WID_A, shaFail), Buffer.from('blob-fail'), 'video/mp4');
    storage.failDeleteKey = workspaceBlobKey(WID_A, shaFail);

    const finalized: string[] = [];
    const resurrected: string[] = [];

    const result = await sweepUnreferencedBlobs(
      {
        db: createFakeDb({}),
        storage,
        logger: SILENT_LOGGER,
        casOps: {
          markZeroRefForDeletion: async () => [
            { workspaceId: WID_A, sha256: shaOk, s3Key: workspaceBlobKey(WID_A, shaOk) },
            { workspaceId: WID_A, sha256: shaFail, s3Key: workspaceBlobKey(WID_A, shaFail) },
          ],
          finalizeBlobDeletion: async (_db, _wid, sha) => {
            finalized.push(sha);
            return true;
          },
          resurrectBlobIfReferenced: async (_db, _wid, sha) => {
            resurrected.push(sha);
            return true;
          },
        },
      },
      { batchSize: 500, graceSeconds: 86_400 },
    );

    assert.equal(result.claimed, 2);
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.thumbnailsDeleted, 1);
    assert.equal(result.derivedDeleted, 1);
    assert.deepEqual(finalized, [shaOk]);
    assert.deepEqual(resurrected, [shaFail]);

    // Verify all 3 keyspaces for shaOk were removed from S3.
    assert.equal(storage.objects.has(workspaceBlobKey(WID_A, shaOk)), false);
    assert.ok(storage.trace.includes(`deletePrefix:${blobThumbnailsPrefix(WID_A, shaOk)}`));
    assert.ok(storage.trace.includes(`deletePrefix:${blobDerivedPrefix(WID_A, shaOk)}`));
  });

  it('sweeps expired upload tickets and deletes both main and companion font license staging keys', async () => {
    const storage = new InMemoryStorage();
    const mainKey = uploadStagingKey(WID_A, UID_A);
    const licKey = uploadLicenseStagingKey(WID_A, UID_A);
    await storage.putObject(mainKey, Buffer.from('stale'), 'font/woff2');
    await storage.putObject(licKey, Buffer.from('license'), 'text/plain');

    let updatedToExpired = false;
    const db = createFakeDb({
      selectQueue: [
        [
          {
            id: UID_A,
            workspaceId: WID_A,
            s3StagingKey: mainKey,
            licenseS3StagingKey: licKey,
            state: 'issued',
            expiresAt: new Date(Date.now() - 10_000),
          },
        ],
      ],
      onUpdate(table, values) {
        if (table === uploadTickets && (values as Record<string, unknown>).state === 'expired') {
          updatedToExpired = true;
        }
        return [];
      },
    });

    const res = await sweepExpiredUploads({ db, storage, logger: SILENT_LOGGER }, { batchSize: 100 });
    assert.equal(res.swept, 1);
    assert.equal(res.failed, 0);
    assert.equal(updatedToExpired, true);
    assert.equal(storage.objects.has(mainKey), false);
    assert.equal(storage.objects.has(licKey), false);
  });
});
