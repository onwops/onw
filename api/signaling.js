// 🚀 REDIS CLOUD WebRTC Signaling Server (Based on Original)

import { Redis } from '@upstash/redis';

const ENABLE_DETAILED_LOGGING = false;

// ==========================================
// CONFIGURATION & CONSTANTS (Original)
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
// UPSTASH REDIS CLIENT
// ==========================================

let redisClient = null;

function getRedisClient() {
    if (!redisClient && process.env.REDIS_URL) {
        try {
            // Parse Redis URL for Upstash
            const url = process.env.REDIS_URL;
            redisClient = Redis.fromEnv({
                url: url,
                automaticDeserialization: false
            });
            criticalLog('REDIS-INIT', 'Redis client initialized');
        } catch (error) {
            criticalLog('REDIS-INIT-ERROR', error.message);
            return null;
        }
    }
    return redisClient;
}

// ==========================================
// REDIS UTILITIES WITH FALLBACK
// ==========================================

// In-memory fallback storage
let memoryWaitingUsers = new Map();
let memoryActiveMatches = new Map();

async function safeRedisOp(operation, fallbackValue = null) {
    try {
        const redis = getRedisClient();
        if (!redis) return fallbackValue;
        return await operation(redis);
    } catch (error) {
        criticalLog('REDIS-ERROR', error.message);
        return fallbackValue;
    }
}

// Redis keys
const keys = {
    waitingUsers: 'waiting_users_hash',
    activeMatches: 'active_matches_hash',
    userCount: 'user_count',
    matchCount: 'match_count'
};

// ==========================================
// STORAGE OPERATIONS (Redis + Memory Fallback)
// ==========================================

async function getWaitingUsers() {
    const redisUsers = await safeRedisOp(async (redis) => {
        const data = await redis.hgetall(keys.waitingUsers);
        if (!data || Object.keys(data).length === 0) return null;
        
        const users = new Map();
        for (const [userId, userData] of Object.entries(data)) {
            try {
                const parsedData = typeof userData === 'string' ? JSON.parse(userData) : userData;
                users.set(userId, parsedData);
            } catch (e) {
                criticalLog('PARSE-ERROR', 'Failed to parse user data for', userId);
            }
        }
        return users;
    });
    
    if (redisUsers) return redisUsers;
    
    // Fallback to memory
    return memoryWaitingUsers;
}

async function setWaitingUser(userId, userData) {
    const success = await safeRedisOp(async (redis) => {
        await redis.hset(keys.waitingUsers, userId, JSON.stringify(userData));
        await redis.expire(keys.waitingUsers, 300); // 5 min TTL
        return true;
    });
    
    if (!success) {
        // Fallback to memory
        memoryWaitingUsers.set(userId, userData);
    }
    
    return true;
}

async function removeWaitingUser(userId) {
    const success = await safeRedisOp(async (redis) => {
        await redis.hdel(keys.waitingUsers, userId);
        return true;
    });
    
    if (!success) {
        // Fallback to memory
        return memoryWaitingUsers.delete(userId);
    }
    
    return success;
}

async function getActiveMatches() {
    const redisMatches = await safeRedisOp(async (redis) => {
        const data = await redis.hgetall(keys.activeMatches);
        if (!data || Object.keys(data).length === 0) return null;
        
        const matches = new Map();
        for (const [matchId, matchData] of Object.entries(data)) {
            try {
                const parsedData = typeof matchData === 'string' ? JSON.parse(matchData) : matchData;
                matches.set(matchId, parsedData);
            } catch (e) {
                criticalLog('PARSE-ERROR', 'Failed to parse match data for', matchId);
            }
        }
        return matches;
    });
    
    if (redisMatches) return redisMatches;
    
    // Fallback to memory
    return memoryActiveMatches;
}

async function setActiveMatch(matchId, matchData) {
    const success = await safeRedisOp(async (redis) => {
        await redis.hset(keys.activeMatches, matchId, JSON.stringify(matchData));
        await redis.expire(keys.activeMatches, 720); // 12 min TTL
        return true;
    });
    
    if (!success) {
        // Fallback to memory
        memoryActiveMatches.set(matchId, matchData);
    }
    
    return true;
}

async function removeActiveMatch(matchId) {
    const success = await safeRedisOp(async (redis) => {
        await redis.hdel(keys.activeMatches, matchId);
        return true;
    });
    
    if (!success) {
        // Fallback to memory
        return memoryActiveMatches.delete(matchId);
    }
    
    return success;
}

