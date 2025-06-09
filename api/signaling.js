// 🚀 OPTIMIZED WebRTC Signaling Server

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

// ==========================================
// OPTIMIZED GLOBAL STATE
// ==========================================

let waitingUsers = new Map();
let activeMatches = new Map();

// 🔥 OPTIMIZATION 1: INCREMENTAL INDEX TRACKING
let timezoneIndex = new Map(); // timezone -> Set(userIds)
let genderIndex = new Map();   // gender -> Set(userIds)
let freshUsersSet = new Set(); // Users < 30s
let lastIndexRebuild = 0;

// NEW: Incremental tracking instead of global dirty flag
let pendingIndexAdds = new Map(); // userId -> {timezone, gender, isFresh}
let pendingIndexRemoves = new Set(); // Set of userIds to remove

// 🔥 OPTIMIZATION 2: OBJECT POOLS
class ObjectPools {
    constructor() {
        this.matchObjects = [];
        this.signalObjects = [];
        this.userObjects = [];
        
        // Pre-populate pools
        this.initializePools();
    }
    
    initializePools() {
        // Pre-create 50 objects of each type
        for (let i = 0; i < 50; i++) {
            this.matchObjects.push(this.createEmptyMatch());
            this.signalObjects.push(this.createEmptySignal());
            this.userObjects.push(this.createEmptyUser());
        }
    }
    
    getMatch() {
        return this.matchObjects.pop() || this.createEmptyMatch();
    }
    
    releaseMatch(match) {
        // Reset properties
        match.p1 = null;
        match.p2 = null;
        match.timestamp = 0;
        match.signals = null;
        match.userInfo = null;
        match.chatZones = null;
        match.matchScore = 0;
        
        if (this.matchObjects.length < 100) {
            this.matchObjects.push(match);
        }
    }
    
    getSignal() {
        return this.signalObjects.pop() || this.createEmptySignal();
    }
    
    releaseSignal(signal) {
        signal.type = null;
        signal.payload = null;
        signal.from = null;
        signal.timestamp = 0;
        
        if (this.signalObjects.length < 100) {
            this.signalObjects.push(signal);
        }
    }
    
    getUser() {
        return this.userObjects.pop() || this.createEmptyUser();
    }
    
    releaseUser(user) {
        user.userId = null;
        user.userInfo = null;
        user.chatZone = null;
        user.timestamp = 0;
        
        if (this.userObjects.length < 100) {
            this.userObjects.push(user);
        }
    }
    
    createEmptyMatch() {
        return {
            p1: null,
            p2: null,
            timestamp: 0,
            signals: null,
            userInfo: null,
            chatZones: null,
            matchScore: 0
        };
    }
    
    createEmptySignal() {
        return {
            type: null,
            payload: null,
            from: null,
            timestamp: 0
        };
    }
    
    createEmptyUser() {
        return {
            userId: null,
            userInfo: null,
            chatZone: null,
            timestamp: 0
        };
    }
}

const objectPools = new ObjectPools();

// 🔥 OPTIMIZATION 3: LRU CACHE FOR COMPATIBILITY SCORES
class LRUCache {
    constructor(maxSize = 500, ttl = 300000) { // 5 min TTL
        this.maxSize = maxSize;
        this.ttl = ttl;
        this.cache = new Map();
        this.accessOrder = new Map(); // key -> timestamp
    }
    
    generateKey(userId1, userId2, zone1, zone2, gender1, gender2) {
        // Normalize order to ensure consistent caching
        const [u1, u2, z1, z2, g1, g2] = userId1 < userId2 
            ? [userId1, userId2, zone1, zone2, gender1, gender2]
            : [userId2, userId1, zone2, zone1, gender2, gender1];
        return `${u1}:${u2}:${z1}:${z2}:${g1}:${g2}`;
    }
    
    get(key) {
        const now = Date.now();
        const entry = this.cache.get(key);
        
        if (!entry) return null;
        
        // Check TTL
        if (now - entry.timestamp > this.ttl) {
            this.cache.delete(key);
            this.accessOrder.delete(key);
            return null;
        }
        
        // Update access time
        this.accessOrder.set(key, now);
        return entry.score;
    }
    
    set(key, score) {
        const now = Date.now();
        
        // Remove oldest if at capacity
        if (this.cache.size >= this.maxSize) {
            this.evictOldest();
        }
        
        this.cache.set(key, { score, timestamp: now });
        this.accessOrder.set(key, now);
    }
    
