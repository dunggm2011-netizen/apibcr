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
let pendingPredictions = {}; // { "table_1": { pred: "PLAYER", round: 123 } }
let lastRounds = {}; // { "table_1": 123 } - Lưu round trước đó để check ván mới

function loadStats() {
    if (fs.existsSync(STATS_FILE)) {
        try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) {}
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

            // === KIỂM TRA VÁN MỚI ĐỂ CHẤM ĐIỂM ===
            for (const table of newData) {
                const tableName = table.table;
                const currentRound = table.round || table.result.length;
                const lastRound = lastRounds[tableName];

                if (lastRound !== undefined && currentRound > lastRound) {
                    // Có ván mới, check dự đoán cũ
                    const pending = pendingPredictions[tableName];
                    if (pending) {
                        const actualResult = table.result.slice(-1); // Lấy kết quả mới nhất (P hoặc B)
                        const isWin = (pending.pred === 'PLAYER' && actualResult === 'P') || 
                                      (pending.pred === 'BANKER' && actualResult === 'B');
                        
                        const tStats = getTableStats(tableName);
                        tStats.total++;
                        if (isWin) tStats.win++;
                        else tStats.loss++;
                        tStats.rate = (tStats.win / tStats.total * 100).toFixed(1);
                        tStats.history.push(isWin ? 'W' : 'L');
                        if (tStats.history.length > 50) tStats.history.shift();
                        saveStats();
                    }
                }
                lastRounds[tableName] = currentRound;
            }

            // Ghi đè data mới
            baccaratData = newData;
            lastUpdate = new Date().toISOString();

            // Cập nhật dự đoán cho ván tới
            for (const item of baccaratData) {
                const analysis = analyzePattern(item.result);
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
// THUẬT TOÁN 12 MODELS
// ======================
const PATTERNS = {
    "PP": "P", "PB": "B", "BP": "B", "BB": "P",
    "PPP": "B", "PPB": "P", "PBP": "B", "PBB": "P",
    "BPP": "B", "BPB": "P", "BBP": "P", "BBB": "B",
    "PPPP": "P", "PPPB": "B", "PPBP": "P", "PPBB": "B"
};
const MIN_HISTORY = 2;
let weights = {
    "streak": 1.0, "alt_1_1": 1.0, "alt_2_1": 1.0, "alt_2_2": 1.0,
    "nghieng": 1.0, "xu_huong_ngan": 1.0, "dao_cau": 1.0,
    "markov1": 1.0, "markov2": 1.0, "ngram": 1.0,
    "pattern_library": 1.5, "momentum": 1.0,
};

function countOccurrences(arr) {
    return arr.reduce((acc, val) => { acc[val] = (acc[val] || 0) + 1; return acc; }, {});
}

function algo_streak(hist) {
    if (hist.length < 4) return [null, 0, ""];
    const last = hist[hist.length - 1];
    let streak = 1;
    for (let i = hist.length - 2; i >= 0; i--) {
        if (hist[i] === last) streak++; else break;
    }
    if (streak >= 5) return [(last === "B" ? "P" : "B"), Math.min(88 + (streak - 5) * 2, 95), `Bẻ bệt ${streak}`];
    if (streak === 4) return [(last === "B" ? "P" : "B"), 78, "Bẻ bệt 4"];
    if (streak === 3) return [last, 65, `Theo bệt ${streak}`];
    return [null, 0, ""];
}

function algo_alt_1_1(hist) {
    if (hist.length < 8) return [null, 0, ""];
    const recent = hist.slice(-10);
    let errors = 0;
    for (let i = 0; i < recent.length - 1; i++) if (recent[i] === recent[i + 1]) errors++;
    if (errors === 0) return [(hist[hist.length - 1] === "B" ? "P" : "B"), 82, "Cầu 1-1 hoàn hảo"];
    if (errors <= 2 && recent.length >= 8) return [(hist[hist.length - 1] === "B" ? "P" : "B"), 72, "Cầu 1-1 (gần)"];
    return [null, 0, ""];
}

function algo_alt_2_1(hist) {
    if (hist.length < 9) return [null, 0, ""];
    const h = hist.slice(-12);
    let ok = true;
    for (let i = 0; i < 9; i += 3) {
        if (i + 2 >= h.length) break;
        if (!(h[i] === h[i+1] && h[i] !== h[i+2])) { ok = false; break; }
    }
    if (ok) return [(h[h.length - 1] === "B" ? "P" : "B"), 78, "Cầu 2-1"];
    ok = true;
    for (let i = 0; i < 9; i += 3) {
        if (i + 2 >= h.length) break;
        if (!(h[i] !== h[i+1] && h[i+1] === h[i+2])) { ok = false; break; }
    }
    if (ok) return [h[h.length - 1], 76, "Cầu 1-2"];
    return [null, 0, ""];
}

function algo_alt_2_2(hist) {
    if (hist.length < 8) return [null, 0, ""];
    const h = hist.slice(-12);
    let pairs = [];
    for (let i = 0; i < Math.min(10, h.length); i += 2) if (i + 1 < h.length) pairs.push([h[i], h[i+1]]);
    if (pairs.length >= 3) {
        const allSame = pairs.every(p => p[0] === p[1]);
        let alternating = true;
        for (let i = 0; i < pairs.length - 1; i++) if (pairs[i][0] === pairs[i+1][0]) { alternating = false; break; }
        if (allSame && alternating) return [pairs[pairs.length - 1][0], 80, "Cầu 2-2"];
    }
    return [null, 0, ""];
}

function algo_nghieng(hist) {
    if (hist.length < 15) return [null, 0, ""];
    const recent = hist.slice(-20); const counts = countOccurrences(recent); const total = recent.length;
    for (const [side, num] of Object.entries(counts)) {
        if (side === "P" || side === "B") {
            const ratio = num / total;
            if (ratio >= 0.70) return [side, Math.min(Math.floor(65 + ratio * 30), 92), `Nghiêng ${side} (${num}/${total})`];
        }
    }
    return [null, 0, ""];
}

function algo_xu_huong_ngan(hist) {
    if (hist.length < 8) return [null, 0, ""];
    const recent = hist.slice(-8); const counts = countOccurrences(recent);
    let most = null, maxNum = 0;
    for (const [k, v] of Object.entries(counts)) if ((k === "P" || k === "B") && v > maxNum) { most = k; maxNum = v; }
    if (most && maxNum >= 6) return [most, 70 + maxNum * 2, `Xu hướng ngắn ${most} (${maxNum}/8)`];
    return [null, 0, ""];
}

function algo_dao_cau(hist) {
    if (hist.length < 6) return [null, 0, ""];
    const l = hist.length;
    if (hist[l-1] === hist[l-2] && hist[l-2] === hist[l-3]) return [(hist[l-1] === "B" ? "P" : "B"), 78, "Đảo cầu (3)"];
    if (hist[l-1] === hist[l-2]) {
        if (l >= 5 && hist[l-3] === hist[l-1]) return [(hist[l-1] === "B" ? "P" : "B"), 70, "Đảo cầu (2+)"];
    }
    return [null, 0, ""];
}

function algo_markov1(hist) {
    if (hist.length < 6) return [null, 0, ""];
    const last = hist[hist.length - 1];
    const trans = { P: { P: 0, B: 0 }, B: { P: 0, B: 0 } };
    for (let i = 0; i < hist.length - 1; i++) {
        const cur = hist[i], nxt = hist[i+1];
        if (trans[cur] && trans[cur][nxt] !== undefined) trans[cur][nxt]++;
    }
    const total = trans[last].P + trans[last].B;
    if (total < 3) return [null, 0, ""];
    if (trans[last].P > trans[last].B) return ["P", Math.min(65 + trans[last].P * 3, 85), `Markov1 P (${trans[last].P}/${total})`];
    return ["B", Math.min(65 + trans[last].B * 3, 85), `Markov1 B (${trans[last].B}/${total})`];
}

function algo_markov2(hist) {
    if (hist.length < 8) return [null, 0, ""];
    const last2 = hist[hist.length - 2] + hist[hist.length - 1];
    const trans = {};
    for (let i = 0; i < hist.length - 2; i++) {
        const key = hist[i] + hist[i+1];
        const nxt = hist[i+2];
        if (!trans[key]) trans[key] = { P: 0, B: 0 };
        if (trans[key][nxt] !== undefined) trans[key][nxt]++;
    }
    if (!trans[last2]) return [null, 0, ""];
    const total = trans[last2].P + trans[last2].B;
    if (total < 2) return [null, 0, ""];
    if (trans[last2].P > trans[last2].B) return ["P", Math.min(68 + total * 2, 88), `Markov2 P (${trans[last2].P}/${total})`];
    return ["B", Math.min(68 + total * 2, 88), `Markov2 B (${trans[last2].B}/${total})`];
}

function algo_ngram(hist) {
    if (hist.length < 5) return [null, 0, ""];
    for (const n of [4, 3]) {
        if (hist.length < n + 1) continue;
        const pattern = hist.slice(-n).join("");
        const matches = [];
        for (let i = 0; i < hist.length - n - 1; i++) {
            if (hist.slice(i, i + n).join("") === pattern) matches.push(hist[i + n]);
        }
        if (matches.length >= 2) {
            const counts = countOccurrences(matches);
            let most = null, maxNum = 0;
            for (const [k, v] of Object.entries(counts)) if (v > maxNum) { most = k; maxNum = v; }
            if (maxNum >= 2) return [most, Math.min(70 + maxNum * 3, 90), `N-gram ${n} (${most} ${maxNum}/${matches.length})`];
        }
    }
    return [null, 0, ""];
}

function algo_pattern_library(hist) {
    if (hist.length < 3) return [null, 0, ""];
    for (let n = Math.min(7, hist.length); n >= 3; n--) {
        const pattern = hist.slice(-n).join("");
        if (PATTERNS[pattern]) return [PATTERNS[pattern], Math.min(78 + n * 2, 94), `PatternLib (${pattern}->${PATTERNS[pattern]})`];
    }
    return [null, 0, ""];
}

function algo_momentum(hist) {
    if (hist.length < 10) return [null, 0, ""];
    const recent = hist.slice(-10);
    let score = 0;
    for (let i = 0; i < recent.length; i++) {
        if (recent[i] === "P") score += (10 - i) * 0.5;
        else score -= (10 - i) * 0.5;
    }
    if (score > 15) return ["P", 65 + Math.min(score / 2, 20), `Momentum P (+${score.toFixed(0)})`];
    if (score < -15) return ["B", 65 + Math.min(Math.abs(score) / 2, 20), `Momentum B (${score.toFixed(0)})`];
    return [null, 0, ""];
}

// ======================
// HÀM DỰ ĐOÁN TỔNG HỢP
// ======================
function analyzePattern(resultArray) {
    let hist = [];
    if (typeof resultArray === 'string') {
        hist = resultArray.split('').filter(c => c === 'P' || c === 'B');
    } else if (Array.isArray(resultArray)) {
        hist = resultArray;
    }

    if (hist.length < MIN_HISTORY) {
        return { prediction: 'CHỜ', confidence: 0, pattern: 'Chưa đủ dữ liệu', explanation: 'Cần thêm kết quả' };
    }

    const models = [
        ["streak", algo_streak], ["alt_1_1", algo_alt_1_1],
        ["alt_2_1", algo_alt_2_1], ["alt_2_2", algo_alt_2_2],
        ["nghieng", algo_nghieng], ["xu_huong_ngan", algo_xu_huong_ngan],
        ["dao_cau", algo_dao_cau], ["markov1", algo_markov1],
        ["markov2", algo_markov2], ["ngram", algo_ngram],
        ["pattern_library", algo_pattern_library], ["momentum", algo_momentum],
    ];

    let results = [];
    for (const [name, func] of models) {
        try {
            const [pred, conf, reason] = func(hist);
            if (pred && conf > 0) {
                const w = weights[name] || 1.0;
                const adj = Math.min(conf * w, 97);
                results.push({ pred, adj, reason, name });
            }
        } catch (e) {}
    }

    if (results.length === 0) {
        return { prediction: hist[hist.length - 1] === 'P' ? 'PLAYER' : 'BANKER', confidence: 55, pattern: 'Theo ván gần nhất', explanation: 'Không có cầu rõ ràng' };
    }

    let score = { P: 0, B: 0 };
    results.forEach(r => { score[r.pred] += r.adj; });

    const finalPred = score.P > score.B ? 'P' : 'B';
    const totalScore = score.P + score.B;
    let totalConf = (score[finalPred] / totalScore) * 100 * 1.2;
    totalConf = Math.min(96, totalConf);

    const best = results.reduce((prev, current) => (prev.adj > current.adj) ? prev : current);
    const mainReason = best ? best.reason : "Tổng hợp";

    return { prediction: finalPred === 'P' ? 'PLAYER' : 'BANKER', confidence: Math.round(totalConf), pattern: mainReason, explanation: `Ưu tiên: ${mainReason}` };
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
        const analysis = analyzePattern(item.result);
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
        lich_su: tStats.history.slice(-20) // Trả về 20 kết quả gần nhất dạng W/L
    });
});

// Endpoint Dự đoán 1 bàn
app.get('/api/predict/:table', (req, res) => {
    const found = baccaratData.find(item => item.table === req.params.table);
    if (!found) return res.json({ success: false, message: 'Không tìm thấy bàn' });

    const analysis = analyzePattern(found.result);
    res.json({ success: true, table: found.table, phien: (found.round || found.result.length) + 1, dudoan: analysis.prediction, dotincay: `${analysis.confidence}%`, pattern: analysis.pattern, ket_qua_gan_nhat: found.result.slice(-20) });
});

// ======================
// KHỞI ĐỘNG
// ======================
async function start() {
    loadStats();
    console.log('--- BACCARAT API SERVER (12 MODELS) ---');
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
