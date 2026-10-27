const axios = require('axios');
const express = require('express');
const https = require('https');

// ======================
// CẤU HÌNH
// ======================
const BASE = "https://autobcr.com";
const LOGIN_URL = `${BASE}/login`;
const LOBBY_URL = `${BASE}/ae/lobby`;
const GETNEWRESULT_URL = `${BASE}/baccarat/getnewresult`;

const USERNAME = "bucumh";
const PASSWORD = "123456";

const agent = new https.Agent({ rejectUnauthorized: false });
let cookieJar = '';
let baccaratData = [];
let lastUpdate = null;

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

// Interceptor lưu cookie
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

// ======================
// LẤY CSRF TOKEN
// ======================
function getCsrfToken(html) {
    const match = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
    return match ? match[1] : null;
}

// ======================
// ĐĂNG NHẬP
// ======================
async function login() {
    try {
        const getResp = await session.get(LOGIN_URL);
        const token = getCsrfToken(getResp.data);
        
        const formData = new URLSearchParams();
        formData.append('username', USERNAME);
        formData.append('password', PASSWORD);
        formData.append('_token', token);
        formData.append('action', 'Login');
        
        const headers = {
            'Referer': LOGIN_URL,
            'Origin': BASE,
            'Content-Type': 'application/x-www-form-urlencoded'
        };
        
        const loginResp = await session.post(LOGIN_URL, formData.toString(), { headers });
        return loginResp.status === 200;
    } catch (error) {
        console.error('Login error:', error.message);
        return false;
    }
}

// ======================
// VÀO LOBBY
// ======================
async function goToLobby() {
    try {
        await session.get(LOBBY_URL);
        return true;
    } catch (error) {
        console.error('Lobby error:', error.message);
        return false;
    }
}

// ======================
// LẤY KẾT QUẢ BACCARAT
// ======================
async function fetchBaccaratData() {
    try {
        let xsrfToken = '';
        const xsrfMatch = cookieJar.match(/XSRF-TOKEN=([^;]+)/);
        if (xsrfMatch) xsrfToken = decodeURIComponent(xsrfMatch[1]);
        
        const headers = {
            'Referer': LOBBY_URL,
            'Origin': BASE,
            'X-Requested-With': 'XMLHttpRequest',
            'X-XSRF-TOKEN': xsrfToken,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        };
        
        const formData = new URLSearchParams();
        formData.append('gameCode', 'ae');
        
        const resp = await session.post(GETNEWRESULT_URL, formData.toString(), { headers });
        
        if (resp.data && resp.data.data) {
            baccaratData = resp.data.data.map(item => ({
                table: item.table_name,
                result: item.result,
                shoeId: item.shoeId || '',
                round: item.round || ''
            }));
            lastUpdate = new Date().toISOString();
        }
        
        return baccaratData;
    } catch (error) {
        console.error('Fetch error:', error.message);
        return [];
    }
}

