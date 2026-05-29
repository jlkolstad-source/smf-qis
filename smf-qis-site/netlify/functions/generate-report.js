// v8 - extended timeout + keep-alive
const https = require('https');

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!body.prompt) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No prompt provided' }) };
  }

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: body.prompt }]
  });

  return new Promise((resolve) => {
    const agent = new https.Agent({ keepAlive: true });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(requestBody),
        'Connection': 'keep-alive',
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            resolve({ statusCode: 500, headers, body: JSON.stringify({ error: parsed.error.message || 'Anthropic API error' }) });
          } else {
            const text = parsed.content
              ? parsed.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
              : '';
            resolve({ statusCode: 200, headers, body: JSON.stringify({ text }) });
          }
        } catch (e) {
          resolve({ statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to parse response' }) });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ statusCode: 500, headers, body: JSON.stringify({ error: e.message }) });
    });

    req.setTimeout(55000, () => {
      req.destroy();
      resolve({ statusCode: 500, headers, body: JSON.stringify({ error: 'Request timed out' }) });
    });

    req.write(requestBody);
    req.end();
  });
};
