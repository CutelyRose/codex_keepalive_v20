import { LIMITS, MODEL_ID_PATTERN } from './constants';
import { normalizeApiBaseUrl } from './api-url';
import type { ManagedTaskConfig, NotificationSettings, PoolTaskConfig, TaskConfig } from './types';

export function showdocEndpoint(pushUrl: string): string {
  if (!/^https:\/\/push\.showdoc\.com\.cn\/server\/api\/push\/[A-Za-z0-9_-]+$/.test(pushUrl)) {
    throw new Error('ShowDoc 推送 URL 无效，请复制推送服务提供的完整 HTTPS 地址');
  }
  return pushUrl;
}

export function serverchanEndpoint(sendKey: string): string {
  const match = /^sctp(\d+)t[A-Za-z0-9_-]+$/.exec(sendKey);
  if (match) return `https://${match[1]}.push.ft07.com/send/${sendKey}.send`;
  if (/^SCT[A-Za-z0-9_-]+$/.test(sendKey)) return `https://sctapi.ftqq.com/${sendKey}.send`;
  throw new Error('Server 酱 SendKey 格式无效，需要 SCT 或 sctp 开头的密钥');
}

export function notificationConfigured(config: NotificationSettings): boolean {
  return Boolean(config.showdocPushUrl || config.serverchanSendKey || config.telegramChatId && config.telegramBotToken);
}

export function validateNotificationSettings(input: NotificationSettings): NotificationSettings {
  const values = {
    showdocPushUrl: input.showdocPushUrl ?? '',
    telegramChatId: input.telegramChatId, telegramBotToken: input.telegramBotToken,
    serverchanSendKey: input.serverchanSendKey ?? '', serverchanTags: input.serverchanTags ?? '',
  };
  for (const [field, value] of Object.entries(values)) {
    const max = field === 'showdocPushUrl' ? 1024 : field.endsWith('Tags') || field.endsWith('ChatId') ? 128 : 256;
    if (typeof value !== 'string' || value.length > max) {
      throw new Error('通知配置无效或超长');
    }
  }
  const config = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])) as Required<NotificationSettings>;
  if ([config.showdocPushUrl, config.serverchanSendKey, config.telegramChatId || config.telegramBotToken].filter(Boolean).length > 1) {
    throw new Error('每个任务只能配置一种成功通知方式');
  }
  if (Boolean(config.telegramChatId) !== Boolean(config.telegramBotToken)) throw new Error('Chat ID 和 Bot Token 需要一起填写');
  if (config.telegramBotToken && !/^\d+:[A-Za-z0-9_-]+$/.test(config.telegramBotToken)) throw new Error('Telegram Bot Token 格式无效');
  if (config.serverchanSendKey) serverchanEndpoint(config.serverchanSendKey);
  if (config.showdocPushUrl) showdocEndpoint(config.showdocPushUrl);
  return config;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}不能为空或超长`);
  return value.trim();
}

function validateCommon<T extends ManagedTaskConfig>(input: T): T {
  if (!input || typeof input !== 'object') throw new Error('任务配置无效');
  if (input.channel !== 'gpt' && input.channel !== 'claude') throw new Error('请求通道无效');
  const numbers = {
    concurrency: 'concurrency', intervalSeconds: 'intervalSeconds',
    timeoutSeconds: 'timeoutSeconds', keepaliveMinSeconds: 'keepaliveMinSeconds',
    keepaliveMaxSeconds: 'keepaliveMaxSeconds',
  } as const;
  for (const [field, limit] of Object.entries(numbers)) {
    const value = input[field as keyof typeof numbers];
    const range = LIMITS[limit];
    if (!Number.isFinite(value) || value < range.min || ('max' in range && value > range.max) ||
        (['maxAttempts', 'concurrency'].includes(field) && !Number.isSafeInteger(value))) {
      throw new Error(`${field} 超出范围`);
    }
  }
  if (typeof input.keepalive !== 'boolean' || typeof input.oneMillion !== 'boolean') throw new Error('任务开关无效');
  if (input.keepaliveMinSeconds > input.keepaliveMaxSeconds) throw new Error('保活最短间隔不能大于最长间隔');
  const model = text(input.model, '模型', 160);
  if (!new RegExp(`^(?:${MODEL_ID_PATTERN})+$`).test(model)) throw new Error('模型 ID 格式无效');
  return {
    ...input, name: text(input.name, '任务名称', 80),
    prompt: text(input.prompt, '提示词', 1000), model,
    ...validateNotificationSettings(input),
  };
}

export function validateTaskConfig(input: TaskConfig): TaskConfig {
  const config = validateCommon(input);
  if ('keyIds' in config) throw new Error('Key 池只能通过 Python 池任务运行');
  if (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1) throw new Error('maxAttempts 超出范围');
  return { ...config, keyId: text(config.keyId, 'Key ID', 100), baseUrl: normalizeApiBaseUrl(config.baseUrl) };
}

export function validatePoolTaskConfig(input: PoolTaskConfig): PoolTaskConfig {
  const config = validateCommon(input);
  if (!Array.isArray(config.keyIds) || config.keyIds.length < 2) throw new Error('Key 池至少选择两个不同的 Key');
  const keyIds = config.keyIds.map(id => text(id, 'Key ID', 100));
  if (new Set(keyIds).size !== keyIds.length) throw new Error('Key 池不能包含重复成员');
  if (!config.keepalive) throw new Error('Key 池必须开启保活');
  if ('keyId' in config || 'baseUrl' in config || 'maxAttempts' in config) throw new Error('Key 池不接受单 Key 地址或探活次数上限');
  return { ...config, keyIds, keepalive: true };
}
