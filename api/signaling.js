// 🚀 HYBRID-OPTIMIZED WebRTC Signaling Server - REDIS INTEGRATED

const ENABLE_DETAILED_LOGGING = false;

// ==========================================
// REDIS CONFIGURATION & CONNECTION
// ==========================================

let redisClient = null;

async function getRedisClient() {
    if (!redisClient) {
        const { createClient } = await import('redis');
        
        redisClient = createClient({
            url: "redis://default:SXZanOZvHCZurRd8dTCudyIKvciwuNz0@redis-12481.c294.ap-northeast-1-2.ec2.redns.redis-cloud.com:12481",
            socket: {
                tls: true,
                rejectUnauthorized: false
            },
            // Connection pool settings for Edge Runtime
            connect_timeout: 5000,
            command_timeout: 3000
        });
        
        redisClient.on('error', (err) => {
            criticalLog('REDIS-ERROR', 'Redis Client Error:', err);
        });
        
        await redisClient.connect();
        criticalLog('REDIS', 'Connected to Redis successfully');
    }
    return redisClient;
}

// ==========================================
// REDIS HELPER FUNCTIONS
// ==========================================

async function setMatch(matchId, match) {
    try {
        const redis = await getRedisClient();
        await redis.setex(`match:${matchId}`, 600, JSON.stringify(match)); // 10 minutes TTL
        smartLog('REDIS', `Match ${matchId} saved to Redis`);
    } catch (error) {
        criticalLog('REDIS-ERROR', `Failed to save match ${matchId}:`, error);
        throw error;
    }
}

async function getMatch(matchId) {
    try {
        const redis = await getRedisClient();
        const data = await redis.get(`match:${matchId}`);
        if (data) {
            smartLog('REDIS', `Match ${matchId} retrieved from Redis`);
            return JSON.parse(data);
        }
        return null;
    } catch (error) {
        criticalLog('REDIS-ERROR', `Failed to get match ${matchId}:`, error);
        return null;
    }
}

async function deleteMatch(matchId) {
    try {
        const redis = await getRedisClient();
        await redis.del(`match:${matchId}`);
        smartLog('REDIS', `Match ${matchId} deleted from Redis`);
    } catch (error) {
        criticalLog('REDIS-ERROR', `Failed to delete match ${matchId}:`, error);
    }
}

async function addWaitingUserToRedis(userId, userData) {
    try {
        const redis = await getRedisClient();
        await redis.hset('waiting_users', userId, JSON.stringify(userData));
        await redis.expire('waiting_users', 300); // 5 minutes TTL for waiting users
        smartLog('REDIS', `User ${userId.slice(-8)} added to Redis waiting list`);
    } catch (error) {
        criticalLog('REDIS-ERROR', `Failed to add user ${userId} to Redis:`, error);
    }
}

async function removeWaitingUserFromRedis(userId) {
    try {
        const redis = await getRedisClient();
        const removed = await redis.hdel('waiting_users', userId);
        smartLog('REDIS', `User ${userId.slice(-8)} removed from Redis waiting list`);
        return removed > 0;
    } catch (error) {
        criticalLog('REDIS-ERROR', `Failed to remove user ${userId} from Redis:`, error);
        return false;
    }
}

async function getAllWaitingUsersFromRedis() {
    try {
        const redis = await getRedisClient();
        const users = await redis.hgetall('waiting_users');
        const parsedUsers = new Map();
        
        for (const [userId, userData] of Object.entries(users)) {
            try {
                parsedUsers.set(userId, JSON.parse(userData));
            } catch (parseError) {
                criticalLog('REDIS-ERROR', `Failed to parse user data for ${userId}:`, parseError);
            }
        }
        
        return parsedUsers;
    } catch (error) {
        criticalLog('REDIS-ERROR', 'Failed to get all waiting users from Redis:', error);
        return new Map();
    }
}

async function getAllActiveMatchesFromRedis() {
    try {
        const redis = await getRedisClient();
        const keys = await redis.keys('match:*');
        const matches = new Map();
        
        if (keys.length > 0) {
            const values = await redis.mget(keys);
            for (let i = 0; i < keys.length; i++) {
                if (values[i]) {
                    const matchId = keys[i].replace('match:', '');
                    try {
                        matches.set(matchId, JSON.parse(values[i]));
                    } catch (parseError) {
                        criticalLog('REDIS-ERROR', `Failed to parse match data for ${matchId}:`, parseError);
                    }
                }
            }
        }
        
        return matches;
    } catch (error) {
        criticalLog('REDIS-ERROR', 'Failed to get all matches from Redis:', error);
        return new Map();
    }
}

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================