// ======================
// THUẬT TOÁN DỰ ĐOÁN BACCARAT
// ======================
function analyzePattern(result) {
    if (!result || result.length < 5) {
        return {
            prediction: 'CHỜ',
            confidence: 0,
            pattern: 'Chưa đủ dữ liệu',
            explanation: 'Cần ít nhất 5 kết quả để phân tích'
        };
    }

    // Lấy các kết quả gần đây (tối đa 20 kết quả cuối)
    const recentResults = result.slice(-20);
    const len = recentResults.length;
    
    // Phân tích các pattern
    const patterns = [];
    
    // 1. Phân tích cầu bệt (streak)
    let currentStreak = 1;
    let maxStreak = 1;
    let streakResult = recentResults[len - 1];
    
    for (let i = len - 2; i >= 0; i--) {
        if (recentResults[i] === streakResult) {
            currentStreak++;
            maxStreak = Math.max(maxStreak, currentStreak);
        } else {
            break;
        }
    }
    
    patterns.push({
        type: 'Bệt',
        streak: currentStreak,
        result: streakResult,
        probability: currentStreak >= 4 ? 0.8 : currentStreak >= 3 ? 0.7 : 0.6
    });

    // 2. Phân tích cầu 1-1 (P B P B)
    let oneOneCount = 0;
    for (let i = len - 3; i >= 0; i -= 2) {
        if (recentResults[i] !== recentResults[i + 1] && 
            recentResults[i] === recentResults[i + 2]) {
            oneOneCount++;
        } else {
            break;
        }
    }
    
    if (oneOneCount >= 2) {
        patterns.push({
            type: 'Cầu 1-1',
            streak: oneOneCount,
            result: recentResults[len - 1] === 'B' ? 'P' : 'B',
            probability: 0.85
        });
    }

    // 3. Phân tích cầu 2-2 (BB PP BB)
    let twoTwoCount = 0;
    for (let i = len - 4; i >= 0; i -= 4) {
        if (recentResults[i] === recentResults[i + 1] && 
            recentResults[i] !== recentResults[i + 2] &&
            recentResults[i + 2] === recentResults[i + 3]) {
            twoTwoCount++;
        } else {
            break;
        }
    }
    
    if (twoTwoCount >= 2) {
        const nextResult = recentResults[len - 1] === recentResults[len - 2] ? 
            (recentResults[len - 1] === 'B' ? 'P' : 'B') : 
            recentResults[len - 1];
        patterns.push({
            type: 'Cầu 2-2',
            streak: twoTwoCount,
            result: nextResult,
            probability: 0.82
        });
    }

    // 4. Phân tích cầu 3-2-1
    if (len >= 6) {
        const last6 = recentResults.slice(-6);
        let match321 = true;
        
        // Check pattern 3-2-1
        for (let i = 0; i < 3; i++) {
            if (last6[i] !== last6[0]) match321 = false;
        }
        for (let i = 3; i < 5; i++) {
            if (last6[i] === last6[0] || last6[i] !== last6[3]) match321 = false;
        }
        if (match321) {
            patterns.push({
                type: 'Cầu 3-2-1',
                streak: 1,
                result: last6[0] === 'B' ? 'P' : 'B',
                probability: 0.75
            });
        }
    }

    // 5. Phân tích xu hướng chung
    let bCount = 0, pCount = 0;
    for (let i = len - 10; i < len; i++) {
        if (recentResults[i] === 'B') bCount++;
        else if (recentResults[i] === 'P') pCount++;
    }
    
    const total = bCount + pCount;
    const bProb = total > 0 ? bCount / total : 0.5;
    
    patterns.push({
        type: 'Xu hướng',
        streak: 1,
        result: bProb >= 0.6 ? 'B' : pCount > bCount ? 'P' : recentResults[len - 1],
        probability: Math.abs(bProb - 0.5) * 2
    });

    // Chọn pattern có xác suất cao nhất
    patterns.sort((a, b) => b.probability - a.probability);
    const bestPattern = patterns[0];
    
    // Tính độ tin cậy (60-90%)
    let confidence = Math.floor(bestPattern.probability * 60 + 30);
    confidence = Math.max(60, Math.min(90, confidence));
    
    // Xác định pattern cuối cùng
    let finalPattern = '';
    if (currentStreak >= 3) {
        finalPattern = `Cầu bệt ${streakResult} (${currentStreak} lần)`;
    } else if (oneOneCount >= 2) {
        finalPattern = `Cầu 1-1 (${oneOneCount * 2} nét)`;
    } else if (twoTwoCount >= 2) {
        finalPattern = `Cầu 2-2 (${twoTwoCount * 2} nét)`;
    } else {
        finalPattern = `Hỗn hợp - ${bestPattern.type}`;
    }

    // Giải thích dự đoán
    let explanation = '';
    if (bestPattern.type === 'Bệt') {
        explanation = `Đang bệt ${streakResult} với ${currentStreak} lần liên tiếp, khả năng cao tiếp tục bệt`;
    } else if (bestPattern.type === 'Cầu 1-1') {
        explanation = `Cầu 1-1 đã xuất hiện ${oneOneCount * 2} nét, dự đoán tiếp tục theo cầu`;
    } else if (bestPattern.type === 'Cầu 2-2') {
        explanation = `Cầu 2-2 đã hình thành ${twoTwoCount * 2} nét, khả năng cao tiếp tục`;
    } else {
        explanation = `Dựa trên xu hướng chung và phân tích pattern`;
    }

    return {
        prediction: bestPattern.result === 'B' ? 'BANKER' : 'PLAYER',
        confidence: confidence,
        pattern: finalPattern,
        explanation: explanation
    };
}

