// 🚀 REDIS-OPTIMIZED WebRTC Signaling Server

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
const TIMEZONE_CIRCLE_HOURS = 24;

// Performance constants
const INDEX_REBUILD_INTERVAL = 10000; // 10 seconds
const MAX_CACHE_SIZE = 1000;
const MATCH_CACHE_TTL = 5000; // 5 seconds
const MAX_CANDIDATES = 5; // Reduced from 10

// Adaptive strategy thresholds
const SIMPLE_STRATEGY_THRESHOLD = 10;
const HYBRID_STRATEGY_THRESHOLD = 100;

// Redis TTL settings
const WAITING_USER_TTL = 180; // 3 minutes
const ACTIVE_MATCH_TTL = 720; // 12 minutes
const SIGNAL_TTL = 300; // 5 minutes
const INDEX_TTL = 60; // 1 minute for indexes

// ==========================================
// REDIS CONNECTION
// ==========================================

import { createClient } from 'redis';

let redisClient = null;

async function getRedisClient() {
    if (!redisClient) {
        redisClient = createClient({
            url: process.env.REDIS_URL
        });
        
        redisClient.on('error', (err) => {
            console.error('Redis Client Error', err);
        });
        
        await redisClient.connect();
    }
    return redisClient;
}

// ==========================================
// REDIS UTILITIES
// ==========================================

