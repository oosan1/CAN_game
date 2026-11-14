/**
 * CAN 2.0A Standard Data Frame Protocol Engine
 * - 11-bit Identifier (Standard Format only)
 * - CRC-15 (polynomial 0x4599)
 * - Bit Stuffing (from SOF through CRC Sequence)
 */

export const CAN_FIELDS = {
  SOF: { id: 'SOF', label: 'SOF', color: '#38bdf8', desc: 'Start of Frame (常に 0)' },
  ID: { id: 'ID', label: 'ID (11bit)', color: '#a78bfa', desc: '標準識別子 (MSBファースト)' },
  RTR: { id: 'RTR', label: 'RTR', color: '#818cf8', desc: 'データフレームは 0' },
  IDE: { id: 'IDE', label: 'IDE', color: '#60a5fa', desc: '標準フォーマットは 0' },
  R0: { id: 'R0', label: 'r0', color: '#64748b', desc: '予約ビット (常に 0)' },
  DLC: { id: 'DLC', label: 'DLC (4bit)', color: '#34d399', desc: 'データ長コード (0〜8バイト)' },
  DATA: { id: 'DATA', label: 'Data', color: '#fbbf24', desc: 'ペイロード (DLC × 8bit)' },
  CRC: { id: 'CRC', label: 'CRC-15', color: '#f472b6', desc: '誤り検出符号 (15bit)' },
  CRC_DELIM: { id: 'CRC_DELIM', label: 'CRC Delim', color: '#fb7185', desc: 'CRCデリミタ (常に 1 / スタッフなし)' },
  ACK_SLOT: { id: 'ACK_SLOT', label: 'ACK Slot', color: '#2dd4bf', desc: '送信時は 1、受信ノードが 0 で応答' },
  ACK_DELIM: { id: 'ACK_DELIM', label: 'ACK Delim', color: '#14b8a6', desc: 'ACKデリミタ (常に 1)' },
  EOF: { id: 'EOF', label: 'EOF (7bit)', color: '#94a3b8', desc: 'End of Frame (1が7連続 / スタッフなし)' },
};

/**
 * Convert an integer to a bit array of fixed width (MSB first).
 * @param {number} value
 * @param {number} width
 * @returns {number[]}
 */
export function intToBits(value, width) {
  const bits = [];
  for (let i = width - 1; i >= 0; i--) {
    bits.push((value >> i) & 1);
  }
  return bits;
}

/**
 * Convert a bit array (MSB first) to an integer.
 * @param {number[]} bits
 * @returns {number}
 */
export function bitsToInt(bits) {
  let val = 0;
  for (const b of bits) {
    val = (val << 1) | (b & 1);
  }
  return val >>> 0;
}

/**
 * Compute CAN 2.0A CRC-15 over destuffed bits (SOF through Data Field).
 * Polynomial: x^15 + x^14 + x^10 + x^8 + x^7 + x^4 + x^3 + 1 (0x4599)
 * @param {number[]} bits
 * @returns {number} 15-bit integer
 */
export function computeCrc15(bits) {
  let crc = 0;
  for (const bit of bits) {
    const crcNext = (bit & 1) ^ ((crc >> 14) & 1);
    crc = (crc << 1) & 0x7fff;
    if (crcNext) {
      crc ^= 0x4599;
    }
  }
  return crc;
}

/**
 * Apply CAN bit stuffing to a bit array (every 5 consecutive identical bits
 * triggers insertion of 1 complementary stuff bit).
 * @param {number[]} bits
 * @returns {{ stuffedBits: number[], stuffIndices: Set<number>, entries: Array<{bit: number, isStuff: boolean, origIndex: number}> }}
 */
