export type Channel = 'gpt' | 'claude';
export type Scheduler = 'browser' | 'python';
export type SchedulerChoice = Scheduler | 'both';
export interface NotificationSettings {
  showdocPushUrl?: string;
  telegramChatId: string;
  telegramBotToken: string;
  serverchanSendKey?: string;
  serverchanTags?: string;
}
export interface AppSettings extends NotificationSettings {
  attempts: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  concurrency: number;
  keepalive: boolean;
  keepaliveMinSeconds: number;
  keepaliveMaxSeconds: number;
}
export interface KeyRecord {
  id: string;
  alias: string;
  value: string;
  baseUrl: string;
  authStatus: 'checking' | 'ready' | 'error';
  models: string[];
  lastAuthenticatedAt?: number;
  error?: string;
}
export interface AuthResult { ok: boolean; models: string[]; error?: string }
export type TaskStatus = 'running' | 'requesting' | 'waiting' | 'keepalive' | 'paused' |
  'accepted-streaming' | 'accepted-completed' | 'accepted-stream-interrupted' |
  'exhausted' | 'cancelled';
export type NotificationStatus = 'not-requested' | 'queued' | 'retrying' | 'sent' | 'dead';
export interface TaskConfig extends NotificationSettings {
  name: string;
  channel: Channel;
  keyId: string;
  baseUrl: string;
  model: string;
  prompt: string;
  maxAttempts: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  concurrency: number;
  keepalive: boolean;
  keepaliveMinSeconds: number;
  keepaliveMaxSeconds: number;
  oneMillion: boolean;
}
export interface TaskEvent {
  id: string;
  at: number;
  type: string;
  title: string;
  detail: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}
export interface Task {
  id: string;
  scheduler: Scheduler;
  config: TaskConfig;
  status: TaskStatus;
  attemptsMade: number;
  probeAttempts: number;
  successes: number;
  healthy: boolean;
  sessionId: string;
  notificationConfigured: boolean;
  lastAttemptAt?: number;
  lastNotifiedAt?: number;
  startedAt: number;
  updatedAt: number;
  acceptedAt?: number;
  completedAt?: number;
  nextAttemptAt?: number;
  pausedFrom?: TaskStatus;
  lastError?: string;
  stopReason?: 'permanent-error';
  responseSummary: string;
  events: TaskEvent[];
  notificationStatus: NotificationStatus;
  notificationAttempts: number;
  notificationId?: string;
  notificationNextAttemptAt?: number;
  notificationReadFailures?: number;
  notificationPollingPaused?: boolean;
  notificationReadError?: string;
}
export interface StoreChangeDetail { kind: 'keys' | 'tasks' | 'settings' }
export interface NotificationPayload {
  taskId: string;
  taskName: string;
  channel: Channel;
  model: string;
  keyTail: string;
  attempts: number;
  elapsedMs: number;
  acceptedAt: number;
  showdocUrl?: string;
  chatId?: string;
  botToken?: string;
  sendKey?: string;
  tags?: string;
}
export interface NotificationReceipt {
  id: string;
  status: 'queued' | 'retrying' | 'sent' | 'dead';
  attempts: number;
  error?: string;
  nextAttemptAt?: number;
}
export interface NotificationClient {
  enqueue(payload: NotificationPayload): Promise<NotificationReceipt>;
  get(id: string): Promise<NotificationReceipt>;
}
