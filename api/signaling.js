// 🚀 EDGE-COMPATIBLE Redis WebRTC Signaling Server

const ENABLE_DETAILED_LOGGING = false;

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================

const USER_TIMEOUT = 120000; // 2 minutes for waiting users
const MATCH_LIFETIME = 600000; // 10 minutes for active matches
const MAX_WAITING_USERS = 120000; // Prevent memory bloat

// Timezone scoring constants
const TIMEZONE_MAX_SCORE = 20;
const TIMEZONE_PENALTY = 1;

// Performance constants
const MAX_CACHE_SIZE = 1000;
const MAX_CANDIDATES = 5;

// Adaptive strategy thresholds
const SIMPLE_STRATEGY_THRESHOLD = 10;
const HYBRID_STRATEGY_THRESHOLD = 100;

// Redis TTL settings
const WAITING_USER_TTL = 180; // 3 minutes
const ACTIVE_MATCH_TTL = 720; // 12 minutes
const SIGNAL_TTL = 300; // 5 minutes
const INDEX_TTL = 60; // 1 minute for indexes

// ==========================================
// EDGE-COMPATIBLE REDIS CLIENT
// ==========================================

class EdgeRedisClient {
    constructor(url) {
        this.url = url;
        this.parseRedisUrl();
    }
    
    parseRedisUrl() {
        try {
            const parsed = new URL(this.url);
            this.host = parsed.hostname;
            this.port = parsed.port || 6379;
            this.password = parsed.password;
            this.baseUrl = `https://${this.host}:${this.port}`;
        } catch (error) {
            criticalLog('REDIS-ERROR', 'Invalid Redis URL:', error.message);
            throw error;
        }
    }
    
