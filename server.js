const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PROXY_BASE = process.env.PROXY_BASE || `http://localhost:${PORT}`;

function proxyUrl(u, base) {
    if (!u) return u;
    if (u.startsWith('data:') || u.startsWith('javascript:') || u.startsWith('blob:') || u.startsWith('#') || u.startsWith('mailto:')) return u;
    try {
        const abs = new URL(u, base).href;
        return `${PROXY_BASE}/?url=${encodeURIComponent(abs)}`;
    } catch { return u; }
}

function rewriteHtml(body, baseUrl) {
    // rewrite href, src, action, srcset
    body = body.replace(/(\s(?:href|src|action|srcset|data-src|data-href))=(["'])([^"']*)\2/gi, (m, attr, q, val) => {
        return `${attr}=${q}${proxyUrl(val, baseUrl)}${q}`;
    });

    // rewrite url() in inline styles
    body = body.replace(/url\(["']?([^)"']+)["']?\)/gi, (m, u) => {
        return `url("${proxyUrl(u, baseUrl)}")`;
    });

    // inject base + interceptor script at very top of head
    const inject = `
<base href="${baseUrl}">
<script>
(function(){
    var BASE = '${PROXY_BASE}';
    var ORIGIN = '${new URL(baseUrl).origin}';
    
    function pw(u, base) {
        if (!u) return u;
        var s = String(u);
        if (s.startsWith('data:') || s.startsWith('javascript:') || s.startsWith('blob:') || s.startsWith('#') || s.startsWith('mailto:')) return s;
        if (s.startsWith(BASE)) return s;
        try {
            var abs = new URL(s, base || location.href).href;
            return BASE + '/?url=' + encodeURIComponent(abs);
        } catch(e) { return s; }
    }

    // intercept fetch
    var _fetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') input = pw(input);
        else if (input && input.url) input = new Request(pw(input.url), input);
        return _fetch.call(this, input, init);
    };

    // intercept XHR
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        var args = Array.prototype.slice.call(arguments);
        args[1] = pw(url);
        return _open.apply(this, args);
    };

    // intercept history
    var _push = history.pushState;
    history.pushState = function(state, title, u) {
        return _push.call(this, state, title, u ? pw(u) : u);
    };
    var _replace = history.replaceState;
    history.replaceState = function(state, title, u) {
        return _replace.call(this, state, title, u ? pw(u) : u);
    };

    // intercept window.open
    var _winOpen = window.open;
    window.open = function(u) {
        var args = Array.prototype.slice.call(arguments);
        if (u) args[0] = pw(u);
        return _winOpen.apply(this, args);
    };

    // intercept location changes
    try {
        Object.defineProperty(window, 'location', {
            get: function() { return window._location || window.__location || location; },
            set: function(u) { location.href = pw(String(u)); }
        });
    } catch(e) {}

    // rewrite dynamically inserted nodes
    var _createEl = document.createElement.bind(document);
    document.createElement = function(tag) {
        var el = _createEl(tag);
        if (tag.toLowerCase() === 'script' || tag.toLowerCase() === 'link' || tag.toLowerCase() === 'img') {
            var desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'src') ||
                       Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
            try {
                ['src','href'].forEach(function(attr) {
                    var orig = Object.getOwnPropertyDescriptor(el.__proto__, attr);
                    if (!orig) return;
                    Object.defineProperty(el, attr, {
                        set: function(v) { orig.set.call(this, pw(v)); },
                        get: function() { return orig.get.call(this); }
                    });
                });
            } catch(e) {}
        }
        return el;
    };
})();
</script>`;

    return body.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
}

function rewriteCss(body, baseUrl) {
    return body.replace(/url\(["']?([^)"']+)["']?\)/gi, (m, u) => {
        return `url("${proxyUrl(u, baseUrl)}")`;
    });
}

function rewriteJs(body, baseUrl) {
    // rewrite string URLs in JS (conservative - only obvious https:// strings)
    return body.replace(/["'`](https?:\/\/[^"'`\s]+)["'`]/g, (m, u) => {
        const proxied = proxyUrl(u, baseUrl);
        return m[0] + proxied + m[m.length - 1];
    });
}

function collectBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

function decompressBuffer(buf, enc) {
    return new Promise((resolve, reject) => {
        if (enc === 'gzip') zlib.gunzip(buf, (e, r) => e ? reject(e) : resolve(r));
        else if (enc === 'br') zlib.brotliDecompress(buf, (e, r) => e ? reject(e) : resolve(r));
        else if (enc === 'deflate') zlib.inflate(buf, (e, r) => e ? reject(e) : resolve(r));
        else resolve(buf);
    });
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
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

    // collect request body
    const reqBody = await collectBuffer(req);

    const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.path || '/',
        method: req.method,
        headers: {
            host: targetUrl.hostname,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'no-cache',
        }
    };

    // forward cookies
    if (req.headers['cookie']) options.headers['cookie'] = req.headers['cookie'];
    if (req.headers['content-type']) options.headers['content-type'] = req.headers['content-type'];
    if (reqBody.length > 0) options.headers['content-length'] = reqBody.length;

    try {
        const proxyRes = await new Promise((resolve, reject) => {
            const proxyReq = protocol.request(options, resolve);
            proxyReq.on('error', reject);
            if (reqBody.length > 0) proxyReq.write(reqBody);
            proxyReq.end();
        });

        const headers = { ...proxyRes.headers };
        delete headers['x-frame-options'];
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        delete headers['strict-transport-security'];

        // rewrite cookies to work cross-origin
        if (headers['set-cookie']) {
            headers['set-cookie'] = (Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']])
                .map(c => c.replace(/;\s*secure/gi, '').replace(/;\s*samesite=[^;]*/gi, '').replace(/;\s*domain=[^;]*/gi, ''));
        }

        // rewrite location redirects
        if (headers['location']) {
            try { headers['location'] = proxyUrl(headers['location'], target); } catch {}
        }

        const contentType = (headers['content-type'] || '').toLowerCase();
        const enc = headers['content-encoding'];
        const isHtml = contentType.includes('text/html');
        const isCss = contentType.includes('text/css');
        const isJs = contentType.includes('javascript');

        if (isHtml || isCss || isJs) {
            delete headers['content-length'];
            delete headers['content-encoding'];
            res.writeHead(proxyRes.statusCode, headers);
            const raw = await collectBuffer(proxyRes);
            const decompressed = await decompressBuffer(raw, enc);
            const text = decompressed.toString('utf8');
            if (isHtml) res.end(rewriteHtml(text, target));
            else if (isCss) res.end(rewriteCss(text, target));
            else res.end(rewriteJs(text, target));
        } else {
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        }
    } catch (err) {
        if (!res.headersSent) { res.writeHead(502); res.end(`Proxy error: ${err.message}`); }
    }
});

server.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
