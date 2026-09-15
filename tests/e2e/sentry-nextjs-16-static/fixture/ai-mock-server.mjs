import { createServer } from 'node:http';

// A single mock server standing in for the OpenAI, Anthropic and Google GenAI HTTP APIs, so the real
// SDK clients emit gen_ai spans without any live credentials. Response bodies mirror the mock servers
// in the node-integration tests (suites/tracing/{openai,anthropic,google-genai}). Uses raw `node:http`
// (not express) so the mock doesn't itself get instrumented.

function readJson(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

let serverPromise;

/** Lazily starts the shared mock server and resolves to its port. */
export function getMockAiPort() {
  serverPromise ??= new Promise(resolve => {
    const server = createServer(async (req, res) => {
      const url = req.url || '';

      // OpenAI: chat completions
      if (req.method === 'POST' && url.endsWith('/openai/chat/completions')) {
        const { model } = await readJson(req);
        sendJson(res, 200, {
          id: 'chatcmpl-mock123',
          object: 'chat.completion',
          created: 1677652288,
          model,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'Hello from OpenAI mock!' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
        });
        return;
      }

      // Anthropic: messages
      if (req.method === 'POST' && url.endsWith('/anthropic/v1/messages')) {
        const { model } = await readJson(req);
        sendJson(res, 200, {
          id: 'msg_mock123',
          type: 'message',
          model,
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello from Anthropic mock!' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 15 },
        });
        return;
      }

      // Google GenAI: generateContent (the model name is embedded in the path before `:generateContent`).
      // Plain string checks avoid the polynomial-backtracking risk of a `.+` regex on the URL.
      if (req.method === 'POST' && url.startsWith('/v1beta/models/') && url.endsWith(':generateContent')) {
        await readJson(req);
        sendJson(res, 200, {
          candidates: [
            {
              content: { parts: [{ text: 'Mock response from Google GenAI!' }], role: 'model' },
              finishReason: 'stop',
              index: 0,
            },
          ],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 12, totalTokenCount: 20 },
        });
        return;
      }

      res.writeHead(404).end();
    });

    server.listen(0, () => {
      resolve(server.address().port);
    });
  });

  return serverPromise;
}
