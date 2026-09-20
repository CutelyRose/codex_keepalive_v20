import { makeId as defaultMakeId } from '../core/utils';

export interface CodexContractInput {
  model: string;
  prompt: string;
  token: string;
  instructions: string;
  makeId?: (prefix: string) => string;
}

export interface CodexContractRequest {
  headers: Record<string, string>;
  body: string;
  identity: CodexRequestIdentity;
}

export interface CodexRequestIdentity {
  installationId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  windowId: string;
}

export function createCodexRequestIdentity(
  makeId: (prefix: string) => string = defaultMakeId,
): CodexRequestIdentity {
  const installationId = makeId('installation');
  const sessionId = makeId('session');
  return {
    installationId,
    sessionId,
    threadId: sessionId,
    turnId: makeId('turn'),
    windowId: `${sessionId}:0`,
  };
}

export function buildCodexContractRequest(input: CodexContractInput): CodexContractRequest {
  const identity = createCodexRequestIdentity(input.makeId);
  const { installationId, sessionId, threadId, turnId, windowId } = identity;
  const turnMetadata = JSON.stringify({
    installation_id: installationId,
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: 'turn',
    thread_source: 'user',
    sandbox: 'none',
  });

  return {
    identity,
    headers: {
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Originator: 'Codex CLI',
      'X-OpenAI-Internal-Codex-Responses-Lite': 'true',
      'X-Client-Request-Id': sessionId,
      'Session-Id': sessionId,
      'Thread-Id': threadId,
      'X-Codex-Window-Id': windowId,
      'X-Codex-Turn-Metadata': turnMetadata,
    },
    body: JSON.stringify({
      model: input.model,
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: input.instructions }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: input.prompt }],
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'low', context: 'all_turns' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: threadId,
      text: { verbosity: 'low' },
      client_metadata: {
        session_id: sessionId,
        thread_id: threadId,
        'x-codex-installation-id': installationId,
        'x-codex-window-id': windowId,
        turn_id: turnId,
        'x-codex-turn-metadata': turnMetadata,
      },
    }),
  };
}
