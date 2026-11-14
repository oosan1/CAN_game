const STORAGE_KEY = 'can_controller_game_records_v1';

export function loadRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Record a Time Attack clear time (in ms) for a specific key (e.g. 'tx_normal', 'rx_hard').
 * Returns { isNewBest: boolean, bestMs: number }
 */
export function saveBestTime(key, timeMs) {
  const records = loadRecords();
  const prev = records[key];
  const isNewBest = typeof prev !== 'number' || timeMs < prev;
  if (isNewBest) {
    records[key] = timeMs;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    } catch {
      // ignore storage quota errors
    }
  }
  return { isNewBest, bestMs: isNewBest ? timeMs : prev };
}

export function formatTimeMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--:--.--';
  const totalSec = ms / 1000;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.floor(totalSec % 60);
  const hundredths = Math.floor((ms % 1000) / 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}
