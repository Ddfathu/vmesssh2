#!/usr/bin/env node

const http = require("http");
const url = require("url");
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const execPromise = promisify(require('child_process').exec);
const { exec, execSync } = require('child_process');

// ========================================================
// VARIABEL KONFIGURASI GLOBAL
// ========================================================
const FILE_PATH = process.env.FILE_PATH || '.tmp';   
const SUB_PATH = process.env.SUB_PATH || 'sub';       
const PORT = 8081; 
const UUID = process.env.UUID || '1f37ac4f-fdd0-49df-9406-1eda70a1d512'; 
const ARGO_PORT = 8001;            
const CFPORT = process.env.CFPORT || 443;                  
const NAME = process.env.NAME || 'ddfathu';                        

const LOG_PATH = path.join(FILE_PATH, "boot.log"); 
const ZT_LOG_PATH = "/tmp/named_tunnel.log";
const ZT_SINGLE_TOKEN_FILE = "/tmp/zt_single_token.txt";
const CFIP_FILE = "/tmp/cfip.txt";
const NET_SETTING_FILE = "/tmp/net_settings.json";
const WS_PROXY_CONFIG_FILE = "/tmp/ws_proxy_config.json";
const SYSTEM_CONFIG_FILE = "/tmp/system_config.json";

const ADMIN_PASS_FILE = "/tmp/admin_pass.txt";
const STATS_PATH = "/tmp/server_stats.json";
const DB_PATH = "/tmp/ssh_details.json";

let cachedDiskUsage = "38%";
let cachedSshOnline = "0 User";
let cachedUserListDetails = "Semua user offline";

if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH);
}

// ========================================================
// HELPER NETWORK, WS-PROXY & SYSTEM CONFIG
// ========================================================
function getNetworkSettings() {
    try {
        if (fs.existsSync(NET_SETTING_FILE)) {
            return JSON.parse(fs.readFileSync(NET_SETTING_FILE, 'utf8'));
        }
    } catch(e) {}
    return { dns_type: "udp", custom_dns: "8.8.8.8", engine: "ws" };
}

function saveNetworkSettings(dns_type, custom_dns, engine) {
    try {
        fs.writeFileSync(NET_SETTING_FILE, JSON.stringify({ dns_type, custom_dns, engine }, null, 2));
    } catch(e) {}
}

function getWsProxyConfig() {
    try {
        if (fs.existsSync(WS_PROXY_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(WS_PROXY_CONFIG_FILE, 'utf8'));
        }
    } catch (e) {}
    return { sshPort: 22, keepAlive: 15000, maxBuffer: 32768 };
}

function saveWsProxyConfig(sshPort, keepAlive, maxBuffer) {
    try {
        const data = {
            sshPort: parseInt(sshPort) || 22,
            keepAlive: parseInt(keepAlive) || 15000,
            maxBuffer: parseInt(maxBuffer) || 32768
        };
        fs.writeFileSync(WS_PROXY_CONFIG_FILE, JSON.stringify(data, null, 2));
    } catch(e) {}
}

function getSystemSettings() {
    try {
        if (fs.existsSync(SYSTEM_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(SYSTEM_CONFIG_FILE, 'utf8'));
        }
    } catch(e) {}
    return { banner: "", enable_bbr: "true", udpgw_port: "7300", udpgw_max_clients: "1000" };
}

function saveSystemSettings(banner, enable_bbr, udpgw_port, udpgw_max_clients) {
    try {
        const data = {
            banner: banner || "",
            enable_bbr: enable_bbr || "true",
            udpgw_port: udpgw_port || "7300",
            udpgw_max_clients: udpgw_max_clients || "1000"
        };
        fs.writeFileSync(SYSTEM_CONFIG_FILE, JSON.stringify(data, null, 2));
    } catch(e) {}
}

function getActiveCfip() {
    try {
        if (fs.existsSync(CFIP_FILE)) {
            const savedIp = fs.readFileSync(CFIP_FILE, 'utf8').trim();
            if (savedIp) return savedIp;
        }
    } catch(e) {}
    return process.env.CFIP || '104.17.3.81';
}

function getAdminPassword() {
    try {
        if (fs.existsSync(ADMIN_PASS_FILE)) {
            return fs.readFileSync(ADMIN_PASS_FILE, 'utf8').trim();
        }
    } catch (e) {}
    return process.env.ADMIN_PASSWORD || null;
}

function verifyAdminPassword(passInput) {
    const currentPass = getAdminPassword();
    if (!currentPass) return false;
    return currentPass === passInput;
}

function generateRandomName() {
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

let subContent = null;
const webName = generateRandomName();
const botName = generateRandomName();
let webPath = path.join(FILE_PATH, webName);
let botPath = path.join(FILE_PATH, botName);
let subPath = path.join(FILE_PATH, 'sub.txt');

function loadDb() {
    if (fs.existsSync(DB_PATH)) {
        try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) { return {}; }
    }
    return {};
}
function saveDb(data) {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch (e) {}
}

let currentActiveDomain = '';

function restartSingleTunnel(newToken) {
    exec("pkill -9 -f 'cloudflared'", () => {
        setTimeout(() => {
            if (newToken && newToken.trim()) {
                fs.writeFileSync(ZT_SINGLE_TOKEN_FILE, newToken.trim());
                exec(`nohup ${botPath} tunnel run --protocol http2 --no-tls-verify --token "${newToken.trim()}" > ${ZT_LOG_PATH} 2>&1 &`);
            } else {
                if (fs.existsSync(ZT_SINGLE_TOKEN_FILE)) fs.unlinkSync(ZT_SINGLE_TOKEN_FILE);
                if (fs.existsSync(ZT_LOG_PATH)) fs.writeFileSync(ZT_LOG_PATH, "Token Dihapus.");
                let args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile ${LOG_PATH} --loglevel info --url http://localhost:${ARGO_PORT}`;
                exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
            }
        }, 1000);
    });
}

function getDomainsByPort(targetPorts) {
    const domains = [];
    try {
        if (fs.existsSync(ZT_LOG_PATH)) {
            const logContent = fs.readFileSync(ZT_LOG_PATH, 'utf8');
            const portRegexStr = targetPorts.join('|');

            const regexIngress = new RegExp(`(?:\\\\?"|")hostname(?:\\\\?"|")\\s*:\\s*(?:\\\\?"|")([^"\\\\]+)(?:\\\\?"|")[^}]*?localhost:(${portRegexStr})`, 'g');
            let match;
            
            while ((match = regexIngress.exec(logContent)) !== null) {
                const domainName = match[1].trim();
                const portNum = match[2];
                if (!domains.some(d => d.domain === domainName)) {
                    domains.push({ domain: domainName, port: portNum });
                }
            }

            if (domains.length === 0) {
                const regexIngressReverse = new RegExp(`localhost:(${portRegexStr})[^}]*?(?:\\\\?"|")hostname(?:\\\\?"|")\\s*:\\s*(?:\\\\?"|")([^"\\\\]+)(?:\\\\?"|")`, 'g');
                while ((match = regexIngressReverse.exec(logContent)) !== null) {
                    const portNum = match[1];
                    const domainName = match[2].trim();
                    if (!domains.some(d => d.domain === domainName)) {
                        domains.push({ domain: domainName, port: portNum });
                    }
                }
            }
        }
    } catch (e) {}

    return domains;
}

