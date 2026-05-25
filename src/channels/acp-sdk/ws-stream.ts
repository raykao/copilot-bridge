import { WebSocket } from 'ws';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk';

// Creates an ACP Stream backed by a WebSocket connection.
// readable: delivers parsed AnyMessage objects from incoming WS text frames
// writable: serialises AnyMessage objects to outgoing WS text frames
export function wsStream(ws: WebSocket): Stream {
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      ws.on('message', (data) => {
        try {
          controller.enqueue(JSON.parse(data.toString()) as AnyMessage);
        } catch {
          // malformed frame - discard silently
        }
      });
      ws.on('close', () => controller.close());
      ws.on('error', (err) => controller.error(err));
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(message) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  });

  return { readable, writable };
}
