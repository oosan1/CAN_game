import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCrc15,
  stuffBits,
  destuffBits,
  encodeStandardFrame,
  decodeStandardFrame,
} from '../src/can-protocol.js';
import { generateMission } from '../src/missions.js';

test('stuffBits inserts stuff bit after 5 consecutive identical bits and handles chained runs', () => {
  // 5 zeros -> insert 1; followed by 4 ones -> stuff(1) + 4 ones = 5 ones -> insert 0!
  const input = [0, 0, 0, 0, 0, 1, 1, 1, 1];
  const { stuffedBits, stuffIndices } = stuffBits(input);
  assert.deepEqual(stuffedBits, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0]);
  assert.deepEqual([...stuffIndices], [5, 10]);

  const { destuffedBits, stuffIndices: removed } = destuffBits(stuffedBits);
  assert.deepEqual(destuffedBits, input);
  assert.deepEqual(removed, [5, 10]);
});

test('destuffBits throws on stuff error (6 consecutive identical bits)', () => {
  assert.throws(() => destuffBits([0, 0, 0, 0, 0, 0]), /Stuff Error/);
});

test('encodeStandardFrame and decodeStandardFrame round-trip accurately', () => {
  const cases = [
    { id: 0x000, data: [0x00] }, // Lots of 0s -> heavy bit stuffing!
    { id: 0x7ff, data: [0xff, 0xff] }, // Lots of 1s -> heavy bit stuffing!
    { id: 0x1a3, data: [0x5a, 0x0f, 0xc3] },
    { id: 0x2b0, data: [] }, // DLC = 0
  ];

  for (const c of cases) {
    const encoded = encodeStandardFrame(c.id, c.data, { ackDominant: true });
    const decoded = decodeStandardFrame(encoded.wireBits);

    assert.equal(decoded.id, c.id);
    assert.equal(decoded.dlc, c.data.length);
    assert.deepEqual(decoded.dataBytes, c.data);
    assert.equal(decoded.crcValid, true);
    assert.equal(decoded.eofValid, true);
    assert.equal(decoded.ackSlot, 0);
  }
});

test('computeCrc15 detects single-bit corruption', () => {
  const encoded = encodeStandardFrame(0x123, [0xab, 0xcd]);
  const corrupted = [...encoded.wireBits];
  // Flip a bit in the middle
  corrupted[10] ^= 1;
  // May throw stuff error or fail CRC check
  try {
    const decoded = decodeStandardFrame(corrupted);
    assert.equal(decoded.crcValid, false);
  } catch (err) {
    assert.match(err.message, /Stuff Error|Bit length mismatch|must be/);
  }
});

test('generateMission produces valid decodable 2-byte frames for all modes', () => {
  for (const mode of ['tx', 'rx']) {
    for (const diff of ['easy', 'normal', 'hard']) {
      for (let i = 0; i < 10; i++) {
        const m = generateMission(mode, diff);
        assert.equal(m.dlc, 2);
        assert.equal(m.dataBytes.length, 2);
        const decoded = decodeStandardFrame(m.encoded.wireBits);
        assert.equal(decoded.id, m.id);
        assert.deepEqual(decoded.dataBytes, m.dataBytes);
        assert.equal(decoded.crcValid, true);
      }
    }
  }
});