    async executeCommand(command, ...args) {
        try {
            const body = [command, ...args].map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            );
            
            const response = await fetch(`${this.baseUrl}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.password}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            
            if (!response.ok) {
                throw new Error(`Redis command failed: ${response.status}`);
            }
            
            const result = await response.json();
            return result.result;
        } catch (error) {
            criticalLog('REDIS-CMD-ERROR', command, error.message);
            return null;
        }
    }
    
    // Basic Redis commands for Edge Runtime
    async get(key) {
        return await this.executeCommand('GET', key);
    }
    
    async set(key, value, options = {}) {
        if (options.EX) {
            return await this.executeCommand('SETEX', key, options.EX, value);
        }
        return await this.executeCommand('SET', key, value);
    }
    
    async del(key) {
        return await this.executeCommand('DEL', key);
    }
    
    async sadd(key, ...members) {
        return await this.executeCommand('SADD', key, ...members);
    }
    
    async srem(key, ...members) {
        return await this.executeCommand('SREM', key, ...members);
    }
    
    async smembers(key) {
        return await this.executeCommand('SMEMBERS', key) || [];
    }
    
    async scard(key) {
        return await this.executeCommand('SCARD', key) || 0;
    }
    
    async lpush(key, ...values) {
        return await this.executeCommand('LPUSH', key, ...values);
    }
    
    async lrange(key, start, stop) {
        return await this.executeCommand('LRANGE', key, start, stop) || [];
    }
    
    async llen(key) {
        return await this.executeCommand('LLEN', key) || 0;
    }
    
    async ltrim(key, start, stop) {
        return await this.executeCommand('LTRIM', key, start, stop);
    }
    
    async incr(key) {
        return await this.executeCommand('INCR', key);
    }
    
    async decr(key) {
        return await this.executeCommand('DECR', key);
    }
    
    async expire(key, seconds) {
        return await this.executeCommand('EXPIRE', key, seconds);
    }
}

let redisClient = null;

function getRedisClient() {
    if (!redisClient && process.env.REDIS_URL) {
        redisClient = new EdgeRedisClient(process.env.REDIS_URL);
    }
    return redisClient;
}

// ==========================================
// REDIS UTILITIES
// ==========================================

async function safeRedisOp(operation) {
    try {
        const redis = getRedisClient();
        if (!redis) {
            criticalLog('REDIS-ERROR', 'Redis client not available');
            return null;
        }
        return await operation(redis);
    } catch (error) {
        criticalLog('REDIS-ERROR', error.message);
        return null;
    }
}

// Redis key generators
const keys = {
    waitingUser: (userId) => `waiting:${userId}`,
    waitingList: () => 'waiting:list',
    activeMatch: (matchId) => `match:${matchId}`,
    matchList: () => 'match:list',
    signals: (matchId, userId) => `signals:${matchId}:${userId}`,
    timezoneIndex: (zone) => `tz_idx:${zone}`,
    genderIndex: (gender) => `gender_idx:${gender}`,
    freshUsers: () => 'fresh_users',
    userCount: () => 'user_count',
    matchCount: () => 'match_count'
};

// ==========================================
// IN-MEMORY FALLBACK
// ==========================================

// Fallback to in-memory if Redis fails
let memoryWaitingUsers = new Map();
let memoryActiveMatches = new Map();

// ==========================================
// OPTIMIZED GLOBAL STATE
// ==========================================

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
// INITIALIZATION
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
// DISTANCE CALCULATION
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
// HYBRID STORAGE OPERATIONS
// ==========================================

async function addWaitingUser(userId, userInfo, chatZone) {
    const user = {
        userId,
        userInfo: userInfo || {},
        chatZone: chatZone || null,
        timestamp: Date.now()
    };
    
    // Try Redis first, fallback to memory
    const redisSuccess = await safeRedisOp(async (redis) => {
        await redis.set(keys.waitingUser(userId), JSON.stringify(user), { EX: WAITING_USER_TTL });
        await redis.sadd(keys.waitingList(), userId);
        
        if (typeof chatZone === 'number') {
            await redis.sadd(keys.timezoneIndex(chatZone), userId);
            await redis.expire(keys.timezoneIndex(chatZone), INDEX_TTL);
        }
        
        const gender = userInfo?.gender || 'Unspecified';
        await redis.sadd(keys.genderIndex(gender), userId);
        await redis.expire(keys.genderIndex(gender), INDEX_TTL);
        
        await redis.sadd(keys.freshUsers(), userId);
        await redis.expire(keys.freshUsers(), 30);
        
        await redis.incr(keys.userCount());
        await redis.expire(keys.userCount(), WAITING_USER_TTL);
        
        return true;
    });
    
    if (!redisSuccess) {
        memoryWaitingUsers.set(userId, user);
        criticalLog('FALLBACK', 'Using memory storage for waiting user');
    }
    
    return user;
}

async function removeWaitingUser(userId) {
    // Try Redis first
    const redisSuccess = await safeRedisOp(async (redis) => {
        const userData = await redis.get(keys.waitingUser(userId));
        if (!userData) return false;
        
        const user = JSON.parse(userData);
        
        await redis.del(keys.waitingUser(userId));
        await redis.srem(keys.waitingList(), userId);
        
        if (typeof user.chatZone === 'number') {
            await redis.srem(keys.timezoneIndex(user.chatZone), userId);
        }
        
        const gender = user.userInfo?.gender || 'Unspecified';
        await redis.srem(keys.genderIndex(gender), userId);
        await redis.srem(keys.freshUsers(), userId);
        await redis.decr(keys.userCount());
        
        return true;
    });
    
    if (!redisSuccess) {
        return memoryWaitingUsers.delete(userId);
    }
    
    return redisSuccess;
}

async function getWaitingUser(userId) {
    // Try Redis first
    const redisUser = await safeRedisOp(async (redis) => {
        const userData = await redis.get(keys.waitingUser(userId));
        return userData ? JSON.parse(userData) : null;
    });
    
    if (redisUser) return redisUser;
    
    // Fallback to memory
    return memoryWaitingUsers.get(userId) || null;
}

async function getAllWaitingUsers() {
    // Try Redis first
    const redisUsers = await safeRedisOp(async (redis) => {
        const userIds = await redis.smembers(keys.waitingList());
        if (!userIds.length) return new Map();
        
        const waitingUsers = new Map();
        
        // Get users one by one (no pipeline in simple implementation)
        for (const userId of userIds) {
            const userData = await redis.get(keys.waitingUser(userId));
            if (userData) {
                waitingUsers.set(userId, JSON.parse(userData));
            }
        }
        
        return waitingUsers;
    });
    
    if (redisUsers && redisUsers.size > 0) return redisUsers;
    
    // Fallback to memory
    return memoryWaitingUsers;
}

async function getWaitingUserCount() {
    const redisCount = await safeRedisOp(async (redis) => {
        const count = await redis.get(keys.userCount());
        return count ? parseInt(count) : 0;
    });
    
    if (redisCount !== null) return redisCount;
    
    return memoryWaitingUsers.size;
}

// ==========================================
// SIMPLE MATCHING STRATEGY
// ==========================================

async function findSimpleMatch(userId, userChatZone, userGender) {
    const waitingUsers = await getAllWaitingUsers();
    
    let bestMatch = null;
    let bestScore = 0;
    
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
// MAIN HANDLERS
// ==========================================

async function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    if (!userId || typeof userId !== 'string') {
        return createCorsResponse({ error: 'userId is required and must be string' }, 400);
    }
    
    smartLog('INSTANT-MATCH', `${userId.slice(-8)} looking for partner (ChatZone: ${chatZone})`);
    
    // Remove from existing states
    await removeWaitingUser(userId);
    
    // Simple matching strategy
    const userGender = gender || userInfo?.gender || 'Unspecified';
    const bestMatch = await findSimpleMatch(userId, chatZone, userGender);
    
    if (bestMatch) {
        const partnerId = bestMatch.userId;
        const partnerUser = bestMatch.user;
        
        // Remove partner from waiting
        await removeWaitingUser(partnerId);
        
        // Create match
        const matchId = preferredMatchId || `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        const isUserInitiator = userId < partnerId;
        const p1 = isUserInitiator ? userId : partnerId;
        const p2 = isUserInitiator ? partnerId : userId;
        
        // Store match in memory for simplicity
        const match = {
            p1, p2,
            timestamp: Date.now(),
            signals: { [p1]: [], [p2]: [] },
            userInfo: {
                [userId]: userInfo || {},
                [partnerId]: partnerUser.userInfo || {}
            },
            chatZones: {
                [userId]: chatZone,
                [partnerId]: partnerUser.chatZone
            },
            matchScore: bestMatch.score
        };
        
        memoryActiveMatches.set(matchId, match);
        
        criticalLog('INSTANT-MATCH', `🚀 ${userId.slice(-8)} <-> ${partnerId.slice(-8)} (${matchId}) | Score: ${bestMatch.score}`);
        
        return createCorsResponse({
            status: 'instant-match',
            matchId,
            partnerId,
            isInitiator: isUserInitiator,
            partnerInfo: partnerUser.userInfo || {},
            partnerChatZone: partnerUser.chatZone,
            signals: [],
            compatibility: bestMatch.score,
            message: 'Instant match found! WebRTC connection will be established.',
            timestamp: Date.now()
        });
        
    } else {
        // Add to waiting list
        await addWaitingUser(userId, userInfo, chatZone);
        
        const position = await getWaitingUserCount();
        smartLog('INSTANT-MATCH', `${userId.slice(-8)} added to waiting list (position ${position})`);
        
        return createCorsResponse({
            status: 'waiting',
            position,
            waitingUsers: position,
            chatZone: chatZone,
            userGender: userGender,
            message: 'Added to matching queue. Waiting for partner...',
            estimatedWaitTime: Math.min(position * 2, 30),
            timestamp: Date.now()
        });
    }
}

async function handleGetSignals(userId, data) {
    const { chatZone, gender } = data;
    
    // Check active matches
    for (const [matchId, match] of memoryActiveMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            const signals = match.signals[userId] || [];
            
            match.signals[userId] = [];
            
            smartLog('GET-SIGNALS', `${userId.slice(-8)} -> ${signals.length} signals`);
            
            return createCorsResponse({
                status: 'matched',
                matchId,
                partnerId,
                isInitiator: match.p1 === userId,
                signals,
                partnerChatZone: match.chatZones ? match.chatZones[partnerId] : null,
                matchScore: match.matchScore || null,
                timestamp: Date.now()
            });
        }
    }
    
