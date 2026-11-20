export type ProjectEvent =
  | {
      type: 'file-change' | 'files-changed';
      workspaceId: string;
      projectId: string;
      revision: string;
      versionId?: string;
      paths: string[];
      writeToken?: string;
      affectsPreview?: boolean;
      affectedCompositions?: string[];
      ts: number;
    }
  | {
      type: 'history-changed';
      workspaceId: string;
      projectId: string;
      revision: string;
      versionId?: string;
      historySeq: number;
      ts: number;
    }
  | {
      type: 'render-updated';
      workspaceId: string;
      projectId: string;
      jobId: string;
      state: string;
      progress: number;
      stage?: string;
      ts: number;
    };

export interface JobProgressEvent {
  jobId: string;
  workspaceId: string;
  projectId?: string | null;
  kind: string;
  state: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  stage?: string;
  progress: number;
  errorCode?: string;
  errorMessage?: string;
  resultJson?: Record<string, unknown>;
  ts: number;
}

export interface JobCancelEvent {
  jobId: string;
  workspaceId: string;
  requestedAt: number;
}

export interface SelectionEvent {
  workspaceId: string;
  projectId: string;
  compositionId?: string;
  elementIds: string[];
  senderId?: string;
  ts: number;
}

export interface McpSessionEvent {
  workspaceId: string;
  sessionId: string;
  event: string;
  data: unknown;
  ts: number;
}

export interface RenderWorkerHealth {
  workerId: string;
  ffmpeg: boolean;
  ffprobe: boolean;
  chromium: boolean;
  concurrency: number;
  activeJobs: number;
  updatedAt: number;
}
