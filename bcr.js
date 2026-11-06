const axios = require('axios');
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ======================
// CẤU HÌNH
// ======================
const BASE = "https://autobcr.com";
const LOGIN_URL = `${BASE}/login`;
const LOBBY_URL = `${BASE}/ae/lobby`;
const GETNEWRESULT_URL = `${BASE}/baccarat/getnewresult`;

const USERNAME = "bucumh";
const PASSWORD = "123456";

const STATS_FILE = path.join(__dirname, 'stats.json');
const agent = new https.Agent({ rejectUnauthorized: false });
let cookieJar = '';
let baccaratData = [];
let lastUpdate = null;

// ======================
// QUẢN LÝ THỐNG KÊ (STATS)
// ======================
let stats = {};
let pendingPredictions = {}; // { "C17": { pred: "BANKER", round: 68 } }
let lastResultsMap = {};     // { "C17": "BBPBB..." } - Lưu chuỗi kết quả để check ván mới chuẩn xác

function loadStats() {
    if (fs.existsSync(STATS_FILE)) {
        try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) { stats = {}; }
    }
}

function saveStats() {
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); } catch (e) {}
}

function getTableStats(tableName) {
    if (!stats[tableName]) {
        stats[tableName] = { total: 0, win: 0, loss: 0, rate: 0, history: [] };
    }
    return stats[tableName];
}

// ======================
// SESSION AXIOS
// ======================
const session = axios.create({
    baseURL: BASE,
    timeout: 30000,
    httpsAgent: agent,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
    }
});

session.interceptors.request.use(config => {
    if (cookieJar) config.headers.Cookie = cookieJar;
    return config;
});

session.interceptors.response.use(res => {
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
        for (const cookie of setCookie) {
            const [name, value] = cookie.split(';')[0].split('=');
            if (cookieJar.includes(`${name}=`)) {
                cookieJar = cookieJar.replace(new RegExp(`${name}=[^;]+;?`), '');
            }
            cookieJar += `${name}=${value}; `;
        }
    }
    return res;
});

function getCsrfToken(html) {
    const match = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
    return match ? match[1] : null;
}

// ======================
// AI MEMORY & THUẬT TOÁN ĐẦY ĐỦ
// ======================
let AI_MEMORY = {
    bridge_history: {},
    markov: {},
    bayesian: { conditional: {} },
    stats: { predict_total: 0, skip: 0 },
    lastPrediction: {}
};

const BRIDGE_BASE_WEIGHTS = {
    "BET_STRONG": 28,
    "BET_MEDIUM": 28,
    "PATTERN_1_1": 28,
    "PATTERN_2_2": 28,
    "PATTERN_2_1_2": 28,
    "PATTERN_3_2_1": 28,
    "PATTERN_DAO": 28,
    "PATTERN_XIEN": 28,
    "PATTERN_KEP": 28
};

const DEFAULT_TRUST = {
    "BET_STRONG": 1.0,
    "BET_MEDIUM": 1.0,
    "PATTERN_1_1": 1.0,
    "PATTERN_2_2": 1.0,
    "PATTERN_2_1_2": 1.0,
    "PATTERN_3_2_1": 1.0,
    "PATTERN_DAO": 1.0,
    "PATTERN_XIEN": 1.0,
    "PATTERN_KEP": 1.0
};

const MAX_BRIDGE_POINTS = 35;