const USER_TIMEOUT = 120000; // 2 minutes for waiting users
const MATCH_LIFETIME = 600000; // 10 minutes for active matches
const MAX_WAITING_USERS = 120000; // Prevent memory bloat

// Timezone scoring constants
const TIMEZONE_MAX_SCORE = 20;
const TIMEZONE_PENALTY = 1;
const TIMEZONE_CIRCLE_HOURS = 24;

// Performance constants
const INDEX_REBUILD_INTERVAL = 10000; // 10 seconds
const MAX_CACHE_SIZE = 1000;
const MATCH_CACHE_TTL = 5000; // 5 seconds
const MAX_CANDIDATES = 5; // Reduced from 10

// Adaptive strategy thresholds
const SIMPLE_STRATEGY_THRESHOLD = 10;
const HYBRID_STRATEGY_THRESHOLD = 100;

// ==========================================
// OPTIMIZED GLOBAL STATE (Now Redis-backed)
// ==========================================

// Keep minimal in-memory cache for performance
let waitingUsersCache = new Map();
let activeMatchesCache = new Map();
let lastCacheUpdate = 0;
const CACHE_TTL = 5000; // 5 seconds cache

// 🔥 OPTIMIZATION: Pre-calculated distance cache (still in-memory for speed)
let distanceCache = new Map();
let timezoneScoreTable = new Array(25);
let genderScoreTable = new Map();

// ==========================================
// LOGGING UTILITIES
// ==========================================

function smartLog(level, ...args) {
    if (ENABLE_DETAILED_LOGGING) {
        console.log(`[${level}]`, ...args);
    }
}

function criticalLog(level, ...args) {
    console.log(`[${level}]`, ...args);
}

// ==========================================
// CORS & RESPONSE UTILITIES
// ==========================================

function createCorsResponse(data, status = 200) {
    return new Response(data ? JSON.stringify(data) : null, {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        }
    });
}

// ==========================================
// INITIALIZATION - PRE-CALCULATE TABLES
// ==========================================

function initializeOptimizations() {
    // Pre-calculate timezone score table
    for (let distance = 0; distance <= 24; distance++) {
        timezoneScoreTable[distance] = Math.max(0, TIMEZONE_MAX_SCORE - (distance * TIMEZONE_PENALTY));
    }
    
    // Pre-calculate gender score combinations
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
    
    criticalLog('INIT', 'Optimization tables initialized');
}

// Initialize on startup
initializeOptimizations();

// ==========================================
// REDIS-BACKED CACHE MANAGEMENT
// ==========================================

async function refreshCacheFromRedis() {
    const now = Date.now();
    if (now - lastCacheUpdate < CACHE_TTL) {
        return; // Cache still fresh
    }
    
    try {
        // Refresh waiting users cache
        waitingUsersCache = await getAllWaitingUsersFromRedis();
        
        // Refresh active matches cache  
        activeMatchesCache = await getAllActiveMatchesFromRedis();
        
        lastCacheUpdate = now;
        smartLog('CACHE', `Cache refreshed: ${waitingUsersCache.size} users, ${activeMatchesCache.size} matches`);
    } catch (error) {
        criticalLog('CACHE-ERROR', 'Failed to refresh cache from Redis:', error);
    }
}

async function getWaitingUsers() {
    await refreshCacheFromRedis();
    return waitingUsersCache;
}

async function getActiveMatches() {
    await refreshCacheFromRedis();
    return activeMatchesCache;
}

// ==========================================
// ULTRA-FAST DISTANCE CALCULATION WITH CACHE
// ==========================================