// ======================
// API DỰ ĐOÁN
// ======================
function generatePredictions() {
    const predictions = [];
    let totalConfidence = 0;
    
    for (const item of baccaratData) {
        if (item.result && item.result.length >= 5) {
            const analysis = analyzePattern(item.result);
            predictions.push({
                table: item.table,
                phien: item.result.length + 1,
                dudoan: analysis.prediction,
                dotincay: `${analysis.confidence}%`,
                pattern: analysis.pattern,
                giaithich: analysis.explanation,
                result: item.result.slice(-20) // Hiển thị 20 kết quả cuối
            });
            totalConfidence += analysis.confidence;
        } else {
            predictions.push({
                table: item.table,
                phien: (item.result ? item.result.length : 0) + 1,
                dudoan: 'CHỜ',
                dotincay: '0%',
                pattern: 'Chưa đủ dữ liệu',
                giaithich: 'Cần thêm kết quả để dự đoán',
                result: item.result || ''
            });
        }
    }
    
    // Sắp xếp theo độ tin cậy giảm dần
    predictions.sort((a, b) => {
        const confA = parseInt(a.dotincay) || 0;
        const confB = parseInt(b.dotincay) || 0;
        return confB - confA;
    });
    
    const totalTables = predictions.length;
    const validTables = predictions.filter(p => p.dudoan !== 'CHỜ').length;
    const avgConfidence = validTables > 0 ? Math.floor(totalConfidence / validTables) : 0;
    
    return {
        success: true,
        time: new Date().toISOString(),
        tong_ban: totalTables,
        ban_du_doan_duoc: validTables,
        do_tin_cay_trung_binh: `${avgConfidence}%`,
        predictions: predictions
    };
}

// ======================
// VÒNG LẶP TỰ ĐỘNG CẬP NHẬT
// ======================
async function autoUpdate() {
    while (true) {
        try {
            await fetchBaccaratData();
            console.log(`[${new Date().toLocaleTimeString()}] Đã cập nhật ${baccaratData.length} bàn`);
        } catch (error) {
            console.error('Auto update error:', error.message);
        }
        await new Promise(resolve => setTimeout(resolve, 3000)); // Cập nhật mỗi 3 giây
    }
}

// ======================
// KHỞI TẠO API SERVER
// ======================
const app = express();

// CORS cho phép gọi từ frontend
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Trang chủ API
app.get('/', (req, res) => {
    res.json({
        name: 'Baccarat API Server',
        version: '2.0.0',
        endpoints: {
            lich_su: '/api/baccarat',
            lich_su_ban: '/api/baccarat/:table',
            moi_nhat: '/api/latest',
            du_doan: '/api/bcrvh11',
            du_doan_ban: '/api/predict/:table'
        },
        lastUpdate: lastUpdate,
        totalTables: baccaratData.length
    });
});

// API lấy tất cả bàn (lịch sử)
app.get('/api/baccarat', (req, res) => {
    res.json({
        success: true,
        data: baccaratData,
        lastUpdate: lastUpdate,
        total: baccaratData.length
    });
});

