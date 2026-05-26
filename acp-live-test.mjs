// Live ACP client test: initialize -> newSession -> prompt
// Usage: node acp-live-test.mjs

import { WebSocket } from 'ws';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const WS_URL = process.env.ACP_URL ?? 'ws://127.0.0.1:3031/bob';

function makeStream(ws) {
  const readable = new ReadableStream({
    start(controller) {
      ws.on('message', (data) => {
        const text = data.toString();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            controller.enqueue(JSON.parse(trimmed));
          } catch {
            console.error('[stream] bad JSON:', trimmed);
          }
        }
      });
      ws.on('close', () => controller.close());
      ws.on('error', (e) => controller.error(e));
    }
  });

  const writable = new WritableStream({
    write(msg) {
      ws.send(JSON.stringify(msg) + '\n');
    },
    close() {
      ws.close();
    }
  });

  return { readable, writable };
}

async function main() {
  console.log(`Connecting to ${WS_URL} ...`);
  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  console.log('Connected.');

  const stream = makeStream(ws);

  // Minimal client impl - just needs requestPermission + sessionUpdate
  const client = {
    requestPermission: async (params) => {
      console.log('[client] permission request:', JSON.stringify(params));
      return { options: [{ id: 'allow', label: 'Allow', kind: 'allow_once' }], selected_option_id: 'allow' };
    },
    sessionUpdate: async (params) => {
      console.log('[client] session update:', JSON.stringify(params).slice(0, 200));
    }
  };

  const conn = new ClientSideConnection((_agent) => client, stream);

  // 1. initialize
  console.log('\n--- initialize ---');
  const initRes = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: 'acp-live-test', version: '0.0.1' }
  });
  console.log('initialize response:', JSON.stringify(initRes, null, 2));

  // 2. newSession
  console.log('\n--- newSession ---');
  const sessionRes = await conn.newSession({
    cwd: '/home/raykao/.copilot-bridge/workspaces/bob',
    mcpServers: []
  });
  console.log('newSession response:', JSON.stringify(sessionRes, null, 2));
  const sessionId = sessionRes.sessionId;

  // 3. prompt
  console.log('\n--- prompt ---');
  const promptRes = await conn.prompt({
    sessionId,
    prompt: [{ type: 'text', text: 'Say hello in exactly 5 words.' }]
  });
  console.log('prompt response:', JSON.stringify(promptRes, null, 2));

  ws.close();
  console.log('\nDone.');
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
