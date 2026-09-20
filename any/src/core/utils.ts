import { LIMITS } from './constants';
import type { Channel, Task, TaskStatus } from './types';

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function randomUUID(): string {
  // getRandomValues also works when the console is opened directly over HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function maskKey(value: string): string {
  const tail = value.slice(-4);
  const prefix = value.startsWith('sk-') ? 'sk-' : '';
  return `${prefix}••••••••••••${tail ? ` · ${tail}` : ''}`;
}

export function keyTail(value: string): string {
  return value.slice(-4).padStart(4, '•');
}

export function modelsForChannel(models: string[], channel: Channel): string[] {
  const prefix = channel === 'gpt' ? 'gpt-' : 'claude-';
  return models.filter((model) => model.toLowerCase().startsWith(prefix));
}

export function clampSetting(
  name: keyof typeof LIMITS,
  input: number,
): number {
  const limits = LIMITS[name];
  if (!Number.isFinite(input)) return limits.min;
  return Math.min('max' in limits ? limits.max : Number.MAX_SAFE_INTEGER, Math.max(limits.min, input));
}

export function isAcceptedStatus(status: TaskStatus): boolean {
  return status.startsWith('accepted-');
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === 'accepted-completed' ||
    status === 'accepted-stream-interrupted' ||
    status === 'exhausted' ||
    status === 'cancelled'
  );
}

export function isSchedulableStatus(status: TaskStatus): boolean {
  return status === 'running' || status === 'requesting' || status === 'waiting' || status === 'keepalive';
}

export function isTaskActive(task: Task): boolean {
  return isSchedulableStatus(task.status) || (task.config.keepalive && task.status === 'accepted-streaming');
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} 分 ${rest} 秒`;
}

export function formatTime(timestamp?: number): string {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export function formatDateTime(timestamp?: number): string {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

export function countdownLabel(nextAttemptAt?: number, now = Date.now()): string {
  if (!nextAttemptAt) return '—';
  const seconds = Math.max(0, Math.ceil((nextAttemptAt - now) / 1000));
  return seconds === 0 ? '即将请求' : `${seconds} 秒`;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;

  const suffix = '…';
  const suffixBytes = encoder.encode(suffix).byteLength;
  let end = Math.max(0, maxBytes - suffixBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });

  while (end > 0) {
    try {
      return `${decoder.decode(encoded.slice(0, end))}${suffix}`;
    } catch {
      end -= 1;
    }
  }
  return suffixBytes <= maxBytes ? suffix : '';
}
