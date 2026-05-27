const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PROXY_BASE = process.env.PROXY_BASE || `http://localhost:${PORT}`;

function proxyUrl(target) {
    return `${PROXY_BASE}/?url=${encodeURIComponent(target)}`;
}

function rewriteHtml(body, baseUrl) {
    body = body.replace(/(href|src|action)=["']([^"']+)["']/gi, (match, attr, val) => {
        if (val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('mailto:')) return match;
        try { return `${attr}="${proxyUrl(new URL(val, baseUrl).href)}"`; } catch { return match; }
    });
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
    return body.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
}

function decompressBuffer(buffer, encoding) {
    return new Promise((resolve, reject) => {
        if (encoding === 'gzip') zlib.gunzip(buffer, (e, r) => e ? reject(e) : resolve(r));
        else if (encoding === 'br') zlib.brotliDecompress(buffer, (e, r) => e ? reject(e) : resolve(r));
        else if (encoding === 'deflate') zlib.inflate(buffer, (e, r) => e ? reject(e) : resolve(r));
        else resolve(buffer);
    });
}

function collectBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
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
            host: targetUrl.hostname,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US,en;q=0.9',
        }
    };

    try {
        const proxyRes = await new Promise((resolve, reject) => {
            const proxyReq = protocol.request(options, resolve);
            proxyReq.on('error', reject);
            proxyReq.end();
        });

        const headers = { ...proxyRes.headers };
        delete headers['x-frame-options'];
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        delete headers['strict-transport-security'];

        if (headers['location']) {
            try { headers['location'] = proxyUrl(new URL(headers['location'], target).href); } catch {}
        }

        const contentType = (headers['content-type'] || '').toLowerCase();
        const isHtml = contentType.includes('text/html');
        const encoding = headers['content-encoding'];

        if (isHtml) {
            delete headers['content-length'];
            delete headers['content-encoding'];
            headers['content-type'] = 'text/html; charset=utf-8';
            res.writeHead(proxyRes.statusCode, headers);
            const raw = await collectBuffer(proxyRes);
            const decompressed = await decompressBuffer(raw, encoding);
            res.end(rewriteHtml(decompressed.toString('utf8'), target));
        } else {
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        }
    } catch (err) {
        res.writeHead(502);
        res.end(`Proxy error: ${err.message}`);
    }
});

server.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
