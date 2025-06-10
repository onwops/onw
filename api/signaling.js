// 🚀 HYBRID-OPTIMIZED WebRTC Signaling Server - VERCEL EDGE FIXED

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

// 🔥 OPTIMIZATION: Multiple indexed data structures
let timezoneIndex = new Map(); // timezone -> Set(userIds)
let genderIndex = new Map();   // gender -> Set(userIds)
let freshUsersSet = new Set(); // Users < 30s
let lastIndexRebuild = 0;

// 🔥 NEW: True incremental tracking
let addedUsers = new Set();
let removedUsers = new Map(); // userId -> user data for cleanup

// 🔥 OPTIMIZATION: Pre-calculated distance cache
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
// ✅ FIXED: REAL-TIME INDEX MANAGEMENT
// ==========================================

// Helper: Add user to indexes - O(1)
function addUserToIndexes(userId, user) {
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
    if (Date.now() - user.timestamp < 30000) {
        freshUsersSet.add(userId);
    }
}

// ✅ FIXED: Remove user from indexes with immediate cleanup
function removeUserFromIndexes(userId, user) {
    if (!user) return;
    
    // Timezone index
    const zone = user.chatZone;
    if (typeof zone === 'number' && timezoneIndex.has(zone)) {
        timezoneIndex.get(zone).delete(userId);
        // Cleanup empty sets
        if (timezoneIndex.get(zone).size === 0) {
            timezoneIndex.delete(zone);
        }
    }
    
    // Gender index
    const gender = user.userInfo?.gender || 'Unspecified';
    if (genderIndex.has(gender)) {
        genderIndex.get(gender).delete(userId);
        if (genderIndex.get(gender).size === 0) {
            genderIndex.delete(gender);
        }
    }
    
    // Fresh users
    freshUsersSet.delete(userId);
}

function buildIndexesIfNeeded() {
    const now = Date.now();
    
    // Process incremental updates first
    if (addedUsers.size > 0 || removedUsers.size > 0) {
        updateIndexesIncrementally();
        return;
    }
    
    // Only rebuild if absolutely necessary
    if (now - lastIndexRebuild < INDEX_REBUILD_INTERVAL && timezoneIndex.size > 0) {
        return; // Skip rebuild
    }
    
    // Full rebuild for initial setup or periodic refresh
    buildIndexes();
}

function buildIndexes() {
    const now = Date.now();
    
    // Clear indexes
    timezoneIndex.clear();
    genderIndex.clear();
    freshUsersSet.clear();
    
    // Build new indexes in single pass
    for (const [userId, user] of waitingUsers.entries()) {
        addUserToIndexes(userId, user);
    }
    
    lastIndexRebuild = now;
    
    smartLog('INDEX-REBUILD', `Indexes built: ${timezoneIndex.size} zones, ${genderIndex.size} genders, ${freshUsersSet.size} fresh`);
}

function updateIndexesIncrementally() {
    // Process added users - O(k) where k = số users thay đổi
    for (const userId of addedUsers) {
        const user = waitingUsers.get(userId);
        if (user) {
            addUserToIndexes(userId, user);
        }
    }
    
    // Process removed users - O(k)
    for (const [userId, userData] of removedUsers.entries()) {
        removeUserFromIndexes(userId, userData);
    }
    
    smartLog('INDEX-UPDATE', `Incremental update: ${addedUsers.size} added, ${removedUsers.size} removed`);
    
    // Clear change tracking
    addedUsers.clear();
    removedUsers.clear();
}

// ==========================================
// ✅ FIXED: OPTIMIZED USER OPERATIONS
// ==========================================

function addWaitingUser(userId, userData) {
    waitingUsers.set(userId, userData);
    // Real-time index update for immediate availability
    addUserToIndexes(userId, userData);
    // Track for potential batch operations (optional)
    addedUsers.add(userId);
}

// ✅ FIXED: Immediate index cleanup
function removeWaitingUser(userId) {
    const user = waitingUsers.get(userId);
    if (user) {
        // Remove from waitingUsers first
        waitingUsers.delete(userId);
        
        // Immediate index cleanup (no more batch delays)
        removeUserFromIndexes(userId, user);
        
        // Clean up tracking
        addedUsers.delete(userId);
        removedUsers.delete(userId);
        
        return true;
    }
    return false;
}

// ==========================================
// ✅ FIXED: MATCHING STRATEGIES WITH SELF-EXCLUSION
// ==========================================

