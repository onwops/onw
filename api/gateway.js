export const config = { runtime: 'edge'};

export default async function handler(req) {

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept, Origin, User-Agent',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400', // 24 hours
    };

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 200,
            headers: corsHeaders
        });
    }

    try {
        // Parse URL để lấy target URL và parameters
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

        // Decode URL nếu được encode
        const decodedTargetUrl = decodeURIComponent(targetUrl);
        
        // Validate URL
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

        // Security check - chỉ cho phép HTTPS (trừ localhost để test)
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

        // Thêm các query parameters khác vào target URL (loại trừ 'url' parameter)
        searchParams.forEach((value, key) => {
            if (key !== 'url') {
                parsedUrl.searchParams.append(key, value);
            }
        });

        // Prepare headers cho request - Edge Runtime compatible
        const requestHeaders = new Headers();
        
        // Forward các headers quan trọng từ client
        const headersToForward = [
            'authorization',
            'content-type', 
            'user-agent',
            'accept',
            'accept-language',
            'accept-encoding',
            'x-api-key',
            'x-requested-with',
            'x-forwarded-for',
            'referer'
        ];

        // Edge Runtime: req.headers is a Headers object
        headersToForward.forEach(headerName => {
            const headerValue = req.headers.get(headerName);
            if (headerValue) {
                requestHeaders.set(headerName, headerValue);
            }
        });

        // Prepare request options
        const fetchOptions = {
            method: req.method,
            headers: requestHeaders
        };

        // Handle request body cho POST/PUT/PATCH requests
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            // Edge Runtime: req.body is a ReadableStream
            if (req.body) {
                fetchOptions.body = req.body;
            }
        }

        // Edge Runtime logging (compatible)
        console.log(`[${new Date().toISOString()}] ${req.method} ${parsedUrl.toString()}`);

        // Make request tới target API
        const response = await fetch(parsedUrl.toString(), fetchOptions);
        
        // Get response data - Edge Runtime compatible
        const contentType = response.headers.get('content-type') || '';
        
        // Clone response để có thể đọc multiple times
        const responseClone = response.clone();
        
        // Prepare response headers
        const responseHeaders = new Headers(corsHeaders);

        // Forward important response headers
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

        // Log response - Edge Runtime compatible
        console.log(`[${new Date().toISOString()}] Response: ${response.status}`);

        // Return response với same status code và stream body
        return new Response(responseClone.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });

    } catch (error) {
        // Edge Runtime error logging
        console.error(`[${new Date().toISOString()}] Proxy error:`, error.message);
        
        // Handle different types of errors
        let errorResponse = {
            error: 'Internal Server Error',
            message: error.message,
            timestamp: new Date().toISOString()
        };

        let statusCode = 500;

        // Network errors
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            errorResponse = {
                error: 'Bad Gateway',
                message: 'Failed to reach target server',
                details: error.message
            };
            statusCode = 502;
        }
        
        // Timeout errors
        if (error.name === 'AbortError') {
            errorResponse = {
                error: 'Gateway Timeout',
                message: 'Request took too long'
            };
            statusCode = 504;
        }

        // URL parsing errors
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
