// 🚀 VERCEL KV WebRTC Signaling Server (Based on Original)

import { kv } from '@vercel/kv';

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
// VERCEL KV STORAGE (Replacing in-memory)
// ==========================================

// KV Keys
const kvKeys = {
    waitingUsers: 'waiting_users',
    activeMatches: 'active_matches',
    timezoneIndex: (zone) => `tz_idx:${zone}`,
    genderIndex: (gender) => `gender_idx:${gender}`,
    freshUsers: 'fresh_users',
    lastIndexRebuild: 'last_index_rebuild'
};

// KV Utilities
async function getWaitingUsers() {
    try {
        const data = await kv.get(kvKeys.waitingUsers);
        return data ? new Map(Object.entries(data)) : new Map();
    } catch (error) {
        criticalLog('KV-ERROR', 'Failed to get waiting users:', error.message);
        return new Map();
    }
}

async function setWaitingUsers(waitingUsers) {
    try {
        const data = Object.fromEntries(waitingUsers);
        await kv.set(kvKeys.waitingUsers, data, { ex: 300 }); // 5 min TTL
        return true;
    } catch (error) {
        criticalLog('KV-ERROR', 'Failed to set waiting users:', error.message);
        return false;
    }
}

async function getActiveMatches() {
    try {
        const data = await kv.get(kvKeys.activeMatches);
        return data ? new Map(Object.entries(data)) : new Map();
    } catch (error) {
        criticalLog('KV-ERROR', 'Failed to get active matches:', error.message);
        return new Map();
    }
}

async function setActiveMatches(activeMatches) {
    try {
        const data = Object.fromEntries(activeMatches);
        await kv.set(kvKeys.activeMatches, data, { ex: 600 }); // 10 min TTL
        return true;
    } catch (error) {
        criticalLog('KV-ERROR', 'Failed to set active matches:', error.message);
        return false;
    }
}

async function getTimezoneIndex(zone) {
    try {
        const data = await kv.get(kvKeys.timezoneIndex(zone));
        return data ? new Set(data) : new Set();
    } catch (error) {
        return new Set();
    }
}

async function setTimezoneIndex(zone, userSet) {
    try {
        await kv.set(kvKeys.timezoneIndex(zone), Array.from(userSet), { ex: 120 });
        return true;
    } catch (error) {
        return false;
    }
}

async function getGenderIndex(gender) {
    try {
        const data = await kv.get(kvKeys.genderIndex(gender));
        return data ? new Set(data) : new Set();
    } catch (error) {
        return new Set();
    }
}

async function setGenderIndex(gender, userSet) {
    try {
        await kv.set(kvKeys.genderIndex(gender), Array.from(userSet), { ex: 120 });
        return true;
    } catch (error) {
        return false;
    }
}

async function getFreshUsers() {
    try {
        const data = await kv.get(kvKeys.freshUsers);
        return data ? new Set(data) : new Set();
    } catch (error) {
        return new Set();
    }
}

async function setFreshUsers(userSet) {
    try {
        await kv.set(kvKeys.freshUsers, Array.from(userSet), { ex: 60 });
        return true;
    } catch (error) {
        return false;
    }
}

// ==========================================
// OPTIMIZED GLOBAL STATE (Original logic)
// ==========================================

// 🔥 OPTIMIZATION: Pre-calculated distance cache (kept in memory for speed)
let distanceCache = new Map(); // "zone1,zone2" -> circularDistance
let timezoneScoreTable = new Array(25); // Pre-calculated scores 0-24
let genderScoreTable = new Map(); // Pre-calculated gender combinations

// 🔥 OPTIMIZATION: Object pools for memory optimization
let matchObjectPool = [];
let signalObjectPool = [];

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
// ADAPTIVE INDEX MANAGEMENT (Modified for KV)
// ==========================================

async function buildIndexesIfNeeded() {
    const now = Date.now();
    
    // Check if rebuild needed
    const lastRebuild = await kv.get(kvKeys.lastIndexRebuild) || 0;
    if (now - lastRebuild < INDEX_REBUILD_INTERVAL) {
        return; // Skip rebuild
    }
    
    const waitingUsers = await getWaitingUsers();
    
    // Quick rebuild only if small user count
    if (waitingUsers.size < 50) {
        await buildIndexes();
        return;
    }
}