function getCurrentHosts() {
    let hwInfo = {};
    if (fs.existsSync(STATS_PATH)) {
        try { hwInfo = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')); } catch (e) {}
    }
    const ztDomains = getDomainsByPort(['8880', '8881']);
    const namedUrl = ztDomains.length > 0 ? ztDomains[0].domain : (process.env.D || "");
    let quickUrl = currentActiveDomain || "Menunggu Quick Tunnel...";
    
    let hostOutput = "";
    if (namedUrl && !namedUrl.includes("Menghubungkan")) hostOutput += `${namedUrl.replace(/https?:\/\//, '')} (SSH WS)`;
    
    if (process.env.RAILWAY_TCP_PROXY_DOMAIN && process.env.RAILWAY_TCP_PROXY_PORT) {
        const autoTcp = `${process.env.RAILWAY_TCP_PROXY_DOMAIN}:${process.env.RAILWAY_TCP_PROXY_PORT}`;
        hostOutput += hostOutput ? ` dan ini (SSH SNI) ${autoTcp}` : `${autoTcp}`;
    } else if (process.env.SNI) {
        hostOutput += hostOutput ? ` dan ${process.env.SNI.replace(/https?:\/\//, '')}` : `${process.env.SNI.replace(/https?:\/\//, '')}`;
    } else if (hwInfo.railway_proxy && hwInfo.railway_proxy.trim() !== "") {
        hostOutput += hostOutput ? ` dan ${hwInfo.railway_proxy}` : `${hwInfo.railway_proxy}`;
    }
    
    if (!hostOutput) hostOutput = quickUrl.replace(/https?:\/\//, '');
    return hostOutput;
}

function listSsh() {
    try {
        const users = [];
        const dbInfo = loadDb();
        const passwdContent = fs.readFileSync('/etc/passwd', 'utf8');
        const lines = passwdContent.split('\n');
        
        for (let line of lines) {
            if (!line.trim()) continue;
            const parts = line.split(':');
            const username = parts[0];
            const uid = parseInt(parts[2], 10);
            const shell = parts[parts.length - 1];
            
            if (uid >= 1000 && !["nobody", "ubuntu", "sshd", "dropbear", "stunnel"].includes(username)) {
                const extra = dbInfo[username] || { password: "-", ip: "Unknown", user_agent: "Unknown" };
                users.push({ username, uid, shell, ...extra });
            }
        }
        return { status: "success", total: users.length, users: users };
    } catch (e) {
        return { status: "error", message: e.message };
    }
}

function addSsh(username, password, ipAddr, userAgent) {
    if (!username || !password) return { status: "error", message: "Username dan password wajib diisi!" };
    if (!/^[a-zA-Z0-9_-]+$/.test(username) || !/^[a-zA-Z0-9_@.-]+$/.test(password)) {
        return { status: "error", message: "Username/Password mengandung karakter ilegal!" };
    }
    try {
        execSync(`useradd -m -s /bin/bash ${username}`);
        execSync(`echo '${username}:${password}' | chpasswd`);
        
        const dbInfo = loadDb();
        dbInfo[username] = { password, ip: ipAddr, user_agent: userAgent };
        saveDb(dbInfo);
        
        const activeHost = getCurrentHosts();
        const accountDetails = 
            `================================\n` +
            ` ⚡ PREMIUM SSH ACCOUNT CREATED ⚡\n` +
            `================================\n` +
            `🔹 Host SSH  : ${activeHost}\n` +
            `🔹 Port TLS  : 443\n` +
            `🔹 Port NTLS : 80\n` +
            `🔹 Username  : ${username}\n` +
            `🔹 Password  : ${password}\n` +
            `================================\n` +
            ` powered by : d e d e f a t h u\n` +
            `================================`;
        return { status: "success", message: accountDetails };
    } catch (e) {
        return { status: "error", message: `Gagal membuat user. Username mungkin sudah terpakai.` };
    }
}

function deleteSsh(username) {
    if (!username || !/^[a-zA-Z0-9_-]+$/.test(username)) return { status: "error", message: "Username ilegal!" };
    try {
        execSync(`userdel -r ${username}`);
        const dbInfo = loadDb();
        if (dbInfo[username]) {
            delete dbInfo[username];
            saveDb(dbInfo);
        }
        return { status: "success", message: `User ${username} berhasil dihapus!` };
    } catch (e) {
        return { status: "error", message: `Gagal menghapus user.` };
    }
}

function readPathsFromFile(filename, defaultPath) { try { if (fs.existsSync(filename)) { const content = fs.readFileSync(filename, 'utf-8'); const paths = content.split('\n').map(p => p.trim()).filter(p => p.startsWith('/')); if (paths.length > 0) return paths; } } catch (e) {} return [defaultPath]; }

async function generateConfig() {
  const netSettings = getNetworkSettings();
  const vlessPaths = readPathsFromFile('pathvless.txt', '/vless-argo');
  const vmessPaths = readPathsFromFile('pathvmess.txt', '/vmess-argo');
  const trojanPaths = readPathsFromFile('pathtrojan.txt', '/trojan-argo');
  
  const fallbacksList = [];
  const inboundsList = [];
  let nextPort = 3100;

  const engine = netSettings.engine || 'ws';

  let streamSettingsObj = {};
  if (engine === 'grpc') {
    streamSettingsObj = { network: "grpc", security: "none", grpcSettings: { serviceName: "grpc-service" } };
  } else if (engine === 'h2') {
    streamSettingsObj = { network: "h2", security: "none", httpSettings: { path: "/h2-path", host: ["localhost"] } };
  } else if (engine === 'tcp') {
    streamSettingsObj = { network: "tcp", security: "none" };
  } else {
    streamSettingsObj = { network: "ws", security: "none" };
  }

  vlessPaths.forEach(p => { 
    const cp = nextPort++; 
    fallbacksList.push({ path: p, dest: cp }); 
    let st = JSON.parse(JSON.stringify(streamSettingsObj));
    if (engine === 'ws') st.wsSettings = { path: p };

    inboundsList.push({ 
        port: cp, listen: "127.0.0.1", protocol: 'vless', 
        settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" }, 
        streamSettings: st, 
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] } 
    }); 
  });

  vmessPaths.forEach(p => { 
    const cp = nextPort++; 
    fallbacksList.push({ path: p, dest: cp }); 
    let st = JSON.parse(JSON.stringify(streamSettingsObj));
    if (engine === 'ws') st.wsSettings = { path: p };

    inboundsList.push({ 
        port: cp, listen: "127.0.0.1", protocol: "vmess", 
        settings: { clients: [{ id: UUID, alterId: 0 }] }, 
        streamSettings: st, 
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] } 
    }); 
  });

  trojanPaths.forEach(p => { 
    const cp = nextPort++; 
    fallbacksList.push({ path: p, dest: cp }); 
    let st = JSON.parse(JSON.stringify(streamSettingsObj));
    if (engine === 'ws') st.wsSettings = { path: p };

    inboundsList.push({ 
        port: cp, listen: "127.0.0.1", protocol: "trojan", 
        settings: { clients: [{ password: UUID }] }, 
        streamSettings: st, 
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] } 
    }); 
  });

  inboundsList.unshift({
    port: ARGO_PORT,
    protocol: 'vless',
    settings: { clients: [{ id: UUID }], decryption: 'none', fallbacks: fallbacksList },
    streamSettings: { network: 'tcp', security: 'none' },
    sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] }
  });

  let dnsValue = (netSettings.custom_dns || "").trim();
  let dnsServers = [];

  if (netSettings.dns_type === 'doh') {
    if (!dnsValue.startsWith('http')) dnsValue = 'https://1.1.1.1/dns-query';
    dnsServers = [dnsValue, "8.8.8.8"];
  } else {
    if (!dnsValue || dnsValue.startsWith('http')) dnsValue = '8.8.8.8';
    dnsServers = [dnsValue, "1.1.1.1"];
  }

  const config = { 
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' }, 
    inbounds: inboundsList, 
    dns: { servers: dnsServers }, 
    outbounds: [{ protocol: "freedom", tag: "direct" }] 
  };
  
  fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config, null, 2));
}

