import claudeTools from './contracts/claude-code-2.1.231-tools.json';
import { randomUUID } from '../core/utils';

const CLAUDE_CODE_BETAS = [
  'claude-code-20250219',
  'context-1m-2025-08-07',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'effort-2025-11-24',
  'fallback-credit-2026-06-01',
] as const;

export interface ClaudeContractInput {
  model: string;
  prompt: string;
  token: string;
  clientContext: string;
  instructions: string;
  oneMillion?: boolean;
  makeId?: (prefix: string) => string;
}

export interface ClaudeContractRequest {
  headers: Record<string, string>;
  body: string;
  model: string;
  identity: ClaudeRequestIdentity;
}

export interface ClaudeRequestIdentity {
  sessionId: string;
  deviceId: string;
}

export function createClaudeRequestIdentity(
  makeId?: (prefix: string) => string,
): ClaudeRequestIdentity {
  return {
    sessionId: makeId ? makeId('claude-session') : randomUUID(),
    deviceId: makeId ? makeId('claude-device') : randomHex(32),
  };
}

export function buildClaudeContractRequest(input: ClaudeContractInput): ClaudeContractRequest {
  const identity = createClaudeRequestIdentity(input.makeId);
  const { sessionId, deviceId } = identity;
  const oneMillionSuffix = /\[1m\]$/i;
  const modelHasOneMillionSuffix = oneMillionSuffix.test(input.model);
  const oneMillion = input.oneMillion === true || modelHasOneMillionSuffix;
  const model = modelHasOneMillionSuffix
    ? input.model.replace(oneMillionSuffix, '')
    : input.model;
  const beta = oneMillion
    ? [...CLAUDE_CODE_BETAS]
    : CLAUDE_CODE_BETAS.filter((name) => name !== 'context-1m-2025-08-07');

  return {
    identity,
    model,
    headers: {
      Authorization: `Bearer ${input.token}`,
      'x-api-key': input.token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': beta.join(','),
      'x-claude-code-session-id': sessionId,
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-app': 'cli',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: input.prompt,
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      system: [
        {
          type: 'text',
          text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: input.clientContext,
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: input.instructions,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: claudeTools,
      metadata: {
        user_id: JSON.stringify({
          device_id: deviceId,
          account_uuid: '',
          session_id: sessionId,
        }),
      },
      max_tokens: 64_000,
      thinking: { type: 'adaptive' },
      context_management: {
        edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
      },
      output_config: { effort: 'max' },
      stream: true,
    }),
  };
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