async function buildIndexes() {
    const now = Date.now();
    const waitingUsers = await getWaitingUsers();
    
    // Clear and rebuild indexes
    let timezoneIndexes = new Map();
    let genderIndexes = new Map();
    let freshUsersSet = new Set();
    
    // Build new indexes in single pass
    for (const [userId, user] of waitingUsers.entries()) {
        // Timezone index
        const zone = user.chatZone;
        if (typeof zone === 'number') {
            if (!timezoneIndexes.has(zone)) {
                timezoneIndexes.set(zone, new Set());
            }
            timezoneIndexes.get(zone).add(userId);
        }
        
        // Gender index
        const gender = user.userInfo?.gender || 'Unspecified';
        if (!genderIndexes.has(gender)) {
            genderIndexes.set(gender, new Set());
        }
        genderIndexes.get(gender).add(userId);
        
        // Fresh users (< 30 seconds)
        if (now - user.timestamp < 30000) {
            freshUsersSet.add(userId);
        }
    }
    
    // Save indexes to KV
    for (const [zone, userSet] of timezoneIndexes.entries()) {
        await setTimezoneIndex(zone, userSet);
    }
    
    for (const [gender, userSet] of genderIndexes.entries()) {
        await setGenderIndex(gender, userSet);
    }
    
    await setFreshUsers(freshUsersSet);
    await kv.set(kvKeys.lastIndexRebuild, now, { ex: 600 });
    
    smartLog('INDEX-REBUILD', `Indexes built: ${timezoneIndexes.size} zones, ${genderIndexes.size} genders, ${freshUsersSet.size} fresh`);
}

// ==========================================
// MATCHING STRATEGIES (Original logic, KV data)
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

async function findUltraFastMatch(userId, userChatZone, userGender) {
    await buildIndexesIfNeeded();
    
    const now = Date.now();
    let bestMatch = null;
    let bestScore = 0;
    
    // Get fresh users list
    const freshUsers = await getFreshUsers();
    
    // 🔥 PRIORITY 1: Same timezone + fresh users (< 30s)
    if (typeof userChatZone === 'number') {
        const sameZoneCandidates = await getTimezoneIndex(userChatZone);
        const waitingUsers = await getWaitingUsers();
        
        for (const candidateId of sameZoneCandidates) {
            if (candidateId === userId) continue;
            
            const candidate = waitingUsers.get(candidateId);
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
    
    // If no good match found, fallback to simple search
    if (bestScore < 20) {
        return await findSimpleMatch(userId, userChatZone, userGender);
    }
    
    return bestMatch;
}

async function findHybridMatch(userId, userChatZone, userGender) {
    const waitingUsers = await getWaitingUsers();
    
    // If small user count, use simple approach (like old version)
    if (waitingUsers.size <= 20) {
        return await findSimpleMatch(userId, userChatZone, userGender);
    }
    
    // Otherwise use optimized approach
    return await findUltraFastMatch(userId, userChatZone, userGender);
}

// ==========================================
// ADAPTIVE INSTANT MATCH HANDLER (Modified for KV)
// ==========================================

async function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    // MINIMAL VALIDATION - NO chatZone validation to avoid 400 error
    if (!userId || typeof userId !== 'string') {
        return createCorsResponse({ error: 'userId is required and must be string' }, 400);
    }
    
    smartLog('INSTANT-MATCH', `${userId.slice(-8)} looking for partner (ChatZone: ${chatZone})`);
    
    // Remove from existing states
    const waitingUsers = await getWaitingUsers();
    const activeMatches = await getActiveMatches();
    
    if (waitingUsers.has(userId)) {
        waitingUsers.delete(userId);
        await setWaitingUsers(waitingUsers);
    }
    
    // Remove from active matches
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            activeMatches.delete(matchId);
            await setActiveMatches(activeMatches);
            break;
        }
    }
    
    // 🔧 ADAPTIVE MATCHING STRATEGY
    const userGender = gender || userInfo?.gender || 'Unspecified';
    
    let bestMatch;
    
    if (waitingUsers.size <= SIMPLE_STRATEGY_THRESHOLD) {
        // Very small pool - use simple linear search (fastest for small data)
        bestMatch = await findSimpleMatch(userId, chatZone, userGender);
        
    } else if (waitingUsers.size <= HYBRID_STRATEGY_THRESHOLD) {
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
        waitingUsers.delete(partnerId);
        await setWaitingUsers(waitingUsers);
        
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
        
        activeMatches.set(matchId, match);
        await setActiveMatches(activeMatches);
        
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
        
        waitingUsers.set(userId, waitingUser);
        await setWaitingUsers(waitingUsers);
        
        const position = waitingUsers.size;
        smartLog('INSTANT-MATCH', `${userId.slice(-8)} added to waiting list (position ${position})`);
        
        return createCorsResponse({
            status: 'waiting',
            position,
            waitingUsers: waitingUsers.size,
            chatZone: chatZone,
            userGender: userGender,
            message: 'Added to matching queue. Waiting for partner...',
            estimatedWaitTime: Math.min(waitingUsers.size * 2, 30),
            timestamp: Date.now()
        });
    }
}

