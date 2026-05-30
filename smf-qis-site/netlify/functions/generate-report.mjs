// v9 - Netlify AI Gateway (streaming)
// Streams the model output token-by-token so the connection produces bytes
// almost immediately. This avoids the timeout that happened when the function
// buffered a full (up to 6000-token) generation before returning — a buffered
// response routinely blew past the 26s synchronous-function ceiling.

import { getUser } from '@netlify/identity';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: CORS });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // Report generation is for authenticated users only.
  const user = await getUser();
  if (!user) return json(401, { error: 'Sign in required.' });

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json(400, { error: 'Invalid JSON' });
  }
  if (!body.prompt) {
    return json(400, { error: 'No prompt provided' });
  }

  // Every report type is produced in one or more sequential calls so no part is
  // truncated at the ~4000-token ceiling. The client passes `part` /
  // `totalParts`; we append continuation framing so each part stitches into one
  // seamless document (the first part carries the header/summary, the final
  // part carries next-steps and signature, and any middle parts only continue
  // findings).
  const part = Number(body.part) || 1;
  const totalParts = Number(body.totalParts) || 1;
  let prompt = body.prompt;
  if (totalParts > 1) {
    if (part === 1) {
      prompt +=
        `\n\nIMPORTANT — MULTI-PART OUTPUT: This is PART ${part} of ${totalParts}. ` +
        'Write the report title/header, the executive summary, and the full ' +
        'finding details for ONLY the findings listed above. Do NOT write the ' +
        'next-steps section or the signature block — those belong to the final ' +
        'part. Stop cleanly after the last finding detail.';
    } else if (part === totalParts) {
      prompt +=
        `\n\nIMPORTANT — MULTI-PART OUTPUT: This is PART ${part} of ${totalParts}, ` +
        'a direct continuation of the same report already in progress. Do NOT ' +
        'repeat the report title, header, or executive summary. Continue ' +
        'seamlessly with the full finding details for ONLY the findings listed ' +
        'above, then provide the next-steps section and the signature block.';
    } else {
      prompt +=
        `\n\nIMPORTANT — MULTI-PART OUTPUT: This is PART ${part} of ${totalParts}, ` +
        'a continuation. Do NOT repeat the title, header, or executive summary, ' +
        'and do NOT write the next-steps or signature block. Continue with the ' +
        'full finding details for ONLY the findings listed above.';
    }
  }

  // Netlify AI Gateway injects ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL.
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const apiKey = process.env.ANTHROPIC_API_KEY;

  let upstream;
  try {
    upstream = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        // Trimmed from 6000 so a full report comfortably finishes streaming
        // within the function's 26s budget.
        max_tokens: 4096,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    return json(502, { error: 'Upstream request failed: ' + e.message });
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '');
    let msg = 'API error';
    try {
      msg = JSON.parse(errText).error?.message || msg;
    } catch (_) {}
    return json(upstream.status || 500, { error: msg });
  }

  // Re-emit the upstream SSE stream as plain text deltas the browser can append.
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const evt = JSON.parse(payload);
              if (
                evt.type === 'content_block_delta' &&
                evt.delta?.type === 'text_delta'
              ) {
                controller.enqueue(encoder.encode(evt.delta.text));
              }
            } catch (_) {
              // ignore keep-alive / non-JSON lines
            }
          }
        }
      } catch (e) {
        controller.enqueue(
          new TextEncoder().encode('\n\n[stream interrupted: ' + e.message + ']')
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS,
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    },
  });
};
