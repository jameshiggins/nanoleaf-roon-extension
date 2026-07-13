'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {
  SlimprotoClient,
  encodeHelo,
  encodeStat,
  parseServerFrames,
  parseStrm,
  ipToString,
} = require('../src/audio/slimproto');

// ---------- codecs (pinned byte layouts) ----------

test('encodeHelo: frame header, device id, mac, capabilities', () => {
  const caps = 'Model=squeezelite,pcm';
  const frame = encodeHelo({ mac: '02:11:22:33:44:55', capabilities: caps });
  assert.equal(frame.toString('ascii', 0, 4), 'HELO');
  assert.equal(frame.readUInt32BE(4), 36 + caps.length); // payload length
  assert.equal(frame[8], 12);                            // deviceId = squeezelite
  assert.deepEqual([...frame.subarray(10, 16)], [0x02, 0x11, 0x22, 0x33, 0x44, 0x55]);
  assert.equal(frame.toString('ascii', 8 + 36), caps);
});

test('encodeStat: 53-byte payload with event code and counters', () => {
  const frame = encodeStat('STMt', { bytesReceived: 1000, serverTimestamp: 0xdeadbeef });
  assert.equal(frame.toString('ascii', 0, 4), 'STAT');
  assert.equal(frame.readUInt32BE(4), 53);
  const p = frame.subarray(8);
  assert.equal(p.toString('ascii', 0, 4), 'STMt');
  assert.equal(p.readBigUInt64BE(15), 1000n);       // bytesReceived
  assert.equal(p.readUInt32BE(47), 0xdeadbeef);     // serverTimestamp echo
});

test('encodeStat: rejects bad event codes', () => {
  assert.throws(() => encodeStat('NO'));
});

function serverFrame(op, payload) {
  const buf = Buffer.alloc(2 + 4 + payload.length);
  buf.writeUInt16BE(4 + payload.length, 0);
  buf.write(op, 2, 'ascii');
  payload.copy(buf, 6);
  return buf;
}

test('parseServerFrames: complete, partial and concatenated frames', () => {
  const f1 = serverFrame('vers', Buffer.from('7.9'));
  const f2 = serverFrame('strm', Buffer.alloc(24));
  const joined = Buffer.concat([f1, f2]);

  // both complete
  let r = parseServerFrames(joined);
  assert.equal(r.frames.length, 2);
  assert.equal(r.frames[0].op, 'vers');
  assert.equal(r.frames[1].op, 'strm');
  assert.equal(r.rest.length, 0);

  // split mid-frame: only the first parses, remainder preserved
  const cut = f1.length + 3;
  r = parseServerFrames(joined.subarray(0, cut));
  assert.equal(r.frames.length, 1);
  assert.equal(r.rest.length, 3);

  // feeding rest + remainder completes the second frame
  r = parseServerFrames(Buffer.concat([r.rest, joined.subarray(cut)]));
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].op, 'strm');
});

test('parseStrm: pinned field offsets', () => {
  const p = Buffer.alloc(24 + 10);
  p.write('s', 0);              // command: start
  p.write('1', 1);              // autostart
  p.write('p', 2);              // format: PCM
  p.write('1', 3);              // 16-bit
  p.write('3', 4);              // 44.1 kHz
  p.write('2', 5);              // stereo
  p.write('1', 6);              // little-endian
  p.writeUInt32BE(42, 14);      // replayGain / timestamp
  p.writeUInt16BE(9001, 18);    // serverPort
  p.writeUInt32BE(0xc0a80102, 20); // 192.168.1.2
  p.write('GET /strea', 24);

  const s = parseStrm(p);
  assert.equal(s.command, 's');
  assert.equal(s.format, 'p');
  assert.equal(s.pcmSampleRate, '3');
  assert.equal(s.pcmChannels, '2');
  assert.equal(s.replayGain, 42);
  assert.equal(s.serverPort, 9001);
  assert.equal(ipToString(s.serverIp), '192.168.1.2');
  assert.equal(s.httpRequest, 'GET /strea');
});

test('parseStrm: rejects short payloads', () => {
  assert.throws(() => parseStrm(Buffer.alloc(10)));
});

// ---------- client behaviour against a mock server ----------

function strmPayload(command, { serverPort = 0, autostart = '1' } = {}) {
  const p = Buffer.alloc(24 + (command === 's' ? 30 : 0));
  p.write(command, 0);
  p.write(autostart, 1);
  p.write('p', 2);
  p.write('1', 3);
  p.write('3', 4);
  p.write('2', 5);
  p.write('1', 6);
  p.writeUInt32BE(1234, 14);
  p.writeUInt16BE(serverPort, 18);
  p.writeUInt32BE(0, 20); // 0.0.0.0 → use control-connection address
  if (command === 's') p.write('GET /stream.pcm HTTP/1.0\r\n\r\n', 24);
  return p;
}

test('SlimprotoClient: HELO on connect, STMt echoes heartbeat timestamp', async () => {
  const events = [];
  const server = net.createServer((socket) => {
    let recv = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      // client frames: [op 4][len u32][payload]
      while (recv.length >= 8) {
        const len = recv.readUInt32BE(4);
        if (recv.length < 8 + len) break;
        const op = recv.toString('ascii', 0, 4);
        const payload = recv.subarray(8, 8 + len);
        recv = recv.subarray(8 + len);
        events.push({ op, payload });
        if (op === 'HELO') socket.write(serverFrame('strm', strmPayload('t')));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const client = new SlimprotoClient({ server: '127.0.0.1', port: server.address().port });
  client.connect();
  await new Promise((r) => setTimeout(r, 200));
  client.close();
  server.close();

  assert.equal(events[0].op, 'HELO');
  assert.equal(events[0].payload[0], 12); // squeezelite device id
  const stat = events.find((e) => e.op === 'STAT');
  assert.ok(stat, 'expected a STAT reply to the heartbeat');
  assert.equal(stat.payload.toString('ascii', 0, 4), 'STMt');
  assert.equal(stat.payload.readUInt32BE(47), 1234); // echoed timestamp
});

test('SlimprotoClient: strm start → fetches HTTP stream, strips headers, emits pcm', async () => {
  // audio server: replies to the HTTP request with headers + PCM body in one write
  const body = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const audioServer = net.createServer((socket) => {
    socket.on('data', () => {
      socket.write(Buffer.concat([Buffer.from('HTTP/1.0 200 OK\r\nContent-Type: audio/x-pcm\r\n\r\n'), body]));
    });
  });
  await new Promise((r) => audioServer.listen(0, '127.0.0.1', r));

  const control = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write(serverFrame('strm', strmPayload('s', { serverPort: audioServer.address().port })));
    });
  });
  await new Promise((r) => control.listen(0, '127.0.0.1', r));

  const client = new SlimprotoClient({ server: '127.0.0.1', port: control.address().port });
  const pcm = [];
  let format = null;
  client.on('streamStart', (fmt) => { format = fmt; });
  client.on('pcm', (chunk) => pcm.push(chunk));
  client.connect();
  await new Promise((r) => setTimeout(r, 300));
  client.close();
  control.close();
  audioServer.close();

  assert.deepEqual(format, { sampleRate: 44100, channels: 2 });
  assert.deepEqual(Buffer.concat(pcm), body, 'headers must be stripped, body delivered verbatim');
  assert.equal(client.bytesReceived, body.length);
});
