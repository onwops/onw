// 🚀 IMPROVED WebRTC Signaling Server - Fixed Architecture

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
const ADAPTIVE_THRESHOLD = 50; // Switch to indexed matching

// ==========================================
// OPTIMIZED GLOBAL STATE
// ==========================================

let waitingUsers = new Map();
let activeMatches = new Map();

// 🔥 OPTIMIZATION: Multiple indexed data structures
let timezoneIndex = new Map(); // timezone -> Set(userIds)
let genderIndex = new Map();   // gender -> Set(userIds)
let freshUsersSet = new Set(); // Users < 30s

// 🔥 OPTIMIZATION: Pre-calculated distance cache
let distanceCache = new Map(); // "zone1,zone2" -> circularDistance
let timezoneScoreTable = new Array(25); // Pre-calculated scores 0-24
let genderScoreTable = new Map(); // Pre-calculated gender combinations

// 🔒 RACE CONDITION PROTECTION
let matchingInProgress = new Set(); // Track users currently being matched

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
// IMPROVED INDEX MANAGEMENT - Real-time Updates
// ==========================================

function addUserToIndexes(userId, user) {
    // Timezone index
    if (typeof user.chatZone === 'number') {
        if (!timezoneIndex.has(user.chatZone)) {
            timezoneIndex.set(user.chatZone, new Set());
        }
        timezoneIndex.get(user.chatZone).add(userId);
    }
    
    // Gender index
    const gender = user.userInfo?.gender || 'Unspecified';
    if (!genderIndex.has(gender)) {
        genderIndex.set(gender, new Set());
    }
    genderIndex.get(gender).add(userId);
    
    // Fresh users (< 30 seconds)
    const now = Date.now();
    if (now - user.timestamp < 30000) {
        freshUsersSet.add(userId);
    }
}

function removeUserFromIndexes(userId, user) {
    // Remove from timezone index
    if (typeof user.chatZone === 'number') {
        const zoneSet = timezoneIndex.get(user.chatZone);
        if (zoneSet) {
            zoneSet.delete(userId);
            if (zoneSet.size === 0) {
                timezoneIndex.delete(user.chatZone);
            }
        }
    }
    
    // Remove from gender index
    const gender = user.userInfo?.gender || 'Unspecified';
    const genderSet = genderIndex.get(gender);
    if (genderSet) {
        genderSet.delete(userId);
        if (genderSet.size === 0) {
            genderIndex.delete(gender);
        }
    }
    
    // Remove from fresh set
    freshUsersSet.delete(userId);
}

function addWaitingUser(userId, userData) {
    waitingUsers.set(userId, userData);
    addUserToIndexes(userId, userData);
}

function removeWaitingUser(userId) {
    const userData = waitingUsers.get(userId);
    if (userData) {
        waitingUsers.delete(userId);
        removeUserFromIndexes(userId, userData);
        return userData;
    }
    return null;
}

// ==========================================
// SIMPLIFIED MATCHING STRATEGIES
// ==========================================

