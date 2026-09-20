import type { TaskConfig } from '../core/types';
import { apiEndpoint } from '../core/api-url';
import { makeId } from '../core/utils';
import { buildClaudeContractRequest } from './claude-contract';
import { buildCodexContractRequest } from './codex-contract';

export interface BuiltRequest {
  url: string;
  headers: Headers;
  body: string;
}

export interface RequestBuilderOptions {
  baseUrl?: string;
  makeId?: (prefix: string) => string;
  sessionId?: string;
}

function requestIds(options: RequestBuilderOptions): (prefix: string) => string {
  return (prefix) => {
    if (options.sessionId) {
      if (prefix === 'session' || prefix === 'claude-session' || prefix === 'installation') return options.sessionId;
      if (prefix === 'claude-device') return options.sessionId.replaceAll('-', '').repeat(2);
    }
    return (options.makeId ?? makeId)(prefix);
  };
}

const CODEX_PROBE_INSTRUCTIONS = [
  'You are handling a queue availability request from AnyRouter Browser Console.',
  'Follow the user request exactly, keep the response brief, and do not call tools.',
].join(' ');

export function buildGptRequest(
  config: TaskConfig,
  token: string,
  options: RequestBuilderOptions = {},
): BuiltRequest {
  const nextId = requestIds(options);
  const request = buildCodexContractRequest({
    model: config.model,
    prompt: config.prompt,
    token,
    instructions: CODEX_PROBE_INSTRUCTIONS,
    makeId: nextId,
  });

  return {
    url: apiEndpoint(options.baseUrl ?? config.baseUrl, 'responses'),
    headers: new Headers(request.headers),
    body: request.body,
  };
}

export function buildClaudeRequest(
  config: TaskConfig,
  token: string,
  options: RequestBuilderOptions = {},
): BuiltRequest {
  const request = buildClaudeContractRequest({
    model: config.model,
    prompt: config.prompt,
    token,
    clientContext: 'You are serving a browser-based Claude Code compatible request.',
    instructions: 'Follow the user request exactly, keep the response brief, and do not call tools.',
    oneMillion: config.oneMillion,
    makeId: requestIds(options),
  });

  return {
    url: `${apiEndpoint(options.baseUrl ?? config.baseUrl, 'messages')}?beta=true`,
    headers: new Headers(request.headers),
    body: request.body,
  };
}

export function buildTaskRequest(
  config: TaskConfig,
  token: string,
  options: RequestBuilderOptions = {},
): BuiltRequest {
  return config.channel === 'gpt'
    ? buildGptRequest(config, token, options)
    : buildClaudeRequest(config, token, options);
}
