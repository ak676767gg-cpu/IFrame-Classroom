const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const parsed = url.parse(req.url, true);
    const target = parsed.query.url;

    if (!target) {
        res.writeHead(200);
        res.end('Proxy is running. Use ?url=https://site.com to proxy a page.');
        return;
    }

    const targetUrl = url.parse(target);
    const protocol = targetUrl.protocol === 'https:' ? https : http;

    const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.path || '/',
        method: req.method,
        headers: {
            ...req.headers,
            host: targetUrl.hostname,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        }
    };

    delete options.headers['origin'];
    delete options.headers['referer'];

    const proxyReq = protocol.request(options, proxyRes => {
        const headers = { ...proxyRes.headers };

        delete headers['x-frame-options'];
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];

        if (headers['location']) {
            headers['location'] = `https://YOUR-APP.onrender.com/?url=${encodeURIComponent(headers['location'])}`;
        }

        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', err => {
        res.writeHead(502);
        res.end(`Proxy error: ${err.message}`);
    });

    req.pipe(proxyReq);
});

server.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
});