function getSystemArchitecture() { return os.arch().includes('arm') ? 'arm' : 'amd'; }
function downloadFile(fileName, fileUrl, callback) {
  if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });
  const writer = fs.createWriteStream(fileName);
  axios({ method: 'get', url: fileUrl, responseType: 'stream' }).then(response => {
    response.data.pipe(writer);
    writer.on('finish', () => { writer.close(); callback(null, fileName); });
    writer.on('error', err => { fs.unlink(fileName, () => {}); callback(err.message); });
  }).catch(err => callback(err.message));
}

async function downloadFilesAndRun() {
  const architecture = getSystemArchitecture();
  const filesToDownload = architecture === 'arm' ? 
    [{ fileName: webPath, fileUrl: "https://arm64.ssss.nyc.mn/web" }, { fileName: botPath, fileUrl: "https://arm64.ssss.nyc.mn/bot" }] :
    [{ fileName: webPath, fileUrl: "https://amd64.ssss.nyc.mn/web" }, { fileName: botPath, fileUrl: "https://amd64.ssss.nyc.mn/bot" }];

  for (let fileInfo of filesToDownload) {
    await new Promise((resolve, reject) => { downloadFile(fileInfo.fileName, fileInfo.fileUrl, (err) => err ? reject(err) : resolve()); });
  }
  fs.chmodSync(webPath, 0o775); fs.chmodSync(botPath, 0o775);

  exec(`nohup ${webPath} -c ${FILE_PATH}/config.json >/dev/null 2>&1 &`);
  
  if (fs.existsSync(ZT_SINGLE_TOKEN_FILE)) {
    const singleToken = fs.readFileSync(ZT_SINGLE_TOKEN_FILE, 'utf8').trim();
    if (singleToken) {
      restartSingleTunnel(singleToken);
    } else {
      let args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile ${LOG_PATH} --loglevel info --url http://localhost:${ARGO_PORT}`;
      exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
    }
  } else {
    let args = `tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile ${LOG_PATH} --loglevel info --url http://localhost:${ARGO_PORT}`;
    exec(`nohup ${botPath} ${args} >/dev/null 2>&1 &`);
  }

  await new Promise(r => setTimeout(r, 5000));
}

async function extractDomains() {
  try {
    if(fs.existsSync(LOG_PATH)) {
      const logContent = fs.readFileSync(LOG_PATH, 'utf-8');
      const match = logContent.match(/https:\/\/([a-zA-Z0-9-]+\.trycloudflare\.com)/);
      if (match) { 
        currentActiveDomain = match[1]; 
        await generateLinks(currentActiveDomain); 
      }
    }
  } catch (e) {}
}