async function safeRedisOp(operation) {
    try {
        const redis = await getRedisClient();
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
// OPTIMIZED GLOBAL STATE (Redis-backed)
// ==========================================

// Pre-calculated distance cache (kept in memory for speed)
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
// ULTRA-FAST DISTANCE CALCULATION WITH CACHE
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
// REDIS WAITING USERS OPERATIONS
// ==========================================

async function addWaitingUser(userId, userInfo, chatZone) {
    return await safeRedisOp(async (redis) => {
        const user = {
            userId,
            userInfo: userInfo || {},
            chatZone: chatZone || null,
            timestamp: Date.now()
        };
        
        const pipeline = redis.multi();
        
        // Add user data
        pipeline.setEx(keys.waitingUser(userId), WAITING_USER_TTL, JSON.stringify(user));
        
        // Add to waiting list
        pipeline.sAdd(keys.waitingList(), userId);
        
        // Update indexes
        if (typeof chatZone === 'number') {
            pipeline.sAdd(keys.timezoneIndex(chatZone), userId);
            pipeline.expire(keys.timezoneIndex(chatZone), INDEX_TTL);
        }
        
        const gender = userInfo?.gender || 'Unspecified';
        pipeline.sAdd(keys.genderIndex(gender), userId);
        pipeline.expire(keys.genderIndex(gender), INDEX_TTL);
        
        // Add to fresh users if recent
        pipeline.sAdd(keys.freshUsers(), userId);
        pipeline.expire(keys.freshUsers(), 30); // 30 seconds
        
        // Update counters
        pipeline.incr(keys.userCount());
        pipeline.expire(keys.userCount(), WAITING_USER_TTL);
        
        await pipeline.exec();
        return user;
    });
}

async function removeWaitingUser(userId) {
    return await safeRedisOp(async (redis) => {
        const userKey = keys.waitingUser(userId);
        const userData = await redis.get(userKey);
        
        if (!userData) return false;
        
        const user = JSON.parse(userData);
        const pipeline = redis.multi();
        
        // Remove user data
        pipeline.del(userKey);
        
        // Remove from waiting list
        pipeline.sRem(keys.waitingList(), userId);
        
        // Remove from indexes
        if (typeof user.chatZone === 'number') {
            pipeline.sRem(keys.timezoneIndex(user.chatZone), userId);
        }
        
        const gender = user.userInfo?.gender || 'Unspecified';
        pipeline.sRem(keys.genderIndex(gender), userId);
        pipeline.sRem(keys.freshUsers(), userId);
        
        // Decrement counter
        pipeline.decr(keys.userCount());
        
        await pipeline.exec();
        return true;
    });
}

async function getWaitingUser(userId) {
    return await safeRedisOp(async (redis) => {
        const userData = await redis.get(keys.waitingUser(userId));
        return userData ? JSON.parse(userData) : null;
    });
}

async function getAllWaitingUsers() {
    return await safeRedisOp(async (redis) => {
        const userIds = await redis.sMembers(keys.waitingList());
        if (!userIds.length) return new Map();
        
        const pipeline = redis.multi();
        userIds.forEach(userId => {
            pipeline.get(keys.waitingUser(userId));
        });
        
        const results = await pipeline.exec();
        const waitingUsers = new Map();
        
        userIds.forEach((userId, index) => {
            const userData = results[index][1];
            if (userData) {
                waitingUsers.set(userId, JSON.parse(userData));
            }
        });
        
        return waitingUsers;
    });
}

async function getWaitingUserCount() {
    return await safeRedisOp(async (redis) => {
        const count = await redis.get(keys.userCount());
        return count ? parseInt(count) : 0;
    });
}

// ==========================================
// REDIS ACTIVE MATCHES OPERATIONS
// ==========================================

async function createActiveMatch(matchId, p1, p2, userInfo, chatZones, matchScore) {
    return await safeRedisOp(async (redis) => {
        const match = {
            p1, p2,
            timestamp: Date.now(),
            userInfo,
            chatZones,
            matchScore
        };
        
        const pipeline = redis.multi();
        
        // Store match data
        pipeline.setEx(keys.activeMatch(matchId), ACTIVE_MATCH_TTL, JSON.stringify(match));
        
        // Add to match list
        pipeline.sAdd(keys.matchList(), matchId);
        
        // Initialize signal queues
        pipeline.del(keys.signals(matchId, p1));
        pipeline.del(keys.signals(matchId, p2));
        
        // Update counter
        pipeline.incr(keys.matchCount());
        pipeline.expire(keys.matchCount(), ACTIVE_MATCH_TTL);
        
        await pipeline.exec();
        return match;
    });
}

async function removeActiveMatch(matchId) {
    return await safeRedisOp(async (redis) => {
        const matchData = await redis.get(keys.activeMatch(matchId));
        if (!matchData) return false;
        
        const match = JSON.parse(matchData);
        const pipeline = redis.multi();
        
        // Remove match data
        pipeline.del(keys.activeMatch(matchId));
        
        // Remove from match list
        pipeline.sRem(keys.matchList(), matchId);
        
        // Clean up signal queues
        pipeline.del(keys.signals(matchId, match.p1));
        pipeline.del(keys.signals(matchId, match.p2));
        
        // Decrement counter
        pipeline.decr(keys.matchCount());
        
        await pipeline.exec();
        return true;
    });
}

async function getActiveMatch(matchId) {
    return await safeRedisOp(async (redis) => {
        const matchData = await redis.get(keys.activeMatch(matchId));
        return matchData ? JSON.parse(matchData) : null;
    });
}

async function findUserMatch(userId) {
    return await safeRedisOp(async (redis) => {
        const matchIds = await redis.sMembers(keys.matchList());
        
        for (const matchId of matchIds) {
            const matchData = await redis.get(keys.activeMatch(matchId));
            if (matchData) {
                const match = JSON.parse(matchData);
                if (match.p1 === userId || match.p2 === userId) {
                    return { matchId, match };
                }
            }
        }
        return null;
    });
}

// ==========================================
// REDIS SIGNALS OPERATIONS
// ==========================================

async function addSignal(matchId, toUserId, signal) {
    return await safeRedisOp(async (redis) => {
        const signalKey = keys.signals(matchId, toUserId);
        
        await redis.lPush(signalKey, JSON.stringify(signal));
        await redis.expire(signalKey, SIGNAL_TTL);
        
        // Limit queue size
        const queueLength = await redis.lLen(signalKey);
        if (queueLength > 100) {
            await redis.lTrim(signalKey, 0, 49); // Keep last 50
        }
        
        return queueLength;
    });
}

async function getSignals(matchId, userId) {
    return await safeRedisOp(async (redis) => {
        const signalKey = keys.signals(matchId, userId);
        
        // Get all signals and clear the queue
        const signals = await redis.lRange(signalKey, 0, -1);
        await redis.del(signalKey);
        
        return signals.map(signal => JSON.parse(signal)).reverse(); // FIFO order
    });
}

// ==========================================
// REDIS INDEX OPERATIONS
// ==========================================

async function getCandidatesByTimezone(chatZone) {
    return await safeRedisOp(async (redis) => {
        if (typeof chatZone !== 'number') return [];
        return await redis.sMembers(keys.timezoneIndex(chatZone));
    });
}

async function getCandidatesByGender(gender) {
    return await safeRedisOp(async (redis) => {
        return await redis.sMembers(keys.genderIndex(gender || 'Unspecified'));
    });
}

async function getFreshUsers() {
    return await safeRedisOp(async (redis) => {
        return await redis.sMembers(keys.freshUsers());
    });
}

// ==========================================
// MATCHING STRATEGIES (Redis-adapted)
// ==========================================

async function findSimpleMatch(userId, userChatZone, userGender) {
    const waitingUsers = await getAllWaitingUsers();
    
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

async function findUltraFastMatch(userId, userChatZone, userGender) {
    const now = Date.now();
    let bestMatch = null;
    let bestScore = 0;
    
    // Get fresh users list
    const freshUsers = new Set(await getFreshUsers());
    
    // 🔥 PRIORITY 1: Same timezone + fresh users (< 30s)
    if (typeof userChatZone === 'number') {
        const sameZoneCandidates = await getCandidatesByTimezone(userChatZone);
        
        for (const candidateId of sameZoneCandidates) {
            if (candidateId === userId) continue;
            
            const candidate = await getWaitingUser(candidateId);
            if (!candidate) continue;
            
            let score = 21; // Base score for same timezone (20 + 1)
            
            // Gender bonus
            const candidateGender = candidate.userInfo?.gender || 'Unspecified';
            score += getGenderScore(userGender, candidateGender);
            
            // Fresh user mega bonus
            if (freshUsers.has(candidateId)) {
                score += 3;
            }
            
            // 🚀 EARLY EXIT: Perfect fresh match
            if (score >= 27) {
                return { userId: candidateId, user: candidate, score };
            }
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = { userId: candidateId, user: candidate, score };
            }
        }
    }
    
    // 🔥 PRIORITY 2: Adjacent timezones (±1, ±2) - but only if no good same-zone match
    if (bestScore < 23 && typeof userChatZone === 'number') {
        const adjacentZones = [
            userChatZone - 1, userChatZone + 1,  // ±1 hour
            userChatZone - 2, userChatZone + 2   // ±2 hours
        ];
        
        for (const adjZone of adjacentZones) {
            const normalizedZone = ((adjZone + 12) % 24) - 12; // Handle wraparound
            const adjCandidates = await getCandidatesByTimezone(normalizedZone);
            
            if (!adjCandidates.length) continue;
            
            // Only check first 2 candidates from adjacent zones for speed
            const limitedCandidates = adjCandidates.slice(0, 2);
            
            for (const candidateId of limitedCandidates) {
                if (candidateId === userId) continue;
                
                const candidate = await getWaitingUser(candidateId);
                if (!candidate) continue;
                
                let score = 1 + getTimezoneScore(userChatZone, normalizedZone);
                
                // Gender bonus
                const candidateGender = candidate.userInfo?.gender || 'Unspecified';
                score += getGenderScore(userGender, candidateGender);
                
                // Fresh bonus
                if (freshUsers.has(candidateId)) {
                    score += 2;
                }
                
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = { userId: candidateId, user: candidate, score };
                }
            }
        }
    }
    
    // 🔥 PRIORITY 3: Any timezone - only if no decent match found
    if (bestScore < 15) {
        const waitingUsers = await getAllWaitingUsers();
        let checkedCount = 0;
        
        for (const [candidateId, candidate] of waitingUsers.entries()) {
            if (candidateId === userId || checkedCount >= 5) break;
            checkedCount++;
            
            let score = 1 + getTimezoneScore(userChatZone, candidate.chatZone);
            
            const candidateGender = candidate.userInfo?.gender || 'Unspecified';
            score += getGenderScore(userGender, candidateGender);
            
            if (freshUsers.has(candidateId)) {
                score += 1;
            }
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = { userId: candidateId, user: candidate, score };
            }
        }
    }
    
    return bestMatch;
}