export function stuffBits(bits) {
  const stuffedBits = [];
  const stuffIndices = new Set();
  const entries = [];

  let runBit = null;
  let runCount = 0;

  for (let i = 0; i < bits.length; i++) {
    const b = bits[i] & 1;
    stuffedBits.push(b);
    entries.push({ bit: b, isStuff: false, origIndex: i });

    if (b === runBit) {
      runCount++;
    } else {
      runBit = b;
      runCount = 1;
    }

    if (runCount === 5) {
      const stuff = b ^ 1;
      const stuffIdx = stuffedBits.length;
      stuffedBits.push(stuff);
      stuffIndices.add(stuffIdx);
      entries.push({ bit: stuff, isStuff: true, origIndex: -1 });
      // Stuff bit counts as the 1st bit of the new polarity run
      runBit = stuff;
      runCount = 1;
    }
  }

  return { stuffedBits, stuffIndices, entries };
}

/**
 * Remove CAN bit stuffing from a stuffed bit array (SOF through CRC Sequence).
 * Throws an error if 6 consecutive identical bits are found (stuff error).
 * @param {number[]} stuffedBits
 * @returns {{ destuffedBits: number[], stuffIndices: number[] }}
 */
export function destuffBits(stuffedBits) {
  const destuffedBits = [];
  const stuffIndices = [];

  let runBit = null;
  let runCount = 0;
  let expectStuff = false;

  for (let i = 0; i < stuffedBits.length; i++) {
    const b = stuffedBits[i] & 1;

    if (expectStuff) {
      if (b === runBit) {
        throw new Error(`Stuff Error at bit index ${i}: expected ${runBit ^ 1}, got ${b}`);
      }
      stuffIndices.push(i);
      expectStuff = false;
      runBit = b;
      runCount = 1;
      continue;
    }

    destuffedBits.push(b);
    if (b === runBit) {
      runCount++;
    } else {
      runBit = b;
      runCount = 1;
    }

    if (runCount === 5) {
      expectStuff = true;
    }
  }

  return { destuffedBits, stuffIndices };
}

/**
 * Encode a Standard CAN 2.0A Data Frame into both destuffed and wire (stuffed) representations
 * with rich per-bit metadata for UI highlighting.
 * @param {number} id 11-bit identifier (0x000 - 0x7FF)
 * @param {number[]} dataBytes Array of 0..8 byte values (0x00 - 0xFF)
 * @param {{ ackDominant?: boolean }} [options]
 */
export function encodeStandardFrame(id, dataBytes, options = {}) {
  if (id < 0 || id > 0x7ff) {
    throw new Error(`Invalid Standard CAN ID: ${id}`);
  }
  if (!Array.isArray(dataBytes) || dataBytes.length > 8) {
    throw new Error(`Invalid DLC: ${dataBytes?.length}`);
  }

  const dlc = dataBytes.length;
  const ackBit = options.ackDominant ? 0 : 1;

  /** @type {Array<{bit: number, field: string}>} */
  const preCrcAnnotated = [];
  const pushField = (field, bits) => {
    for (const b of bits) {
      preCrcAnnotated.push({ bit: b & 1, field });
    }
  };

  pushField('SOF', [0]);
  pushField('ID', intToBits(id, 11));
  pushField('RTR', [0]);
  pushField('IDE', [0]);
  pushField('R0', [0]);
  pushField('DLC', intToBits(dlc, 4));
  for (const byteVal of dataBytes) {
    pushField('DATA', intToBits(byteVal & 0xff, 8));
  }

  const preCrcBits = preCrcAnnotated.map((x) => x.bit);
  const crc = computeCrc15(preCrcBits);

  const stuffedZoneAnnotated = [...preCrcAnnotated];
  for (const b of intToBits(crc, 15)) {
    stuffedZoneAnnotated.push({ bit: b, field: 'CRC' });
  }

  // Apply bit stuffing from SOF through CRC Sequence
  const stuffResult = stuffBits(stuffedZoneAnnotated.map((x) => x.bit));
  const wireAnnotated = [];

  for (const entry of stuffResult.entries) {
    if (entry.isStuff) {
      wireAnnotated.push({ bit: entry.bit, field: 'STUFF', isStuff: true });
    } else {
      wireAnnotated.push({
        bit: entry.bit,
        field: stuffedZoneAnnotated[entry.origIndex].field,
        isStuff: false,
      });
    }
  }

  // Fixed-form tail (NOT bit-stuffed)
  const tailFields = [
    { field: 'CRC_DELIM', bits: [1] },
    { field: 'ACK_SLOT', bits: [ackBit] },
    { field: 'ACK_DELIM', bits: [1] },
    { field: 'EOF', bits: [1, 1, 1, 1, 1, 1, 1] },
  ];

  for (const tf of tailFields) {
    for (const b of tf.bits) {
      wireAnnotated.push({ bit: b, field: tf.field, isStuff: false });
    }
  }

  return {
    id,
    dlc,
    dataBytes: [...dataBytes],
    crc,
    preCrcBits,
    destuffedBits: stuffedZoneAnnotated.map((x) => x.bit),
    wireBits: wireAnnotated.map((x) => x.bit),
    wireAnnotated,
    stuffBitCount: stuffResult.stuffIndices.size,
  };
}

