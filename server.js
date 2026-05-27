const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const PROXY_BASE = process.env.PROXY_BASE || `http://localhost:${PORT}`;

function proxyUrl(target) {
    return `${PROXY_BASE}/?url=${encodeURIComponent(target)}`;
}

function rewriteHtml(body, baseUrl) {
    // rewrite all absolute and relative URLs in HTML attributes
    body = body.replace(/(href|src|action)=["']([^"']+)["']/gi, (match, attr, val) => {
        if (val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('mailto:')) return match;
        try {
            const absolute = new URL(val, baseUrl).href;
            return `${attr}="${proxyUrl(absolute)}"`;
        } catch { return match; }
    });

    // rewrite redirect locations in meta refresh
    body = body.replace(/content=["'](\d+;\s*url=)([^"']+)["']/gi, (match, prefix, u) => {
        try { return `content="${prefix}${proxyUrl(new URL(u, baseUrl).href)}"`; } catch { return match; }
    });

    // inject JS interceptor
    const inject = `<script>
(function(){
    const B='${PROXY_BASE}';
    function pw(u){
        if(!u||u.startsWith('data:')||u.startsWith('javascript:')||u.startsWith('#')||u.startsWith('blob:'))return u;
        try{return B+'/?url='+encodeURIComponent(new URL(u,location.href).href);}catch(e){return u;}
    }
    const _fetch=window.fetch;
    window.fetch=function(input,init){if(typeof input==='string')input=pw(input);return _fetch(input,init);};
    const _open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u,...r){return _open.call(this,m,pw(u),...r);};
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
        delete headers['strict-transport-security'];

        // rewrite redirects
        if (headers['location']) {
            try {
                headers['location'] = proxyUrl(new URL(headers['location'], target).href);
            } catch {}
        }

        const contentType = (headers['content-type'] || '').toLowerCase();
        const isHtml = contentType.includes('text/html');

        if (isHtml) {
            // only rewrite HTML — pipe everything else raw
            delete headers['content-length'];
            headers['content-type'] = 'text/html; charset=utf-8';
            res.writeHead(proxyRes.statusCode, headers);
            let body = '';
            proxyRes.setEncoding('utf8');
            proxyRes.on('data', chunk => body += chunk);
            proxyRes.on('end', () => res.end(rewriteHtml(body, target)));
        } else {
            // binary/CSS/JS/images — pipe raw, no touching
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

server.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