function getCircularDistance(zone1, zone2) {
    if (typeof zone1 !== 'number' || typeof zone2 !== 'number') return 12;
    
    const cacheKey = zone1 <= zone2 ? `${zone1},${zone2}` : `${zone2},${zone1}`;
    
    if (distanceCache.has(cacheKey)) {
        return distanceCache.get(cacheKey);
    }
    
    const linear = Math.abs(zone1 - zone2);
    const circular = linear > 12 ? 24 - linear : linear;
    
    if (distanceCache.size >= MAX_CACHE_SIZE) {
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
// REDIS-BACKED MATCHING STRATEGIES
// ==========================================

async function findSimpleMatchExcludeSelf(userId, userChatZone, userGender) {
    let bestMatch = null;
    let bestScore = 0;
    
    const waitingUsers = await getWaitingUsers();
    
    for (const [candidateId, candidate] of waitingUsers.entries()) {
        if (candidateId === userId) continue; // ✅ Skip self
        
        let score = 1;
        
        // Quick timezone score
        if (typeof userChatZone === 'number' && typeof candidate.chatZone === 'number') {
            const distance = getCircularDistance(userChatZone, candidate.chatZone);
            score += timezoneScoreTable[distance] || 0;
        }
        
        // Quick gender score
        const candidateGender = candidate.userInfo?.gender || 'Unspecified';
        score += getGenderScore(userGender, candidateGender);
        
        // Fresh bonus
        if (Date.now() - candidate.timestamp < 30000) {
            score += 2;
        }
        
        if (score > bestScore) {
            bestScore = score;
            bestMatch = { userId: candidateId, user: candidate, score };
        }
        
        // Early exit for perfect matches
        if (score >= 25) break;
    }
    
    return bestMatch;
}

// ==========================================
// ✅ REDIS-INTEGRATED HANDLERS
// ==========================================

async function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    if (!userId || typeof userId !== 'string') {
        return createCorsResponse({ error: 'userId is required and must be string' }, 400);
    }
    
    smartLog('INSTANT-MATCH', `${userId.slice(-8)} looking for partner (ChatZone: ${chatZone})`);
    
    // ✅ CHECK ACTIVE MATCHES FROM REDIS
    const activeMatches = await getActiveMatches();
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            return createCorsResponse({
                status: 'already-matched',
                matchId,
                partnerId,
                isInitiator: match.p1 === userId,
                message: 'User already in active match',
                timestamp: Date.now()
            });
        }
    }
    
    // ADAPTIVE MATCHING STRATEGY
    const userGender = gender || userInfo?.gender || 'Unspecified';
    const waitingUsers = await getWaitingUsers();
    
    let bestMatch;
    let strategy = 'simple';
    
    // For now, use simple strategy with Redis backend
    bestMatch = await findSimpleMatchExcludeSelf(userId, chatZone, userGender);
    
    if (bestMatch) {
        const partnerId = bestMatch.userId;
        const partnerUser = bestMatch.user;
        
        // ✅ REMOVE BOTH USERS FROM REDIS WAITING LIST
        await removeWaitingUserFromRedis(userId);
        await removeWaitingUserFromRedis(partnerId);
        
        // Invalidate cache
        lastCacheUpdate = 0;
        
        // Create match
        const matchId = preferredMatchId || `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        const isUserInitiator = userId < partnerId;
        const p1 = isUserInitiator ? userId : partnerId;
        const p2 = isUserInitiator ? partnerId : userId;
        
        // ✅ CREATE MATCH OBJECT WITH CONNECTION TRACKING
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
            strategy: strategy
        };
        
        // ✅ SAVE MATCH TO REDIS
        await setMatch(matchId, match);
        
        criticalLog('INSTANT-MATCH', `🚀 ${userId.slice(-8)} <-> ${partnerId.slice(-8)} (${matchId}) | Score: ${bestMatch.score} | Strategy: ${strategy}`);
        
        return createCorsResponse({
            status: 'instant-match',
            matchId,
            partnerId,
            isInitiator: isUserInitiator,
            partnerInfo: partnerUser.userInfo || {},
            partnerChatZone: partnerUser.chatZone,
            signals: [],
            compatibility: bestMatch.score,
            strategy: strategy,
            message: 'Instant match found! WebRTC connection will be established.',
            timestamp: Date.now()
        });
        
    } else {
        // ✅ ADD USER TO REDIS WAITING LIST
        const waitingUser = {
            userId,
            userInfo: userInfo || {},
            chatZone: chatZone || null,
            timestamp: Date.now()
        };
        
        await addWaitingUserToRedis(userId, waitingUser);
        
        // Invalidate cache
        lastCacheUpdate = 0;
        
        const currentWaitingUsers = await getWaitingUsers();
        const position = Array.from(currentWaitingUsers.keys()).indexOf(userId) + 1;
        
        return createCorsResponse({
            status: 'waiting',
            position: position || currentWaitingUsers.size,
            waitingUsers: currentWaitingUsers.size,
            chatZone: chatZone,
            userGender: userGender,
            strategy: strategy,
            message: 'Added to matching queue. Waiting for partner...',
            estimatedWaitTime: Math.min(currentWaitingUsers.size * 2, 30),
            timestamp: Date.now()
        });
    }
}

async function handleGetSignals(userId, data) {
    const { chatZone, gender, userInfo } = data;
    
    // ✅ CHECK ACTIVE MATCHES FROM REDIS
    const activeMatches = await getActiveMatches();
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            const signals = match.signals[userId] || [];
            
            // Clear signals after retrieval and update Redis
            match.signals[userId] = [];
            await setMatch(matchId, match);
            
            smartLog('GET-SIGNALS', `${userId.slice(-8)} -> ${signals.length} signals`);
            
            return createCorsResponse({
                status: 'matched',
                matchId,
                partnerId,
                isInitiator: match.p1 === userId,
                signals,
                partnerChatZone: match.chatZones ? match.chatZones[partnerId] : null,
                matchScore: match.matchScore || null,
                strategy: match.strategy || 'unknown',
                timestamp: Date.now()
            });
        }
    }
    
    // ✅ CHECK WAITING LIST FROM REDIS
    const waitingUsers = await getWaitingUsers();
    if (waitingUsers.has(userId)) {
        const position = Array.from(waitingUsers.keys()).indexOf(userId) + 1;
        return createCorsResponse({
            status: 'waiting',
            position,
            waitingUsers: waitingUsers.size,
            chatZone: chatZone,
            userGender: gender || 'Unspecified',
            timestamp: Date.now()
        });
    } else {
        // ✅ AUTO-RECOVERY: Add user back to Redis if has enough info
        if (chatZone !== undefined) {
            const waitingUser = {
                userId,
                userInfo: userInfo || {},
                chatZone: chatZone,
                timestamp: Date.now()
            };
            
            await addWaitingUserToRedis(userId, waitingUser);
            lastCacheUpdate = 0; // Invalidate cache
            
            smartLog('GET-SIGNALS', `${userId.slice(-8)} auto-recovered to waiting list`);
            
            return createCorsResponse({
                status: 'waiting',
                position: (await getWaitingUsers()).size,
                waitingUsers: (await getWaitingUsers()).size,
                chatZone: chatZone,
                userGender: gender || 'Unspecified',
                message: 'Auto-recovered to waiting list',
                timestamp: Date.now()
            });
        }
    }
    
    return createCorsResponse({
        status: 'not_found',
        message: 'User not found in waiting list or active matches',
        tip: 'Try calling instant-match first',
        timestamp: Date.now()
    });
}

async function handleSendSignal(userId, data) {
    const { matchId, type, payload } = data;
    
    if (!matchId || !type || !payload) {
        return createCorsResponse({ 
            error: 'Missing required fields',
            required: ['matchId', 'type', 'payload']
        }, 400);
    }
    
    // ✅ GET MATCH FROM REDIS
    const match = await getMatch(matchId);
    if (!match) {
        return createCorsResponse({ 
            error: 'Match not found',
            matchId
        }, 404);
    }
    
    if (match.p1 !== userId && match.p2 !== userId) {
        return createCorsResponse({ error: 'User not in this match' }, 403);
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
    }
    
    // ✅ UPDATE MATCH IN REDIS
    await setMatch(matchId, match);
    
    smartLog('SEND-SIGNAL', `${userId.slice(-8)} -> ${partnerId.slice(-8)} (${type})`);
    
    return createCorsResponse({
        status: 'sent',
        partnerId,
        signalType: type,
        queueLength: match.signals[partnerId].length,
        timestamp: Date.now()
    });
}

async function handleP2pConnected(userId, data) {
    const { matchId, partnerId } = data;
    criticalLog('P2P-CONNECTED', `${matchId} - ${userId.slice(-8)} connected`);
    
    let removed = false;
    
    // ✅ REMOVE FROM REDIS WAITING LIST
    if (await removeWaitingUserFromRedis(userId)) removed = true;
    if (await removeWaitingUserFromRedis(partnerId)) removed = true;
    
    // ✅ UPDATE MATCH STATUS IN REDIS
    const match = await getMatch(matchId);
    if (match) {
        match.connected = true;
        match.connectedAt = Date.now();
        await setMatch(matchId, match);
        criticalLog('P2P-CONNECTED', `Match ${matchId} marked as connected in Redis`);
    } else {
        criticalLog('P2P-CONNECTED', `Match ${matchId} not found in Redis`);
    }
    
    // Invalidate cache
    lastCacheUpdate = 0;
    
    return createCorsResponse({
        status: 'p2p_connected',
        removed,
        matchPreserved: !!match,
        timestamp: Date.now()
    });
}

async function handleDisconnect(userId) {
    criticalLog('DISCONNECT', userId.slice(-8));
    
    let removed = false;
    
    // ✅ REMOVE FROM REDIS WAITING LIST
    if (await removeWaitingUserFromRedis(userId)) removed = true;
    
    // ✅ HANDLE MATCH DISCONNECT IN REDIS
    const activeMatches = await getActiveMatches();
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            
            // Send disconnect signal to partner
            if (match.signals && match.signals[partnerId]) {
                match.signals[partnerId].push({
                    type: 'disconnect',
                    payload: { reason: 'partner_disconnected' },
                    from: userId,
                    timestamp: Date.now()
                });
            }
            
            // Mark match as disconnected
            match.disconnected = true;
            match.disconnectedAt = Date.now();
            match.disconnectedBy = userId;
            
            // Update match in Redis
            await setMatch(matchId, match);
            
            // Schedule deletion after delay
            setTimeout(async () => {
                await deleteMatch(matchId);
                criticalLog('DISCONNECT', `Delayed removal of match ${matchId} from Redis`);
            }, 5000);
            
            criticalLog('DISCONNECT', `Match ${matchId} marked for removal in Redis`);
            removed = true;
            break;
        }
    }
    
    // Invalidate cache
    lastCacheUpdate = 0;
    
    return createCorsResponse({ 
        status: 'disconnected',
        removed,
        timestamp: Date.now()
    });
}

// ==========================================
// REDIS-BACKED CLEANUP
// ==========================================

async function cleanup() {
    const now = Date.now();
    let cleanedUsers = 0;
    let cleanedMatches = 0;
    
    const SIGNALING_TIMEOUT = 120000;  // 2 minutes
    const CONNECTED_TIMEOUT = 300000;  // 5 minutes  
    const USER_TIMEOUT = 120000;       // 2 minutes
    
    try {
        // ✅ CLEANUP WAITING USERS FROM REDIS
        const waitingUsers = await getAllWaitingUsersFromRedis();
        const expiredUsers = [];
        
        for (const [userId, user] of waitingUsers.entries()) {
            if (now - user.timestamp > USER_TIMEOUT) {
                expiredUsers.push(userId);
            }
        }
        
        for (const userId of expiredUsers) {
            if (await removeWaitingUserFromRedis(userId)) {
                cleanedUsers++;
            }
        }
        
        // ✅ CLEANUP MATCHES FROM REDIS
        const activeMatches = await getAllActiveMatchesFromRedis();
        const expiredMatches = [];
        
        for (const [matchId, match] of activeMatches.entries()) {
            const age = now - match.timestamp;
            
            if (!match.connected) {
                if (age > SIGNALING_TIMEOUT) {
                    expiredMatches.push(matchId);
                    criticalLog('CLEANUP', `Expired signaling match: ${matchId} (${Math.round(age/1000)}s old)`);
                }
            } else {
                const connectedAge = now - match.connectedAt;
                if (connectedAge > CONNECTED_TIMEOUT) {
                    expiredMatches.push(matchId);
                    criticalLog('CLEANUP', `Expired connected match: ${matchId} (connected ${Math.round(connectedAge/1000)}s ago)`);
                }
            }
        }
        
        for (const matchId of expiredMatches) {
            await deleteMatch(matchId);
            cleanedMatches++;
        }
        
        // Invalidate cache after cleanup
        lastCacheUpdate = 0;
        
        if (cleanedUsers > 0 || cleanedMatches > 0) {
            criticalLog('CLEANUP', `Removed ${cleanedUsers} users, ${cleanedMatches} matches from Redis`);
        }
        
    } catch (error) {
        criticalLog('CLEANUP-ERROR', 'Redis cleanup failed:', error);
    }
}

// ==========================================
// REQUEST BODY PARSING
// ==========================================

async function parseRequestBody(request) {
    try {
        if (request.headers.get('content-type')?.includes('application/json')) {
            return await request.json();
        }
        
        const textBody = await request.text();
        
        if (!textBody || !textBody.trim()) {
            throw new Error('Empty request body');
        }
        
        try {
            return JSON.parse(textBody);
        } catch (parseError) {
            throw new Error(`Invalid JSON: ${parseError.message}`);
        }
        
    } catch (error) {
        throw new Error(`Body parsing failed: ${error.message}`);
    }
}

// ==========================================
// MAIN HANDLER FUNCTION - REDIS INTEGRATED
// ==========================================

export default async function handler(request) {
    const startTime = Date.now();
    
    // Perform cleanup periodically
    if (Math.random() < 0.1) { // 10% chance to cleanup on each request
        cleanup().catch(err => criticalLog('CLEANUP-ERROR', err));
    }
    
    if (request.method === 'OPTIONS') {
        return createCorsResponse(null, 200);
    }
    
    if (request.method === 'GET') {
        const url = new URL(request.url);
        const debug = url.searchParams.get('debug');
        
        if (debug === 'true') {
            const waitingUsers = await getWaitingUsers();
            const activeMatches = await getActiveMatches();
            
            return createCorsResponse({
                status: 'hybrid-optimized-webrtc-signaling-redis-integrated',
                runtime: 'vercel-edge',
                version: '3.0-redis-integrated',
                storage: 'Redis Labs',
                fixes: [
                    'Redis integration for multi-instance compatibility',
                    'Distributed state management',
                    'No more 404 Match not found errors',
                    'Persistent signaling across instances',
                    'Real-time cache with Redis backend'
                ],
                stats: {
                    waitingUsers: waitingUsers.size,
                    activeMatches: activeMatches.size,
                    cacheAge: Date.now() - lastCacheUpdate,
                    redisConnected: !!redisClient
                },
                performance: {
                    startupTime: Date.now() - startTime
                },
                timestamp: Date.now()
            });
        }
        
        return createCorsResponse({ 
            status: 'redis-integrated-signaling-ready',
            runtime: 'vercel-edge',
            version: '3.0-redis',
            message: 'Redis-integrated WebRTC signaling server ready!',
            timestamp: Date.now()
        });
    }
    
    if (request.method !== 'POST') {
        return createCorsResponse({ error: 'POST required for signaling' }, 405);
    }
    
    try {
        const data = await parseRequestBody(request);
        const { action, userId } = data;

        if (!action || !userId) {
            return createCorsResponse({
                error: 'Missing required fields',
                required: ['action', 'userId'],
                received: Object.keys(data || {})
            }, 400);
        }

        // Timeout protection
        if (Date.now() - startTime > 8000) { // 8 seconds for edge runtime
            criticalLog('TIMEOUT-WARNING', `Request taking too long: ${Date.now() - startTime}ms`);
            return createCorsResponse({
                error: 'Request timeout prevention',
                message: 'Please retry your request'
            }, 408);
        }

        // Handle different actions with Redis backend
        switch (action) {
            case 'instant-match':
                return await handleInstantMatch(userId, data);
            case 'get-signals':
                return await handleGetSignals(userId, data);
            case 'send-signal':
                return await handleSendSignal(userId, data);
            case 'p2p-connected':
                return await handleP2pConnected(userId, data);
            case 'disconnect':
                return await handleDisconnect(userId);
            default:
                return createCorsResponse({
                    error: 'Unknown action',
                    received: action,
                    available: ['instant-match', 'get-signals', 'send-signal', 'p2p-connected', 'disconnect']
                }, 400);
        }

    } catch (error) {
        criticalLog('ERROR', `Server error: ${error.message}`);
        
        // Enhanced error response for debugging
        return createCorsResponse({
            error: 'Internal server error',
            message: error.message,
            type: error.constructor.name,
            processing_time: Date.now() - startTime,
            tip: 'Check request format and try again',
            redis_connected: !!redisClient
        }, 500);
    }
}
