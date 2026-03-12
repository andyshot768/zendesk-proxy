module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  const zdUrl = decodeURIComponent(url);

  try {
    const https = require('https');
    const urlObj = new URL(zdUrl);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Authorization': req.headers['authorization'] || '',
        'Content-Type': 'application/json',
      }
    };

    const data = await new Promise((resolve, reject) => {
      const request = https.request(options, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
          try { resolve({ status: response.statusCode, body: JSON.parse(body) }); }
          catch(e) { resolve({ status: response.statusCode, body }); }
        });
      });
      request.on('error', reject);
      request.end();
    });

    return res.status(data.status).json(data.body);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
