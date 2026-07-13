'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { encodeFrameV2, Streamer } = require('../src/nanoleaf/streamer');

test('encodeFrameV2: pinned byte layout', () => {
  const buf = encodeFrameV2([
    { id: 0x1234, r: 10, g: 20, b: 30, transition: 1 },
    { id: 7, r: 255, g: 0, b: 128, w: 5, transition: 0x0203 },
  ]);
  assert.equal(buf.length, 2 + 2 * 8);
  // header: panel count
  assert.deepEqual([...buf.subarray(0, 2)], [0x00, 0x02]);
  // panel 1: id BE, r, g, b, w=0 default, transition BE
  assert.deepEqual([...buf.subarray(2, 10)], [0x12, 0x34, 10, 20, 30, 0, 0x00, 0x01]);
  // panel 2
  assert.deepEqual([...buf.subarray(10, 18)], [0x00, 0x07, 255, 0, 128, 5, 0x02, 0x03]);
});

test('encodeFrameV2: clamps and rounds color values', () => {
  const buf = encodeFrameV2([{ id: 1, r: -5, g: 300, b: 12.6 }]);
  assert.equal(buf[4], 0);    // r clamped up
  assert.equal(buf[5], 255);  // g clamped down
  assert.equal(buf[6], 13);   // b rounded
});

test('encodeFrameV2: default transition is 1', () => {
  const buf = encodeFrameV2([{ id: 1, r: 0, g: 0, b: 0 }]);
  assert.equal(buf.readUInt16BE(8), 1);
});

function udpReceiver() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const received = [];
    socket.on('message', (msg) => received.push(Buffer.from(msg)));
    socket.bind(0, '127.0.0.1', () => resolve({ socket, received, port: socket.address().port }));
  });
}

test('Streamer: delivers frames over UDP', async () => {
  const { socket, received, port } = await udpReceiver();
  const streamer = new Streamer({ host: '127.0.0.1', port, fps: 60 });
  try {
    streamer.sendFrame([{ id: 3, r: 1, g: 2, b: 3 }]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], encodeFrameV2([{ id: 3, r: 1, g: 2, b: 3 }]));
  } finally {
    streamer.close();
    socket.close();
  }
});

test('Streamer: paces to fps — newest frame wins, none queue', async () => {
  const { socket, received, port } = await udpReceiver();
  // 10 fps → 100 ms budget; fire 5 frames back-to-back
  const streamer = new Streamer({ host: '127.0.0.1', port, fps: 10 });
  try {
    for (let i = 1; i <= 5; i++) streamer.sendFrame([{ id: i, r: i, g: 0, b: 0 }]);
    await new Promise((r) => setTimeout(r, 250));
    // first goes out immediately; of the rest only the newest survives the budget window
    assert.equal(received.length, 2, `got ${received.length} datagrams`);
    assert.equal(received[0].readUInt16BE(2), 1); // panel id of frame 1
    assert.equal(received[1].readUInt16BE(2), 5); // frames 2-4 dropped
  } finally {
    streamer.close();
    socket.close();
  }
});

test('Streamer: blackout addresses every panel with zeros', async () => {
  const { socket, received, port } = await udpReceiver();
  const streamer = new Streamer({ host: '127.0.0.1', port, fps: 60 });
  try {
    streamer.blackout([1, 2, 3]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(received.length, 1);
    const buf = received[0];
    assert.equal(buf.readUInt16BE(0), 3);
    for (let p = 0; p < 3; p++) {
      const o = 2 + p * 8;
      assert.deepEqual([...buf.subarray(o + 2, o + 6)], [0, 0, 0, 0]);
    }
  } finally {
    streamer.close();
    socket.close();
  }
});

test('Streamer: ignores frames after close', async () => {
  const { socket, received, port } = await udpReceiver();
  const streamer = new Streamer({ host: '127.0.0.1', port, fps: 60 });
  streamer.close();
  streamer.sendFrame([{ id: 1, r: 9, g: 9, b: 9 }]);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(received.length, 0);
  socket.close();
});
