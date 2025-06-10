// 🚀 WEBRTC SIGNALING SERVER - NODE.JS + REDIS LABS

const { createClient } = require('redis');

const ENABLE_DETAILED_LOGGING = false;

// ==========================================
// FIXED REDIS CONFIGURATION FOR NODE.JS
// ==========================================

let redisClient = null;
// ✅ ROBUST parseNodeJSBody for large SDP payloads
// ✅ Enhanced parseNodeJSBody to handle both text/plain and application/json
async function parseNodeJSBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalSize = 0;
        const maxSize = 10 * 1024 * 1024; // 10MB limit
        
        // ✅ Detect Content-Type
        const contentType = req.headers['content-type'] || 'text/plain';
        console.log(`📦 [PARSE] Content-Type: ${contentType}`);
        
        const timeout = setTimeout(() => {
            console.error('❌ [PARSE] Request body parsing timeout after 15s');
            reject(new Error('Request body parsing timeout'));
        }, 15000); // Increased timeout for large payloads
        
        req.on('data', (chunk) => {
            totalSize += chunk.length;
            
            if (totalSize > maxSize) {
                clearTimeout(timeout);
                console.error(`❌ [PARSE] Request body too large: ${totalSize} bytes`);
                reject(new Error('Request body too large'));
                return;
            }
            
            chunks.push(chunk);
            console.log(`📦 [PARSE] Chunk received: ${chunk.length} bytes (total: ${totalSize})`);
        });
        
        req.on('end', () => {
            clearTimeout(timeout);
            
            try {
                // ✅ Proper Buffer concatenation
                const body = Buffer.concat(chunks).toString('utf8');
                console.log(`📦 [PARSE] Body assembled: ${body.length} chars`);
                console.log(`📦 [PARSE] Body preview: ${body.substring(0, 200)}...`);
                
                if (!body.trim()) {
                    console.error('❌ [PARSE] Empty request body');
                    reject(new Error('Empty request body'));
                    return;
                }
                
                // ✅ Handle different content types
                let parsed;
                
                if (contentType.includes('application/json')) {
                    console.log('📦 [PARSE] Parsing as JSON (application/json)');
                    parsed = JSON.parse(body);
                } else if (contentType.includes('text/plain')) {
                    console.log('📦 [PARSE] Parsing as JSON from text/plain');
                    // Validate JSON structure first
                    if (!body.startsWith('{') || !body.endsWith('}')) {
                        console.error('❌ [PARSE] Invalid JSON structure in text/plain:', {
                            starts: body.substring(0, 50),
                            ends: body.substring(body.length - 50)
                        });
                        reject(new Error('Invalid JSON structure in text/plain'));
                        return;
                    }
                    parsed = JSON.parse(body);
                } else {
                    // Fallback: try to parse as JSON anyway
                    console.log(`📦 [PARSE] Unknown content-type ${contentType}, attempting JSON parse`);
                    parsed = JSON.parse(body);
                }
                
                console.log(`✅ [PARSE] Successfully parsed ${contentType}, action: ${parsed.action}`);
                
                // ✅ Enhanced logging for specific actions
                if (parsed.action === 'send-signal' && parsed.payload?.sdp) {
                    console.log(`📦 [PARSE] SDP signal detected: ${parsed.type}, SDP size: ${parsed.payload.sdp.length}`);
                }
                
                resolve(parsed);
                
            } catch (error) {
                console.error('❌ [PARSE] JSON parse error:', error.message);
                console.error('❌ [PARSE] Content-Type:', contentType);
                console.error('❌ [PARSE] Body preview:', body ? body.substring(0, 500) + '...' : 'null');
                console.error('❌ [PARSE] Body suffix:', body ? '...' + body.substring(body.length - 200) : 'null');
                reject(new Error(`JSON parse error for ${contentType}: ${error.message}`));
            }
        });
        
        req.on('error', (error) => {
            clearTimeout(timeout);
            console.error('❌ [PARSE] Stream error:', error);
            reject(new Error(`Stream error: ${error.message}`));
        });
        
        req.on('close', () => {
            clearTimeout(timeout);
            console.log('📦 [PARSE] Request connection closed');
        });
    });
}
async function getRedisClient() {
    if (!redisClient) {
        redisClient = createClient({
            // ✅ FIX: Bỏ s khỏi rediss://
            url: "redis://default:SXZanOZvHCZurRd8dTCudyIKvciwuNz0@redis-12481.c294.ap-northeast-1-2.ec2.redns.redis-cloud.com:12481",
            socket: {
                // ✅ FIX: Bỏ toàn bộ TLS config
                connectTimeout: 10000,
                commandTimeout: 5000
            },
            retry_strategy: (options) => {
                if (options.error && options.error.code === 'ECONNREFUSED') {
                    return new Error('The server refused the connection');
                }
                if (options.total_retry_time > 1000 * 60 * 60) {
                    return new Error('Retry time exhausted');
                }
                if (options.attempt > 10) {
                    return undefined;
                }
                return Math.min(options.attempt * 100, 3000);
            }
        });
        
        redisClient.on('error', (err) => {
            console.log('[REDIS-ERROR] Redis Client Error:', err);
        });
        
        redisClient.on('connect', () => {
            console.log('[REDIS] Connected to Redis Labs');
        });
        
        try {
            await redisClient.connect();
            console.log('[REDIS] Redis connection established successfully');
        } catch (error) {
            console.error('[REDIS-ERROR] Failed to connect to Redis:', error);
            throw error;
        }
    }
    return redisClient;
}
// ==========================================
// REDIS HELPER FUNCTIONS
// ==========================================

