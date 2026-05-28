const https = require('https');

exports.handler = async function(event, context) {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // CORS headers — allows your Netlify domain to call this function
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'API key not configured. Add ANTHROPIC_API_KEY in Netlify environment variables.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { prompt } = body;
  if (!prompt) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No prompt provided' }) };
  }

  // Call Anthropic API
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-5-20251001',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(requestBody),
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            resolve({
              statusCode: 500,
              headers,
              body: JSON.stringify({ error: parsed.error.message || 'Anthropic API error' })
            });
          } else {
            const text = parsed.content
              ? parsed.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
              : '';
            resolve({
              statusCode: 200,
              headers,
              body: JSON.stringify({ text })
            });
          }
        } catch (e) {
          resolve({
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to parse API response' })
          });
        }
      });
    });

    req.on('error', (e) => {
      resolve({
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: e.message })
      });
    });

    req.write(requestBody);
    req.end();
  });
};