function findSimpleMatchExcludeSelf(userId, userChatZone, userGender) {
    let bestMatch = null;
    let bestScore = 0;
    
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

function findUltraFastMatchExcludeSelf(userId, userChatZone, userGender) {
    buildIndexesIfNeeded();
    
    const now = Date.now();
    let bestMatch = null;
    let bestScore = 0;
    
    // 🔥 PRIORITY 1: Same timezone + fresh users (< 30s)
    if (typeof userChatZone === 'number') {
        const sameZoneCandidates = timezoneIndex.get(userChatZone);
        if (sameZoneCandidates) {
            for (const candidateId of sameZoneCandidates) {
                if (candidateId === userId) continue; // ✅ Skip self
                
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
                if (candidateId === userId || checkedCount >= 2) continue; // ✅ Skip self
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
            if (candidateId === userId || checkedCount >= 5) break; // ✅ Skip self
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

function findHybridMatchExcludeSelf(userId, userChatZone, userGender) {
    // If small user count, use simple approach
    if (waitingUsers.size <= 20) {
        return findSimpleMatchExcludeSelf(userId, userChatZone, userGender);
    }
    
    // If many null/undefined timezones, use simple approach
    const validTimezoneUsers = Array.from(waitingUsers.values())
        .filter(u => typeof u.chatZone === 'number').length;
    
    if (validTimezoneUsers < waitingUsers.size * 0.5) {
        return findSimpleMatchExcludeSelf(userId, userChatZone, userGender);
    }
    
    // Otherwise use optimized approach
    buildIndexesIfNeeded();
    return findUltraFastMatchExcludeSelf(userId, userChatZone, userGender);
}

// ==========================================
// ✅ FIXED: INSTANT MATCH HANDLER (NO RACE CONDITIONS)
// ==========================================


// ==========================================
// ✅ FIXED: OTHER HANDLERS
// ==========================================

function handleGetSignals(userId, data) {
    const { chatZone, gender, userInfo } = data;
    
    // Kiểm tra active matches trước
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
                strategy: match.strategy || 'unknown',
                timestamp: Date.now()
            });
        }
    }
    
    // ✅ Kiểm tra waiting list với auto-recovery
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
        // ✅ AUTO-RECOVERY: Tự động thêm lại user nếu có đủ thông tin
        if (chatZone !== undefined) {
            const waitingUser = {
                userId,
                userInfo: userInfo || {},
                chatZone: chatZone,
                timestamp: Date.now()
            };
            
            addWaitingUser(userId, waitingUser);
            
            smartLog('GET-SIGNALS', `${userId.slice(-8)} auto-recovered to waiting list`);
            
            return createCorsResponse({
                status: 'waiting',
                position: waitingUsers.size,
                waitingUsers: waitingUsers.size,
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
    
    // ✅ FIX: CHỈ xóa khỏi waiting list
    if (removeWaitingUser(userId)) removed = true;
    if (removeWaitingUser(partnerId)) removed = true;
    
    // ✅ FIX: KHÔNG xóa match, chỉ đánh dấu là connected
    const match = activeMatches.get(matchId);
    if (match) {
        match.connected = true;
        match.connectedAt = Date.now();
        criticalLog('P2P-CONNECTED', `Match ${matchId} marked as connected`);
    } else {
        criticalLog('P2P-CONNECTED', `Match ${matchId} not found (may have been cleaned up)`);
    }
    
    // ❌ REMOVED: activeMatches.delete(matchId);
    
    return createCorsResponse({
        status: 'p2p_connected',
        removed,
        matchPreserved: !!match,
        timestamp: Date.now()
    });
}

function handleDisconnect(userId) {
    criticalLog('DISCONNECT', userId.slice(-8));
    
    let removed = false;
    
    // Use optimized removal
    if (removeWaitingUser(userId)) removed = true;
    
    // ✅ FIX: Better match cleanup on disconnect
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
            
            // ✅ FIX: Mark match as disconnected instead of immediate deletion
            match.disconnected = true;
            match.disconnectedAt = Date.now();
            match.disconnectedBy = userId;
            
            // ✅ DELETE after a short delay to allow partner to receive disconnect signal
            setTimeout(() => {
                activeMatches.delete(matchId);
                criticalLog('DISCONNECT', `Delayed removal of match ${matchId}`);
            }, 5000); // 5 second delay
            
            criticalLog('DISCONNECT', `Match ${matchId} marked for removal`);
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
    
    // ✅ TIMEOUTS - Phân biệt signaling và connected
    const SIGNALING_TIMEOUT = 120000;  // 2 phút cho signaling exchange
    const CONNECTED_TIMEOUT = 300000;  // 5 phút sau khi P2P connected
    const USER_TIMEOUT = 120000;       // 2 phút cho waiting users
    
    // Batch cleanup - collect expired IDs first
    const expiredUsers = [];
    for (const [userId, user] of waitingUsers.entries()) {
        if (now - user.timestamp > USER_TIMEOUT) {
            expiredUsers.push(userId);
        }
    }
    
    // ✅ FIX: Smart match cleanup based on connection status
    const expiredMatches = [];
    for (const [matchId, match] of activeMatches.entries()) {
        const age = now - match.timestamp;
        
        if (!match.connected) {
            // ✅ Match chưa connected - chỉ xóa sau 2 phút signaling
            if (age > SIGNALING_TIMEOUT) {
                expiredMatches.push(matchId);
                criticalLog('CLEANUP', `Expired signaling match: ${matchId} (${Math.round(age/1000)}s old)`);
            }
        } else {
            // ✅ Match đã connected - xóa sau 5 phút connected
            const connectedAge = now - match.connectedAt;
            if (connectedAge > CONNECTED_TIMEOUT) {
                expiredMatches.push(matchId);
                criticalLog('CLEANUP', `Expired connected match: ${matchId} (connected ${Math.round(connectedAge/1000)}s ago)`);
            }
        }
    }
    
    // Batch delete using optimized removal
    expiredUsers.forEach(userId => {
        if (removeWaitingUser(userId)) cleanedUsers++;
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
            if (removeWaitingUser(userId)) cleanedUsers++;
        });
    }
    
    if (cleanedUsers > 0 || cleanedMatches > 0) {
        criticalLog('CLEANUP', `Removed ${cleanedUsers} users, ${cleanedMatches} matches. Active: ${waitingUsers.size} waiting, ${activeMatches.size} matched`);
    }
}

// ==========================================
// 3. ✅ FIXED: handleInstantMatch - Ensure match object has proper structure
// ==========================================

function handleInstantMatch(userId, data) {
    const { userInfo, preferredMatchId, chatZone, gender } = data;
    
    // MINIMAL VALIDATION - NO chatZone validation to avoid 400 error
    if (!userId || typeof userId !== 'string') {
        return createCorsResponse({ error: 'userId is required and must be string' }, 400);
    }
    
    smartLog('INSTANT-MATCH', `${userId.slice(-8)} looking for partner (ChatZone: ${chatZone})`);
    
    // ✅ KIỂM TRA ACTIVE MATCHES TRƯỚC - không thay đổi
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
    
    // 🔧 ADAPTIVE MATCHING STRATEGY
    const userGender = gender || userInfo?.gender || 'Unspecified';
    const startTime = Date.now();
    
    let bestMatch;
    let strategy;
    
    if (waitingUsers.size <= SIMPLE_STRATEGY_THRESHOLD) {
        bestMatch = findSimpleMatchExcludeSelf(userId, chatZone, userGender);
        strategy = 'simple';
    } else if (waitingUsers.size <= HYBRID_STRATEGY_THRESHOLD) {
        bestMatch = findHybridMatchExcludeSelf(userId, chatZone, userGender);
        strategy = 'hybrid';
    } else {
        buildIndexesIfNeeded();
        bestMatch = findUltraFastMatchExcludeSelf(userId, chatZone, userGender);
        strategy = 'optimized';
    }
    
    if (bestMatch) {
        const partnerId = bestMatch.userId;
        const partnerUser = bestMatch.user;
        
        // ✅ FIX: CHỈ xóa cả 2 users KHI tìm thấy match
        removeWaitingUser(userId);
        removeWaitingUser(partnerId);
        
        // Create match
        const matchId = preferredMatchId || `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        
        const isUserInitiator = userId < partnerId;
        const p1 = isUserInitiator ? userId : partnerId;
        const p2 = isUserInitiator ? partnerId : userId;
        
        // ✅ FIX: Enhanced match object with connection tracking
        const match = {
            p1, p2,
            timestamp: Date.now(),
            connected: false,           // ✅ NEW: Track connection status
            connectedAt: null,          // ✅ NEW: Track when P2P connected
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
        
        activeMatches.set(matchId, match);
        
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
        // ✅ FIX: Thêm hoặc update user trong waiting list
        const waitingUser = {
            userId,
            userInfo: userInfo || {},
            chatZone: chatZone || null,
            timestamp: Date.now()
        };
        
        // Kiểm tra xem user đã có trong waiting list chưa
        if (waitingUsers.has(userId)) {
            // Update thông tin user hiện tại
            const existingUser = waitingUsers.get(userId);
            existingUser.userInfo = userInfo || existingUser.userInfo || {};
            existingUser.chatZone = chatZone !== undefined ? chatZone : existingUser.chatZone;
            existingUser.timestamp = Date.now(); // Update timestamp
            
            // Update indexes if needed
            removeUserFromIndexes(userId, existingUser);
            addUserToIndexes(userId, existingUser);
            
            smartLog('INSTANT-MATCH', `${userId.slice(-8)} updated in waiting list`);
        } else {
            // Thêm user mới vào waiting list
            addWaitingUser(userId, waitingUser);
            smartLog('INSTANT-MATCH', `${userId.slice(-8)} added to waiting list`);
        }
        
        const position = Array.from(waitingUsers.keys()).indexOf(userId) + 1;
        
        return createCorsResponse({
            status: 'waiting',
            position,
            waitingUsers: waitingUsers.size,
            chatZone: chatZone,
            userGender: userGender,
            strategy: strategy || 'simple',
            message: 'Added to matching queue. Waiting for partner...',
            estimatedWaitTime: Math.min(waitingUsers.size * 2, 30),
            timestamp: Date.now()
        });
    }
}


// ==========================================
// ✅ FIXED: REQUEST BODY PARSING FOR VERCEL EDGE
// ==========================================

async function parseRequestBody(request) {
    try {
        // Method 1: Try built-in json() method first (most reliable for Vercel Edge)
        if (request.headers.get('content-type')?.includes('application/json')) {
            return await request.json();
        }
        
        // Method 2: Handle text/plain body (fallback)
        const textBody = await request.text();
        
        if (!textBody || !textBody.trim()) {
            throw new Error('Empty request body');
        }
        
        // Try to parse as JSON
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
// MAIN HANDLER FUNCTION - VERCEL EDGE OPTIMIZED
// ==========================================

export default async function handler(request) {
    // Quick cleanup at start to prevent timeouts
    const startTime = Date.now();
    cleanup();
    
    if (request.method === 'OPTIONS') {
        return createCorsResponse(null, 200);
    }
    
    if (request.method === 'GET') {
        const url = new URL(request.url);
        const debug = url.searchParams.get('debug');
        
        if (debug === 'true') {
            return createCorsResponse({
                status: 'hybrid-optimized-webrtc-signaling-vercel-fixed',
                runtime: 'vercel-edge',
                version: '2.1-vercel-fixed',
                strategies: {
                    simple: `≤${SIMPLE_STRATEGY_THRESHOLD} users`,
                    hybrid: `${SIMPLE_STRATEGY_THRESHOLD + 1}-${HYBRID_STRATEGY_THRESHOLD} users`, 
                    optimized: `>${HYBRID_STRATEGY_THRESHOLD} users`
                },
                fixes: [
                    'Vercel Edge Runtime compatible request body parsing',
                    'Timeout prevention with fast cleanup',
                    'Race condition eliminated in instant-match',
                    'Real-time index synchronization',
                    'Auto-recovery in get-signals',
                    'Self-exclusion in all matching strategies'
                ],
                stats: {
                    waitingUsers: waitingUsers.size,
                    activeMatches: activeMatches.size,
                    cacheSize: distanceCache.size,
                    indexStats: {
                        timezones: timezoneIndex.size,
                        genders: genderIndex.size,
                        freshUsers: freshUsersSet.size,
                        lastRebuild: Date.now() - lastIndexRebuild,
                        pendingAdds: addedUsers.size,
                        pendingRemoves: removedUsers.size
                    }
                },
                performance: {
                    startupTime: Date.now() - startTime
                },
                timestamp: Date.now()
            });
        }
        
        return createCorsResponse({ 
            status: 'hybrid-optimized-signaling-vercel-ready',
            runtime: 'vercel-edge',
            version: '2.1-vercel-fixed',
            stats: { 
                waiting: waitingUsers.size, 
                matches: activeMatches.size,
                strategy: waitingUsers.size <= SIMPLE_STRATEGY_THRESHOLD ? 'simple' : 
                         waitingUsers.size <= HYBRID_STRATEGY_THRESHOLD ? 'hybrid' : 'optimized'
            },
            message: 'Vercel Edge optimized WebRTC signaling server ready!',
            timestamp: Date.now()
        });
    }
    
    if (request.method !== 'POST') {
        return createCorsResponse({ error: 'POST required for signaling' }, 405);
    }
    
    try {
        // ✅ FIXED: Vercel Edge compatible body parsing
        const data = await parseRequestBody(request);
        
        const { action, userId } = data;

        if (!action || !userId) {
            return createCorsResponse({
                error: 'Missing required fields',
                required: ['action', 'userId'],
                received: Object.keys(data || {})
            }, 400);
        }

        // Quick timeout check
        if (Date.now() - startTime > 55000) { // 55 seconds safety margin
            criticalLog('TIMEOUT-WARNING', `Request taking too long: ${Date.now() - startTime}ms`);
            return createCorsResponse({
                error: 'Request timeout prevention',
                message: 'Please retry your request'
            }, 408);
        }

        // Handle different actions with timeout protection
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
            tip: 'Check request format and try again'
        }, 500);
    }
}

// ✅ CRITICAL: Vercel Edge Runtime configuration
export const config = { 
    runtime: 'edge'
}
