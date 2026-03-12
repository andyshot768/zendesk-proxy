const https = require('https');

module.exports = function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  var url = req.query.url;
  if (!url) {
    res.status(400).json({ error: 'url param required' });
    return;
  }

  var zdUrl = decodeURIComponent(url);
  var urlObj = new URL(zdUrl);
  var auth = req.headers['authorization'] || '';

  var options = {
    hostname: urlObj.hostname,
    path: urlObj.pathname + urlObj.search,
    method: 'GET',
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/json'
    }
  };

  var request = https.request(options, function(response) {
    var body = '';
    response.on('data', function(chunk) { body += chunk; });
    response.on('end', function() {
      try {
        res.status(response.statusCode).json(JSON.parse(body));
      } catch(e) {
        res.status(response.statusCode).send(body);
      }
    });
  });

  request.on('error', function(e) {
    res.status(500).json({ error: e.message });
  });

  request.end();
};
