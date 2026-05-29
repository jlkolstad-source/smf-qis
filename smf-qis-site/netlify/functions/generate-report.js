// v7a
exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log('API key present:', !!apiKey);
  console.log('API key prefix:', apiKey ? apiKey.substring(0, 15) : 'MISSING');

  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!body.prompt) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No prompt provided' }) };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: body.prompt }]
      })
    });

    clearTimeout(timeout);
    console.log('Response status:', response.status);

    const data = await response.json();

    if (!response.ok) {
      console.log('API error:', JSON.stringify(data.error));
      return { statusCode: 500, headers, body: JSON.stringify({ error: data.error?.message || 'API error' }) };
    }

    const text = data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
    return { statusCode: 200, headers, body: JSON.stringify({ text }) };

  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Request timed out after 25 seconds' : e.message;
    console.log('Caught error:', e.name, e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: msg }) };
  }
};