function convert(v) {
    return v === "B" ? "BANKER" : "PLAYER";
}
function opposite(v) { return v === "B" ? "P" : "B"; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function normalizeRaw(raw) {
    return (raw || "").toUpperCase().replace(/T/g, "").replace(/[^BP]/g, "");
}
function recentSlice(s, n) { return s.slice(Math.max(0, s.length - n)); }

function buildGroups(s) {
    if (!s.length) return [];
    const groups = [];
    let current = s[0], count = 1;
    for (let i = 1; i < s.length; i++) {
        if (s[i] === current) count++;
        else {
            groups.push({ side: current, len: count });
            current = s[i];
            count = 1;
        }
    }
    groups.push({ side: current, len: count });
    return groups;
}

function getBridgeTrust(name) {
    const h = AI_MEMORY.bridge_history[name];
    if (!h || h.total < 15) {
        return DEFAULT_TRUST[name] || 1.0;
    }
    const rate = h.correct / h.total;
    return clamp(rate + 0.2, 0.6, 1.5);
}

function getPatternConfidence(s, patternName) {
    if (s.length < 10) return 0.7;
    const groups = buildGroups(s);
    const recent = groups.slice(-10);
    let matchCount = 0;
    let totalCheck = 0;

    for (let i = 0; i < recent.length - 1; i++) {
        const sub = recent.slice(i);
        if (patternName.includes("BET") && sub[0] && sub[0].len >= 3) matchCount++;
        else if (patternName.includes("1-1") && sub.length >= 2 && sub[0].len === 1 && sub[1].len === 1) matchCount++;
        else if (patternName.includes("2-2") && sub.length >= 2 && sub[0].len === 2 && sub[1].len === 2) matchCount++;
        else if (patternName.includes("2-1-2") && sub.length >= 3 && sub[0].len === 2 && sub[1].len === 1 && sub[2].len === 2) matchCount++;
        else if (patternName.includes("3-2-1") && sub.length >= 3 && sub[0].len === 3 && sub[1].len === 2 && sub[2].len === 1) matchCount++;
        totalCheck++;
    }

    const conf = totalCheck > 0 ? clamp(matchCount / totalCheck + 0.3, 0.5, 0.95) : 0.7;
    return conf;
}

function detectBridge(s) {
    if (s.length < 4) return { side: "NONE", weight: 0, name: "NONE", trust: 1.0, confidence: 0.7 };
    const groups = buildGroups(s);
    const lastGroups = groups.slice(-8);
    if (lastGroups.length < 2) return { side: "NONE", weight: 0, name: "NONE", trust: 1.0, confidence: 0.7 };

    const last = lastGroups[lastGroups.length - 1];
    const prev = lastGroups[lastGroups.length - 2];
    const prev2 = lastGroups.length >= 3 ? lastGroups[lastGroups.length - 3] : null;
    const prev3 = lastGroups.length >= 4 ? lastGroups[lastGroups.length - 4] : null;

    let detected = null;

    if (last.len >= 5) {
        detected = { side: last.side, weight: BRIDGE_BASE_WEIGHTS.BET_STRONG, name: "BET_STRONG" };
    } else if (last.len === 4) {
        detected = { side: last.side, weight: BRIDGE_BASE_WEIGHTS.BET_STRONG, name: "BET_STRONG" };
    } else if (last.len === 3) {
        detected = { side: last.side, weight: BRIDGE_BASE_WEIGHTS.BET_MEDIUM, name: "BET_MEDIUM" };
    }
    else if (lastGroups.length >= 4) {
        const last4 = lastGroups.slice(-4);
        if (last4.every(g => g.len === 1)) {
            const sides = last4.map(g => g.side);
            if (sides[0] !== sides[1] && sides[1] !== sides[2] && sides[2] !== sides[3]) {
                detected = { side: opposite(last.side), weight: BRIDGE_BASE_WEIGHTS.PATTERN_1_1, name: "PATTERN_1_1" };
            }
        }
    }
    else if (lastGroups.length >= 2 && prev.len === 2 && last.len === 2) {
        detected = { side: last.side, weight: BRIDGE_BASE_WEIGHTS.PATTERN_2_2, name: "PATTERN_2_2" };
    }
    else if (lastGroups.length >= 3 && prev2) {
        if (prev2.len === 2 && prev.len === 1 && last.len === 2 && prev2.side === last.side) {
            detected = { side: prev2.side, weight: BRIDGE_BASE_WEIGHTS.PATTERN_2_1_2, name: "PATTERN_2_1_2" };
        }
    }
    else if (lastGroups.length >= 3 && prev2) {
        if (prev2.len === 3 && prev.len === 2 && last.len === 1) {
            detected = { side: last.side, weight: BRIDGE_BASE_WEIGHTS.PATTERN_3_2_1, name: "PATTERN_3_2_1" };
        }
    }
    else if (lastGroups.length >= 3 && prev2) {
        if (prev2.side !== prev.side && prev.side !== last.side && prev2.side === last.side) {
            if (prev2.len >= 2 && prev.len === 1 && last.len >= 2) {
                detected = { side: prev2.side, weight: BRIDGE_BASE_WEIGHTS.PATTERN_XIEN, name: "PATTERN_XIEN" };
            }
        }
    }
    else if (lastGroups.length >= 4 && prev2 && prev3) {
        if (prev3.len === prev2.len && prev2.len === prev.len && prev.len === last.len) {
            const sides = [prev3.side, prev2.side, prev.side, last.side];
            if (sides[0] === sides[2] && sides[1] === sides[3] && sides[0] !== sides[1]) {
                detected = { side: last.side, weight: BRIDGE_BASE_WEIGHTS.PATTERN_KEP, name: "PATTERN_KEP" };
            }
        }
    }
    else if (lastGroups.length >= 3) {
        const last3 = lastGroups.slice(-3);
        if (last3.every(g => g.len === 1)) {
            const sides = last3.map(g => g.side);
            if (sides[0] !== sides[1] && sides[1] !== sides[2]) {
                detected = { side: opposite(last.side), weight: BRIDGE_BASE_WEIGHTS.PATTERN_DAO, name: "PATTERN_DAO" };
            }
        }
    }

    if (!detected) {
        return { side: "NONE", weight: 0, name: "NONE", trust: 1.0, confidence: 0.7 };
    }

    const trust = getBridgeTrust(detected.name);
    const confidence = getPatternConfidence(s, detected.name);

    let adjustedWeight = Math.round(detected.weight * trust * confidence);
    adjustedWeight = Math.min(adjustedWeight, MAX_BRIDGE_POINTS);

    return {
        side: detected.side,
        weight: adjustedWeight,
        name: detected.name,
        trust: trust,
        confidence: confidence
    };
}

function markovBackoff(s) {
    if (s.length < 2) return { B: 0, P: 0 };
    const orders = [5, 4, 3, 2];
    for (const order of orders) {
        if (s.length < order) continue;
        const ctx = s.slice(-order);
        const data = AI_MEMORY.markov[order] && AI_MEMORY.markov[order][ctx];
        if (data && (data.B + data.P) >= 3) {
            const total = data.B + data.P;
            return {
                B: Math.round((data.B / total) * 100),
                P: Math.round((data.P / total) * 100)
            };
        }
    }
    return { B: 0, P: 0 };
}

function analyzeTrend(s) {
    if (s.length < 6) return { side: "NONE", weight: 0 };
    const block = recentSlice(s, 20);
    const bCount = (block.match(/B/g) || []).length;
    const total = block.length;
    if (total < 4) return { side: "NONE", weight: 0 };
    const pB = bCount / total;
    const diff = Math.abs(pB - 0.5);
    if (diff < 0.05) return { side: "NONE", weight: 0 };
    const weight = Math.round(diff * 45);
    return {
        side: pB > 0.5 ? "B" : "P",
        weight: clamp(weight, 5, 25)
    };
}

function bayesianUpdate(s) {
    if (s.length < 2) return { B: 0, P: 0 };
    const last = s[s.length - 1];
    const data = AI_MEMORY.bayesian.conditional[last];
    if (!data || data.count < 3) return { B: 0, P: 0 };
    const pB = data.next_B / data.count;
    const pP = data.next_P / data.count;
    const diff = Math.abs(pB - pP);
    if (diff < 0.05) return { B: 0, P: 0 };
    return {
        B: Math.round(pB * 100),
        P: Math.round(pP * 100)
    };
}

function predict(raw, ban) {
    const s = normalizeRaw(raw);
    AI_MEMORY.stats.predict_total++;

    if (s.length < 4) {
        AI_MEMORY.stats.skip++;
        return {
            prediction: 'PLAYER',
            confidence: 50,
            pattern: 'Chuỗi quá ngắn (<4 ván)',
            explanation: 'Chuỗi quá ngắn (<4 ván)'
        };
    }

    const markov = markovBackoff(s);
    let scoreB = markov.B || 0;
    let scoreP = markov.P || 0;

    const bridge = detectBridge(s);
    if (bridge.side === "B") scoreB += bridge.weight;
    else if (bridge.side === "P") scoreP += bridge.weight;

    const trend = analyzeTrend(s);
    if (trend.side === "B") scoreB += trend.weight;
    else if (trend.side === "P") scoreP += trend.weight;

    const bayes = bayesianUpdate(s);
    if (bayes.B > 0 && bayes.P > 0) {
        const total = bayes.B + bayes.P;
        const bWeight = Math.round((bayes.B / total) * 35);
        const pWeight = Math.round((bayes.P / total) * 35);
        scoreB += bWeight;
        scoreP += pWeight;
    }

    if (scoreB === 0 && scoreP === 0) {
        if (markov.B > markov.P) { scoreB = 50; scoreP = 50; }
        else { scoreP = 50; scoreB = 50; }
    }

    const totalScore = scoreB + scoreP;
    const pB = totalScore > 0 ? (scoreB / totalScore) * 100 : 50;
    const pP = totalScore > 0 ? (scoreP / totalScore) * 100 : 50;

    const predictSide = pB >= pP ? "B" : "P";
    const confidence = Math.round(Math.max(pB, pP));

    if (ban) {
        AI_MEMORY.lastPrediction[ban] = predictSide;
    }

    const reasons = [];
    if (markov.B > 0 || markov.P > 0) reasons.push(`✔ Markov (B:${markov.B}% P:${markov.P}%)`);
    if (bridge.name !== "NONE") {
        reasons.push(`✔ ${bridge.name} (+${bridge.weight})`);
    }
    if (trend.side !== "NONE") reasons.push(`✔ Xu hướng ${trend.side} (+${trend.weight})`);
    if (bayes.B > 0 || bayes.P > 0) reasons.push(`✔ Bayesian (B:${bayes.B}% P:${bayes.P}%)`);

    if (reasons.length === 0) reasons.push("⚠ Dùng Markov fallback");

    return {
        prediction: convert(predictSide),
        confidence: clamp(confidence, 50, 99),
        pattern: bridge.name !== "NONE" ? bridge.name : "Score Fusion Engine",
        explanation: reasons.join(" | ")
    };
}

function learn(raw, ban) {
    const s = normalizeRaw(raw);
    if (s.length < 3) return;
    const before = s.slice(0, -1);
    const real = s[s.length - 1];
    if (!before.length || !real) return;

    const orders = [5, 4, 3, 2];
    for (const order of orders) {
        if (before.length >= order) {
            const ctx = before.slice(-order);
            if (!AI_MEMORY.markov[order]) AI_MEMORY.markov[order] = {};
            if (!AI_MEMORY.markov[order][ctx]) AI_MEMORY.markov[order][ctx] = { B: 0, P: 0 };
            AI_MEMORY.markov[order][ctx][real] += 1;
        }
    }

    const lastBefore = before[before.length - 1];
    if (!AI_MEMORY.bayesian.conditional[lastBefore]) {
        AI_MEMORY.bayesian.conditional[lastBefore] = { count: 0, next_B: 0, next_P: 0 };
    }
    AI_MEMORY.bayesian.conditional[lastBefore].count++;
    if (real === "B") AI_MEMORY.bayesian.conditional[lastBefore].next_B++;
    else AI_MEMORY.bayesian.conditional[lastBefore].next_P++;
}

function analyzePattern(resultArray, tableName = null) {
    let hist = "";
    if (typeof resultArray === 'string') {
        hist = normalizeRaw(resultArray);
    } else if (Array.isArray(resultArray)) {
        hist = resultArray.join('');
    }
    return predict(hist, tableName);
}

// ======================
// ĐĂNG NHẬP & LẤY DATA
// ======================
async function login() {
    try {
        const getResp = await session.get(LOGIN_URL);
        const token = getCsrfToken(getResp.data);
        if (!token) return false;
        
        const formData = new URLSearchParams();
        formData.append('username', USERNAME);
        formData.append('password', PASSWORD);
        formData.append('_token', token);
        formData.append('action', 'Login');
        
        const loginResp = await session.post(LOGIN_URL, formData.toString(), {
            headers: { 'Referer': LOGIN_URL, 'Origin': BASE, 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        return loginResp.status === 200;
    } catch (error) { return false; }
}

async function goToLobby() {
    try { await session.get(LOBBY_URL); return true; } catch { return false; }
}

async function fetchBaccaratData() {
    try {
        let xsrfToken = '';
        const xsrfMatch = cookieJar.match(/XSRF-TOKEN=([^;]+)/);
        if (xsrfMatch) xsrfToken = decodeURIComponent(xsrfMatch[1]);
        
        const formData = new URLSearchParams();
        formData.append('gameCode', 'ae');
        
        const resp = await session.post(GETNEWRESULT_URL, formData.toString(), {
            headers: {
                'Referer': LOBBY_URL, 'Origin': BASE, 'X-Requested-With': 'XMLHttpRequest',
                'X-XSRF-TOKEN': xsrfToken, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            }
        });
        
        if (resp.data && resp.data.data) {
            const newData = resp.data.data.map(item => ({
                table: item.table_name,
                result: item.result || '',
                shoeId: item.shoeId || '',
                round: item.round || ''
            }));

            // === KIỂM TRA VÁN MỚI ĐỂ CHẤM ĐIỂM (FIX THỐNG KÊ) ===
            for (const table of newData) {
                const tableName = table.table;
                const currentResultString = table.result || '';
                const lastSavedResult = lastResultsMap[tableName];

                if (lastSavedResult !== undefined && currentResultString.length > lastSavedResult.length) {
                    const pending = pendingPredictions[tableName];
                    if (pending) {
                        const cleanResults = currentResultString.replace(/T/g, '');
                        const actualResult = cleanResults.slice(-1); // 'P' hoặc 'B'
                        
                        const isWin = (pending.pred === 'PLAYER' && actualResult === 'P') || 
                                      (pending.pred === 'BANKER' && actualResult === 'B');
                        
                        const tStats = getTableStats(tableName);
                        tStats.total++;
                        if (isWin) tStats.win++;
                        else tStats.loss++;
                        tStats.rate = ((tStats.win / tStats.total) * 100).toFixed(1);
                        tStats.history.push(isWin ? 'W' : 'L');
                        
                        if (tStats.history.length > 50) tStats.history.shift();
                        saveStats(); // Lưu trực tiếp vào stats.json
                    }
                }
                lastResultsMap[tableName] = currentResultString;
            }

            baccaratData = newData;
            lastUpdate = new Date().toISOString();

            // Huấn luyện AI & Cập nhật dự đoán cho ván tới
            for (const item of baccaratData) {
                learn(item.result, item.table);
                const analysis = analyzePattern(item.result, item.table);
                pendingPredictions[item.table] = {
                    pred: analysis.prediction,
                    round: item.round || item.result.length
                };
            }
        }
        return baccaratData;
    } catch (error) { return []; }
}

// ======================
// API SERVER
// ======================
const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.get('/', (req, res) => {
    res.json({ name: 'Baccarat tele(@duybmw)', endpoints: { lich_su: '/api/baccarat', moi_nhat: '/api/latest', du_doan: '/api/bcrbytduy', thong_ke: '/api/stats', thong_ke_ban: '/api/stats/:table' }, lastUpdate, totalTables: baccaratData.length });
});

app.get('/api/baccarat', (req, res) => res.json({ success: true, data: baccaratData, lastUpdate, total: baccaratData.length }));

app.get('/api/latest', (req, res) => {
    const latest = [...baccaratData].sort((a, b) => (parseInt(b.table) || 0) - (parseInt(a.table) || 0));
    res.json({ success: true, data: latest.slice(0, 10), lastUpdate });
});

// Endpoint Dự đoán tổng hợp (Kèm Thống kê)
app.get('/api/bcrbytduy', (req, res) => {
    const predictions = [];
    for (const item of baccaratData) {
        const analysis = analyzePattern(item.result, item.table);
        const tStats = getTableStats(item.table);
        predictions.push({
            table: item.table,
            phien: (item.round || item.result.length) + 1,
            dudoan: analysis.prediction,
            dotincay: `${analysis.confidence}%`,
            pattern: analysis.pattern,
            giaithich: analysis.explanation,
            thong_ke: `${tStats.win}✅/${tStats.loss}❌ (${tStats.rate}%)`,
            result: item.result.slice(-20)
        });
    }
    predictions.sort((a, b) => (parseInt(b.dotincay) || 0) - (parseInt(a.dotincay) || 0));
    res.json({ success: true, time: new Date().toISOString(), predictions });
});

// Endpoint Thống kê TẤT CẢ các bàn
app.get('/api/stats', (req, res) => {
    let totalWin = 0, totalLoss = 0;
    for (const t in stats) {
        totalWin += stats[t].win;
        totalLoss += stats[t].loss;
    }
    const total = totalWin + totalLoss;
    const rate = total > 0 ? ((totalWin / total) * 100).toFixed(1) : 0;
    
    res.json({
        success: true,
        tong_thang: totalWin,
        tong_thua: totalLoss,
        ti_le_tong: `${rate}%`,
        chi_tiet: stats
    });
});

// Endpoint Thống kê 1 bàn cụ thể
app.get('/api/stats/:table', (req, res) => {
    const tableName = req.params.table;
    const tStats = getTableStats(tableName);
    res.json({
        success: true,
        table: tableName,
        thang: tStats.win,
        thua: tStats.loss,
        ti_le: `${tStats.rate}%`,
        lich_su: tStats.history.slice(-20)
    });
});

// Endpoint Dự đoán 1 bàn
app.get('/api/predict/:table', (req, res) => {
    const found = baccaratData.find(item => item.table === req.params.table);
    if (!found) return res.json({ success: false, message: 'Không tìm thấy bàn' });

    const analysis = analyzePattern(found.result, found.table);
    res.json({ success: true, table: found.table, phien: (found.round || found.result.length) + 1, dudoan: analysis.prediction, dotincay: `${analysis.confidence}%`, pattern: analysis.pattern, ket_qua_gan_nhat: found.result.slice(-20) });
});

// ======================
// KHỞI ĐỘNG
// ======================
async function start() {
    loadStats();
    console.log('--- BACCARAT API SERVER (FULL AI ENGINE + FIXED STATS) ---');
    console.log('Đang đăng nhập...');
    if (!await login()) { console.error('Login thất bại!'); process.exit(1); }
    await goToLobby();
    console.log('Đang lấy dữ liệu...');
    await fetchBaccaratData();
    console.log(`Đã lấy ${baccaratData.length} bàn`);

    setInterval(fetchBaccaratData, 3000); // Tự động update mỗi 3s

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server chạy tại cổng ${PORT}`);
    });
}

start();