// ==========================================
// OTHER HANDLERS (Modified for KV)
// ==========================================

async function handleGetSignals(userId, data) {
    const { chatZone, gender } = data;
    const activeMatches = await getActiveMatches();
    
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            const signals = match.signals[userId] || [];
            
            match.signals[userId] = [];
            await setActiveMatches(activeMatches);
            
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
    
    await setActiveMatches(activeMatches);
    
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
    
    const waitingUsers = await getWaitingUsers();
    if (waitingUsers.has(userId)) {
        waitingUsers.delete(userId);
        removed = true;
    }
    if (waitingUsers.has(partnerId)) {
        waitingUsers.delete(partnerId);
        removed = true;
    }
    if (removed) {
        await setWaitingUsers(waitingUsers);
    }
    
    const activeMatches = await getActiveMatches();
    activeMatches.delete(matchId);
    await setActiveMatches(activeMatches);
    
    return createCorsResponse({
        status: 'p2p_connected',
        removed,
        timestamp: Date.now()
    });
}

async function handleDisconnect(userId) {
    criticalLog('DISCONNECT', userId.slice(-8));
    
    let removed = false;
    
    const waitingUsers = await getWaitingUsers();
    if (waitingUsers.has(userId)) {
        waitingUsers.delete(userId);
        await setWaitingUsers(waitingUsers);
        removed = true;
    }
    
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
            activeMatches.delete(matchId);
            await setActiveMatches(activeMatches);
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
// OPTIMIZED CLEANUP (Modified for KV)
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
    
    expiredUsers.forEach(userId => {
        waitingUsers.delete(userId);
        cleanedUsers++;
    });
    
    if (cleanedUsers > 0) {
        await setWaitingUsers(waitingUsers);
    }
    
    // Cleanup active matches
    const activeMatches = await getActiveMatches();
    const expiredMatches = [];
    
    for (const [matchId, match] of activeMatches.entries()) {
        if (now - match.timestamp > MATCH_LIFETIME) {
            expiredMatches.push(matchId);
        }
    }
    
    expiredMatches.forEach(matchId => {
        activeMatches.delete(matchId);
        cleanedMatches++;
    });
    
    if (cleanedMatches > 0) {
        await setActiveMatches(activeMatches);
    }
    
    // Capacity limit cleanup
    if (waitingUsers.size > MAX_WAITING_USERS) {
        const excess = waitingUsers.size - MAX_WAITING_USERS;
        const oldestUsers = Array.from(waitingUsers.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp)
            .slice(0, excess)
            .map(entry => entry[0]);
        
        oldestUsers.forEach(userId => {
            waitingUsers.delete(userId);
            cleanedUsers++;
        });
        
        await setWaitingUsers(waitingUsers);
    }
    
    if (cleanedUsers > 0 || cleanedMatches > 0) {
        criticalLog('CLEANUP', `Removed ${cleanedUsers} users, ${cleanedMatches} matches. Active: ${waitingUsers.size} waiting, ${activeMatches.size} matched`);
    }
}

// ==========================================
// MAIN HANDLER FUNCTION (Original with KV)
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
                status: 'vercel-kv-webrtc-signaling',
                runtime: 'edge',
                storage: 'vercel-kv',
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
            status: 'vercel-kv-signaling-ready',
            runtime: 'edge',
            storage: 'vercel-kv',
            stats: { 
                waiting: waitingUsers.size, 
                matches: activeMatches.size,
                strategy: waitingUsers.size <= SIMPLE_STRATEGY_THRESHOLD ? 'simple' : 
                         waitingUsers.size <= HYBRID_STRATEGY_THRESHOLD ? 'hybrid' : 'optimized'
            },
            message: 'Vercel KV WebRTC signaling server ready',
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

export const config = { runtime: 'edge' };
