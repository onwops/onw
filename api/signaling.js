// 🚀 WEBRTC SIGNALING SERVER - NODE.JS + REDIS LABS

import { createClient } from 'redis';

const ENABLE_DETAILED_LOGGING = false;

// ==========================================
// FIXED REDIS CONFIGURATION FOR NODE.JS
// ==========================================

let redisClient = null;
async function parseNodeJSBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        const maxSize = 1024 * 1024; // 1MB limit
        
        const timeout = setTimeout(() => {
            reject(new Error('Request body parsing timeout'));
        }, 10000);
        
        req.on('data', (chunk) => {
            size += chunk.length;
            
            if (size > maxSize) {
                clearTimeout(timeout);
                reject(new Error('Request body too large'));
                return;
            }
            
            body += chunk.toString();
        });
        
        req.on('end', () => {
            clearTimeout(timeout);
            try {
                if (!body.trim()) {
                    reject(new Error('Empty request body'));
                    return;
                }
                
                const parsed = JSON.parse(body);
                resolve(parsed);
            } catch (error) {
                reject(new Error(`JSON parse error: ${error.message}`));
            }
        });
        
        req.on('error', (error) => {
            clearTimeout(timeout);
            reject(new Error(`Stream error: ${error.message}`));
        });
    });
}
async function getRedisClient() {
    if (!redisClient) {
        redisClient = createClient({
            // ✅ FIX: Proper Redis Labs URL format for Node.js
            url: "rediss://default:SXZanOZvHCZurRd8dTCudyIKvciwuNz0@redis-12481.c294.ap-northeast-1-2.ec2.redns.redis-cloud.com:12481",
            socket: {
                // ✅ FIX: Correct TLS config for Redis Labs
                tls: true,
                rejectUnauthorized: false,
                connectTimeout: 10000,
                commandTimeout: 5000
            },
            // ✅ FIX: Add retry strategy
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