async function findHybridMatch(userId, userChatZone, userGender) {
    const userCount = await getWaitingUserCount();
    
    // If small user count, use simple approach
    if (userCount <= 20) {
        return await findSimpleMatch(userId, userChatZone, userGender);
    }
    
    // Otherwise use optimized approach
    return await findUltraFastMatch(userId, userChatZone, userGender);
}

// ==========================================
// ADAPTIVE INSTANT MATCH HANDLER
// ==========================================

async function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    // MINIMAL VALIDATION
    if (!userId || typeof userId !== 'string') {
        return createCorsResponse({ error: 'userId is required and must be string' }, 400);
    }
    
    smartLog('INSTANT-MATCH', `${userId.slice(-8)} looking for partner (ChatZone: ${chatZone})`);
    
    // Remove from existing states
    await removeWaitingUser(userId);
    
    // Remove from active matches
    const existingMatch = await findUserMatch(userId);
    if (existingMatch) {
        await removeActiveMatch(existingMatch.matchId);
    }
    
    // 🔧 ADAPTIVE MATCHING STRATEGY
    const userGender = gender || userInfo?.gender || 'Unspecified';
    const userCount = await getWaitingUserCount();
    
    let bestMatch;
    
    if (userCount <= SIMPLE_STRATEGY_THRESHOLD) {
        // Very small pool - use simple linear search
        bestMatch = await findSimpleMatch(userId, chatZone, userGender);
        
    } else if (userCount <= HYBRID_STRATEGY_THRESHOLD) {
        // Medium pool - use hybrid approach
        bestMatch = await findHybridMatch(userId, chatZone, userGender);
        
    } else {
        // Large pool - use full optimization
        bestMatch = await findUltraFastMatch(userId, chatZone, userGender);
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
        
        const userInfoMap = {
            [userId]: userInfo || {},
            [partnerId]: partnerUser.userInfo || {}
        };
        
        const chatZonesMap = {
            [userId]: chatZone,
            [partnerId]: partnerUser.chatZone
        };
        
        await createActiveMatch(matchId, p1, p2, userInfoMap, chatZonesMap, bestMatch.score);
        
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

// ==========================================
// OTHER HANDLERS (Redis-adapted)
// ==========================================

async function handleGetSignals(userId, data) {
    const { chatZone, gender } = data;
    
    const userMatch = await findUserMatch(userId);
    if (userMatch) {
        const { matchId, match } = userMatch;
        const partnerId = match.p1 === userId ? match.p2 : match.p1;
        const signals = await getSignals(matchId, userId);
        
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
    
    const waitingUser = await getWaitingUser(userId);
    if (waitingUser) {
        const totalUsers = await getWaitingUserCount();
        // Calculate position (approximate)
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
    
    const match = await getActiveMatch(matchId);
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
    
    const signal = {
        type,
        payload,
        from: userId,
        timestamp: Date.now()
    };
    
    const queueLength = await addSignal(matchId, partnerId, signal);
    
    smartLog('SEND-SIGNAL', `${userId.slice(-8)} -> ${partnerId.slice(-8)} (${type})`);
    
    return createCorsResponse({
        status: 'sent',
        partnerId,
        signalType: type,
        queueLength,
        timestamp: Date.now()
    });
}

async function handleP2pConnected(userId, data) {
    const { matchId, partnerId } = data;
    criticalLog('P2P-CONNECTED', `${matchId} - ${userId.slice(-8)} connected`);
    
    let removed = false;
    
    // Remove both users from waiting (if any)
    const userRemoved = await removeWaitingUser(userId);
    const partnerRemoved = await removeWaitingUser(partnerId);
    removed = userRemoved || partnerRemoved;
    
    // Remove the match
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
    
    // Remove from waiting list
    const userRemoved = await removeWaitingUser(userId);
    if (userRemoved) removed = true;
    
    // Find and handle active match
    const userMatch = await findUserMatch(userId);
    if (userMatch) {
        const { matchId, match } = userMatch;
        const partnerId = match.p1 === userId ? match.p2 : match.p1;
        
        // Send disconnect signal to partner
        const disconnectSignal = {
            type: 'disconnect',
            payload: { reason: 'partner_disconnected' },
            from: userId,
            timestamp: Date.now()
        };
        
        await addSignal(matchId, partnerId, disconnectSignal);
        
        criticalLog('DISCONNECT', `Removing match ${matchId}`);
        await removeActiveMatch(matchId);
        removed = true;
    }
    
    return createCorsResponse({ 
        status: 'disconnected',
        removed,
        timestamp: Date.now()
    });
}

// ==========================================
// REDIS CLEANUP
// ==========================================

async function cleanup() {
    await safeRedisOp(async (redis) => {
        const now = Date.now();
        let cleanedUsers = 0;
        let cleanedMatches = 0;
        
        // Cleanup expired waiting users
        const userIds = await redis.sMembers(keys.waitingList());
        const expiredUsers = [];
        
        if (userIds.length > 0) {
            const pipeline = redis.multi();
            userIds.forEach(userId => {
                pipeline.get(keys.waitingUser(userId));
            });
            
            const results = await pipeline.exec();
            
            userIds.forEach((userId, index) => {
                const userData = results[index][1];
                                    if (userData) {
                    const user = JSON.parse(userData);
                    if (now - user.timestamp > USER_TIMEOUT) {
                        expiredUsers.push(userId);
                    }
                } else {
                    // User data missing, remove from list
                    expiredUsers.push(userId);
                }
            });
        }
        
        // Remove expired users
        for (const userId of expiredUsers) {
            await removeWaitingUser(userId);
            cleanedUsers++;
        }
        
        // Cleanup expired matches
        const matchIds = await redis.sMembers(keys.matchList());
        const expiredMatches = [];
        
        if (matchIds.length > 0) {
            const pipeline = redis.multi();
            matchIds.forEach(matchId => {
                pipeline.get(keys.activeMatch(matchId));
            });
            
            const results = await pipeline.exec();
            
            matchIds.forEach((matchId, index) => {
                const matchData = results[index][1];
                if (matchData) {
                    const match = JSON.parse(matchData);
                    if (now - match.timestamp > MATCH_LIFETIME) {
                        expiredMatches.push(matchId);
                    }
                } else {
                    // Match data missing, remove from list
                    expiredMatches.push(matchId);
                }
            });
        }
        
        // Remove expired matches
        for (const matchId of expiredMatches) {
            await removeActiveMatch(matchId);
            cleanedMatches++;
        }
        
        // Capacity limit cleanup for waiting users
        const currentUserCount = await getWaitingUserCount();
        if (currentUserCount > MAX_WAITING_USERS) {
            const excess = currentUserCount - MAX_WAITING_USERS;
            const allUsers = await getAllWaitingUsers();
            
            // Sort by timestamp and remove oldest
            const sortedUsers = Array.from(allUsers.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp)
                .slice(0, excess);
            
            for (const [userId] of sortedUsers) {
                await removeWaitingUser(userId);
                cleanedUsers++;
            }
        }
        
        if (cleanedUsers > 0 || cleanedMatches > 0) {
            const remainingUsers = await getWaitingUserCount();
            const remainingMatches = (await redis.sCard(keys.matchList())) || 0;
            criticalLog('CLEANUP', `Removed ${cleanedUsers} users, ${cleanedMatches} matches. Active: ${remainingUsers} waiting, ${remainingMatches} matched`);
        }
    });
}

// ==========================================
// MAIN HANDLER FUNCTION
// ==========================================

export default async function handler(req) {
    // Run cleanup periodically
    await cleanup();
    
    if (req.method === 'OPTIONS') {
        return createCorsResponse(null, 200);
    }
    
    if (req.method === 'GET') {
        const url = new URL(req.url);
        const debug = url.searchParams.get('debug');
        
        if (debug === 'true') {
            const waitingCount = await getWaitingUserCount();
            const matchCount = await safeRedisOp(async (redis) => {
                return await redis.sCard(keys.matchList());
            }) || 0;
            
            return createCorsResponse({
                status: 'redis-optimized-webrtc-signaling',
                runtime: 'edge',
                redis: 'enabled',
                strategies: {
                    simple: `≤${SIMPLE_STRATEGY_THRESHOLD} users`,
                    hybrid: `${SIMPLE_STRATEGY_THRESHOLD + 1}-${HYBRID_STRATEGY_THRESHOLD} users`, 
                    optimized: `>${HYBRID_STRATEGY_THRESHOLD} users`
                },
                stats: {
                    waitingUsers: waitingCount,
                    activeMatches: matchCount,
                    cacheSize: distanceCache.size
                },
                timestamp: Date.now()
            });
        }
        
        const waitingCount = await getWaitingUserCount();
        const matchCount = await safeRedisOp(async (redis) => {
            return await redis.sCard(keys.matchList());
        }) || 0;
        
        const strategy = waitingCount <= SIMPLE_STRATEGY_THRESHOLD ? 'simple' : 
                        waitingCount <= HYBRID_STRATEGY_THRESHOLD ? 'hybrid' : 'optimized';
        
        return createCorsResponse({ 
            status: 'redis-optimized-signaling-ready',
            runtime: 'edge',
            redis: 'connected',
            stats: { 
                waiting: waitingCount, 
                matches: matchCount,
                strategy
            },
            message: 'Redis-optimized WebRTC signaling server ready',
            timestamp: Date.now()
        });
    }
    
    if (req.method !== 'POST') {
        return createCorsResponse({ error: 'POST required for signaling' }, 405);
    }
    
    try {
        // FLEXIBLE JSON PARSING
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