async function setMatch(matchId, match) {
    try {
        const redis = await getRedisClient();
        await redis.setEx(`match:${matchId}`, 600, JSON.stringify(match));
        console.log(`[REDIS] Match ${matchId} saved`);
    } catch (error) {
        console.error(`[REDIS-ERROR] Failed to save match ${matchId}:`, error);
        throw error;
    }
}

async function getMatch(matchId) {
    try {
        const redis = await getRedisClient();
        const data = await redis.get(`match:${matchId}`);
        if (data) {
            return JSON.parse(data);
        }
        return null;
    } catch (error) {
        console.error(`[REDIS-ERROR] Failed to get match ${matchId}:`, error);
        return null;
    }
}

async function deleteMatch(matchId) {
    try {
        const redis = await getRedisClient();
        await redis.del(`match:${matchId}`);
        console.log(`[REDIS] Match ${matchId} deleted`);
    } catch (error) {
        console.error(`[REDIS-ERROR] Failed to delete match ${matchId}:`, error);
    }
}

async function addWaitingUserToRedis(userId, userData) {
    try {
        const redis = await getRedisClient();
        await redis.hSet('waiting_users', userId, JSON.stringify(userData));
        await redis.expire('waiting_users', 300);
        console.log(`[REDIS] User ${userId.slice(-8)} added to waiting list`);
    } catch (error) {
        console.error(`[REDIS-ERROR] Failed to add user ${userId}:`, error);
    }
}

