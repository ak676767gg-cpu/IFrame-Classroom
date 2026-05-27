const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const PROXY_BASE = process.env.PROXY_BASE || `http://localhost:${PORT}`;

function proxyUrl(target) {
    return `${PROXY_BASE}/?url=${encodeURIComponent(target)}`;
}

function rewriteBody(body, baseUrl) {
    const base = new URL(baseUrl);

    // rewrite href and src attributes
    body = body.replace(/(href|src|action)=["']([^"']+)["']/gi, (match, attr, val) => {
        if (val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('mailto:')) return match;
        try {
            const absolute = new URL(val, baseUrl).href;
            return `${attr}="${proxyUrl(absolute)}"`;
        } catch { return match; }
    });

    // rewrite window.location, fetch, XMLHttpRequest urls
    body = body.replace(/(['"`])(https?:\/\/[^'"`]+)(['"`])/g, (match, q1, u, q2) => {
        try {
            return `${q1}${proxyUrl(u)}${q2}`;
        } catch { return match; }
    });

    // inject base rewrite script at top of <head>
    const inject = `
<script>
(function() {
    const PROXY = ${JSON.stringify(PROXY_BASE)};
    function pw(u) {
        if (!u || u.startsWith('data:') || u.startsWith('javascript:') || u.startsWith('#') || u.startsWith('blob:')) return u;
        try { return PROXY + '/?url=' + encodeURIComponent(new URL(u, location.href).href); } catch(e) { return u; }
    }
    // intercept fetch
    const _fetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') input = pw(input);
        return _fetch(input, init);
    };
    // intercept XHR
    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        return _open.call(this, method, pw(url), ...rest);
    };
    // intercept navigation
    const _pushState = history.pushState;
    history.pushState = function(state, title, url) {
        if (url && !url.startsWith('/') && !url.startsWith('?')) url = pw(url);
        return _pushState.call(this, state, title, url);
    };
})();
</script>`;

    body = body.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
    return body;
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const parsed = url.parse(req.url, true);
    const target = parsed.query.url;

    if (!target) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Proxy running. Use ?url=https://site.com');
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

        // rewrite redirect
        if (headers['location']) {
            try {
                const absolute = new URL(headers['location'], target).href;
                headers['location'] = proxyUrl(absolute);
            } catch {}
        }

        const contentType = (headers['content-type'] || '').toLowerCase();
        const isHtml = contentType.includes('text/html');

        if (isHtml) {
            delete headers['content-length'];
            headers['content-type'] = 'text/html; charset=utf-8';
            res.writeHead(proxyRes.statusCode, headers);

            let body = '';
            proxyRes.setEncoding('utf8');
            proxyRes.on('data', chunk => body += chunk);
            proxyRes.on('end', () => {
                res.end(rewriteBody(body, target));
            });
        } else {
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        }
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