async function getMetaInfo() { try { const res = await axios.get('https://api.ip.sb/geoip'); return `${res.data.country_code}-${res.data.isp}`.replace(/\s+/g, '_'); } catch(e) { return 'RailwayServer'; } }
async function generateLinks(argoDomain) {
  const ISP = await getMetaInfo(); const nodeName = `${NAME}-${ISP}`;
  const activeCfip = getActiveCfip();
  const defaultVless = readPathsFromFile('pathvless.txt', '/vless-argo')[0];
  const defaultVmess = readPathsFromFile('pathvmess.txt', '/vmess-argo')[0];
  const defaultTrojan = readPathsFromFile('pathtrojan.txt', '/trojan-argo')[0];
  
  const VMESS = { v: '2', ps: `${nodeName}`, add: activeCfip, port: CFPORT, id: UUID, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: argoDomain, path: `${defaultVmess}?ed=2560`, tls: 'tls', sni: argoDomain, alpn: '', fp: 'firefox' };
  const subTxt = `vless://${UUID}@${activeCfip}:${CFPORT}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=${encodeURIComponent(defaultVless + '?ed=2560')}#${nodeName}\n\nvmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')}\n\ntrojan://${UUID}@${activeCfip}:${CFPORT}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=${encodeURIComponent(defaultTrojan + '?ed=2560')}#${nodeName}`;
  subContent = Buffer.from(subTxt).toString('base64');
  fs.writeFileSync(subPath, subContent);
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathName = parsedUrl.pathname;
    const query = parsedUrl.query;
    const ipAddr = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || "Unknown IP";
    const userAgent = req.headers['user-agent'] || "Unknown UA";
    
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (pathName === `/${SUB_PATH}`) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(subContent || (fs.existsSync(subPath) ? fs.readFileSync(subPath, 'utf-8') : 'Loading sub...'));
    }

    if (pathName === '/__info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const defaultVless = readPathsFromFile('pathvless.txt', '/vless-argo')[0];
        const defaultVmess = readPathsFromFile('pathvmess.txt', '/vmess-argo')[0];
        const defaultTrojan = readPathsFromFile('pathtrojan.txt', '/trojan-argo')[0];
        return res.end(JSON.stringify({ 
            uuid: UUID, 
            cfip: getActiveCfip(),
            domain: currentActiveDomain || "Menunggu Quick Tunnel...", 
            paths: { vless: defaultVless, vmess: defaultVmess, trojan: defaultTrojan } 
        }));
    }

    if (pathName === '/api/logtunnel') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : "Log belum siap.");
    }

    if (pathName === '/api/lognamed') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (fs.existsSync(ZT_LOG_PATH)) {
            return res.end(fs.readFileSync(ZT_LOG_PATH, 'utf8'));
        } else {
            return res.end("Log Zero Trust belum terbuat atau file /tmp/named_tunnel.log tidak ditemukan.");
        }
    }

    if (pathName === '/api/setup-pass') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const newPass = query.pass ? query.pass.trim() : "";
        const oldPass = query.old_pass ? query.old_pass.trim() : "";
        const currentPass = getAdminPassword();

        if (currentPass) {
            if (oldPass !== currentPass) {
                return res.end(JSON.stringify({ status: "error", message: "Password Admin Lama Salah!" }));
            }
        }
        
        if (!newPass || newPass.length < 4) {
            return res.end(JSON.stringify({ status: "error", message: "Password minimal 4 karakter!" }));
        }

        fs.writeFileSync(ADMIN_PASS_FILE, newPass);
        return res.end(JSON.stringify({ status: "success", message: "Password Admin Berhasil Disimpan/Diubah!" }));
    }

    // 🔑 API ENDPOINT SET NETWORK & CUSTOM DNS
    if (pathName === '/api/set-network') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!verifyAdminPassword(query.pass)) {
            return res.end(JSON.stringify({ status: "error", message: "Akses Ditolak! Anda harus Login Admin terlebih dahulu." }));
        }
        const dns_type = query.dns_type || "udp";
        const custom_dns = query.custom_dns ? decodeURIComponent(query.custom_dns) : "8.8.8.8";
        const engine = query.engine || "ws";
        
        saveNetworkSettings(dns_type, custom_dns, engine);
        await generateConfig();
        
        exec(`pkill -9 -f '${webName}'`, () => {
            setTimeout(() => {
                exec(`nohup ${webPath} -c ${FILE_PATH}/config.json >/dev/null 2>&1 &`);
            }, 1000);
        });

        return res.end(JSON.stringify({ status: "success", message: `Setting V2Ray Disimpan! DNS: [${dns_type.toUpperCase()}] ${custom_dns}, Engine: ${engine.toUpperCase()}. Engine restarted!` }));
    }

    // ⚡ API ENDPOINT SET WS-PROXY SSH CONTROLLER
    if (pathName === '/api/set-wsproxy') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!verifyAdminPassword(query.pass)) {
            return res.end(JSON.stringify({ status: "error", message: "Akses Ditolak! Anda harus Login Admin terlebih dahulu." }));
        }

        saveWsProxyConfig(query.ssh_port, query.keep_alive, query.max_buffer);
        return res.end(JSON.stringify({ status: "success", message: `Setting SSH Disimpan! Target Port: ${query.ssh_port || 22}, KeepAlive: ${query.keep_alive || 15000}ms` }));
    }

    // 🛠️ API ENDPOINT SET SYSTEM CONFIG (BANNER, BBR, UDPGW)
    if (pathName === '/api/set-system') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!verifyAdminPassword(query.pass)) {
            return res.end(JSON.stringify({ status: "error", message: "Akses Ditolak! Anda harus Login Admin terlebih dahulu." }));
        }

        const banner = query.banner ? decodeURIComponent(query.banner) : "";
        const enable_bbr = query.enable_bbr || "true";
        const udpgw_port = query.udpgw_port || "7300";
        const udpgw_max_clients = query.udpgw_max_clients || "1000";

        saveSystemSettings(banner, enable_bbr, udpgw_port, udpgw_max_clients);

        // 1. Update Banner Dropbear Instan
        if (banner) {
            try {
                fs.writeFileSync('/etc/dropbear_banner', banner);
            } catch(e) {
                console.error("Gagal tulis banner:", e);
            }
        } else {
            const defaultBanner = "==================================================\n" +
                                  "          👑 SELAMAT MENIKMATI 👑\n" +
                                  "       🥳 SSH SERVER PAAS RAILWAY 🥳\n" +
                                  "==================================================\n" +
                                  " powered by : d e d e f a t h u\n" +
                                  "==================================================\n";
            try { fs.writeFileSync('/etc/dropbear_banner', defaultBanner); } catch(e){}
        }

        // 2. Restart Dropbear Terpisah
        exec("pkill -9 dropbear", () => {
            setTimeout(() => {
                const wsCfg = getWsProxyConfig();
                const sshPort = wsCfg.sshPort || 22;
                exec(`/usr/sbin/dropbear -p 127.0.0.1:${sshPort} -b /etc/dropbear_banner -W 1048576 -K 15 -I 300`, (err) => {
                    if (err) console.error("Gagal restart Dropbear:", err.message);
                });
            }, 1000);
        });

        // 3. KILL BADVPN UDPGW LAMA & RESTART KE PORT BARU SINKRON
        exec("pkill -9 badvpn-udpgw", () => {
            setTimeout(() => {
                if (fs.existsSync('/usr/local/bin/badvpn-udpgw')) {
                    exec(`nohup /usr/local/bin/badvpn-udpgw --listen-addr 0.0.0.0:${udpgw_port} --max-clients ${udpgw_max_clients} --max-connections-for-client 50 >/dev/null 2>&1 &`);
                }
            }, 1000);
        });

        // 4. Apply BBR Switch
        try {
            if (enable_bbr === "true") {
                exec("sysctl -w net.ipv4.tcp_congestion_control=bbr 2>/dev/null");
            } else {
                exec("sysctl -w net.ipv4.tcp_congestion_control=cubic 2>/dev/null");
            }
        } catch(e) {}

        return res.end(JSON.stringify({ status: "success", message: `System Config Berhasil Disimpan!` }));
    }

    if (pathName === '/api/set-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!verifyAdminPassword(query.pass)) {
            return res.end(JSON.stringify({ status: "error", message: "Akses Ditolak! Anda harus Login Admin terlebih dahulu." }));
        }
        
        const singleToken = query.token !== undefined ? query.token.trim() : null;
        if (singleToken !== null) restartSingleTunnel(singleToken);

        return res.end(JSON.stringify({ status: "success", message: "Perintah restart tunnel terkirim! Tunggu 10 detik..." }));
    }

    if (pathName === '/api/set-cfip') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!verifyAdminPassword(query.pass)) {
            return res.end(JSON.stringify({ status: "error", message: "Akses Ditolak! Anda harus Login Admin terlebih dahulu." }));
        }
        const newIp = query.ip ? query.ip.trim() : "";
        if (newIp) {
            fs.writeFileSync(CFIP_FILE, newIp);
            if (currentActiveDomain) generateLinks(currentActiveDomain);
            return res.end(JSON.stringify({ status: "success", message: `CFIP Berhasil Diperbarui ke: ${newIp}` }));
        } else {
            if (fs.existsSync(CFIP_FILE)) fs.unlinkSync(CFIP_FILE);
            return res.end(JSON.stringify({ status: "success", message: "CFIP Direset ke Default." }));
        }
    }

    if (pathName === '/api/add') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(addSsh(query.user, query.pass, ipAddr, userAgent))); }
    
    if (pathName === '/api/delete') { 
        res.writeHead(200, { 'Content-Type': 'application/json' }); 
        if (!verifyAdminPassword(query.token)) return res.end(JSON.stringify({ status: "error", message: "Akses Ditolak!" })); 
        return res.end(JSON.stringify(deleteSsh(query.user))); 
    }
    
    if (pathName === '/api/list') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(listSsh())); }
    
    if (pathName === '/api/login') { 
        res.writeHead(200, { 'Content-Type': 'application/json' }); 
        const isPassConfigured = getAdminPassword() !== null;
        if (!isPassConfigured) {
            return res.end(JSON.stringify({ status: "not_configured", message: "Password Admin belum pernah dibuat!" }));
        }
        return res.end(JSON.stringify(verifyAdminPassword(query.pass) ? { status: "success", token: query.pass } : { status: "error", message: "Password Salah!" })); 
    }
    
    if (pathName === '/api/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        
        let hwInfo = { 
            cpu_model: os.cpus()[0] ? os.cpus()[0].model : "Unknown Core", 
            ram_total: (os.totalmem()/1024/1024/1024).toFixed(2)+" GB", 
            ram_used: ((os.totalmem()-os.freemem())/1024/1024/1024).toFixed(2)+" GB", 
            disk_usage: cachedDiskUsage, 
            uptime: (os.uptime()/3600).toFixed(2)+" Hours", 
            ssh_online: cachedSshOnline, 
            user_list_details: cachedUserListDetails 
        };
        
        if (fs.existsSync(STATS_PATH)) { try { hwInfo = { ...hwInfo, ...JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')) }; } catch (e) {} }
        
        let quickUrl = currentActiveDomain || "Menunggu Quick Tunnel...";
        let ztSshDomains = getDomainsByPort(['8880', '8881']);
        let ztVmessDomains = getDomainsByPort(['8001']);
        let passConfigured = getAdminPassword() !== null;
        let netSettings = getNetworkSettings();
        let wsProxyCfg = getWsProxyConfig();
        let sysSettings = getSystemSettings();
        
        let rlwyUrl = process.env.RAILWAY_TCP_PROXY_DOMAIN && process.env.RAILWAY_TCP_PROXY_PORT
            ? `${process.env.RAILWAY_TCP_PROXY_DOMAIN}:${process.env.RAILWAY_TCP_PROXY_PORT}`
            : (process.env.SNI || "Tidak Aktif");
        
        let cleanOnlineStr = String(hwInfo.ssh_online).replace(/👥/g, '').replace(/Active/g, '').replace(/Users/g, '').trim();
        return res.end(JSON.stringify({ 
            active_cfip: getActiveCfip(), 
            quick_url: quickUrl, 
            zt_domains: ztSshDomains, 
            zt_vmess_domains: ztVmessDomains, 
            pass_configured: passConfigured, 
            railway_url: rlwyUrl, 
            status: "ONLINE", 
            dns_type: netSettings.dns_type,
            custom_dns: netSettings.custom_dns,
            engine_mode: netSettings.engine,
            ws_proxy_cfg: wsProxyCfg,
            sys_settings: sysSettings,
            ...hwInfo, 
            ssh_online: cleanOnlineStr || "0" 
        }));
    }

    if (pathName === '/' || pathName === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <title>⚡ PREMIUM SSH & VPN PANEL ⚡</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: '-apple-system', BlinkMacSystemFont, sans-serif; background: #000000; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 15px; flex-direction: column;}
        .container { background: #000000; width: 100%; max-width: 500px; padding: 20px; border-radius: 16px; box-shadow: 0 0 20px rgba(56, 189, 248, 0.1); border: 1px solid #111827; margin-bottom: 20px; }
        .header { text-align: center; margin-bottom: 20px; position: relative; }
        h1 { font-size: 20px; color: #38bdf8; text-transform: uppercase; letter-spacing: 1px; }
        .dev-tag { font-size: 11px; color: #64748b; margin-top: 4px; font-weight: bold; }
        .btn-login-trigger { position: absolute; top: 0; right: 0; background: #111827; color: #f8fafc; border: 1px solid #1f2937; padding: 4px 8px; border-radius: 6px; font-size: 10px; cursor: pointer; font-weight: bold; }
        .status-container { text-align: center; margin-bottom: 15px; }
        .status-badge { display: inline-block; background: #0a0a0a; padding: 5px 12px; border-radius: 50px; font-size: 11px; font-weight: bold; border: 1px solid #1f2937; }
        .status-dot { height: 8px; width: 8px; background-color: #4ade80; border-radius: 50%; display: inline-block; margin-right: 6px; box-shadow: 0 0 8px #4ade80; }
        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px; }
        .stat-card { background: #0a0a0a; padding: 12px; border-radius: 8px; border: 1px solid #1f2937; text-align: left; }
        .stat-title { font-size: 11px; color: #94a3b8; text-transform: uppercase; }
        .stat-value { font-size: 14px; font-weight: bold; color: #f1f5f9; margin-top: 4px; }
        .ssh-manager { background: #0a0a0a; padding: 15px; border-radius: 12px; border: 1px solid #1f2937; margin-bottom: 20px; position: relative;}
        .ssh-title { font-size: 13px; font-weight: bold; color: #38bdf8; text-transform: uppercase; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
        .input-group { display: flex; gap: 8px; margin-bottom: 10px; }
        .input-ssh { background: #000000; border: 1px solid #1f2937; padding: 8px 12px; border-radius: 6px; color: #fff; font-size: 13px; width: 100%; outline: none; }
        .select-zt { background: #000000; border: 1px solid #a855f7; padding: 8px 12px; border-radius: 6px; color: #38bdf8; font-size: 13px; width: 100%; font-weight: bold; font-family: monospace; outline: none; margin: 6px 0; }
        .btn-add { background: #38bdf8; color: #090d16; border: none; padding: 8px 15px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 13px; }
        .admin-status-lbl { font-size: 10px; font-weight: bold; color: #38bdf8; background: rgba(56, 189, 248, 0.1); padding: 2px 6px; border-radius: 4px; }
        .result-box { display: none; background: #000000; border: 1px solid #4ade80; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 12px; color: #4ade80; white-wrap: pre-wrap; margin-bottom: 15px; overflow-x: hidden; }
        .btn-copy-result { display: none; background: #4ade80; color: #090d16; border: none; padding: 6px 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 11px; width: 100%; margin-bottom: 15px; }
        .ssh-list { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
        .ssh-list th { text-align: left; padding: 6px; color: #94a3b8; border-bottom: 1px solid #1f2937; }
        .ssh-list td { padding: 6px; border-bottom: 1px solid #111827; vertical-align: middle; }
        .btn-action-group { display: flex; gap: 4px; justify-content: flex-end; }
        .btn-del { background: #ef4444; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; display: none; }
        .btn-info { background: #eab308; color: #090d16; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold; display: none; }
        .url-section { background: #000000; border: 1px solid #38bdf8; padding: 12px; border-radius: 8px; margin-bottom: 12px; text-align: center; }
        .url-box { font-family: monospace; font-size: 13px; word-break: break-all; color: #38bdf8; font-weight: bold; margin: 6px 0; }
        .btn-copy { background: #38bdf8; color: #090d16; border: none; padding: 6px 12px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 11px; width: 100%; }
        .card-blue { background-color: #050a14; border: 1px solid #1e293b; padding: 15px; border-radius: 12px; margin-top: 15px; text-align: left; }
        .btn-blue { background-color: #0f172a; border: 1px solid #1e293b; color: #93c5fd; padding: 8px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; width: 100%; text-align: center; font-family: monospace; }
        .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 8px; }
        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
        .lbl-vpn { font-size: 10px; color: #38bdf8; font-weight: bold; display: block; margin-bottom: 4px; text-transform: uppercase; }
        .border-lbl { border-left: 2px solid #38bdf8; padding-left: 6px; font-size: 11px; font-weight: bold; margin-top: 12px; font-family: monospace; }
        .zt-admin-card { background: #000000; border: 1px solid #8b5cf6; padding: 16px; border-radius: 12px; margin-bottom: 18px; }
        .sub-box { background: #05050a; border: 1px solid #1f1938; padding: 12px; border-radius: 10px; margin-bottom: 12px; }
        .sub-box-title { font-size: 12px; font-weight: bold; color: #38bdf8; margin-bottom: 8px; text-transform: uppercase; }
        .btn-token-trigger { width: 100%; padding: 12px; border-radius: 8px; font-weight: bold; font-size: 13px; cursor: pointer; border: none; text-transform: uppercase; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>👑 SELAMAT DATANG DI PANEL SSH/VPN RAILWAY 👑</h1>
            <div class="dev-tag">DYNAMIC TRIPLE-TUNNEL NODE CORE ACTIVE</div>
            <button class="btn-login-trigger" id="admin-login-btn" onclick="handleAdminAuthBtn()">🔑 LOGIN ADMIN</button>
        </div>
        <div class="status-container"><div class="status-badge"><span class="status-dot"></span><span style="color: #4ade80">ALL TUNNELS ONLINE</span></div></div>
        <div class="stats-grid">
            <div class="stat-card" style="grid-column: span 2;"><div class="stat-title">CPU Model</div><div class="stat-value" id="cpu" style="font-size:12px; color:#38bdf8;">Loading...</div></div>
            <div class="stat-card"><div class="stat-title">RAM Used / Total</div><div class="stat-value" id="ram">Loading...</div></div>
            <div class="stat-card"><div class="stat-title">Disk Usage (/)</div><div class="stat-value" id="disk">Loading...</div></div>
            <div class="stat-card"><div class="stat-title">Server Uptime</div><div class="stat-value" id="uptime" style="font-size:12px;">Loading...</div></div>
            <div class="stat-card" style="border-color: #a855f7;"><div class="stat-title" style="color:#d8b4fe;">SSH Online Users</div><div class="stat-value" id="ssh" style="font-size:14px; color:#a855f7;">👥 0 Users</div></div>
        </div>

        <div class="zt-admin-card" id="zt-admin-box">
            <div style="font-size: 12px; font-weight: bold; color: #d8b4fe; margin-bottom: 12px; display: flex; justify-content: space-between;">
                <span>⚙️ SYSTEM CONTROL PANEL</span>
                <span id="btn-change-pass" onclick="changeAdminPassUI()" style="color: #eab308; cursor: pointer; text-decoration: underline; font-size: 11px; display: none;">🔑 GANTI PASS ADMIN</span>
            </div>

            <div class="sub-box" style="border-color: #0284c7;">
                <div class="sub-box-title" style="color:#38bdf8;">⚙️ PENGATURAN V2RAY SERVER</div>
                <div class="grid-2">
                    <div>
                        <label class="lbl-vpn" style="color:#eab308;">DNS MODE</label>
                        <select id="dnsTypeSelect" class="input-ssh" style="color: #eab308;" onchange="toggleCustomDnsInput()">
                            <option value="udp">🚀 UDP Fast DNS (IP)</option>
                            <option value="doh">🔒 DoH Secure DNS (HTTPS URL)</option>
                        </select>
                    </div>
                    <div>
                        <label class="lbl-vpn" style="color:#38bdf8;">ENGINE MODE</label>
                        <select id="engineSelect" class="input-ssh" style="color: #38bdf8;">
                            <option value="ws">🌐 WebSocket (WS)</option>
                            <option value="grpc">⚡ gRPC Engine</option>
                            <option value="h2">🚀 HTTP/2 (H2)</option>
                            <option value="tcp">🔌 TCP (Raw Direct)</option>
                        </select>
                    </div>
                </div>
                <div>
                    <label class="lbl-vpn" style="color:#4ade80;">CUSTOM DNS IP / DOH URL</label>
                    <select id="dnsDropdown" class="input-ssh" style="color:#4ade80;" onchange="toggleCustomDnsInput()">
                        <option value="8.8.8.8">Google DNS (8.8.8.8)</option>
                        <option value="1.1.1.1">Cloudflare DNS (1.1.1.1)</option>
                        <option value="9.9.9.9">Quad9 DNS (9.9.9.9)</option>
                        <option value="https://1.1.1.1/dns-query">Cloudflare DoH</option>
                        <option value="https://dns.google/dns-query">Google DoH</option>
                        <option value="custom">✏️ Custom...</option>
                    </select>
                    <input type="text" id="customDnsInput" class="input-ssh" placeholder="IP / DoH Manual..." style="color:#4ade80; display:none; margin-top:4px;">
                </div>
                <button class="btn-token-trigger" style="background: #0284c7; color: #fff; margin-top: 6px;" onclick="saveDnsNetworkSetting()">💾 SIMPAN V2RAY SERVER CONFIG</button>
            </div>

            <div class="sub-box" style="border-color: #8b5cf6;">
                <div class="sub-box-title" style="color:#d8b4fe;">🔌 PENGATURAN SSH SERVER</div>
                <div class="grid-3">
                    <div>
                        <label class="lbl-vpn" style="color:#a855f7;">PORT DROPBEAR</label>
                        <select id="wsPortDropdown" class="input-ssh" style="color:#a855f7;" onchange="toggleCustomWsInputs()">
                            <option value="22">Port 22</option>
                            <option value="109">Port 109</option>
                            <option value="143">Port 143</option>
                            <option value="custom">✏️ Custom...</option>
                        </select>
                        <input type="number" id="wsPortInput" class="input-ssh" placeholder="Port..." style="display:none; margin-top:4px;">
                    </div>
                    <div>
                        <label class="lbl-vpn" style="color:#a855f7;">KEEPALIVE (MS)</label>
                        <select id="wsKeepDropdown" class="input-ssh" style="color:#a855f7;" onchange="toggleCustomWsInputs()">
                            <option value="5000">5000 (5s)</option>
                            <option value="15000">15000 (15s)</option>
                            <option value="30000">30000 (30s)</option>
                            <option value="custom">✏️ Custom...</option>
                        </select>
                        <input type="number" id="wsKeepInput" class="input-ssh" placeholder="MS..." style="display:none; margin-top:4px;">
                    </div>
                    <div>
                        <label class="lbl-vpn" style="color:#a855f7;">MAX BUFFER</label>
                        <select id="wsBufDropdown" class="input-ssh" style="color:#a855f7;" onchange="toggleCustomWsInputs()">
                            <option value="16384">16384 (16KB)</option>
                            <option value="32768">32768 (32KB)</option>
                            <option value="65536">65536 (64KB)</option>
                            <option value="custom">✏️ Custom...</option>
                        </select>
                        <input type="number" id="wsBufInput" class="input-ssh" placeholder="Bytes..." style="display:none; margin-top:4px;">
                    </div>
                </div>

                <div style="margin-top:12px; border-top:1px solid #1f1938; padding-top:10px;">
                    <div>
                        <label class="lbl-vpn" style="color:#eab308;">CUSTOM BANNER DROPBEAR</label>
                        <textarea id="bannerInput" class="input-ssh" style="height:50px; font-family:monospace;" placeholder="Kosongkan untuk banner standar..."></textarea>
                    </div>
                    <div class="grid-2" style="margin-top:8px;">
                        <div>
                            <label class="lbl-vpn" style="color:#10b981;">TCP BBR SWITCH</label>
                            <select id="bbrSelect" class="input-ssh" style="color:#10b981;">
                                <option value="true">⚡ ON (BBR)</option>
                                <option value="false">❌ OFF (Cubic)</option>
                            </select>
                        </div>
                        <div>
                            <label class="lbl-vpn" style="color:#f43f5e;">BADVPN UDPGW PORT</label>
                            <select id="udpgwPortSelect" class="input-ssh" style="color:#f43f5e;">
                                <option value="7300">Port 7300</option>
                                <option value="7200">Port 7200</option>
                                <option value="7100">Port 7100</option>
                            </select>
                        </div>
                    </div>
                </div>

                <button class="btn-token-trigger" style="background: #8b5cf6; color: #fff; margin-top:10px;" onclick="saveWsProxySettingUI()">💾 SIMPAN CONFIG SSH SERVER</button>
            </div>

            <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:12px;">
                <button class="btn-token-trigger" style="background: linear-gradient(135deg, #a855f7, #6b21a8); color: #fff;" onclick="promptSingleTokenInput()">🌐 MASUKKAN TOKEN ARGO TUNNEL</button>
                <button class="btn-token-trigger" style="background: #16a34a; color: #fff;" onclick="promptCfipInput()">🚀 SET CLOUDFLARE CLEAN IP (CFIP)</button>
            </div>

            <div class="sub-box" style="border-color: #10b981; margin-bottom: 0;">
                <div class="sub-box-title" style="color:#10b981; text-align:center;">📋 PENGATURAN TERPASANG</div>
                <div style="font-size: 11px; color: #4ade80; text-align: center; font-weight: bold;">
                    <span>CFIP: </span><span id="display-cfip" style="color:#fff;">Loading...</span> | 
                    <span>DNS: </span><span id="display-dns" style="color:#eab308;">UDP</span> | 
                    <span>ENGINE: </span><span id="display-engine" style="color:#38bdf8;">WS</span><br>
                    <span>PORT SSH: </span><span id="display-ws-port" style="color:#d8b4fe;">22</span> | 
                    <span>BBR: </span><span id="display-bbr" style="color:#10b981;">ON</span> | 
                    <span>UDPGW: </span><span id="display-udpgw" style="color:#f43f5e;">7300</span>
                </div>
            </div>
        </div>

        <div class="ssh-manager">
            <div class="ssh-title"><span>➕ BUAT AKUN SSH BARU</span><span id="admin-indicator" class="admin-status-lbl">PUBLIC CREATION</span></div>
            <div class="input-group">
                <input type="text" id="ssh-user" class="input-ssh" placeholder="Username...">
                <input type="password" id="ssh-pass" class="input-ssh" placeholder="Password...">
                <button class="btn-add" id="btn-add-ssh" onclick="createAccount()">ADD</button>
            </div>
            <div id="ssh-result" class="result-box"></div>
            <button id="btn-copy-acc" class="btn-copy-result" onclick="copyAccountText()">📋 COPY DETAIL AKUN</button>
            <div id="ssh-msg" style="font-size: 11px; margin-top: 5px;"></div>
            <div class="ssh-title" style="margin-top: 15px; border-top: 1px solid #1f2937; padding-top: 10px;">📋 DAFTAR AKUN TERDAFTAR</div>
            <table class="ssh-list">
                <thead><tr><th>Username</th><th>Shell</th><th style="text-align: right;">Aksi</th></tr></thead>
                <tbody id="ssh-table-body"><tr><td colspan="3" style="text-align:center; color:#64748b;">Loading accounts...</td></tr></tbody>
            </table>
        </div>

        <div class="url-section" style="border-color: #a855f7;">
            <div class="url-title" style="color: #d8b4fe;">Server SSH Aktif (Zero Trust)</div>
            <div id="zt-container"><div class="url-box" id="named-url">Menghubungkan...</div></div>
            <button class="btn-copy" id="btn-copy-named" style="background:#a855f7; color:#fff;" onclick="copyTxt('named-url', 'btn-copy-named')">📋 COPY SSH SERVER</button>
        </div>

        <div class="url-section" style="border-color: #0284c7;">
            <div class="url-title" style="color: #38bdf8;">Server Zero Trust (X-Ray Domain)</div>
            <div id="zt-vmess-container"><div class="url-box" id="vmess-named-url" style="color:#38bdf8;">Menghubungkan...</div></div>
            <button class="btn-copy" id="btn-copy-vmess-named" style="background:#0284c7; color:#fff;" onclick="copyTxt('vmess-named-url', 'btn-copy-vmess-named')">📋 COPY VMESS DOMAIN</button>
        </div>

        <div class="url-section" style="border-color: #f43f5e;"><div class="url-title" style="color: #fb7185;">Server SNI MURNI</div><div class="url-box" id="railway-url" style="color: #f43f5e;">Loading...</div><button class="btn-copy" id="btn-copy-railway" style="background:#f43f5e; color:#fff;" onclick="copyTxt('railway-url', 'btn-copy-railway')">📋 COPY SERVER SSH SNI</button></div>
        <div class="url-section"><div class="url-title">Quick Tunnel URL</div><div class="url-box" id="quick-url">Loading...</div><button class="btn-copy" id="btn-copy-quick" onclick="copyTxt('quick-url', 'btn-copy-quick')">📋 COPY SUB DOMAIN</button></div>

        <div class="card-blue">
          <div style="text-align: center; margin-bottom: 12px;"><span style="font-size: 13px; font-weight: bold; color: #fff;">⚡ CONFIG GENERATOR</span></div>
          <div class="grid-2">
            <div><label class="lbl-vpn">UUID</label><input id="uuidInput" type="text" value="Loading..." class="input-ssh" readonly></div>
            <div><label class="lbl-vpn">TARGET DOMAIN</label><select id="domainSelect" class="input-ssh" style="color: #38bdf8;"><option value="">-- Menunggu Domain --</option></select></div>
          </div>
          <div style="margin-bottom: 12px;"><label class="lbl-vpn">BUG HOST</label><input id="bugInput" type="text" value="suporte.garena.com" class="input-ssh"></div>

          <div class="border-lbl" style="border-color:#38bdf8; color:#93c5fd;">BUG SNI (NORMAL)</div>
          <div class="grid-3"><button onclick="buildConfig('vless', 'sni')" class="btn-blue">VLESS STD</button><button onclick="buildConfig('vmess', 'sni')" class="btn-blue">VMESS STD</button><button onclick="buildConfig('trojan', 'sni')" class="btn-blue">TROJAN STD</button></div>

          <div id="output-area" class="result-box" style="margin-top: 15px; border-color: #38bdf8; display: none;">
            <p id="configText" style="word-break: break-all; color: #fff; font-family: monospace;"></p>
          </div>
        </div>
    </div>

    <script>
        let adminToken = localStorage.getItem("admin_session_token") || "";
        let savedUsersData = []; 
        let isPassConfigured = false;

        function checkAdminUI() {
            let indicator = document.getElementById('admin-indicator'); 
            let loginBtn = document.getElementById('admin-login-btn');
            if(!isPassConfigured) {
                loginBtn.innerText = "⚙️ SETUP PASS"; loginBtn.style.background = "#eab308"; loginBtn.style.color = "#000";
            } else if(adminToken) {
                indicator.innerText = "ADMIN ROUTE"; indicator.style.color = "#4ade80";
                loginBtn.innerText = "🔒 LOGOUT";
                document.querySelectorAll('.btn-del').forEach(b => b.style.display = "inline-block");
            } else {
                indicator.innerText = "PUBLIC CREATION"; indicator.style.color = "#38bdf8";
                loginBtn.innerText = "🔑 LOGIN ADMIN";
                document.querySelectorAll('.btn-del').forEach(b => b.style.display = "none");
            }
        }

        function toggleCustomDnsInput() {
            let sel = document.getElementById('dnsDropdown').value;
            document.getElementById('customDnsInput').style.display = (sel === 'custom') ? 'block' : 'none';
        }

        function toggleCustomWsInputs() {
            document.getElementById('wsPortInput').style.display = (document.getElementById('wsPortDropdown').value === 'custom') ? 'block' : 'none';
            document.getElementById('wsKeepInput').style.display = (document.getElementById('wsKeepDropdown').value === 'custom') ? 'block' : 'none';
            document.getElementById('wsBufInput').style.display = (document.getElementById('wsBufDropdown').value === 'custom') ? 'block' : 'none';
        }

        async function handleAdminAuthBtn() {
            if(!isPassConfigured) {
                let newP = prompt("Masukkan Password Admin Baru:");
                if(!newP) return;
                let res = await fetch('/api/setup-pass?pass=' + encodeURIComponent(newP));
                let data = await res.json(); alert(data.message);
                if(data.status === "success") { adminToken = newP; localStorage.setItem("admin_session_token", adminToken); updateStats(); }
                return;
            }
            if(adminToken) { localStorage.removeItem("admin_session_token"); adminToken = ""; checkAdminUI(); return; }
            let pass = prompt("Masukkan Password Admin:"); if(!pass) return;
            let res = await fetch('/api/login?pass='+pass); let data = await res.json();
            if(data.status === "success") { adminToken = data.token; localStorage.setItem("admin_session_token", adminToken); checkAdminUI(); fetchAccounts(); } else { alert(data.message); }
        }

        async function saveWsProxySettingUI() {
            if (!adminToken) { alert("Akses Ditolak! Login Admin dulu."); return; }
            let port = document.getElementById('wsPortDropdown').value === 'custom' ? document.getElementById('wsPortInput').value : document.getElementById('wsPortDropdown').value;
            let keep = document.getElementById('wsKeepDropdown').value === 'custom' ? document.getElementById('wsKeepInput').value : document.getElementById('wsKeepDropdown').value;
            let buf = document.getElementById('wsBufDropdown').value === 'custom' ? document.getElementById('wsBufInput').value : document.getElementById('wsBufDropdown').value;
            let banner = document.getElementById('bannerInput').value.trim();
            let bbr = document.getElementById('bbrSelect').value;
            let udpgw = document.getElementById('udpgwPortSelect').value;

            try {
                await fetch('/api/set-wsproxy?pass=' + encodeURIComponent(adminToken) + '&ssh_port=' + port + '&keep_alive=' + keep + '&max_buffer=' + buf);
                await fetch('/api/set-system?pass=' + encodeURIComponent(adminToken) + '&banner=' + encodeURIComponent(banner) + '&enable_bbr=' + bbr + '&udpgw_port=' + udpgw);
                alert("Konfigurasi Berhasil Disimpan!");
            } catch(e) { alert("Perintah simpan dikirim!"); }
            setTimeout(updateStats, 2000);
        }

        async function updateStats() {
            try {
                let res = await fetch('/api/stats'); let data = await res.json();
                isPassConfigured = data.pass_configured; checkAdminUI();
                document.getElementById('cpu').innerText = data.cpu_model || "N/A"; 
                document.getElementById('ram').innerText = (data.ram_used || "0") + " / " + (data.ram_total || "0"); 
                document.getElementById('disk').innerText = data.disk_usage || "0%"; 
                document.getElementById('uptime').innerText = data.uptime || "0 Hours";
                document.getElementById('ssh').innerText = "👥 " + (data.ssh_online || "0") + " Users";
                document.getElementById('display-cfip').innerText = data.active_cfip || "Default";
                document.getElementById('display-dns').innerText = (data.dns_type || "UDP").toUpperCase();
                document.getElementById('display-engine').innerText = (data.engine_mode || "WS").toUpperCase();
                document.getElementById('display-ws-port').innerText = data.ws_proxy_cfg ? data.ws_proxy_cfg.sshPort : "22";
                document.getElementById('display-bbr').innerText = (data.sys_settings && data.sys_settings.enable_bbr === "true") ? "ON" : "OFF";
                document.getElementById('display-udpgw').innerText = data.sys_settings ? data.sys_settings.udpgw_port : "7300";

                let zt = document.getElementById('named-url');
                if (data.zt_domains && data.zt_domains.length > 0) zt.innerText = data.zt_domains[0].domain;
                let ztv = document.getElementById('vmess-named-url');
                if (data.zt_vmess_domains && data.zt_vmess_domains.length > 0) ztv.innerText = data.zt_vmess_domains[0].domain;

                document.getElementById('railway-url').innerText = data.railway_url || "Tidak Aktif"; 
                document.getElementById('quick-url').innerText = data.quick_url || "Menunggu...";
            } catch(e) {}
        }

        async function fetchAccounts() {
            try {
                let res = await fetch('/api/list'); let data = await res.json();
                let tbody = document.getElementById('ssh-table-body'); tbody.innerHTML = "";
                if(data.status === "success" && data.users.length > 0) {
                    data.users.forEach(u => {
                        tbody.innerHTML += '<tr><td>👤 '+u.username+'</td><td>'+u.shell+'</td><td style="text-align:right;"><button class="btn-del" onclick="deleteAccount(\''+u.username+'\')">HAPUS</button></td></tr>';
                    });
                    checkAdminUI();
                } else { tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">Belum ada akun</td></tr>'; }
            } catch(e) {}
        }

        async function createAccount() {
            let user = document.getElementById('ssh-user').value.trim();
            let pass = document.getElementById('ssh-pass').value.trim();
            if(!user || !pass) return alert("Isi username & password!");
            let res = await fetch('/api/add?user='+user+'&pass='+pass);
            let data = await res.json();
            if(data.status === "success") { alert("Akun berhasil dibuat!"); fetchAccounts(); } else alert(data.message);
        }

        async function deleteAccount(username) {
            if(!adminToken) return alert("Login admin dulu!");
            if(confirm("Hapus "+username+"?")) {
                let res = await fetch('/api/delete?user='+username+'&token='+adminToken);
                fetchAccounts();
            }
        }

        function copyTxt(id, btnId) {
            let elem = document.getElementById(id);
            if(elem && !elem.innerText.includes("Menunggu")) {
                navigator.clipboard.writeText(elem.innerText);
                let btn = document.getElementById(btnId); btn.innerText = "✅ COPIED!";
                setTimeout(() => btn.innerText = "📋 COPY", 1500);
            }
        }

        function buildConfig(protocol, type) {
            let uuid = document.getElementById('uuidInput').value;
            let host = document.getElementById('quick-url').innerText;
            let bug = document.getElementById('bugInput').value;
            if(!host || host.includes("Menunggu")) return alert("Domain belum siap!");
            let link = protocol + '://' + uuid + '@' + bug + ':443?security=tls&sni=' + host;
            document.getElementById('configText').innerText = link;
            document.getElementById('output-area').style.display = 'block';
        }

        updateStats(); fetchAccounts();
        setInterval(updateStats, 5000);
    </script>
</body>
</html>`);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end("Not Found");
});

server.on('upgrade', (req, socket, head) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/ssh-ws') {
    const wsCfg = getWsProxyConfig();
    const targetPort = wsCfg.sshPort || 8880;
    const targetConn = require('net').createConnection({ port: targetPort, host: '127.0.0.1' }, () => {
      let rawHeaders = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) { rawHeaders += `${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`; }
      rawHeaders += '\r\n';
      targetConn.write(rawHeaders);
      if (head && head.length > 0) targetConn.write(head);
      socket.pipe(targetConn).pipe(socket);
    });
    targetConn.on('error', () => socket.destroy());
    socket.on('error', () => targetConn.destroy());
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
    console.log(`[UI Engine] Running on port ${PORT}`);
    generateConfig().then(() => downloadFilesAndRun()).then(() => extractDomains()).catch(e => console.error(e));
    
    if (fs.existsSync(ZT_SINGLE_TOKEN_FILE)) {
        try {
            const savedToken = fs.readFileSync(ZT_SINGLE_TOKEN_FILE, 'utf8').trim();
            if (savedToken) restartSingleTunnel(savedToken);
        } catch(e) {}
    }

    setInterval(extractDomains, 3000);

    setInterval(() => {
        exec("df -h / | awk 'NR==2 {print $5}'", (err, stdout) => {
            if (!err && stdout.trim()) cachedDiskUsage = stdout.trim();
        });

        exec("netstat -anp 2>/dev/null | grep dropbear | grep ESTABLISHED | awk '{print $5}' | cut -d: -f1 | sort -u", (err, stdout) => {
            if (!err && stdout.trim()) {
                const ipLines = stdout.trim().split('\n').filter(Boolean);
                cachedSshOnline = ipLines.length > 0 ? "1 User" : "0 User";
            } else {
                cachedSshOnline = "0 User";
            }
        });
    }, 4000);
});
