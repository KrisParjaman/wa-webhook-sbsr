const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const TOKEN = '3dnyql4Hpk2IPjghKsJ6hKJnDPLND3Ms';
const PROTOCOL_VERSION = 3;

// Step 1: Login to get session cookie
function login() {
  return new Promise((resolve, reject) => {
    const data = 'token=' + encodeURIComponent(TOKEN);
    const req = http.request({
      hostname: '127.0.0.1', port: 45891, path: '/login', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      const cookie = res.headers['set-cookie']?.[0]?.split(';')[0];
      if (cookie) resolve(cookie); else reject(new Error('No cookie'));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const cookie = await login();
  console.log('[AUTH] Got cookie:', cookie);

  const ws = new WebSocket('ws://127.0.0.1:45891', { headers: { Cookie: cookie } });

  ws.on('open', () => console.log('[WS] Connected'));

  ws.on('message', (raw) => {
    const str = raw.toString();
    console.log('[RECV]', str.substring(0, 2000));
    
    try {
      const msg = JSON.parse(str);
      
      // Handle challenge: respond with connect request
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const connectFrame = {
          type: 'req',
          id: crypto.randomUUID(),
          method: 'connect',
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: 'gateway-client',
              displayName: 'WA Bridge',
              version: '1.0.0',
              platform: 'linux',
              mode: 'backend'
            },
            caps: [],
            auth: { token: TOKEN },
            role: 'operator',
            scopes: ['operator.admin']
          }
        };
        console.log('[SEND connect]', JSON.stringify(connectFrame).substring(0, 500));
        ws.send(JSON.stringify(connectFrame));
      }
      
      // After connect success, send a test chat.send
      if (msg.type === 'res' && msg.ok === true && msg.payload?.protocol) {
        console.log('[CONNECTED OK] Protocol:', msg.payload.protocol);
        
        // Now try chat.send
        const chatFrame = {
          type: 'req',
          id: crypto.randomUUID(),
          method: 'chat.send',
          params: {
            sessionKey: 'whatsapp:+628test',
            message: 'Hello from WA bridge test',
            idempotencyKey: crypto.randomUUID()
          }
        };
        console.log('[SEND chat.send]', JSON.stringify(chatFrame).substring(0, 500));
        ws.send(JSON.stringify(chatFrame));
      }
      
      // Log chat events
      if (msg.type === 'event' && msg.event === 'chat') {
        console.log('[CHAT EVENT]', JSON.stringify(msg.payload).substring(0, 1000));
      }
    } catch(e) {}
  });

  ws.on('error', (err) => console.error('[ERROR]', err.message));
  ws.on('close', (code, reason) => console.log('[CLOSED]', code, reason.toString()));

  setTimeout(() => { console.log('[DONE]'); ws.close(); process.exit(0); }, 30000);
}

main().catch(console.error);
