// api/gateway.js
export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept, Origin, User-Agent',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
    };

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 200, headers: corsHeaders });
    }

    try {
        const { searchParams } = new URL(req.url);
        const targetUrl = searchParams.get('url');
        
        if (!targetUrl) {
            return new Response(JSON.stringify({
                error: 'Missing target URL',
                usage: 'GET /api/gateway?url=https://api.example.com/endpoint'
            }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const decodedTargetUrl = decodeURIComponent(targetUrl);
        
        let parsedUrl;
        try {
            parsedUrl = new URL(decodedTargetUrl);
        } catch (error) {
            return new Response(JSON.stringify({
                error: 'Invalid URL format',
                provided: decodedTargetUrl
            }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (parsedUrl.protocol !== 'https:' && !parsedUrl.hostname.includes('localhost')) {
            return new Response(JSON.stringify({
                error: 'Only HTTPS URLs are allowed',
                provided: parsedUrl.protocol
            }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        searchParams.forEach((value, key) => {
            if (key !== 'url') parsedUrl.searchParams.append(key, value);
        });

        // ==========================================
        // ✅ GIỮ CODE GỐC, NHƯNG FORWARD-ALL + FORCE OVERRIDE
        // ==========================================
        
        // Clone toàn bộ headers từ client request
        const requestHeaders = new Headers(req.headers);

        // Loại bỏ hop-by-hop headers và các header dễ leak proxy/client IP
        const blockedRequestHeaders = [
            'host',
            'content-length',
            'connection',
            'keep-alive',
            'proxy-authenticate',
            'proxy-authorization',
            'proxy-connection',
            'te',
            'trailer',
            'transfer-encoding',
            'upgrade',
            'forwarded',
            'x-forwarded-for',
            'x-forwarded-host',
            'x-forwarded-port',
            'x-forwarded-proto',
            'x-real-ip',
            'via',
            'cf-connecting-ip',
            'cf-ipcountry',
            'cf-ray',
            'cdn-loop'
        ];

        blockedRequestHeaders.forEach(headerName => {
            requestHeaders.delete(headerName);
        });

        // ==========================================
        // ✅ FORCE OVERRIDE các header muốn giả lập browser
        // ==========================================
        
        requestHeaders.set(
            'User-Agent',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
        );

        requestHeaders.set(
            'Accept',
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
        );

        requestHeaders.set('Accept-Language', 'en-US,en;q=0.9');
        requestHeaders.set('Accept-Encoding', 'gzip, deflate, br');
        requestHeaders.set('Cache-Control', 'no-cache');
        requestHeaders.set('Pragma', 'no-cache');
        requestHeaders.set('Upgrade-Insecure-Requests', '1');

        requestHeaders.set(
            'Sec-CH-UA',
            '"Chromium";v="149", "Not;A Brand";v="99"'
        );
        requestHeaders.set('Sec-CH-UA-Mobile', '?0');
        requestHeaders.set('Sec-CH-UA-Platform', '"Linux"');

        const fetchOptions = {
            method: req.method,
            headers: requestHeaders
        };

        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            if (req.body) fetchOptions.body = req.body;
        }

        console.log(`[${new Date().toISOString()}] ${req.method} ${parsedUrl.toString()}`);

        const response = await fetch(parsedUrl.toString(), fetchOptions);
        
        const responseClone = response.clone();
        const responseHeaders = new Headers(corsHeaders);

        const responseHeadersToForward = [
            'content-type', 'cache-control', 'etag', 'expires', 
            'last-modified', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'
        ];

        responseHeadersToForward.forEach(headerName => {
            const headerValue = response.headers.get(headerName);
            if (headerValue) responseHeaders.set(headerName, headerValue);
        });

        console.log(`[${new Date().toISOString()}] Response: ${response.status}`);

        return new Response(responseClone.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Proxy error:`, error.message);
        
        let errorResponse = {
            error: 'Internal Server Error',
            message: error.message,
            timestamp: new Date().toISOString()
        };

        let statusCode = 500;

        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            errorResponse = { error: 'Bad Gateway', message: 'Failed to reach target server', details: error.message };
            statusCode = 502;
        }
        
        if (error.name === 'AbortError') {
            errorResponse = { error: 'Gateway Timeout', message: 'Request took too long' };
            statusCode = 504;
        }

        if (error.name === 'TypeError' && error.message.includes('URL')) {
            errorResponse = { error: 'Bad Request', message: 'Invalid URL format' };
            statusCode = 400;
        }

        return new Response(JSON.stringify(errorResponse), {
            status: statusCode,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}