// ==========================================
// OPTIMIZED GLOBAL STATE (Original)
// ==========================================

// 🔥 OPTIMIZATION: Pre-calculated distance cache (kept in memory for speed)
let distanceCache = new Map(); // "zone1,zone2" -> circularDistance
let timezoneScoreTable = new Array(25); // Pre-calculated scores 0-24
let genderScoreTable = new Map(); // Pre-calculated gender combinations

// ==========================================
// LOGGING UTILITIES (Original)
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
// CORS & RESPONSE UTILITIES (Original)
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
// INITIALIZATION - PRE-CALCULATE TABLES (Original)
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
// ULTRA-FAST DISTANCE CALCULATION WITH CACHE (Original)
// ==========================================

function getCircularDistance(zone1, zone2) {
    if (typeof zone1 !== 'number' || typeof zone2 !== 'number') return 12;
    
    // Cache key (normalized)
    const cacheKey = zone1 <= zone2 ? `${zone1},${zone2}` : `${zone2},${zone1}`;
    
    if (distanceCache.has(cacheKey)) {
        return distanceCache.get(cacheKey);
    }
    
    const linear = Math.abs(zone1 - zone2);
    const circular = linear > 12 ? 24 - linear : linear;
    
    // Add to cache with LRU eviction
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
// MATCHING STRATEGIES (Original logic)
// ==========================================

async function findSimpleMatch(userId, userChatZone, userGender) {
    const waitingUsers = await getWaitingUsers();
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (const [candidateId, candidate] of waitingUsers.entries()) {
        if (candidateId === userId) continue;
        
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

async function findHybridMatch(userId, userChatZone, userGender) {
    const waitingUsers = await getWaitingUsers();
    
    // If small user count, use simple approach
    if (waitingUsers.size <= 20) {
        return await findSimpleMatch(userId, userChatZone, userGender);
    }
    
    // Otherwise use simple approach for now (can optimize later)
    return await findSimpleMatch(userId, userChatZone, userGender);
}

// ==========================================
// MAIN HANDLERS (Modified for Redis)
// ==========================================

async function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    // MINIMAL VALIDATION - NO chatZone validation to avoid 400 error
    if (!userId || typeof userId !== 'string') {
        return createCorsResponse({ error: 'userId is required and must be string' }, 400);
    }
    
    smartLog('INSTANT-MATCH', `${userId.slice(-8)} looking for partner (ChatZone: ${chatZone})`);
    
    // Remove from existing states
    await removeWaitingUser(userId);
    
    // Remove from active matches
    const activeMatches = await getActiveMatches();
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            await removeActiveMatch(matchId);
            break;
        }
    }
    
    // 🔧 ADAPTIVE MATCHING STRATEGY
    const userGender = gender || userInfo?.gender || 'Unspecified';
    const waitingUsers = await getWaitingUsers();
    
    let bestMatch;
    
    if (waitingUsers.size <= SIMPLE_STRATEGY_THRESHOLD) {
        // Very small pool - use simple linear search (fastest for small data)
        bestMatch = await findSimpleMatch(userId, chatZone, userGender);
        
    } else if (waitingUsers.size <= HYBRID_STRATEGY_THRESHOLD) {
        // Medium pool - use hybrid approach
        bestMatch = await findHybridMatch(userId, chatZone, userGender);
        
    } else {
        // Large pool - use hybrid approach
        bestMatch = await findHybridMatch(userId, chatZone, userGender);
    }
    
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
        
        // Use simple object creation for reliability
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
        
        await setActiveMatch(matchId, match);
        
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
        const waitingUser = {
            userId,
            userInfo: userInfo || {},
            chatZone: chatZone || null,
            timestamp: Date.now()
        };
        
        await setWaitingUser(userId, waitingUser);
        
        const updatedWaitingUsers = await getWaitingUsers();
        const position = updatedWaitingUsers.size;
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
    const activeMatches = await getActiveMatches();
    
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            const signals = match.signals[userId] || [];
            
            match.signals[userId] = [];
            await setActiveMatch(matchId, match);
            
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
    
    const activeMatches = await getActiveMatches();
    const match = activeMatches.get(matchId);
    
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
    
    await setActiveMatch(matchId, match);
    
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
    
    await removeActiveMatch(matchId);
    
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
    
    const activeMatches = await getActiveMatches();
    for (const [matchId, match] of activeMatches.entries()) {
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
            await removeActiveMatch(matchId);
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
// OPTIMIZED CLEANUP (Modified for Redis)
// ==========================================

async function cleanup() {
    const now = Date.now();
    let cleanedUsers = 0;
    let cleanedMatches = 0;
    
    // Cleanup waiting users
    const waitingUsers = await getWaitingUsers();
    const expiredUsers = [];
    
    for (const [userId, user] of waitingUsers.entries()) {
        if (now - user.timestamp > USER_TIMEOUT) {
            expiredUsers.push(userId);
        }
    }
    
    for (const userId of expiredUsers) {
        await removeWaitingUser(userId);
        cleanedUsers++;
    }
    
    // Cleanup active matches
    const activeMatches = await getActiveMatches();
    const expiredMatches = [];
    
    for (const [matchId, match] of activeMatches.entries()) {
        if (now - match.timestamp > MATCH_LIFETIME) {
            expiredMatches.push(matchId);
        }
    }
    
    for (const matchId of expiredMatches) {
        await removeActiveMatch(matchId);
        cleanedMatches++;
    }
    
    if (cleanedUsers > 0 || cleanedMatches > 0) {
        const remainingUsers = (await getWaitingUsers()).size;
        const remainingMatches = (await getActiveMatches()).size;
        criticalLog('CLEANUP', `Removed ${cleanedUsers} users, ${cleanedMatches} matches. Active: ${remainingUsers} waiting, ${remainingMatches} matched`);
    }
}

// ==========================================
// MAIN HANDLER FUNCTION (Original with Redis)
// ==========================================

export default async function handler(req) {
    await cleanup();
    
    if (req.method === 'OPTIONS') {
        return createCorsResponse(null, 200);
    }
    
    if (req.method === 'GET') {
        const url = new URL(req.url);
        const debug = url.searchParams.get('debug');
        
        if (debug === 'true') {
            const waitingUsers = await getWaitingUsers();
            const activeMatches = await getActiveMatches();
            
            return createCorsResponse({
                status: 'redis-cloud-webrtc-signaling',
                runtime: 'edge',
                storage: 'redis-cloud',
                redis: process.env.REDIS_URL ? 'connected' : 'not-configured',
                strategies: {
                    simple: `≤${SIMPLE_STRATEGY_THRESHOLD} users`,
                    hybrid: `${SIMPLE_STRATEGY_THRESHOLD + 1}-${HYBRID_STRATEGY_THRESHOLD} users`, 
                    optimized: `>${HYBRID_STRATEGY_THRESHOLD} users`
                },
                stats: {
                    waitingUsers: waitingUsers.size,
                    activeMatches: activeMatches.size,
                    cacheSize: distanceCache.size
                },
                timestamp: Date.now()
            });
        }
        
        const waitingUsers = await getWaitingUsers();
        const activeMatches = await getActiveMatches();
        
        return createCorsResponse({ 
            status: 'redis-cloud-signaling-ready',
            runtime: 'edge',
            storage: 'redis-cloud',
            redis: process.env.REDIS_URL ? 'available' : 'missing',
            stats: { 
                waiting: waitingUsers.size, 
                matches: activeMatches.size,
                strategy: waitingUsers.size <= SIMPLE_STRATEGY_THRESHOLD ? 'simple' : 
                         waitingUsers.size <= HYBRID_STRATEGY_THRESHOLD ? 'hybrid' : 'optimized'
            },
            message: 'Redis Cloud WebRTC signaling server ready',
            timestamp: Date.now()
        });
    }
    
    if (req.method !== 'POST') {
        return createCorsResponse({ error: 'POST required for signaling' }, 405);
    }
    
    try {
        // FLEXIBLE JSON PARSING (Original logic)
        let data;
        let requestBody = '';
        
        try {
            data = await req.json();
        } catch (jsonError) {
            if (!req.body) {
                return createCorsResponse({ 
                    error: 'No request body found',
                    tip: 'Send JSON body with your POST request'
                }, 400);
            }
            
            const reader = req.body.getReader();
            const decoder = new TextDecoder();
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                requestBody += decoder.decode(value, { stream: true });
            }
            
            if (!requestBody.trim()) {
                return createCorsResponse({ 
                    error: 'Empty request body',
                    tip: 'Send JSON data'
                }, 400);
            }
            
            data = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;
        }
        
        const { action, userId, chatZone } = data;
        
        if (!userId) {
            return createCorsResponse({ 
                error: 'userId is required',
                tip: 'Include userId in your JSON'
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