/**
 * Decode a raw wire bitstream of a Standard CAN 2.0A Data Frame.
 * @param {number[] | string} rawInput
 */
export function decodeStandardFrame(rawInput) {
  const wireBits =
    typeof rawInput === 'string'
      ? rawInput
          .replace(/\s+/g, '')
          .split('')
          .map((c) => {
            if (c !== '0' && c !== '1') throw new Error(`Invalid bit char: ${c}`);
            return Number(c);
          })
      : rawInput.map((b) => b & 1);

  if (wireBits.length < 44) {
    throw new Error('Frame too short for CAN 2.0A');
  }

  // Tail is always 10 unstuffed bits: CRC Delim(1) + ACK Slot(1) + ACK Delim(1) + EOF(7)
  const tailStart = wireBits.length - 10;
  const stuffedZone = wireBits.slice(0, tailStart);
  const tail = wireBits.slice(tailStart);

  const { destuffedBits, stuffIndices } = destuffBits(stuffedZone);

  // Minimum destuffed length: SOF(1)+ID(11)+RTR(1)+IDE(1)+r0(1)+DLC(4)+CRC(15) = 34
  if (destuffedBits.length < 34) {
    throw new Error('Destuffed frame too short');
  }

  const sof = destuffedBits[0];
  if (sof !== 0) throw new Error('SOF must be 0');

  const id = bitsToInt(destuffedBits.slice(1, 12));
  const rtr = destuffedBits[12];
  const ide = destuffedBits[13];
  const r0 = destuffedBits[14];
  const dlc = bitsToInt(destuffedBits.slice(15, 19));

  if (rtr !== 0) throw new Error('Only Data Frames (RTR=0) are supported');
  if (ide !== 0) throw new Error('Only Standard Format (IDE=0) is supported');
  if (dlc > 8) throw new Error(`Invalid DLC: ${dlc}`);

  const expectedDestuffedLen = 19 + dlc * 8 + 15;
  if (destuffedBits.length !== expectedDestuffedLen) {
    throw new Error(
      `Bit length mismatch: expected ${expectedDestuffedLen} destuffed bits for DLC=${dlc}, got ${destuffedBits.length}`
    );
  }

  const dataBytes = [];
  for (let i = 0; i < dlc; i++) {
    const start = 19 + i * 8;
    dataBytes.push(bitsToInt(destuffedBits.slice(start, start + 8)));
  }

  const preCrcBits = destuffedBits.slice(0, 19 + dlc * 8);
  const rxCrc = bitsToInt(destuffedBits.slice(19 + dlc * 8, expectedDestuffedLen));
  const expectedCrc = computeCrc15(preCrcBits);

  const crcDelim = tail[0];
  const ackSlot = tail[1];
  const ackDelim = tail[2];
  const eof = tail.slice(3);

  return {
    sof,
    id,
    rtr,
    ide,
    r0,
    dlc,
    dataBytes,
    crc: rxCrc,
    crcValid: rxCrc === expectedCrc,
    crcDelim,
    ackSlot,
    ackDelim,
    eofValid: eof.every((b) => b === 1),
    stuffIndices,
    destuffedBits,
    wireBits,
  };
}

/**
 * Format a number as hex string with 0x prefix and zero-padding.
 * @param {number} val
 * @param {number} digits
 */
export function toHex(val, digits = 2) {
  return '0x' + val.toString(16).toUpperCase().padStart(digits, '0');
}