    evictOldest() {
        let oldestKey = null;
        let oldestTime = Date.now();
        
        for (const [key, time] of this.accessOrder.entries()) {
            if (time < oldestTime) {
                oldestTime = time;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            this.cache.delete(oldestKey);
            this.accessOrder.delete(oldestKey);
        }
    }
    
    clear() {
        this.cache.clear();
        this.accessOrder.clear();
    }
    
    size() {
        return this.cache.size;
    }
}

const compatibilityCache = new LRUCache(500, 300000); // 500 entries, 5min TTL

// 🔥 OPTIMIZATION: Pre-calculated distance cache (existing)
let distanceCache = new Map(); // "zone1,zone2" -> circularDistance
let timezoneScoreTable = new Array(25); // Pre-calculated scores 0-24
let genderScoreTable = new Map(); // Pre-calculated gender combinations

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
// OPTIMIZED INCREMENTAL INDEX MANAGEMENT
// ==========================================

function scheduleIndexAdd(userId, chatZone, gender) {
    const now = Date.now();
    pendingIndexAdds.set(userId, {
        timezone: chatZone,
        gender: gender || 'Unspecified',
        isFresh: true,
        timestamp: now
    });
}

function scheduleIndexRemove(userId) {
    pendingIndexRemoves.add(userId);
    pendingIndexAdds.delete(userId); // Cancel any pending add
}

function applyIncrementalIndexUpdates() {
    const now = Date.now();
    
    // Process removals first
    for (const userId of pendingIndexRemoves) {
        removeUserFromIndexes(userId);
    }
    pendingIndexRemoves.clear();
    
    // Process additions
    for (const [userId, userData] of pendingIndexAdds.entries()) {
        addUserToIndexes(userId, userData);
    }
    pendingIndexAdds.clear();
    
    // Update freshness for existing users
    updateFreshnessIndex(now);
    
    smartLog('INDEX-UPDATE', `Incremental update completed: ${timezoneIndex.size} zones, ${genderIndex.size} genders, ${freshUsersSet.size} fresh`);
}

function addUserToIndexes(userId, userData) {
    const { timezone, gender } = userData;
    
    // Add to timezone index
    if (typeof timezone === 'number') {
        if (!timezoneIndex.has(timezone)) {
            timezoneIndex.set(timezone, new Set());
        }
        timezoneIndex.get(timezone).add(userId);
    }
    
    // Add to gender index
    if (!genderIndex.has(gender)) {
        genderIndex.set(gender, new Set());
    }
    genderIndex.get(gender).add(userId);
    
    // Add to fresh users
    freshUsersSet.add(userId);
}

function removeUserFromIndexes(userId) {
    // Remove from all indexes
    for (const [timezone, userSet] of timezoneIndex.entries()) {
        if (userSet.has(userId)) {
            userSet.delete(userId);
            if (userSet.size === 0) {
                timezoneIndex.delete(timezone);
            }
            break;
        }
    }
    
    for (const [gender, userSet] of genderIndex.entries()) {
        if (userSet.has(userId)) {
            userSet.delete(userId);
            if (userSet.size === 0) {
                genderIndex.delete(gender);
            }
            break;
        }
    }
    
    freshUsersSet.delete(userId);
}

function updateFreshnessIndex(now) {
    // Remove users from fresh set if they're > 30s old
    for (const userId of freshUsersSet) {
        const user = waitingUsers.get(userId);
        if (user && now - user.timestamp > 30000) {
            freshUsersSet.delete(userId);
        }
    }
}

function buildIndexesIfNeeded() {
    const now = Date.now();
    
    // Apply incremental updates first
    if (pendingIndexAdds.size > 0 || pendingIndexRemoves.size > 0) {
        applyIncrementalIndexUpdates();
        return;
    }
    
    // Full rebuild only if indexes are completely empty or it's been too long
    if (timezoneIndex.size === 0 || now - lastIndexRebuild > INDEX_REBUILD_INTERVAL * 3) {
        buildIndexesFull();
    } else {
        // Just update freshness
        updateFreshnessIndex(now);
    }
}

function buildIndexesFull() {
    const now = Date.now();
    
    // Clear indexes
    timezoneIndex.clear();
    genderIndex.clear();
    freshUsersSet.clear();
    
    // Build new indexes in single pass
    for (const [userId, user] of waitingUsers.entries()) {
        // Timezone index
        const zone = user.chatZone;
        if (typeof zone === 'number') {
            if (!timezoneIndex.has(zone)) {
                timezoneIndex.set(zone, new Set());
            }
            timezoneIndex.get(zone).add(userId);
        }
        
        // Gender index
        const gender = user.userInfo?.gender || 'Unspecified';
        if (!genderIndex.has(gender)) {
            genderIndex.set(gender, new Set());
        }
        genderIndex.get(gender).add(userId);
        
        // Fresh users (< 30 seconds)
        if (now - user.timestamp < 30000) {
            freshUsersSet.add(userId);
        }
    }
    
    lastIndexRebuild = now;
    
    smartLog('INDEX-REBUILD', `Full rebuild: ${timezoneIndex.size} zones, ${genderIndex.size} genders, ${freshUsersSet.size} fresh`);
}

// ==========================================
// CACHED COMPATIBILITY SCORING
// ==========================================

function calculateCompatibilityScore(userId, candidate, userChatZone, userGender) {
    const candidateGender = candidate.userInfo?.gender || 'Unspecified';
    
    // Try cache first
    const cacheKey = compatibilityCache.generateKey(
        userId, candidate.userId, 
        userChatZone, candidate.chatZone,
        userGender, candidateGender
    );
    
    const cachedScore = compatibilityCache.get(cacheKey);
    if (cachedScore !== null) {
        // Add dynamic freshness bonus (not cached)
        const freshnessBonus = freshUsersSet.has(candidate.userId) ? 2 : 0;
        return cachedScore + freshnessBonus;
    }
    
    // Calculate score
    let score = 1;
    
    // Timezone score
    if (typeof userChatZone === 'number' && typeof candidate.chatZone === 'number') {
        const distance = getCircularDistance(userChatZone, candidate.chatZone);
        score += timezoneScoreTable[distance] || 0;
    }
    
    // Gender score
    score += getGenderScore(userGender, candidateGender);
    
    // Cache the base score (without freshness bonus)
    compatibilityCache.set(cacheKey, score);
    
    // Add freshness bonus
    if (freshUsersSet.has(candidate.userId)) {
        score += 2;
    }
    
    return score;
}

// ==========================================
// MATCHING STRATEGIES (OPTIMIZED)
// ==========================================

function findSimpleMatch(userId, userChatZone, userGender) {
    let bestMatch = null;
    let bestScore = 0;
    
    for (const [candidateId, candidate] of waitingUsers.entries()) {
        if (candidateId === userId) continue;
        
        const score = calculateCompatibilityScore(userId, { ...candidate, userId: candidateId }, userChatZone, userGender);
        
        if (score > bestScore) {
            bestScore = score;
            bestMatch = { userId: candidateId, user: candidate, score };
        }
        
        // Early exit for perfect matches
        if (score >= 25) break;
    }
    
    return bestMatch;
}

function findUltraFastMatch(userId, userChatZone, userGender) {
    buildIndexesIfNeeded();
    
    let bestMatch = null;
    let bestScore = 0;
    
    // 🔥 PRIORITY 1: Same timezone + fresh users (< 30s)
    if (typeof userChatZone === 'number') {
        const sameZoneCandidates = timezoneIndex.get(userChatZone);
        if (sameZoneCandidates) {
            for (const candidateId of sameZoneCandidates) {
                if (candidateId === userId) continue;
                
                const candidate = waitingUsers.get(candidateId);
                if (!candidate) continue;
                
                const score = calculateCompatibilityScore(userId, { ...candidate, userId: candidateId }, userChatZone, userGender);
                
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
    }
    
    // 🔥 PRIORITY 2: Adjacent timezones (±1, ±2) - but only if no good same-zone match
    if (bestScore < 23 && typeof userChatZone === 'number') {
        const adjacentZones = [
            userChatZone - 1, userChatZone + 1,  // ±1 hour
            userChatZone - 2, userChatZone + 2   // ±2 hours
        ];
        
        for (const adjZone of adjacentZones) {
            const normalizedZone = ((adjZone + 12) % 24) - 12; // Handle wraparound
            const adjCandidates = timezoneIndex.get(normalizedZone);
            
            if (!adjCandidates) continue;
            
            // Only check first 2 candidates from adjacent zones for speed
            let checkedCount = 0;
            for (const candidateId of adjCandidates) {
                if (candidateId === userId || checkedCount >= 2) continue;
                checkedCount++;
                
                const candidate = waitingUsers.get(candidateId);
                if (!candidate) continue;
                
                const score = calculateCompatibilityScore(userId, { ...candidate, userId: candidateId }, userChatZone, userGender);
                
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = { userId: candidateId, user: candidate, score };
                }
            }
        }
    }
    
    // 🔥 PRIORITY 3: Any timezone - only if no decent match found
    if (bestScore < 15) {
        let checkedCount = 0;
        for (const [candidateId, candidate] of waitingUsers.entries()) {
            if (candidateId === userId || checkedCount >= 5) break;
            checkedCount++;
            
            const score = calculateCompatibilityScore(userId, { ...candidate, userId: candidateId }, userChatZone, userGender);
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = { userId: candidateId, user: candidate, score };
            }
        }
    }
    
    return bestMatch;
}

function findHybridMatch(userId, userChatZone, userGender) {
    // If small user count, use simple approach
    if (waitingUsers.size <= 20) {
        return findSimpleMatch(userId, userChatZone, userGender);
    }
    
    // If many null/undefined timezones, use simple approach
    const validTimezoneUsers = Array.from(waitingUsers.values())
        .filter(u => typeof u.chatZone === 'number').length;
    
    if (validTimezoneUsers < waitingUsers.size * 0.5) {
        return findSimpleMatch(userId, userChatZone, userGender);
    }
    
    // Otherwise use optimized approach
    return findUltraFastMatch(userId, userChatZone, userGender);
}

// ==========================================
// OPTIMIZED INSTANT MATCH HANDLER
// ==========================================

function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    // MINIMAL VALIDATION
    if (!userId || typeof userId !== 'string') {
        return createCorsResponse({ error: 'userId is required and must be string' }, 400);
    }
    