    const waitingUser = await getWaitingUser(userId);
    if (waitingUser) {
        const totalUsers = await getWaitingUserCount();
        const position = Math.max(1, Math.floor(totalUsers * Math.random()) + 1);
        
        return createCorsResponse({
            status: 'waiting',
            position,
            waitingUsers: totalUsers,
            chatZone: chatZone,
            userGender: gender || 'Unspecified',
            timestamp: Date.now()
        });
    }
    
    return createCorsResponse({
        status: 'not_found',
        message: 'User not found in waiting list or active matches',
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
    
    const match = memoryActiveMatches.get(matchId);
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
    
    if (match.signals[partnerId].length > 100) {
        match.signals[partnerId] = match.signals[partnerId].slice(-50);
    }
    
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
    
    const userRemoved = await removeWaitingUser(userId);
    const partnerRemoved = await removeWaitingUser(partnerId);
    removed = userRemoved || partnerRemoved;
    
    memoryActiveMatches.delete(matchId);
    
    return createCorsResponse({
        status: 'p2p_connected',
        removed,
        timestamp: Date.now()
    });
}

async function handleDisconnect(userId) {
    criticalLog('DISCONNECT', userId.slice(-8));
    
    let removed = false;
    
    const userRemoved = await removeWaitingUser(userId);
    if (userRemoved) removed = true;
    
    for (const [matchId, match] of memoryActiveMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            
            if (match.signals && match.signals[partnerId]) {
                match.signals[partnerId].push({
                    type: 'disconnect',
                    payload: { reason: 'partner_disconnected' },
                    from: userId,
                    timestamp: Date.now()
                });
            }
            
            criticalLog('DISCONNECT', `Removing match ${matchId}`);
            memoryActiveMatches.delete(matchId);
            removed = true;
            break;
        }
    }
    
    return createCorsResponse({ 
        status: 'disconnected',
        removed,
        timestamp: Date.now()
    });
}

// ==========================================
// MAIN HANDLER FUNCTION
// ==========================================

export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return createCorsResponse(null, 200);
    }
    
    if (req.method === 'GET') {
        const url = new URL(req.url);
        const debug = url.searchParams.get('debug');
        
        if (debug === 'true') {
            const waitingCount = await getWaitingUserCount();
            
            return createCorsResponse({
                status: 'edge-compatible-webrtc-signaling',
                runtime: 'edge',
                redis: process.env.REDIS_URL ? 'configured' : 'not-configured',
                storage: 'hybrid-redis-memory',
                stats: {
                    waitingUsers: waitingCount,
                    activeMatches: memoryActiveMatches.size,
                    cacheSize: distanceCache.size
                },
                timestamp: Date.now()
            });
        }
        
        const waitingCount = await getWaitingUserCount();
        
        return createCorsResponse({ 
            status: 'edge-compatible-signaling-ready',
            runtime: 'edge',
            redis: process.env.REDIS_URL ? 'available' : 'fallback-memory',
            stats: { 
                waiting: waitingCount, 
                matches: memoryActiveMatches.size,
                strategy: 'simple'
            },
            message: 'Edge-compatible WebRTC signaling server ready',
            timestamp: Date.now()
        });
    }
    
    if (req.method !== 'POST') {
        return createCorsResponse({ error: 'POST required for signaling' }, 405);
    }
    
    try {
        let data;
        
        try {
            data = await req.json();
        } catch (jsonError) {
            return createCorsResponse({ 
                error: 'Invalid JSON in request body'
            }, 400);
        }
        
        const { action, userId, chatZone } = data;
        
        if (!userId) {
            return createCorsResponse({ 
                error: 'userId is required'
            }, 400);
        }
        
        if (!action) {
            return createCorsResponse({ 
                error: 'action is required',
                validActions: ['instant-match', 'get-signals', 'send-signal', 'p2p-connected', 'disconnect']
            }, 400);
        }
        
        criticalLog(`${action.toUpperCase()}`, `${userId.slice(-8)} (Zone: ${chatZone || 'N/A'})`);
        
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
                return createCorsResponse({ error: `Unknown action: ${action}` }, 400);
        }
    } catch (error) {
        criticalLog('SERVER ERROR', `Error: ${error.message}`);
        return createCorsResponse({ 
            error: 'Server error', 
            details: error.message,
            timestamp: Date.now()
        }, 500);
    }
}

 