async function removeWaitingUserFromRedis(userId) {
    try {
        const redis = await getRedisClient();
        const removed = await redis.hDel('waiting_users', userId);
        console.log(`[REDIS] User ${userId.slice(-8)} removed from waiting list`);
        return removed > 0;
    } catch (error) {
        console.error(`[REDIS-ERROR] Failed to remove user ${userId}:`, error);
        return false;
    }
}
async function handleP2pConnected(userId, data) {
    const { matchId, partnerId } = data;
    
    console.log(`[P2P-CONNECTED] ${userId.slice(-8)} connected to match ${matchId?.slice(-8)}`);
    
    try {
        // Remove from waiting list if still there
        let removed = false;
        if (await removeWaitingUserFromRedis(userId)) removed = true;
        if (partnerId && await removeWaitingUserFromRedis(partnerId)) removed = true;
        
        // Update match status
        if (matchId) {
            const match = await getMatch(matchId);
            if (match) {
                match.connected = true;
                match.connectedAt = Date.now();
                await setMatch(matchId, match);
                
                console.log(`[P2P-CONNECTED] ✅ Match ${matchId.slice(-8)} marked as connected`);
                
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        status: 'p2p_connected',
                        removed,
                        matchPreserved: true,
                        timestamp: Date.now()
                    })
                };
            } else {
                console.log(`[P2P-CONNECTED] ⚠️ Match ${matchId.slice(-8)} not found`);
            }
        }
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                status: 'p2p_connected',
                removed,
                matchPreserved: false,
                message: 'Match not found but users removed from waiting list',
                timestamp: Date.now()
            })
        };
        
    } catch (error) {
        console.error(`[P2P-CONNECTED-ERROR] ${userId.slice(-8)}:`, error.message);
        
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to handle P2P connection',
                message: error.message,
                timestamp: Date.now()
            })
        };
    }
}
async function handleDisconnect(userId) {
    console.log(`[DISCONNECT] ${userId.slice(-8)} disconnecting`);
    
    try {
        let removed = false;
        
        // Remove from waiting list
        if (await removeWaitingUserFromRedis(userId)) {
            removed = true;
            console.log(`[DISCONNECT] ${userId.slice(-8)} removed from waiting list`);
        }
        
        // Find and handle active matches
        const redis = await getRedisClient();
        const matchKeys = await redis.keys('match:*');
        
        for (const key of matchKeys) {
            const matchId = key.replace('match:', '');
            const match = await getMatch(matchId);
            
            if (match && (match.p1 === userId || match.p2 === userId)) {
                const partnerId = match.p1 === userId ? match.p2 : match.p1;
                
                // Send disconnect signal to partner
                if (match.signals && match.signals[partnerId]) {
                    match.signals[partnerId].push({
                        type: 'disconnect',
                        payload: { reason: 'partner_disconnected' },
                        from: userId,
                        timestamp: Date.now()
                    });
                    
                    await setMatch(matchId, match);
                }
                
                // Schedule match deletion after delay
                setTimeout(async () => {
                    await deleteMatch(matchId);
                    console.log(`[DISCONNECT] ⏰ Delayed removal of match ${matchId.slice(-8)}`);
                }, 5000);
                
                console.log(`[DISCONNECT] 📤 Disconnect signal sent to ${partnerId.slice(-8)}, match ${matchId.slice(-8)} scheduled for removal`);
                removed = true;
                break;
            }
        }
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                status: 'disconnected',
                removed,
                timestamp: Date.now()
            })
        };
        
    } catch (error) {
        console.error(`[DISCONNECT-ERROR] ${userId.slice(-8)}:`, error.message);
        
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to handle disconnect',
                message: error.message,
                timestamp: Date.now()
            })
        };
    }
}
async function getAllWaitingUsersFromRedis() {
    try {
        const redis = await getRedisClient();
        const users = await redis.hGetAll('waiting_users');
        const parsedUsers = new Map();
        
        for (const [userId, userData] of Object.entries(users)) {
            try {
                parsedUsers.set(userId, JSON.parse(userData));
            } catch (parseError) {
                console.error(`[REDIS-ERROR] Failed to parse user data for ${userId}:`, parseError);
            }
        }
        
        return parsedUsers;
    } catch (error) {
        console.error('[REDIS-ERROR] Failed to get waiting users:', error);
        return new Map();
    }
}

// ==========================================
// CONSTANTS
// ==========================================

const USER_TIMEOUT = 120000;
const MATCH_LIFETIME = 600000;
const TIMEZONE_MAX_SCORE = 20;
const TIMEZONE_PENALTY = 1;

// Pre-calculated tables
let timezoneScoreTable = new Array(25);
let genderScoreTable = new Map();
let distanceCache = new Map();

function initializeOptimizations() {
    for (let distance = 0; distance <= 24; distance++) {
        timezoneScoreTable[distance] = Math.max(0, TIMEZONE_MAX_SCORE - (distance * TIMEZONE_PENALTY));
    }
    
    const genders = ['Male', 'Female', 'Unspecified'];
    const genderCoeffs = { 'Male': 1, 'Female': -1, 'Unspecified': 0 };
    
    for (const g1 of genders) {
        for (const g2 of genders) {
            const coeff1 = genderCoeffs[g1];
            const coeff2 = genderCoeffs[g2];
            const score = 3 - (coeff1 * coeff2);
            genderScoreTable.set(`${g1},${g2}`, score);
        }
    }
    
    console.log('[INIT] Optimization tables initialized');
}

initializeOptimizations();