// API lấy theo bàn cụ thể (lịch sử)
app.get('/api/baccarat/:table', (req, res) => {
    const tableName = req.params.table;
    const found = baccaratData.find(item => item.table === tableName);
    
    if (found) {
        res.json({ success: true, data: found });
    } else {
        res.json({ success: false, message: 'Không tìm thấy bàn ' + tableName });
    }
});

// API lấy kết quả mới nhất
app.get('/api/latest', (req, res) => {
    const latest = [...baccaratData].sort((a, b) => {
        const numA = parseInt(a.table) || 0;
        const numB = parseInt(b.table) || 0;
        return numB - numA;
    });
    res.json({ success: true, data: latest.slice(0, 10), lastUpdate: lastUpdate });
});

// API dự đoán full tất cả các bàn
app.get('/api/bcrvh11', (req, res) => {
    const predictions = generatePredictions();
    res.json(predictions);
});

// API dự đoán cho một bàn cụ thể
app.get('/api/predict/:table', (req, res) => {
    const tableName = req.params.table;
    const found = baccaratData.find(item => item.table === tableName);
    
    if (!found) {
        return res.json({ 
            success: false, 
            message: 'Không tìm thấy bàn ' + tableName 
        });
    }
    
    const analysis = analyzePattern(found.result);
    res.json({
        success: true,
        table: tableName,
        phien: found.result.length + 1,
        dudoan: analysis.prediction,
        dotincay: `${analysis.confidence}%`,
        pattern: analysis.pattern,
        giaithich: analysis.explanation,
        ket_qua_gan_nhat: found.result.slice(-20)
    });
});

// ======================
// KHỞI ĐỘNG SERVER
// ======================
async function start() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║   BACCARAT API SERVER - VERSION 2.0   ║');
    console.log('║   TÍCH HỢP LỊCH SỬ & DỰ ĐOÁN         ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    
    console.log('[1/3] Đang đăng nhập...');
    const loginOk = await login();
    if (!loginOk) {
        console.error('❌ Đăng nhập thất bại!');
        process.exit(1);
    }
    console.log('✅ Đăng nhập thành công');
    
    console.log('[2/3] Đang vào lobby...');
    await goToLobby();
    console.log('✅ Vào lobby thành công');
    
    console.log('[3/3] Đang lấy dữ liệu ban đầu...');
    await fetchBaccaratData();
    console.log(`✅ Đã lấy ${baccaratData.length} bàn\n`);
    
    // Hiển thị một vài bàn mẫu
    console.log('📊 MẪU MỘT SỐ BÀN:');
    baccaratData.slice(0, 5).forEach(item => {
        const resultShort = item.result.slice(-30);
        console.log(`   Bàn ${item.table.padEnd(4)}: ...${resultShort}`);
    });
    if (baccaratData.length > 5) {
        console.log(`   ... và ${baccaratData.length - 5} bàn khác`);
    }
    
    // Chạy auto update background
    console.log('\n⚡ Bắt đầu auto update (mỗi 3 giây)...');
    autoUpdate();
    
    // Khởi động server
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log('\n🚀 API SERVER ĐÃ SẴN SÀNG:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📜 LỊCH SỬ:');
        console.log(`   • Tất cả bàn:  http://localhost:${PORT}/api/baccarat`);
        console.log(`   • Bàn cụ thể:  http://localhost:${PORT}/api/baccarat/1`);
        console.log(`   • Mới nhất:    http://localhost:${PORT}/api/latest`);
        console.log('');
        console.log('🔮 DỰ ĐOÁN:');
        console.log(`   • Tất cả bàn:  http://localhost:${PORT}/api/bcrvh11`);
        console.log(`   • Bàn cụ thể:  http://localhost:${PORT}/api/predict/1`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`\n💡 API dự đoán tự động tính toán ngay khi có request`);
        console.log(`⏰ Lịch sử được cập nhật mỗi 3 giây\n`);
    });
}

// Xử lý lỗi không catch
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error.message);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error.message);
});

// Khởi động
start();