function findWithLinearScan(userId, userChatZone, userGender) {
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

function findWithIndexes(userId, userChatZone, userGender) {
    const now = Date.now();
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
                
                let score = 21; // Base score for same timezone (20 + 1)
                
                // Gender bonus
                const candidateGender = candidate.userInfo?.gender || 'Unspecified';
                score += getGenderScore(userGender, candidateGender);
                
                // Fresh user mega bonus
                if (freshUsersSet.has(candidateId)) {
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
                
                let score = 1 + getTimezoneScore(userChatZone, normalizedZone);
                
                // Gender bonus
                const candidateGender = candidate.userInfo?.gender || 'Unspecified';
                score += getGenderScore(userGender, candidateGender);
                
                // Fresh bonus
                if (freshUsersSet.has(candidateId)) {
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
        let checkedCount = 0;
        for (const [candidateId, candidate] of waitingUsers.entries()) {
            if (candidateId === userId || checkedCount >= 5) break;
            checkedCount++;
            
            let score = 1 + getTimezoneScore(userChatZone, candidate.chatZone);
            
            const candidateGender = candidate.userInfo?.gender || 'Unspecified';
            score += getGenderScore(userGender, candidateGender);
            
            if (freshUsersSet.has(candidateId)) {
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

// ==========================================
// UNIFIED MATCHING FUNCTION
// ==========================================

function findBestMatch(userId, userChatZone, userGender) {
    try {
        // Use indexes for larger user pools
        if (waitingUsers.size > ADAPTIVE_THRESHOLD) {
            return findWithIndexes(userId, userChatZone, userGender);
        }
    } catch (indexError) {
        // Graceful degradation if indexes fail
        smartLog('FALLBACK', 'Index matching failed, using linear scan');
    }
    
    // Always have fallback to linear scan
    return findWithLinearScan(userId, userChatZone, userGender);
}

// ==========================================
// RACE-CONDITION SAFE MATCHING
// ==========================================

function performMatching(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    const userGender = gender || userInfo?.gender || 'Unspecified';
    
    // Double-check and cleanup user from waiting state
    removeWaitingUser(userId);
    
    // Remove from active matches if exists
    for (const [matchId, match] of activeMatches.entries()) {
        if (match.p1 === userId || match.p2 === userId) {
            activeMatches.delete(matchId);
            break;
        }
    }
    
    // Find best match
    const bestMatch = findBestMatch(userId, chatZone, userGender);
    
    if (bestMatch) {
        const partnerId = bestMatch.userId;
        const partnerUser = bestMatch.user;
        
        // Atomic partner removal with validation
        const removedPartner = removeWaitingUser(partnerId);
        if (!removedPartner) {
            // Partner was already matched by another request
            // Restore current user to waiting list
            const waitingUser = {
                userId,
                userInfo: userInfo || {},
                chatZone: chatZone || null,
                timestamp: Date.now()
            };
            addWaitingUser(userId, waitingUser);
            
            smartLog('RACE-AVOIDED', `${userId.slice(-8)} - partner ${partnerId.slice(-8)} already taken`);
            return { retry: true };
        }
        
        // Create match
        const matchId = preferredMatchId || `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        const isUserInitiator = userId < partnerId;
        const p1 = isUserInitiator ? userId : partnerId;
        const p2 = isUserInitiator ? partnerId : userId;
        
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
        
        criticalLog('MATCH-SUCCESS', `🚀 ${userId.slice(-8)} <-> ${partnerId.slice(-8)} (${matchId}) | Score: ${bestMatch.score}`);
        
        return {
            success: true,
            response: createCorsResponse({
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
        
        addWaitingUser(userId, waitingUser);
        
        const position = waitingUsers.size;
        smartLog('WAIT-ADDED', `${userId.slice(-8)} added to waiting list (position ${position})`);
        
        return {
            success: true,
            response: createCorsResponse({
                status: 'waiting',
                position,
                waitingUsers: waitingUsers.size,
                chatZone: chatZone,
                userGender: userGender,
                message: 'Added to matching queue. Waiting for partner...',
                estimatedWaitTime: Math.min(waitingUsers.size * 2, 30),
                timestamp: Date.now()
            })
        };
    }
}

function handleInstantMatch(userId, data) {
    // MINIMAL VALIDATION
    if (!userId || typeof userId !== 'string') {
        return createCorsResponse({ error: 'userId is required and must be string' }, 400);
    }
    
    // 🔒 RACE CONDITION PROTECTION
    if (matchingInProgress.has(userId)) {
        return createCorsResponse({ 
            status: 'already_matching',
            message: 'Match request already in progress' 
        });
    }
    
    // Add to lock set
    matchingInProgress.add(userId);
    
    try {
        smartLog('INSTANT-MATCH', `${userId.slice(-8)} looking for partner (ChatZone: ${data.chatZone})`);
        
        // Perform matching in critical section
        const result = performMatching(userId, data);
        
        // Handle retry case (race condition detected)
        if (result.retry) {
            // Try again immediately
            const retryResult = performMatching(userId, data);
            return retryResult.response;
        }
        
        return result.response;
        
    } finally {
        // Always cleanup lock
        matchingInProgress.delete(userId);
    }
}

// ==========================================
// OTHER HANDLERS (SAME AS BEFORE)
// ==========================================

function handleGetSignals(userId, data) {
    const { chatZone, gender } = data;
    
    for (const [matchId, match] of activeMatches.entries()) {
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
    
    // Safe removal with validation
    if (removeWaitingUser(userId)) {
        removed = true;
    }
    if (removeWaitingUser(partnerId)) {
        removed = true;
    }
    
    activeMatches.delete(matchId);
    
    return createCorsResponse({
        status: 'p2p_connected',
        removed,
        timestamp: Date.now()
    });
}

function handleDisconnect(userId) {
    criticalLog('DISCONNECT', userId.slice(-8));
    
    let removed = false;
    
    // Safe removal from waiting list
    if (removeWaitingUser(userId)) {
        removed = true;
    }
    
    // Remove from active matches
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
// OPTIMIZED CLEANUP
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
    
    // Batch delete with safe removal
    expiredUsers.forEach(userId => {
        if (removeWaitingUser(userId)) {
            cleanedUsers++;
        }
    });
    
    expiredMatches.forEach(matchId => {
        activeMatches.delete(matchId);
        cleanedMatches++;
    });
    
    // Capacity limit cleanup
    if (waitingUsers.size > MAX_WAITING_USERS) {
        const excess = waitingUsers.size - MAX_WAITING_USERS;
        const oldestUsers = Array.from(waitingUsers.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp)
            .slice(0, excess)
            .map(entry => entry[0]);
        
        oldestUsers.forEach(userId => {
            if (removeWaitingUser(userId)) {
                cleanedUsers++;
            }
        });
    }
    
    // Cleanup stale fresh users
    for (const userId of freshUsersSet) {
        const user = waitingUsers.get(userId);
        if (!user || now - user.timestamp > 30000) {
            freshUsersSet.delete(userId);
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
                status: 'improved-webrtc-signaling',
                runtime: 'edge',
                improvements: [
                    'Unified adaptive matching strategy',
                    'Race condition protection with micro-locking',
                    'Real-time index consistency',
                    'Graceful fallback mechanisms'
                ],
                stats: {
                    waitingUsers: waitingUsers.size,
                    activeMatches: activeMatches.size,
                    matchingInProgress: matchingInProgress.size,
                    cacheSize: distanceCache.size,
                    indexStats: {
                        timezones: timezoneIndex.size,
                        genders: genderIndex.size,
                        freshUsers: freshUsersSet.size
                    }
                },
                timestamp: Date.now()
            });
        }
        
        return createCorsResponse({ 
            status: 'improved-signaling-ready',
            runtime: 'edge',
            stats: { 
                waiting: waitingUsers.size, 
                matches: activeMatches.size,
                strategy: waitingUsers.size <= ADAPTIVE_THRESHOLD ? 'linear' : 'indexed'
            },
            message: 'Improved WebRTC signaling server ready',
            timestamp: Date.now()
        });
    }
    
    if (req.method !== 'POST') {
        return createCorsResponse({ error: 'POST required for signaling' }, 405);
    }
    
    try {
        // FLEXIBLE JSON PARSING - Support both application/json and text/plain
        let data;
        let requestBody = '';
        
        try {
            data = await req.json();
        } catch (jsonError) {
            // Fallback to manual parsing for text/plain requests
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
            
            // Parse as JSON string (handles text/plain content-type)
            try {
                data = JSON.parse(requestBody);
            } catch (parseError) {
                return createCorsResponse({ 
                    error: 'Invalid JSON format',
                    received: requestBody.substring(0, 100),
                    tip: 'Ensure your data is valid JSON'
                }, 400);
            }
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