function getCircularDistance(zone1, zone2) {
    if (typeof zone1 !== 'number' || typeof zone2 !== 'number') return 12;
    
    const cacheKey = zone1 <= zone2 ? `${zone1},${zone2}` : `${zone2},${zone1}`;
    
    if (distanceCache.has(cacheKey)) {
        return distanceCache.get(cacheKey);
    }
    
    const linear = Math.abs(zone1 - zone2);
    const circular = linear > 12 ? 24 - linear : linear;
    
    if (distanceCache.size >= 1000) {
        const firstKey = distanceCache.keys().next().value;
        distanceCache.delete(firstKey);
    }
    distanceCache.set(cacheKey, circular);
    
    return circular;
}

function getTimezoneScore(zone1, zone2) {
    const distance = getCircularDistance(zone1, zone2);
    return timezoneScoreTable[distance] || 0;
}

function getGenderScore(gender1, gender2) {
    const key = `${gender1 || 'Unspecified'},${gender2 || 'Unspecified'}`;
    return genderScoreTable.get(key) || 3;
}

// ==========================================
// MATCHING LOGIC
// ==========================================

async function findSimpleMatch(userId, userChatZone, userGender) {
    let bestMatch = null;
    let bestScore = 0;
    
    const waitingUsers = await getAllWaitingUsersFromRedis();
    
    for (const [candidateId, candidate] of waitingUsers.entries()) {
        if (candidateId === userId) continue;
        
        let score = 1;
        
        if (typeof userChatZone === 'number' && typeof candidate.chatZone === 'number') {
            const distance = getCircularDistance(userChatZone, candidate.chatZone);
            score += timezoneScoreTable[distance] || 0;
        }
        
        const candidateGender = candidate.userInfo?.gender || 'Unspecified';
        score += getGenderScore(userGender, candidateGender);
        
        if (Date.now() - candidate.timestamp < 30000) {
            score += 2;
        }
        
        if (score > bestScore) {
            bestScore = score;
            bestMatch = { userId: candidateId, user: candidate, score };
        }
        
        if (score >= 25) break;
    }
    
    return bestMatch;
}

