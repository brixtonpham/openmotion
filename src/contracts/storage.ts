import type { Readable } from 'node:stream';

export const BLOB_SCOPES = ['workspace', 'catalog'] as const;
export type BlobScope = (typeof BLOB_SCOPES)[number];

export const BLOB_GC_STATES = ['active', 'deleting'] as const;
export type BlobGcState = (typeof BLOB_GC_STATES)[number];

/**
 * Structured media metadata populated by ffprobe / Sharp on worker-media
 * and consumed by diskless Studio routes (lintProjectInMemory, timelineInMemory,
 * HEAD /api/projects/:id/preview/*, /media/metadata).
 */
export interface BlobMetadata {
  modality?: 'image' | 'video' | 'audio';
  mimeType?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: number;
  codec?: string;
  audioCodec?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  rotation?: number;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
  waveformPeaksKey?: string;
  loudnessLufs?: number;
  sdrNormalized?: boolean;
}

export interface HeadObjectResult {
  contentLength: number;
  contentType?: string;
  etag?: string;
}

export interface ObjectStreamResult {
  stream: Readable;
  contentLength?: number;
  contentType?: string;
  etag?: string;
  contentRange?: string;
}

export interface PresignGetOptions {
  expiresInSec?: number;
  responseContentDisposition?: string;
  responseContentType?: string;
}

export interface PresignPutOptions {
  contentType: string;
  contentLength?: number;
  expiresInSec?: number;
}

export interface BucketCorsRule {
  readonly AllowedOrigins: readonly string[];
  readonly AllowedMethods: readonly ('GET' | 'HEAD' | 'PUT')[];
  readonly AllowedHeaders: readonly string[];
  readonly ExposeHeaders: readonly string[];
  readonly MaxAgeSeconds: number;
}

/** Required CORS headers for mediabunny, thumbnailDiskCache, and VideoFrameThumbnail across 302 presigned GET/PUT. */
export const S3_CANONICAL_CORS_SPEC = {
  AllowedMethods: ['GET', 'HEAD', 'PUT'] as const,
  AllowedHeaders: ['Range', 'If-None-Match', 'If-Match', 'Content-Type', 'Content-Length'] as const,
  ExposeHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag', 'Content-Type'] as const,
  MaxAgeSeconds: 3600,
} as const;

export interface StoragePort {
  putObject(
    key: string,
    body: Buffer | Uint8Array | Readable | string,
    contentType: string,
    contentLength?: number,
  ): Promise<void>;
  putBlobIfAbsent(key: string, body: Buffer, contentType: string): Promise<{ uploaded: boolean }>;
  getObjectBuffer(key: string, maxBytes?: number): Promise<Buffer>;
  getObjectStream(key: string, range?: string): Promise<ObjectStreamResult>;
  headObject(key: string): Promise<HeadObjectResult | null>;
  deleteObject(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  presignPut(key: string, options: PresignPutOptions): Promise<string>;
  presignGet(key: string, options?: PresignGetOptions): Promise<string>;
  ensureBucketAndCors(allowedOrigins?: readonly string[]): Promise<void>;
}
