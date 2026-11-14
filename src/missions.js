import { encodeStandardFrame } from './can-protocol.js';

const ECU_TOPICS = [
  { ecu: 'Engine ECU', label: 'エンジン回転数 (RPM)', minId: 0x080, maxId: 0x1ff },
  { ecu: 'Brake ECU', label: 'ABS車輪速センサー', minId: 0x040, maxId: 0x120 },
  { ecu: 'Steer ECU', label: 'ステアリング操舵角', minId: 0x100, maxId: 0x2ff },
  { ecu: 'Battery ECU', label: 'バッテリー電圧/SOC', minId: 0x200, maxId: 0x3ff },
  { ecu: 'Body ECU', label: 'ドア・ライト状態', minId: 0x300, maxId: 0x5ff },
  { ecu: 'Climate ECU', label: 'エアコン設定温度', minId: 0x400, maxId: 0x6ff },
];

// Patterns that frequently trigger 5-consecutive-bit stuffing
const STUFF_RICH_BYTES = [0x00, 0xff, 0xf0, 0x0f, 0x1f, 0xe0, 0x03, 0xfc, 0x7c, 0x83, 0x3e, 0xc1];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a mission for TX or RX mode.
 * @param {'tx'|'rx'} mode
 * @param {'normal'|'hard'} difficulty
 */
export function generateMission(mode, difficulty) {
  const topic = pickRandom(ECU_TOPICS);
  const dlc = 2; // Fixed 2-byte payload (DLC = 2)

  let id = 0;
  let dataBytes = [];
  let encoded = null;

  // Ensure at least 1 stuff bit in the frame so bit-stuffing is always experienced
  for (let attempt = 0; attempt < 25; attempt++) {
    id = randInt(topic.minId, topic.maxId);
    dataBytes = [];
    for (let i = 0; i < dlc; i++) {
      if (Math.random() < 0.6) {
        dataBytes.push(pickRandom(STUFF_RICH_BYTES));
      } else {
        dataBytes.push(randInt(0, 255));
      }
    }
    encoded = encodeStandardFrame(id, dataBytes, { ackDominant: mode === 'rx' });
    if (encoded.stuffBitCount >= 1) break;
  }

  return {
    mode,
    difficulty,
    ecu: topic.ecu,
    label: topic.label,
    id,
    dlc,
    dataBytes,
    encoded,
  };
}