// ==========================================
// ✅ FIXED: NODE.JS REQUEST HANDLERS
// ==========================================

 async function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    // ✅ SỬA: Enhanced validation
    if (!userId || typeof userId !== 'string') {
        return {
            statusCode: 400,
            body: JSON.stringify({ 
                error: 'userId is required and must be string',
                received: { userId, type: typeof userId }
            })
        };
    }
    
    // ✅ THÊM: Debug log
    console.log(`[INSTANT-MATCH] ${userId.slice(-8)} looking for partner`, {
        hasUserInfo: !!userInfo,
        chatZone,
        gender,
        dataKeys: Object.keys(data)
    });
    
    // Check if user already in a match
    const waitingUsers = await getAllWaitingUsersFromRedis();
    const userGender = gender || userInfo?.gender || 'Unspecified';
    
    const bestMatch = await findSimpleMatch(userId, chatZone, userGender);
    
    if (bestMatch) {
        const partnerId = bestMatch.userId;
        const partnerUser = bestMatch.user;
        
        // Remove both users from waiting list
        await removeWaitingUserFromRedis(userId);
        await removeWaitingUserFromRedis(partnerId);
        
        // Create match
        const matchId = preferredMatchId || `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        const isUserInitiator = userId < partnerId;
        const p1 = isUserInitiator ? userId : partnerId;
        const p2 = isUserInitiator ? partnerId : userId;
        
        const match = {
            p1, p2,
            timestamp: Date.now(),
            connected: false,
            connectedAt: null,
            signals: { [p1]: [], [p2]: [] },
            userInfo: {
                [userId]: userInfo || {},
                [partnerId]: partnerUser.userInfo || {}
            },
            chatZones: {
                [userId]: chatZone,
                [partnerId]: partnerUser.chatZone
            },
            matchScore: bestMatch.score,
            strategy: 'simple'
        };
        
        await setMatch(matchId, match);
        
        console.log(`[INSTANT-MATCH] 🚀 ${userId.slice(-8)} <-> ${partnerId.slice(-8)} (${matchId}) | Score: ${bestMatch.score}`);
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                status: 'instant-match',
                matchId,
                partnerId,
                isInitiator: isUserInitiator,
                partnerInfo: partnerUser.userInfo || {},
                partnerChatZone: partnerUser.chatZone,
                signals: [],
                compatibility: bestMatch.score,
                strategy: 'simple',
                message: 'Instant match found! WebRTC connection will be established.',
                timestamp: Date.now()
            })
        };
        
    } else {
        // Add to waiting list
        const waitingUser = {
            userId,
            userInfo: userInfo || {},
            chatZone: chatZone || null,
            timestamp: Date.now()
        };
        
        await addWaitingUserToRedis(userId, waitingUser);
        
        const currentWaitingUsers = await getAllWaitingUsersFromRedis();
        const position = Array.from(currentWaitingUsers.keys()).indexOf(userId) + 1;
        
        console.log(`[INSTANT-MATCH] ${userId.slice(-8)} added to waiting list (position: ${position})`);
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                status: 'waiting',
                position: position || currentWaitingUsers.size,
                waitingUsers: currentWaitingUsers.size,
                chatZone: chatZone,
                userGender: userGender,
                strategy: 'simple',
                message: 'Added to matching queue. Waiting for partner...',
                estimatedWaitTime: Math.min(currentWaitingUsers.size * 2, 30),
                timestamp: Date.now()
            })
        };
    }
}
async function handleSendSignal(userId, data) {
    const { matchId, type, payload } = data;
   console.log(`📤 [SIGNAL] ${userId.slice(-8)} sending ${type} to match ${matchId?.slice(-8)}`);
    
    // ✅ Special logging for offer/answer
    if (type === 'offer' || type === 'answer') {
        console.log(`📤 [${type.toUpperCase()}] Received from ${userId.slice(-8)}`);
        console.log(`📤 [${type.toUpperCase()}] SDP size: ${payload?.sdp?.length || 0} chars`);
        console.log(`📤 [${type.toUpperCase()}] SDP preview: ${payload?.sdp?.substring(0, 100)}...`);
        console.log(`📤 [${type.toUpperCase()}] Payload keys: ${Object.keys(payload || {})}`);
    }
    // ✅ SỬA: Enhanced validation
    if (!matchId || !type || !payload) {
        return {
            statusCode: 400,
            body: JSON.stringify({ 
                error: 'Missing required fields',
                required: ['matchId', 'type', 'payload'],
                received: {
                    matchId: !!matchId,
                    type: !!type,
                    payload: !!payload,
                    dataKeys: Object.keys(data)
                }
            })
        };
    }
    
    // ✅ THÊM: Debug log
    console.log(`[SEND-SIGNAL] ${userId.slice(-8)} sending ${type} to match ${matchId.slice(-8)}`);
    
    const match = await getMatch(matchId);
    if (!match) {
        return {
            statusCode: 404,
            body: JSON.stringify({ 
                error: 'Match not found',
                matchId,
                tip: 'Match may have expired or been deleted'
            })
        };
    }
    
    if (match.p1 !== userId && match.p2 !== userId) {
        return {
            statusCode: 403,
            body: JSON.stringify({ 
                error: 'User not in this match',
                userId: userId.slice(-8),
                matchUsers: [match.p1.slice(-8), match.p2.slice(-8)]
            })
        };
    }
    
    const partnerId = match.p1 === userId ? match.p2 : match.p1;
    
    if (!match.signals[partnerId]) {
        match.signals[partnerId] = [];
    }
    
    const signal = {
        type,
        payload,
        from: userId,
        timestamp: Date.now()
    };
    
    match.signals[partnerId].push(signal);
    
    // Limit queue size
    if (match.signals[partnerId].length > 100) {
        match.signals[partnerId] = match.signals[partnerId].slice(-50);
        console.log(`[SEND-SIGNAL] Trimmed signal queue for ${partnerId.slice(-8)}`);
    }
    
    await setMatch(matchId, match);
    
    console.log(`[SEND-SIGNAL] ✅ ${userId.slice(-8)} -> ${partnerId.slice(-8)} (${type}) | Queue: ${match.signals[partnerId].length}`);
    
    return {
        statusCode: 200,
        body: JSON.stringify({
            status: 'sent',
            partnerId,
            signalType: type,
            queueLength: match.signals[partnerId].length,
            timestamp: Date.now()
        })
    };
}
async function handleGetSignals(userId, data) {
    const { chatZone, gender, userInfo } = data;
    
    // ✅ THÊM: Debug log
    console.log(`[GET-SIGNALS] ${userId.slice(-8)} checking for signals/matches`);
    
    try {
        // Check all active matches for this user
        const redis = await getRedisClient();
        const matchKeys = await redis.keys('match:*');
        
        for (const key of matchKeys) {
            const matchId = key.replace('match:', '');
            const match = await getMatch(matchId);
            
            if (match && (match.p1 === userId || match.p2 === userId)) {
                const partnerId = match.p1 === userId ? match.p2 : match.p1;
                const signals = match.signals[userId] || [];
                
                // Clear signals after reading
                match.signals[userId] = [];
                await setMatch(matchId, match);
                
                console.log(`[GET-SIGNALS] ✅ ${userId.slice(-8)} found match ${matchId.slice(-8)} with ${signals.length} signals`);
                
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        status: 'matched',
                        matchId,
                        partnerId,
                        isInitiator: match.p1 === userId,
                        signals,
                        partnerChatZone: match.chatZones ? match.chatZones[partnerId] : null,
                        matchScore: match.matchScore || null,
                        strategy: match.strategy || 'simple',
                        timestamp: Date.now()
                    })
                };
            }
        }
        
        // If no active match, check waiting list
        const waitingUsers = await getAllWaitingUsersFromRedis();
        
        if (waitingUsers.has(userId)) {
            const position = Array.from(waitingUsers.keys()).indexOf(userId) + 1;
            
            console.log(`[GET-SIGNALS] ${userId.slice(-8)} waiting in position ${position}`);
            
            return {
                statusCode: 200,
                body: JSON.stringify({
                    status: 'waiting',
                    position,
                    waitingUsers: waitingUsers.size,
                    chatZone: chatZone,
                    userGender: gender || 'Unspecified',
                    timestamp: Date.now()
                })
            };
        } else {
            // ✅ AUTO-RECOVERY: Add user back to waiting list if they have valid data
            if (chatZone !== undefined) {
                const waitingUser = {
                    userId,
                    userInfo: userInfo || {},
                    chatZone: chatZone,
                    timestamp: Date.now()
                };
                
                await addWaitingUserToRedis(userId, waitingUser);
                const currentWaitingUsers = await getAllWaitingUsersFromRedis();
                
                console.log(`[GET-SIGNALS] ${userId.slice(-8)} auto-recovered to waiting list`);
                
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        status: 'waiting',
                        position: currentWaitingUsers.size,
                        waitingUsers: currentWaitingUsers.size,
                        chatZone: chatZone,
                        userGender: gender || 'Unspecified',
                        message: 'Auto-recovered to waiting list',
                        timestamp: Date.now()
                    })
                };
            }
        }
        
        return {
            statusCode: 404,
            body: JSON.stringify({
                status: 'not_found',
                message: 'User not found in waiting list or active matches',
                tip: 'Try calling instant-match first',
                timestamp: Date.now()
            })
        };
        
    } catch (error) {
        console.error(`[GET-SIGNALS-ERROR] ${userId.slice(-8)}:`, error.message);
        
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to get signals',
                message: error.message,
                timestamp: Date.now()
            })
        };
    }
}
async function handler(req, res) {
    const startTime = Date.now();
    
    // ✅ THÊM: Global timeout protection
    const globalTimeout = setTimeout(() => {
        if (!res.headersSent) {
            console.error('[GLOBAL-TIMEOUT] Function timeout after 25s');
            res.status(408).json({
                error: 'Function timeout',
                message: 'Request took too long to process'
            });
        }
    }, 25000); // 25 seconds
    
    try {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.method === 'OPTIONS') {
            clearTimeout(globalTimeout);
            res.status(200).end();
            return;
        }
        
        if (req.method === 'GET') {
            clearTimeout(globalTimeout);
            
            const debug = req.query.debug;
            
            if (debug === 'true') {
                try {
                    const waitingUsers = await getAllWaitingUsersFromRedis();
                    
                    res.status(200).json({
                        status: 'redis-integrated-webrtc-signaling',
                        runtime: 'nodejs18.x',
                        version: '3.2-redis-nodejs-fixed',
                        storage: 'Redis Labs',
                        fixes: [
                            'Node.js runtime compatibility',
                            'Redis Labs integration', 
                            'Fixed request body parsing',
                            'Added timeout protection',
                            'Memory usage optimization'
                        ],
                        stats: {
                            waitingUsers: waitingUsers.size,
                            redisConnected: !!redisClient
                        },
                        timestamp: Date.now()
                    });
                } catch (error) {
                    res.status(200).json({
                        status: 'redis-signaling-ready-debug-error',
                        error: error.message,
                        redisConnected: !!redisClient,
                        timestamp: Date.now()
                    });
                }
                return;
            }
            
            res.status(200).json({ 
                status: 'redis-nodejs-signaling-ready',
                message: 'Redis + Node.js WebRTC signaling server ready!',
                timestamp: Date.now()
            });
            return;
        }
        
        if (req.method !== 'POST') {
            clearTimeout(globalTimeout);
            res.status(405).json({ error: 'POST required for signaling' });
            return;
        }
        
        // ✅ THÊM: Quick timeout check
        if (Date.now() - startTime > 20000) {
            clearTimeout(globalTimeout);
            res.status(408).json({
                error: 'Processing timeout',
                message: 'Request took too long'
            });
            return;
        }
        
        // Parse body with timeout
        const data = await parseNodeJSBody(req);
        const { action, userId } = data;
        
        // ✅ THÊM: Quick validation
        if (!action) {
            clearTimeout(globalTimeout);
            console.log('[DEBUG] Missing action. Received:', Object.keys(data));
            res.status(400).json({
                error: 'Missing action field',
                received: Object.keys(data || {}),
                tip: 'action field is required'
            });
            return;
        }
        
        if (!userId) {
            clearTimeout(globalTimeout);
            res.status(400).json({
                error: 'Missing userId field',
                tip: 'userId field is required'
            });
            return;
        }
        
        // ✅ THÊM: Timeout check before processing
        if (Date.now() - startTime > 22000) {
            clearTimeout(globalTimeout);
            res.status(408).json({
                error: 'Pre-processing timeout',
                message: 'Not enough time to process'
            });
            return;
        }
        
        // Handle actions with individual timeouts
        let result;
        
        try {
            switch (action) {
                case 'instant-match':
                    result = await Promise.race([
                        handleInstantMatch(userId, data),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('instant-match timeout')), 8000)
                        )
                    ]);
                    break;
                case 'send-signal':
                    result = await Promise.race([
                        handleSendSignal(userId, data),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('send-signal timeout')), 5000)
                        )
                    ]);
                    break;
                case 'get-signals':
                    result = await Promise.race([
                        handleGetSignals(userId, data),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('get-signals timeout')), 5000)
                        )
                    ]);
                    break;
                case 'p2p-connected':
                    result = await Promise.race([
                        handleP2pConnected(userId, data),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('p2p-connected timeout')), 3000)
                        )
                    ]);
                    break;
                case 'disconnect':
                    result = await Promise.race([
                        handleDisconnect(userId),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('disconnect timeout')), 3000)
                        )
                    ]);
                    break;
                default:
                    result = {
                        statusCode: 400,
                        body: JSON.stringify({
                            error: 'Unknown action',
                            received: action,
                            available: ['instant-match', 'get-signals', 'send-signal', 'p2p-connected', 'disconnect']
                        })
                    };
            }
        } catch (actionError) {
            console.error(`[ACTION-ERROR] ${action}:`, actionError.message);
            result = {
                statusCode: 500,
                body: JSON.stringify({
                    error: `Action ${action} failed`,
                    message: actionError.message,
                    timeout: actionError.message.includes('timeout')
                })
            };
        }

        clearTimeout(globalTimeout);
        
        if (!res.headersSent) {
            res.status(result.statusCode).json(JSON.parse(result.body));
        }

    } catch (error) {
        clearTimeout(globalTimeout);
        console.error('[MAIN-ERROR]', error.message);
        
        if (!res.headersSent) {
            if (error.message.includes('timeout') || error.message.includes('Body too large')) {
                res.status(408).json({
                    error: 'Request timeout or too large',
                    message: error.message,
                    processing_time: Date.now() - startTime
                });
            } else {
                res.status(500).json({
                    error: 'Server error',
                    message: error.message,
                    processing_time: Date.now() - startTime
                });
            }
        }
    }
}
module.exports = handler;
