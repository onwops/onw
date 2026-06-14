// api/gateway.js
export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    // CORS headers
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept, Origin, User-Agent',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
    };

    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 200,
            headers: corsHeaders
        });
    }

    try {
        const { searchParams } = new URL(req.url);
        const targetUrl = searchParams.get('url');
        
        if (!targetUrl) {
            return new Response(JSON.stringify({
                error: 'Missing target URL',
                usage: 'GET /api/gateway?url=https://api.example.com/endpoint'
            }), {
                status: 400,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            });
        }

        const decodedTargetUrl = decodeURIComponent(targetUrl);
        
        let parsedUrl;
        try {
            parsedUrl = new URL(decodedTargetUrl);
        } catch (error) {
            return new Response(JSON.stringify({
                error: 'Invalid URL format',
                provided: decodedTargetUrl
            }), {
                status: 400,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            });
        }

        if (parsedUrl.protocol !== 'https:' && !parsedUrl.hostname.includes('localhost')) {
            return new Response(JSON.stringify({
                error: 'Only HTTPS URLs are allowed',
                provided: parsedUrl.protocol
            }), {
                status: 400,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json'
                }
            });
        }

        searchParams.forEach((value, key) => {
            if (key !== 'url') {
                parsedUrl.searchParams.append(key, value);
            }
        });

        // ==========================================
        // ✅ CHỈNH SỬA: Override headers cho data.ny.gov
        // ==========================================
        
        const requestHeaders = new Headers();
        
        // ✅ 1. User-Agent: Chrome trên Windows (giả như browser thật)
        requestHeaders.set('User-Agent', 
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        
        // ✅ 2. Accept: Giống browser thật
        requestHeaders.set('Accept', 
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
        );
        
        // ✅ 3. Accept-Language: Tiếng Anh (US)
        requestHeaders.set('Accept-Language', 'en-US,en;q=0.9');
        
        // ✅ 4. Accept-Encoding: Standard browser
        requestHeaders.set('Accept-Encoding', 'gzip, deflate, br');
        
        // ✅ 5. Connection: Keep-Alive (browser thật)
        requestHeaders.set('Connection', 'keep-alive');
        
        // ✅ 6. Sec-Ch-Ua: Chrome device (client hints)
        requestHeaders.set('Sec-Ch-Ua', 
            '"Chromium";v="120", "Not;A Brand";v="99"'
        );
        
        // ✅ 7. Sec-Ch-Ua-Platform: Windows
        requestHeaders.set('Sec-Ch-Ua-Platform', '"Windows"');
        
        // ✅ 8. Upgrade-Insecure-Requests: Browser standard
        requestHeaders.set('Upgrade-Insecure-Requests', '1');
        
        // ✅ 9. Cache-Control: No-cache (browser fresh request)
        requestHeaders.set('Cache-Control', 'no-cache');
        
        // ✅ 10. Pragma: No-cache (legacy browser)
        requestHeaders.set('Pragma', 'no-cache');
        
        // ✅ 11. DNT: Do Not Track (optional)
        // requestHeaders.set('DNT', '1');
        
        // ✅ 12. Forward ONLY specific headers (không forward X-Forwarded-For từ client)
        const headersToForward = [
            'authorization',
            'content-type',
            'x-api-key'
        ];

        headersToForward.forEach(headerName => {
            const headerValue = req.headers.get(headerName);
            if (headerValue) {
                requestHeaders.set(headerName, headerValue);
            }
        });
        
        // ❌ KHÔNG forward: X-Forwarded-For, Via, X-Real-IP (proxy headers từ client)
        // requestHeaders.delete('X-Forwarded-For');
        // requestHeaders.delete('Via');
        // requestHeaders.delete('X-Real-IP');

        const fetchOptions = {
            method: req.method,
            headers: requestHeaders
        };

        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            if (req.body) {
                fetchOptions.body = req.body;
            }
        }

        console.log(`[${new Date().toISOString()}] ${req.method} ${parsedUrl.toString()}`);

        // Make request
        const response = await fetch(parsedUrl.toString(), fetchOptions);
        
        const contentType = response.headers.get('content-type') || '';
        const responseClone = response.clone();
        
        const responseHeaders = new Headers(corsHeaders);

        const responseHeadersToForward = [
            'content-type',
            'cache-control', 
            'etag', 
            'expires',
            'last-modified',
            'x-ratelimit-limit',
            'x-ratelimit-remaining',
            'x-ratelimit-reset'
        ];

        responseHeadersToForward.forEach(headerName => {
            const headerValue = response.headers.get(headerName);
            if (headerValue) {
                responseHeaders.set(headerName, headerValue);
            }
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
            errorResponse = {
                error: 'Bad Gateway',
                message: 'Failed to reach target server',
                details: error.message
            };
            statusCode = 502;
        }
        
        if (error.name === 'AbortError') {
            errorResponse = {
                error: 'Gateway Timeout',
                message: 'Request took too long'
            };
            statusCode = 504;
        }

        if (error.name === 'TypeError' && error.message.includes('URL')) {
            errorResponse = {
                error: 'Bad Request',
                message: 'Invalid URL format'
            };
            statusCode = 400;
        }

        return new Response(JSON.stringify(errorResponse), {
            status: statusCode,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
            }
        });
    }
}