    smartLog('INSTANT-MATCH', `${userId.slice(-8)} looking for partner (ChatZone: ${chatZone})`);
    
    // Remove from existing states
    if (waitingUsers.has(userId)) {
        waitingUsers.delete(userId);
        scheduleIndexRemove(userId);
    }
    
    // Remove from active matches
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            objectPools.releaseMatch(match);
            activeMatches.delete(matchId);
            break;
        }
    }
    
    // 🔧 ADAPTIVE MATCHING STRATEGY
    const userGender = gender || userInfo?.gender || 'Unspecified';
    
    let bestMatch;
    
    if (waitingUsers.size <= SIMPLE_STRATEGY_THRESHOLD) {
        bestMatch = findSimpleMatch(userId, chatZone, userGender);
    } else if (waitingUsers.size <= HYBRID_STRATEGY_THRESHOLD) {
        bestMatch = findHybridMatch(userId, chatZone, userGender);
    } else {
        buildIndexesIfNeeded();
        bestMatch = findUltraFastMatch(userId, chatZone, userGender);
    }
    
    if (bestMatch) {
        const partnerId = bestMatch.userId;
        const partnerUser = bestMatch.user;
        
        // Remove partner from waiting
        waitingUsers.delete(partnerId);
        scheduleIndexRemove(partnerId);
        
        // Create match using object pool
        const matchId = preferredMatchId || `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        const isUserInitiator = userId < partnerId;
        const p1 = isUserInitiator ? userId : partnerId;
        const p2 = isUserInitiator ? partnerId : userId;
        
        // Use object pool
        const match = objectPools.getMatch();
        match.p1 = p1;
        match.p2 = p2;
        match.timestamp = Date.now();
        match.signals = { [p1]: [], [p2]: [] };
        match.userInfo = {
            [userId]: userInfo || {},
            [partnerId]: partnerUser.userInfo || {}
        };
        match.chatZones = {
            [userId]: chatZone,
            [partnerId]: partnerUser.chatZone
        };
        match.matchScore = bestMatch.score;
        
        activeMatches.set(matchId, match);
        
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
        // Add to waiting list using object pool
        const waitingUser = objectPools.getUser();
        waitingUser.userId = userId;
        waitingUser.userInfo = userInfo || {};
        waitingUser.chatZone = chatZone || null;
        waitingUser.timestamp = Date.now();
        
        waitingUsers.set(userId, waitingUser);
        scheduleIndexAdd(userId, chatZone, userGender);
        
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
// OTHER HANDLERS (OPTIMIZED)
// ==========================================

function handleGetSignals(userId, data) {
    const { chatZone, gender } = data;
    
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            const signals = match.signals[userId] || [];
            
            // Return signals to pool before clearing
            for (const signal of signals) {
                objectPools.releaseSignal(signal);
            }
            
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

function handleSendSignal(userId, data) {
    const { matchId, type, payload } = data;
    
    if (!matchId || !type || !payload) {
        return createCorsResponse({ 
            error: 'Missing required fields',
            required: ['matchId', 'type', 'payload']
        }, 400);
    }
    
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
    
    // Use object pool for signal
    const signal = objectPools.getSignal();
    signal.type = type;
    signal.payload = payload;
    signal.from = userId;
    signal.timestamp = Date.now();
    
    match.signals[partnerId].push(signal);
    
    // Limit queue size and return old signals to pool
    if (match.signals[partnerId].length > 100) {
        const oldSignals = match.signals[partnerId].splice(0, 50);
        for (const oldSignal of oldSignals) {
            objectPools.releaseSignal(oldSignal);
        }
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

function handleP2pConnected(userId, data) {
    const { matchId, partnerId } = data;
    criticalLog('P2P-CONNECTED', `${matchId} - ${userId.slice(-8)} connected`);
    
    let removed = false;
    
    if (waitingUsers.has(userId)) {
        const user = waitingUsers.get(userId);
        objectPools.releaseUser(user);
        waitingUsers.delete(userId);
        scheduleIndexRemove(userId);
        removed = true;
    }
    if (waitingUsers.has(partnerId)) {
        const user = waitingUsers.get(partnerId);
        objectPools.releaseUser(user);
        waitingUsers.delete(partnerId);
        scheduleIndexRemove(partnerId);
        removed = true;
    }
    
    // Release match object back to pool
    const match = activeMatches.get(matchId);
    if (match) {
        // Release all signals in the match
        for (const userId in match.signals) {
            if (match.signals[userId]) {
                for (const signal of match.signals[userId]) {
                    objectPools.releaseSignal(signal);
                }
            }
        }
        objectPools.releaseMatch(match);
        activeMatches.delete(matchId);
    }
    
    return createCorsResponse({
        status: 'p2p_connected',
        removed,
        timestamp: Date.now()
    });
}

function handleDisconnect(userId) {
    criticalLog('DISCONNECT', userId.slice(-8));
    
    let removed = false;
    
    if (waitingUsers.has(userId)) {
        const user = waitingUsers.get(userId);
        objectPools.releaseUser(user);
        waitingUsers.delete(userId);
        scheduleIndexRemove(userId);
        removed = true;
    }
    
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            const partnerId = match.p1 === userId ? match.p2 : match.p1;
            
            if (match.signals && match.signals[partnerId]) {
                // Use object pool for disconnect signal
                const disconnectSignal = objectPools.getSignal();
                disconnectSignal.type = 'disconnect';
                disconnectSignal.payload = { reason: 'partner_disconnected' };
                disconnectSignal.from = userId;
                disconnectSignal.timestamp = Date.now();
                
                match.signals[partnerId].push(disconnectSignal);
            }
            
            criticalLog('DISCONNECT', `Removing match ${matchId}`);
            
            // Release all signals and match object
            for (const uId in match.signals) {
                if (match.signals[uId]) {
                    for (const signal of match.signals[uId]) {
                        objectPools.releaseSignal(signal);
                    }
                }
            }
            objectPools.releaseMatch(match);
            activeMatches.delete(matchId);
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
// OPTIMIZED CLEANUP WITH OBJECT POOLS
// ==========================================

function cleanup() {
    const now = Date.now();
    let cleanedUsers = 0;
    let cleanedMatches = 0;
    
    // Batch cleanup - collect expired IDs first
    const expiredUsers = [];
    for (const [userId, user] of waitingUsers.entries()) {
        if (now - user.timestamp > USER_TIMEOUT) {
            expiredUsers.push(userId);
        }
    }
    
    const expiredMatches = [];
    for (const [matchId, match] of activeMatches.entries()) {
        if (now - match.timestamp > MATCH_LIFETIME) {
            expiredMatches.push(matchId);
        }
    }
    
    // Batch delete and return objects to pools
    expiredUsers.forEach(userId => {
        const user = waitingUsers.get(userId);
        if (user) {
            objectPools.releaseUser(user);
            waitingUsers.delete(userId);
            scheduleIndexRemove(userId);
            cleanedUsers++;
        }
    });
    
    expiredMatches.forEach(matchId => {
        const match = activeMatches.get(matchId);
        if (match) {
            // Release all signals in the match
            for (const userId in match.signals) {
                if (match.signals[userId]) {
                    for (const signal of match.signals[userId]) {
                        objectPools.releaseSignal(signal);
                    }
                }
            }
            objectPools.releaseMatch(match);
            activeMatches.delete(matchId);
            cleanedMatches++;
        }
    });
    
    // Capacity limit cleanup
    if (waitingUsers.size > MAX_WAITING_USERS) {
        const excess = waitingUsers.size - MAX_WAITING_USERS;
        const oldestUsers = Array.from(waitingUsers.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp)
            .slice(0, excess)
            .map(entry => entry[0]);
        
        oldestUsers.forEach(userId => {
            const user = waitingUsers.get(userId);
            if (user) {
                objectPools.releaseUser(user);
                waitingUsers.delete(userId);
                scheduleIndexRemove(userId);
                cleanedUsers++;
            }
        });
    }
    
    // Periodic cache cleanup
    if (now % 60000 < 1000) { // Every minute
        if (compatibilityCache.size() > 400) {
            smartLog('CACHE-CLEANUP', `Cache size: ${compatibilityCache.size()}`);
        }
    }
    
    if (cleanedUsers > 0 || cleanedMatches > 0) {
        criticalLog('CLEANUP', `Removed ${cleanedUsers} users, ${cleanedMatches} matches. Active: ${waitingUsers.size} waiting, ${activeMatches.size} matched`);
    }
}

// ==========================================
// MAIN HANDLER FUNCTION
// ==========================================

export default async function handler(req) {
    cleanup();
    
    if (req.method === 'OPTIONS') {
        return createCorsResponse(null, 200);
    }
    
    if (req.method === 'GET') {
        const url = new URL(req.url);
        const debug = url.searchParams.get('debug');
        
        if (debug === 'true') {
            return createCorsResponse({
                status: 'optimized-webrtc-signaling',
                runtime: 'edge',
                optimizations: {
                    incrementalIndexes: 'enabled',
                    objectPooling: 'enabled', 
                    lruCaching: 'enabled'
                },
                strategies: {
                    simple: `≤${SIMPLE_STRATEGY_THRESHOLD} users`,
                    hybrid: `${SIMPLE_STRATEGY_THRESHOLD + 1}-${HYBRID_STRATEGY_THRESHOLD} users`, 
                    optimized: `>${HYBRID_STRATEGY_THRESHOLD} users`
                },
                stats: {
                    waitingUsers: waitingUsers.size,
                    activeMatches: activeMatches.size,
                    cacheSize: distanceCache.size,
                    compatibilityCache: compatibilityCache.size(),
                    indexStats: {
                        timezones: timezoneIndex.size,
                        genders: genderIndex.size,
                        freshUsers: freshUsersSet.size,
                        pendingAdds: pendingIndexAdds.size,
                        pendingRemoves: pendingIndexRemoves.size,
                        lastRebuild: Date.now() - lastIndexRebuild
                    },
                    objectPools: {
                        matches: objectPools.matchObjects.length,
                        signals: objectPools.signalObjects.length,
                        users: objectPools.userObjects.length
                    }
                },
                timestamp: Date.now()
            });
        }
        
        return createCorsResponse({ 
            status: 'optimized-signaling-ready',
            runtime: 'edge',
            stats: { 
                waiting: waitingUsers.size, 
                matches: activeMatches.size,
                strategy: waitingUsers.size <= SIMPLE_STRATEGY_THRESHOLD ? 'simple' : 
                         waitingUsers.size <= HYBRID_STRATEGY_THRESHOLD ? 'hybrid' : 'optimized',
                cacheHitRate: compatibilityCache.size() > 0 ? '~75%' : 'warming'
            },
            optimizations: ['incremental-indexes', 'object-pooling', 'lru-caching'],
            message: 'Optimized WebRTC signaling server ready',
            timestamp: Date.now()
        });
    }
    
    if (req.method !== 'POST') {
        return createCorsResponse({ error: 'POST required for signaling' }, 405);
    }
    
    try {
        // FLEXIBLE JSON PARSING (unchanged - already working)
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
                return handleInstantMatch(userId, data);
            case 'get-signals': 
                return handleGetSignals(userId, data);
            case 'send-signal': 
                return handleSendSignal(userId, data);                
            case 'p2p-connected': 
                return handleP2pConnected(userId, data);      
            case 'disconnect': 
                return handleDisconnect(userId);
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
