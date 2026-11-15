import {
  CAN_FIELDS,
  computeCrc15,
  decodeStandardFrame,
  intToBits,
  stuffBits,
  toHex,
} from './can-protocol.js';
import { generateMission } from './missions.js';
import { CanBusSimulator } from './bus-sim.js';
import { mountCrcLongDivisionPad } from './crc-pad.js';
import { formatTimeMs, loadRecords, saveBestTime } from './storage.js';

const TIME_ATTACK_FRAMES = 1;
const PENALTY_MS = 5000;

const appState = {
  screen: 'menu', // 'menu' | 'play' | 'result'
  mode: 'tx', // 'tx' | 'rx'
  difficulty: 'easy', // 'easy' | 'normal' | 'hard'
  playStyle: 'practice', // 'practice' | 'time_attack'

  mission: null,
  phase: 'frame', // 'frame' | 'bus'
  busSim: null,

  // Time Attack tracking (paused during bus arbitration phase to remove luck)
  frameIndex: 0,
  accumulatedMs: 0,
  timerSegmentStart: 0,
  timerPaused: false,
  penaltyMs: 0,
  skippedCount: 0,
  timerInterval: null,

  // TX Easy/Normal state
  txSlots: [], // { index, field, byteIdx, expectedBit, value: null|0|1, isStuff: boolean }
  // RX Easy state
  rxRemovedStuff: new Set(),
};

const mainEl = document.getElementById('main-content');
const btnBackMenu = document.getElementById('btn-back-menu');
const btnHome = document.getElementById('btn-home');
const btnGuide = document.getElementById('btn-guide');
const btnCloseGuide = document.getElementById('btn-close-guide');
const guideDrawer = document.getElementById('guide-drawer');

function toggleGuide(forceState) {
  const willShow =
    typeof forceState === 'boolean' ? forceState : guideDrawer.classList.contains('hidden');
  guideDrawer.classList.toggle('hidden', !willShow);
  btnGuide.textContent = willShow ? '📖 CAN仕様ガイド: ON' : '📖 CAN仕様ガイド: OFF';
}

btnGuide.addEventListener('click', () => toggleGuide());
btnCloseGuide.addEventListener('click', () => toggleGuide(false));
btnBackMenu.addEventListener('click', goMenu);
btnHome.addEventListener('click', goMenu);

function goMenu() {
  stopTimersAndSim();
  appState.screen = 'menu';
  btnBackMenu.classList.add('hidden');
  renderMenu();
}

function stopTimersAndSim() {
  if (appState.busSim) {
    appState.busSim.stop();
    appState.busSim = null;
  }
  if (appState.timerInterval) {
    clearInterval(appState.timerInterval);
    appState.timerInterval = null;
  }
}

function pauseTimer() {
  if (appState.playStyle !== 'time_attack' || appState.timerPaused) return;
  appState.accumulatedMs += Date.now() - appState.timerSegmentStart;
  appState.timerPaused = true;
  updateHudTimer();
}

function resumeTimer() {
  if (appState.playStyle !== 'time_attack' || !appState.timerPaused) return;
  appState.timerSegmentStart = Date.now();
  appState.timerPaused = false;
  updateHudTimer();
}

function getElapsedMs() {
  const running = appState.timerPaused ? 0 : Date.now() - appState.timerSegmentStart;
  return appState.accumulatedMs + running + appState.penaltyMs;
}

function addPenalty(seconds = 5) {
  if (appState.playStyle === 'time_attack') {
    appState.penaltyMs += seconds * 1000;
    updateHudTimer();
  }
}

function updateHudTimer() {
  const el = document.getElementById('hud-timer');
  if (el) {
    el.textContent = appState.timerPaused
      ? `⏸ ${formatTimeMs(getElapsedMs())}`
      : formatTimeMs(getElapsedMs());
  }
}

/* ==================== MENU ==================== */
function renderMenu() {
  const records = loadRecords();
  mainEl.innerHTML = `
    <div class="menu-hero">
      <h2>CANコントローラの気持ちになろう</h2>
      <p>
        CAN 2.0A（標準フォーマット・DATA 2バイト固定 / DLC=2）の「生ビット列 ↔ データフレーム変換」「ビットスタッフィング」「バス調停」を手動で体験するシミュレータです。
      </p>
    </div>

    <div class="card">
      <div class="selector-grid">
        <div class="option-group">
          <div class="option-label">1. モード選択 (TX / RX)</div>
          <button class="choice-btn ${appState.mode === 'tx' ? 'active' : ''}" data-opt="mode" data-val="tx">
            <strong>📤 送信モード (TX)</strong>
            <span>データフレーム組立＋スタッフビット挿入＋バス調停を体験</span>
          </button>
          <button class="choice-btn ${appState.mode === 'rx' ? 'active' : ''}" data-opt="mode" data-val="rx">
            <strong>📥 受信モード (RX)</strong>
            <span>生ビット列からスタッフビット除去＋ID・2バイトデータ解読</span>
          </button>
        </div>

        <div class="option-group">
          <div class="option-label">2. 難易度 (Easy / Normal / Hard / Extreme)</div>
          <button class="choice-btn ${appState.difficulty === 'easy' ? 'active' : ''}" data-opt="difficulty" data-val="easy">
            <strong>🌱 イージー (チュートリアル)</strong>
            <span>手順ガイド・自動入力ボタン・クリックデスタッフ付き</span>
          </button>
          <button class="choice-btn ${appState.difficulty === 'normal' ? 'active' : ''}" data-opt="difficulty" data-val="normal">
            <strong>🟢 通常モード (Normal)</strong>
            <span>フィールド・Sビットのハイライトあり。入力と読取は自力で！</span>
          </button>
          <button class="choice-btn ${appState.difficulty === 'hard' ? 'active' : ''}" data-opt="difficulty" data-val="hard">
            <strong>🔥 ハードモード (Hard)</strong>
            <span>ハイライト・ガイドなし！生ビット列のみ＋メモ欄</span>
          </button>
          <button class="choice-btn ${appState.difficulty === 'extreme' ? 'active' : ''}" data-opt="difficulty" data-val="extreme">
            <strong>💀 超ハード (Extreme)</strong>
            <span>CRC-15計算機なし！筆算メモ欄でCRCも手計算する職人モード</span>
          </button>
        </div>

        <div class="option-group">
          <div class="option-label">3. プレイスタイル</div>
          <button class="choice-btn ${appState.playStyle === 'practice' ? 'active' : ''}" data-opt="playStyle" data-val="practice">
            <strong>🎯 練習モード (Practice)</strong>
            <span>1フレームずつじっくり確認しながらプレイ</span>
          </button>
          <button class="choice-btn ${appState.playStyle === 'time_attack' ? 'active' : ''}" data-opt="playStyle" data-val="time_attack"
            ${appState.difficulty === 'easy' ? 'disabled style="opacity:0.45; cursor:not-allowed;"' : ''}>
            <strong>⏱️ タイムアタック (${TIME_ATTACK_FRAMES}問連続)</strong>
            <span>${
              appState.difficulty === 'easy'
                ? '※ イージーモードではタイムアタックは無効です'
                : '変換タイムを計測（送信調停中はタイマー停止／スキップ可）'
            }</span>
          </button>
        </div>
      </div>

      <div style="text-align:center;">
        <button class="btn btn-primary" id="btn-start-game" style="padding:0.8rem 2.2rem; font-size:1.05rem;">
          🚀 コントローラ起動 (スタート)
        </button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">🏆 タイムアタック自己ベスト (${TIME_ATTACK_FRAMES}フレーム連続 / DATA 2Byte)</div>
      <div class="records-grid">
        <div class="record-item"><span>TX 通常</span><span class="record-time">${formatTimeMs(records['tx_normal'])}</span></div>
        <div class="record-item"><span>TX ハード</span><span class="record-time">${formatTimeMs(records['tx_hard'])}</span></div>
        <div class="record-item"><span>TX 超ハード</span><span class="record-time">${formatTimeMs(records['tx_extreme'])}</span></div>
        <div class="record-item"><span>RX 通常</span><span class="record-time">${formatTimeMs(records['rx_normal'])}</span></div>
        <div class="record-item"><span>RX ハード</span><span class="record-time">${formatTimeMs(records['rx_hard'])}</span></div>
        <div class="record-item"><span>RX 超ハード</span><span class="record-time">${formatTimeMs(records['rx_extreme'])}</span></div>
      </div>
    </div>
  `;

  mainEl.querySelectorAll('.choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      appState[btn.dataset.opt] = btn.dataset.val;
      if (appState.difficulty === 'easy') {
        appState.playStyle = 'practice';
      }
      renderMenu();
    });
  });

  document.getElementById('btn-start-game').addEventListener('click', startGame);
}

/* ==================== GAME FLOW ==================== */
function startGame() {
  stopTimersAndSim();
  appState.screen = 'play';
  appState.frameIndex = 0;
  appState.accumulatedMs = 0;
  appState.timerSegmentStart = Date.now();
  appState.timerPaused = false;
  appState.penaltyMs = 0;
  appState.skippedCount = 0;
  btnBackMenu.classList.remove('hidden');

  if (appState.playStyle === 'time_attack') {
    appState.timerInterval = setInterval(updateHudTimer, 50);
  }
  loadNextMission();
}

function loadNextMission() {
  appState.mission = generateMission(appState.mode, appState.difficulty);
  appState.phase = 'frame';
  appState.rxRemovedStuff = new Set();

  if (appState.playStyle === 'time_attack') {
    resumeTimer();
  }

  if (appState.mode === 'tx' && (appState.difficulty === 'easy' || appState.difficulty === 'normal')) {
    initTxSlots(appState.mission);
  }
  renderPlayScreen();
}

function initTxSlots(mission) {
  let dataBitCounter = 0;
  appState.txSlots = mission.encoded.wireAnnotated.map((item, idx) => {
    let byteIdx = -1;
    if (item.field === 'DATA') {
      byteIdx = Math.floor(dataBitCounter / 8);
      dataBitCounter++;
    }
    return {
      index: idx,
      field: item.field,
      byteIdx,
      expectedBit: item.bit,
      isStuff: item.isStuff,
      value: null,
    };
  });
}

function skipCurrentFrame() {
  stopTimersAndSim();
  if (appState.playStyle === 'time_attack') {
    if (appState.phase === 'bus') {
      // Skipping bus arbitration still records the Step 1 conversion time as a valid clear
      handleMissionCleared(false);
    } else {
      appState.skippedCount++;
      appState.timerInterval = setInterval(updateHudTimer, 50);
      handleMissionCleared(true);
    }
  } else {
    loadNextMission();
  }
}

function renderHudHtml() {
  const modeLabel = appState.mode === 'tx' ? '📤 送信 (TX)' : '📥 受信 (RX)';
  const diffLabel =
    appState.difficulty === 'easy'
      ? '🌱 イージー'
      : appState.difficulty === 'normal'
      ? '🟢 通常'
      : appState.difficulty === 'hard'
      ? '🔥 ハード'
      : '💀 超ハード';
  const progressLabel =
    appState.playStyle === 'time_attack'
      ? `Frame ${appState.frameIndex + 1} / ${TIME_ATTACK_FRAMES}`
      : 'Practice Mode';

  return `
    <div class="hud-bar">
      <div class="hud-pills">
        <span class="pill pill-accent">${modeLabel}</span>
        <span class="pill">${diffLabel}</span>
        <span class="pill">${progressLabel}</span>
        ${appState.penaltyMs > 0 ? `<span class="pill pill-warn">ペナルティ +${appState.penaltyMs / 1000}s</span>` : ''}
        ${appState.skippedCount > 0 ? `<span class="pill">スキップ ${appState.skippedCount}回</span>` : ''}
      </div>
      <div style="display:flex; align-items:center; gap:0.75rem;">
        ${
          appState.playStyle === 'time_attack'
            ? `<button class="btn btn-sm btn-ghost" id="btn-skip-frame">${
                appState.phase === 'bus' ? '⏭ 調停をスキップして記録' : '⏭ スキップ'
              }</button>
               <div class="timer-display" id="hud-timer">${
                 appState.timerPaused
                   ? `⏸ ${formatTimeMs(getElapsedMs())}`
                   : formatTimeMs(getElapsedMs())
               }</div>`
            : `<button class="btn btn-sm btn-ghost" id="btn-skip-frame">⏭ 別の問題へ</button>`
        }
      </div>
    </div>
  `;
}

function bindHudEvents() {
  document.getElementById('btn-skip-frame')?.addEventListener('click', skipCurrentFrame);
}

function renderPlayScreen() {
  if (appState.phase === 'bus') {
    renderBusPhase();
    return;
  }

  if (appState.mode === 'tx') {
    if (appState.difficulty === 'hard' || appState.difficulty === 'extreme') {
      renderTxHard(appState.difficulty === 'extreme');
    } else {
      renderTxSlotMode(appState.difficulty === 'easy');
    }
  } else {
    if (appState.difficulty === 'easy') {
      renderRxEasy();
    } else if (appState.difficulty === 'normal') {
      renderRxNormal();
    } else if (appState.difficulty === 'hard') {
      renderRxHard();
    } else {
      renderRxExtreme();
    }
  }
}

/* ==================== TX EASY & NORMAL ==================== */
function renderTxSlotMode(isEasy) {
  const m = appState.mission;
  const idBin = intToBits(m.id, 11).join('');
  const dlcBin = intToBits(m.dlc, 4).join('');
  const dataBins = m.dataBytes.map((b) => intToBits(b, 8).join(''));

  // Group slots by field, splitting DATA into Byte 0..7 for readability
  const groups = [];
  let currentGroup = null;
  for (const slot of appState.txSlots) {
    const groupKey = slot.isStuff
      ? currentGroup
        ? currentGroup.key
        : 'STUFF'
      : slot.field === 'DATA'
      ? `DATA_${slot.byteIdx}`
      : slot.field;

    if (!currentGroup || currentGroup.key !== groupKey) {
      const label =
        slot.field === 'DATA'
          ? `Data[${slot.byteIdx}] (${toHex(m.dataBytes[slot.byteIdx], 2)})`
          : CAN_FIELDS[slot.field]?.label || slot.field;
      const color = CAN_FIELDS[slot.field]?.color || '#64748b';
      currentGroup = { key: groupKey, field: slot.field, label, color, slots: [] };
      groups.push(currentGroup);
    }
    currentGroup.slots.push(slot);
  }

  const preCrcSlots = appState.txSlots.filter(
    (s) => !s.isStuff && ['SOF', 'ID', 'RTR', 'IDE', 'R0', 'DLC', 'DATA'].includes(s.field)
  );
  const preCrcReady = preCrcSlots.every((s) => s.value !== null);
  const computedCrcBits = preCrcReady
    ? intToBits(computeCrc15(preCrcSlots.map((s) => s.value)), 15).join('')
    : null;

  mainEl.innerHTML = `
    ${renderHudHtml()}
    <div class="card">
      <div class="card-title">
        <span>送信リクエスト: ${m.ecu} (${m.label})</span>
        <span class="pill pill-accent">DATA 2Byte固定 (DLC=2) / スタッフビット: ${m.encoded.stuffBitCount}個</span>
      </div>
      <div class="mission-specs">
        <div class="spec-box">
          <div class="spec-label">ID (11-bit)</div>
          <div class="spec-val">${toHex(m.id, 3)}</div>
          <div class="spec-bin">${idBin}</div>
        </div>
        <div class="spec-box">
          <div class="spec-label">DLC (4-bit)</div>
          <div class="spec-val">${m.dlc}</div>
          <div class="spec-bin">${dlcBin}</div>
        </div>
        <div class="spec-box" style="flex:1">
          <div class="spec-label">Data (2 Bytes)</div>
          <div class="spec-val">${m.dataBytes.map((b) => toHex(b, 2)).join(' ')}</div>
          <div class="spec-bin">${dataBins.map((b, i) => `[${i}]${b}`).join(' ')}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>Step 1: 標準データフレーム組立 &amp; スタッフビット挿入</span>
        ${
          isEasy
            ? `<button class="btn btn-sm btn-ghost" id="btn-fill-fixed">✨ 固定部(SOF/RTR/IDE/r0/Delim/ACK/EOF)を自動入力</button>`
            : `<span class="pill">通常モード: 全ビット手動入力</span>`
        }
      </div>
      ${
        isEasy
          ? `<div class="feedback info" style="margin-top:0; margin-bottom:0.85rem;">
              <strong>🌱 チュートリアル手順：</strong>
              ① 右上の「固定部を自動入力」を押す → ② 上の2進数を見ながら <code>ID</code>・<code>DLC(0010)</code>・<code>Data[0..1]</code> を入力（<code>0</code>/<code>1</code>キー連打で次へ進みます！） →
              ③ 黄色い <code style="color:var(--warning)">S</code> スロットには<strong>直前と逆のビット</strong>を入力 → ④ 下の「CRC-15をスロットに反映」を押して検証！
            </div>`
          : `<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0;">
              フィールド色分けと <code style="color:var(--warning)">S</code>（スタッフビット位置）はハイライトされています。キーボードの <code>0</code> / <code>1</code>（またはクリック）で全ビットを手動入力してください。
            </p>`
      }

      <div class="field-groups" id="tx-normal-groups">
        ${groups
          .map(
            (g) => `
              <div class="field-group" style="border-top-color:${g.color}">
                <div class="field-group-header" style="color:${g.color}">
                  <span>${g.label}</span>
                </div>
                <div class="bit-row">
                  ${g.slots
                    .map((s) => {
                      const cls =
                        s.value === null ? 'bit-empty' : s.value === 0 ? 'bit-0' : 'bit-1';
                      const stuffCls = s.isStuff ? 'stuff-slot' : '';
                      return `<button type="button" class="bit-slot ${cls} ${stuffCls}" data-idx="${s.index}" title="${
                        s.isStuff ? 'スタッフビット (5連続の反転)' : g.label
                      }">${s.value === null ? '·' : s.value}</button>`;
                    })
                    .join('')}
                </div>
              </div>
            `
          )
          .join('')}
      </div>

      <div class="feedback info" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <div>
          <strong>ハードウェア CRC-15 演算器:</strong>
          ${
            computedCrcBits
              ? `<code>${computedCrcBits}</code>`
              : '<span style="color:var(--text-muted)">SOF〜Dataをすべて入力すると計算されます</span>'
          }
        </div>
        ${
          isEasy && computedCrcBits
            ? `<button class="btn btn-sm btn-primary" id="btn-apply-crc">✨ CRC-15をスロットに反映</button>`
            : ''
        }
      </div>

      <div id="tx-feedback"></div>

      <div style="margin-top:1rem; display:flex; justify-content:flex-end;">
        <button class="btn btn-success" id="btn-tx-validate">⚡ フレーム検証 → バス調停フェーズへ</button>
      </div>
    </div>
  `;

  bindHudEvents();

  mainEl.querySelectorAll('.bit-slot').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const slot = appState.txSlots[idx];
      slot.value = slot.value === null ? 0 : slot.value === 0 ? 1 : 0;
      renderTxSlotMode(isEasy);
      mainEl.querySelector(`.bit-slot[data-idx="${idx}"]`)?.focus();
    });

    btn.addEventListener('keydown', (e) => {
      const idx = Number(btn.dataset.idx);
      if (e.key === '0' || e.key === '1') {
        e.preventDefault();
        appState.txSlots[idx].value = Number(e.key);
        renderTxSlotMode(isEasy);
        mainEl.querySelector(`.bit-slot[data-idx="${idx + 1}"]`)?.focus();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        appState.txSlots[idx].value = null;
        renderTxSlotMode(isEasy);
        mainEl.querySelector(`.bit-slot[data-idx="${Math.max(0, idx - 1)}"]`)?.focus();
      }
    });
  });

  document.getElementById('btn-fill-fixed')?.addEventListener('click', () => {
    for (const s of appState.txSlots) {
      if (s.isStuff) continue;
      if (['SOF', 'RTR', 'IDE', 'R0'].includes(s.field)) s.value = 0;
      if (['CRC_DELIM', 'ACK_SLOT', 'ACK_DELIM', 'EOF'].includes(s.field)) s.value = 1;
    }
    renderTxSlotMode(isEasy);
  });

  const applyCrcBtn = document.getElementById('btn-apply-crc');
  if (applyCrcBtn && computedCrcBits) {
    applyCrcBtn.addEventListener('click', () => {
      let cIdx = 0;
      for (const s of appState.txSlots) {
        if (!s.isStuff && s.field === 'CRC') {
          s.value = Number(computedCrcBits[cIdx++]);
        }
      }
      renderTxSlotMode(isEasy);
    });
  }

  document.getElementById('btn-tx-validate').addEventListener('click', () => {
    const fb = document.getElementById('tx-feedback');
    const emptyCount = appState.txSlots.filter((s) => s.value === null).length;
    if (emptyCount > 0) {
      fb.innerHTML = `<div class="feedback warning">まだ未入力のスロットが ${emptyCount} 個あります。</div>`;
      return;
    }

    const firstMismatch = appState.txSlots.find((s) => s.value !== s.expectedBit);
    if (firstMismatch) {
      addPenalty(5);
      const label = firstMismatch.isStuff
        ? 'スタッフビット (5連続の反転ビット)'
        : CAN_FIELDS[firstMismatch.field]?.label || firstMismatch.field;
      fb.innerHTML = `<div class="feedback error">不一致があります！ Bit #${firstMismatch.index + 1} (${label}) を確認してください。</div>`;
      return;
    }

    appState.phase = 'bus';
    renderBusPhase();
  });
}

/* ==================== TX HARD & EXTREME ==================== */
function renderTxHard(isExtreme = false) {
  const m = appState.mission;
  mainEl.innerHTML = `
    ${renderHudHtml()}
    <div class="card">
      <div class="card-title">
        <span>${isExtreme ? '💀 超ハードモード' : '🔥 ハードモード'}送信リクエスト: ${m.ecu} (${m.label})</span>
        <span class="pill pill-warn">DATA 2Byte固定 (DLC=2) / ${isExtreme ? 'CRC計算機なし' : 'ガイドなし'}</span>
      </div>
      <div class="mission-specs">
        <div class="spec-box">
          <div class="spec-label">ID (11-bit Hex)</div>
          <div class="spec-val">${toHex(m.id, 3)}</div>
        </div>
        <div class="spec-box">
          <div class="spec-label">DLC</div>
          <div class="spec-val">2</div>
        </div>
        <div class="spec-box" style="flex:1">
          <div class="spec-label">Data Bytes (Hex)</div>
          <div class="spec-val">${m.dataBytes.map((b) => toHex(b, 2)).join(' ')}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">📝 メモ欄 (Scratchpad)</div>
      <textarea class="scratchpad" id="hard-scratchpad" placeholder="2進数への変換や、5連続ビットのチェック用メモとして自由に使えます..."></textarea>
    </div>

    ${
      isExtreme
        ? `<div id="crc-long-div-pad"></div>`
        : `
      <div class="card">
        <div class="card-title">🧮 ハードウェア CRC-15 計算機</div>
        <p style="font-size:0.83rem; color:var(--text-muted); margin-top:0;">
          SOF(0) 〜 Data(2Byte) までの<strong>デスタッフ済みビット列</strong>を入力すると、15bit の CRC を計算します。
        </p>
        <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
          <input type="text" class="hex-input" id="crc-calc-input" style="flex:1; min-width:220px; text-transform:none;" placeholder="例: 0 00110100011 0 0 0 0010 ..." />
          <button class="btn btn-primary" id="btn-calc-crc">CRC-15 計算</button>
        </div>
        <div id="crc-calc-out" style="margin-top:0.5rem;"></div>
      </div>
    `
    }

    <div class="card">
      <div class="card-title">Step 1: 生ビット列出力 (SOF〜EOF / スタッフビット込み)</div>
      <textarea class="bitstream-input" id="hard-tx-input" rows="3" placeholder="0と1のみで入力してください（スペースや改行は無視されます）"></textarea>
      <div id="tx-hard-feedback"></div>
      <div style="margin-top:1rem; display:flex; justify-content:flex-end;">
        <button class="btn btn-success" id="btn-hard-tx-validate">⚡ ビット列を検証 → バス調停フェーズへ</button>
      </div>
    </div>
  `;

  bindHudEvents();

  if (isExtreme) {
    mountCrcLongDivisionPad(document.getElementById('crc-long-div-pad'));
  }

  document.getElementById('btn-calc-crc')?.addEventListener('click', () => {
    const raw = document.getElementById('crc-calc-input').value.replace(/\s+/g, '');
    const out = document.getElementById('crc-calc-out');
    if (!/^[01]+$/.test(raw)) {
      out.innerHTML = `<div class="feedback error">0 と 1 のみで入力してください。</div>`;
      return;
    }
    const crc = computeCrc15(raw.split('').map(Number));
    const crcBin = intToBits(crc, 15).join('');
    out.innerHTML = `<div class="feedback info">CRC-15 (${raw.length}bit入力): <code>${crcBin}</code> (${toHex(crc, 4)})</div>`;
  });

  document.getElementById('btn-hard-tx-validate').addEventListener('click', () => {
    const cleaned = document.getElementById('hard-tx-input').value.replace(/\s+/g, '');
    const expected = m.encoded.wireBits.join('');
    const fb = document.getElementById('tx-hard-feedback');

    if (!/^[01]+$/.test(cleaned)) {
      fb.innerHTML = `<div class="feedback error">0 と 1 のみで入力してください。</div>`;
      return;
    }

    if (cleaned !== expected) {
      addPenalty(5);
      let diffIdx = 0;
      while (diffIdx < cleaned.length && diffIdx < expected.length && cleaned[diffIdx] === expected[diffIdx]) {
        diffIdx++;
      }
      fb.innerHTML = `
        <div class="feedback error">
          ビット列が一致しません！(入力: ${cleaned.length}bit / 正解: ${expected.length}bit) —
          最初の不一致は <strong>Bit #${diffIdx + 1}</strong> 付近です。
        </div>`;
      return;
    }

    appState.phase = 'bus';
    renderBusPhase();
  });
}

/* ==================== PHASE 2: BUS TIMING & ARBITRATION ==================== */
function renderBusPhase() {
  // Pause Time Attack timer during bus arbitration so luck/animation speed doesn't affect score
  pauseTimer();

  const m = appState.mission;
  mainEl.innerHTML = `
    ${renderHudHtml()}
    <div class="card">
      <div class="card-title">
        <span>Step 2: バスタイミング制御 &amp; 調停 (Arbitration)</span>
        <span class="pill pill-accent">自ノードID: ${toHex(m.id, 3)}</span>
      </div>
      ${
        appState.playStyle === 'time_attack'
          ? `<div class="feedback info" style="margin-top:0; margin-bottom:0.75rem;">
              ⏱️ <strong>タイムアタックタイマー一時停止中：</strong>運要素をなくすため、調停フェーズの時間はタイムに加算されません。（「⏭ スキップ」で次へ進むこともできます）
            </div>`
          : ''
      }
      <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0;">
        1. 他ノードのフレーム完了 (EOF + IFS) を待って <strong>IDLE</strong> になったら <code>[SOF送信]</code> を押してください。<br/>
        2. 競合ノードと同時に送信が始まったら調停（ID比較）に入ります。自分が <code>1</code> を出したのにバスが <code>0</code> なら即座に <code>[送信停止 (Back Off)]</code> を押してください！
      </p>

      <div id="bus-dynamic-area"></div>
    </div>
  `;

  bindHudEvents();

  appState.busSim = new CanBusSimulator({
    playerId: m.id,
    playerWireBits: m.encoded.wireBits,
    difficulty: appState.difficulty,
    onUpdate: (simState) => {
      const container = document.getElementById('bus-dynamic-area');
      if (!container) return;

      const stateBadge =
        simState.state === 'WAIT_IDLE'
          ? '<span class="pill pill-warn">BUSY (他ECU送信中)</span>'
          : simState.state === 'IDLE'
          ? '<span class="pill pill-accent" style="border-color:var(--success); color:var(--success)">IDLE (送信可能!)</span>'
          : simState.state === 'ARBITRATION'
          ? '<span class="pill pill-warn">ARBITRATION (調停中)</span>'
          : '<span class="pill pill-accent">STREAMING</span>';

      const showCompRow = appState.difficulty !== 'hard' && appState.difficulty !== 'extreme';
      const arbMonitorHtml =
        simState.arbHistory && simState.arbHistory.length > 0
          ? `
        <div class="arb-monitor">
          <div class="arb-monitor-title">
            <span>🔍 調停モニター (Wired-AND: 0 が 1 に勝つ)</span>
            <span>${
              simState.compId !== null && showCompRow
                ? `自ノード ${toHex(simState.playerId, 3)} vs 競合ECU ${toHex(simState.compId, 3)}`
                : `自ノード ${toHex(simState.playerId, 3)}`
            }</span>
          </div>
          <div class="arb-table">
            <div class="arb-row">
              <div class="arb-row-label">ビット位置</div>
              ${simState.arbHistory.map((h) => `<div class="arb-cell header">${h.label}</div>`).join('')}
            </div>
            <div class="arb-row">
              <div class="arb-row-label">あなた (TX)</div>
              ${simState.arbHistory
                .map((h) => `<div class="arb-cell status-${h.status}">${h.myBit}</div>`)
                .join('')}
            </div>
            ${
              showCompRow
                ? `<div class="arb-row">
                    <div class="arb-row-label">競合ECU</div>
                    ${simState.arbHistory
                      .map((h) => `<div class="arb-cell status-${h.status}">${h.compBit}</div>`)
                      .join('')}
                  </div>`
                : ''
            }
            <div class="arb-row">
              <div class="arb-row-label">バス結果 (AND)</div>
              ${simState.arbHistory
                .map((h) => `<div class="arb-cell status-${h.status}">${h.busBit}</div>`)
                .join('')}
            </div>
          </div>
        </div>
      `
          : '';

      const easyExplainHtml =
        appState.difficulty === 'easy' && simState.arbLostPending
          ? `<div class="feedback info" style="margin-top:0.65rem;">
              <strong>💡 今起きていること：</strong>
              CANバスでは <code>0</code>（ドミナント）が <code>1</code>（リセッシブ）を電気的に上書きします（Wired-AND）。<br/>
              上の調停モニターの黄色い列で、あなたは <code>1</code> を送信したのにバスが <code>0</code> になっています。これは<strong>IDが小さい（優先度が高い）別のECU</strong>が同時に送信している証拠です！<br/>
              壊さずに譲るため、<strong>[🛑 調停負け・送信停止 (Back Off)]</strong> を押して相手が終わるのを待ちましょう。
            </div>`
          : '';

      container.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.6rem;">
          <div>バス状態: ${stateBadge}</div>
          <div style="font-family:var(--mono); font-size:0.85rem; color:var(--text-muted)">
            送信進捗: ${simState.bitIndex} / ${simState.totalBits} bit
          </div>
        </div>

        <div class="oscilloscope">
          <div class="scope-track" id="scope-track">
            ${simState.trace
              .map(
                (t) => `
              <div class="scope-bit val-${t.bit} src-${t.source}">
                <div class="scope-bar"></div>
                <span>${t.bit}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>

        ${arbMonitorHtml}

        <div class="feedback ${simState.messageType}">${simState.message}</div>
        ${easyExplainHtml}

        <div class="bus-controls">
          ${
            simState.state === 'COMPLETE'
              ? `<button class="btn btn-success pulse-urgent" id="btn-bus-finish">✅ 送信完了！次へ進む</button>`
              : `
                <button class="btn btn-primary ${simState.state === 'IDLE' ? 'pulse-urgent' : ''}" id="btn-send-sof"
                  ${simState.state !== 'WAIT_IDLE' && simState.state !== 'IDLE' ? 'disabled' : ''}>
                  📡 SOF送信 (0)
                </button>
                ${
                  appState.difficulty === 'easy' && simState.state === 'ARBITRATION' && !simState.arbLostPending
                    ? `<button class="btn btn-primary" id="btn-step-arb">➡️ 次の1ビットを送る</button>`
                    : ''
                }
                <button class="btn btn-warning ${simState.arbLostPending ? 'pulse-urgent' : ''}" id="btn-back-off"
                  ${simState.state !== 'ARBITRATION' ? 'disabled' : ''}>
                  🛑 調停負け・送信停止 (Back Off)
                </button>
              `
          }
        </div>
      `;

      const track = document.getElementById('scope-track');
      if (track) track.scrollLeft = track.scrollWidth;

      document.getElementById('btn-send-sof')?.addEventListener('click', () => {
        appState.busSim.sendSof();
      });

      document.getElementById('btn-step-arb')?.addEventListener('click', () => {
        appState.busSim.stepArbitration();
      });

      document.getElementById('btn-back-off')?.addEventListener('click', () => {
        appState.busSim.backOff();
      });

      document.getElementById('btn-bus-finish')?.addEventListener('click', () => {
        handleMissionCleared(false);
      });
    },
    onComplete: () => {
      // Wait for user to click [✅ 送信完了！次へ進む] so they can inspect the arbitration & ACK result
    },
  });
}

/* ==================== RX EASY (TUTORIAL) ==================== */
function renderRxEasy() {
  const m = appState.mission;
  const wireBits = m.encoded.wireBits;
  const decoded = decodeStandardFrame(wireBits);
  const stuffSet = new Set(decoded.stuffIndices);
  const allStuffRemoved = decoded.stuffIndices.every((idx) => appState.rxRemovedStuff.has(idx));

  const destuffedAnnotated = m.encoded.wireAnnotated.filter((x) => !x.isStuff);
  const fieldGroups = [];
  let cur = null;
  let dataCounter = 0;
  for (const item of destuffedAnnotated) {
    let key = item.field;
    let label = CAN_FIELDS[item.field]?.label || item.field;
    if (item.field === 'DATA') {
      const bIdx = Math.floor(dataCounter / 8);
      key = `DATA_${bIdx}`;
      label = `Data[${bIdx}]`;
      dataCounter++;
    }
    if (!cur || cur.key !== key) {
      cur = { key, field: item.field, label, color: CAN_FIELDS[item.field]?.color || '#64748b', bits: [] };
      fieldGroups.push(cur);
    }
    cur.bits.push(item.bit);
  }

  mainEl.innerHTML = `
    ${renderHudHtml()}
    <div class="card">
      <div class="card-title">
        <span>🌱 Step 1: 受信生ビット列のデスタッフ (クリックで除去)</span>
        <span class="pill pill-accent">残りスタッフビット: ${decoded.stuffIndices.length - appState.rxRemovedStuff.size}</span>
      </div>
      <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0;">
        黄色くハイライトされた <code style="color:var(--warning)">S</code> ビットをすべてクリックして取り除くと、Step 2 のフレーム解読が開きます。
      </p>

      <div class="bit-row" id="rx-wire-bits">
        ${wireBits
          .map((b, idx) => {
            const isStuff = stuffSet.has(idx);
            const isRemoved = appState.rxRemovedStuff.has(idx);
            const cls = b === 0 ? 'bit-0' : 'bit-1';
            const extra = isRemoved ? 'stuff-removed' : isStuff ? 'stuff-slot' : '';
            return `<button type="button" class="bit-slot ${cls} ${extra}" data-idx="${idx}">${b}</button>`;
          })
          .join('')}
      </div>
      <div id="rx-step1-fb"></div>
    </div>

    ${
      allStuffRemoved
        ? `
      <div class="card">
        <div class="card-title">Step 2: フレーム構造の解読 &amp; ACK応答</div>
        <div class="feedback info" style="margin-top:0; margin-bottom:0.85rem;">
          <strong>🌱 チュートリアルヒント：</strong>
          ID (11bit) = <code>${toHex(m.id, 3)}</code> ／ Data (2バイト) = <code>${m.dataBytes
            .map((b) => toHex(b, 2).replace('0x', ''))
            .join(' ')}</code>
        </div>
        <div class="field-groups" style="margin-bottom:1rem;">
          ${fieldGroups
            .map(
              (g) => `
                <div class="field-group" style="border-top-color:${g.color}">
                  <div class="field-group-header" style="color:${g.color}">${g.label}</div>
                  <div class="bit-row">
                    ${g.bits.map((b) => `<span class="bit-slot ${b === 0 ? 'bit-0' : 'bit-1'}">${b}</span>`).join('')}
                  </div>
                </div>
              `
            )
            .join('')}
        </div>

        <div class="input-row">
          <div class="field-input-group">
            <label for="rx-id-input">ID (16進数 / 例: 1A3)</label>
            <input type="text" class="hex-input" id="rx-id-input" placeholder="1A3" maxlength="5" style="width:130px" />
          </div>
          <div class="field-input-group" style="flex:1; min-width:200px;">
            <label for="rx-data-input">Data Bytes (2バイト 16進数スペース区切り)</label>
            <input type="text" class="hex-input" id="rx-data-input" placeholder="5A 0F ..." />
          </div>
          <button class="btn btn-success" id="btn-rx-submit">✅ ACK (0) 送信して受信完了</button>
        </div>
        <div id="rx-step2-fb"></div>
      </div>
    `
        : ''
    }
  `;

  bindHudEvents();

  mainEl.querySelectorAll('#rx-wire-bits .bit-slot').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      if (stuffSet.has(idx)) {
        appState.rxRemovedStuff.add(idx);
        renderRxEasy();
      } else {
        addPenalty(5);
        document.getElementById('rx-step1-fb').innerHTML =
          `<div class="feedback error">Bit #${idx + 1} はスタッフビットではありません！</div>`;
      }
    });
  });

  document.getElementById('btn-rx-submit')?.addEventListener('click', () => {
    validateRxAnswer(m, 'rx-step2-fb');
  });
}

/* ==================== RX NORMAL (HIGHLIGHT ONLY, MANUAL DECODE) ==================== */
function renderRxNormal() {
  const m = appState.mission;
  const wireBits = m.encoded.wireBits;

  // Group wireAnnotated into readable field blocks while keeping STUFF bits highlighted inline
  const groups = [];
  let cur = null;
  let dataCounter = 0;
  for (const item of m.encoded.wireAnnotated) {
    let key = item.isStuff ? (cur ? cur.key : 'STUFF') : item.field;
    let label = CAN_FIELDS[item.field]?.label || item.field;
    if (!item.isStuff && item.field === 'DATA') {
      const bIdx = Math.floor(dataCounter / 8);
      key = `DATA_${bIdx}`;
      label = `Data[${bIdx}]`;
      dataCounter++;
    }
    if (!cur || cur.key !== key) {
      cur = {
        key,
        label,
        color: CAN_FIELDS[item.field]?.color || '#64748b',
        items: [],
      };
      groups.push(cur);
    }
    cur.items.push(item);
  }

  mainEl.innerHTML = `
    ${renderHudHtml()}
    <div class="card">
      <div class="card-title">
        <span>🟢 通常モード受信: スタッフビット &amp; フィールドハイライト表示</span>
        <span class="pill pill-accent">スタッフビット数: ${m.encoded.stuffBitCount}</span>
      </div>
      <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0;">
        黄色く光る <code style="color:var(--warning)">S</code> ビットを<strong>自分で読み飛ばしながら（デスタッフして）</strong>、<code>ID</code> と <code>Data[0..1]</code> を16進数で読み取り入力してください。
      </p>

      <div class="field-groups" style="margin-bottom:1rem;">
        ${groups
          .map(
            (g) => `
              <div class="field-group" style="border-top-color:${g.color}">
                <div class="field-group-header" style="color:${g.color}">${g.label}</div>
                <div class="bit-row">
                  ${g.items
                    .map(
                      (it) =>
                        `<span class="bit-slot ${it.bit === 0 ? 'bit-0' : 'bit-1'} ${
                          it.isStuff ? 'stuff-slot' : ''
                        }" title="${it.isStuff ? 'スタッフビット (読み飛ばす)' : g.label}">${it.bit}</span>`
                    )
                    .join('')}
                </div>
              </div>
            `
          )
          .join('')}
      </div>

      <div class="input-row">
        <div class="field-input-group">
          <label for="rx-id-input">ID (16進数 / 例: 1A3)</label>
          <input type="text" class="hex-input" id="rx-id-input" placeholder="1A3" maxlength="5" style="width:130px" />
        </div>
        <div class="field-input-group" style="flex:1; min-width:220px;">
          <label for="rx-data-input">Data Bytes (2バイト 16進数スペース区切り)</label>
          <input type="text" class="hex-input" id="rx-data-input" placeholder="5A 0F ..." />
        </div>
        <button class="btn btn-success" id="btn-rx-submit">✅ ACK (0) 送信して受信完了</button>
      </div>
      <div id="rx-normal-fb"></div>
    </div>
  `;

  bindHudEvents();

  document.getElementById('btn-rx-submit').addEventListener('click', () => {
    validateRxAnswer(m, 'rx-normal-fb');
  });
}

/* ==================== RX HARD ==================== */
function renderRxHard() {
  const m = appState.mission;
  const rawStr = m.encoded.wireBits.join('');

  mainEl.innerHTML = `
    ${renderHudHtml()}
    <div class="card">
      <div class="card-title">
        <span>🔥 ハードモード受信: 生ビット列 (DATA 2Byte / DLC=2)</span>
        <button class="btn btn-sm btn-ghost" id="btn-copy-to-pad">📝 メモ欄にコピー</button>
      </div>
      <div class="raw-stream-box">${rawStr}</div>
    </div>

    <div class="card">
      <div class="card-title">📝 メモ欄 (Scratchpad)</div>
      <textarea class="scratchpad" id="rx-hard-pad" placeholder="スタッフビットに印をつけたり、SOF / ID(11bit) / RTR / IDE / r0 / DLC(4bit) / Data(16bit) に区切ってみましょう..."></textarea>
    </div>

    <div class="card">
      <div class="card-title">受信レジスタ入力 &amp; ACK応答</div>
      <div class="input-row">
        <div class="field-input-group">
          <label for="rx-id-input">ID (16進数 / 例: 1A3)</label>
          <input type="text" class="hex-input" id="rx-id-input" placeholder="1A3" maxlength="5" style="width:130px" />
        </div>
        <div class="field-input-group" style="flex:1; min-width:220px;">
          <label for="rx-data-input">Data Bytes (2バイト 16進数スペース区切り)</label>
          <input type="text" class="hex-input" id="rx-data-input" placeholder="5A 0F ..." />
        </div>
        <button class="btn btn-success" id="btn-rx-submit">✅ ACK (0) 送信して受信完了</button>
      </div>
      <div id="rx-hard-fb"></div>
    </div>
  `;

  bindHudEvents();

  document.getElementById('btn-copy-to-pad').addEventListener('click', () => {
    const pad = document.getElementById('rx-hard-pad');
    pad.value = rawStr;
    pad.focus();
  });

  document.getElementById('btn-rx-submit').addEventListener('click', () => {
    validateRxAnswer(m, 'rx-hard-fb');
  });
}

/* ==================== RX EXTREME (CRC HAND CALCULATION) ==================== */
function renderRxExtreme() {
  const m = appState.mission;
  const preCrcStuffed = stuffBits(m.encoded.preCrcBits).stuffedBits.join('');

  mainEl.innerHTML = `
    ${renderHudHtml()}
    <div class="card">
      <div class="card-title">
        <span>💀 超ハードモード受信: 生ビット列 (CRC-15はマスク中！)</span>
        <button class="btn btn-sm btn-ghost" id="btn-copy-to-pad">📝 メモ欄にコピー</button>
      </div>
      <p style="font-size:0.83rem; color:var(--text-muted); margin-top:0;">
        <code>SOF〜Data</code>（スタッフ込み）の後ろの <strong>CRC-15 (15bit)</strong> が隠されています。
        デスタッフして <code>ID</code> と <code>Data</code> を解読し、さらに <code>SOF〜Data</code>（デスタッフ済35bit）から <strong>CRC-15を手計算</strong> して一致させてください！
      </p>
      <div class="raw-stream-box">
        <span>${preCrcStuffed}</span><span style="color:var(--warning); font-weight:800;">???????????????</span><span style="color:var(--text-muted);">1111111111</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">📝 デスタッフ用メモ欄 (Scratchpad)</div>
      <textarea class="scratchpad" id="rx-extreme-pad" placeholder="スタッフビットに印をつけたり、SOF / ID(11bit) / RTR / IDE / r0 / DLC(4bit) / Data(16bit) に区切ってみましょう..."></textarea>
    </div>

    <div id="crc-long-div-pad"></div>

    <div class="card">
      <div class="card-title">受信レジスタ入力 &amp; CRC-15 検証</div>
      <div class="input-row">
        <div class="field-input-group">
          <label for="rx-id-input">ID (16進数 / 例: 1A3)</label>
          <input type="text" class="hex-input" id="rx-id-input" placeholder="1A3" maxlength="5" style="width:120px" />
        </div>
        <div class="field-input-group" style="flex:1; min-width:180px;">
          <label for="rx-data-input">Data Bytes (2バイト 16進数スペース区切り)</label>
          <input type="text" class="hex-input" id="rx-data-input" placeholder="5A 0F" />
        </div>
        <div class="field-input-group" style="flex:1; min-width:210px;">
          <label for="rx-crc-input">CRC-15 (15bit 2進数)</label>
          <input type="text" class="hex-input" id="rx-crc-input" style="text-transform:none;" placeholder="15bit (例: 101011001110001)" maxlength="20" />
        </div>
        <button class="btn btn-success" id="btn-rx-submit">✅ CRC検証 &amp; ACK (0) 送信</button>
      </div>
      <div id="rx-extreme-fb"></div>
    </div>
  `;

  bindHudEvents();
  mountCrcLongDivisionPad(document.getElementById('crc-long-div-pad'));

  document.getElementById('btn-copy-to-pad').addEventListener('click', () => {
    const pad = document.getElementById('rx-extreme-pad');
    pad.value = preCrcStuffed;
    pad.focus();
  });

  document.getElementById('btn-rx-submit').addEventListener('click', () => {
    validateRxAnswer(m, 'rx-extreme-fb', true);
  });
}

function validateRxAnswer(mission, feedbackElId, requireCrc = false) {
  const idStr = document.getElementById('rx-id-input').value.trim().replace(/^0x/i, '');
  const dataStr = document.getElementById('rx-data-input').value.trim();
  const fb = document.getElementById(feedbackElId);

  const parsedId = parseInt(idStr, 16);
  if (!idStr || Number.isNaN(parsedId) || parsedId !== mission.id) {
    addPenalty(5);
    fb.innerHTML = `<div class="feedback error">IDが一致しません！11bitのIDフィールドを16進数に変換してください。</div>`;
    return;
  }

  const tokens = dataStr ? dataStr.split(/[\s,]+/).map((t) => t.replace(/^0x/i, '')) : [];
  const parsedBytes = tokens.map((t) => parseInt(t, 16));
  const bytesMatch =
    parsedBytes.length === mission.dataBytes.length &&
    parsedBytes.every((b, i) => !Number.isNaN(b) && b === mission.dataBytes[i]);

  if (!bytesMatch) {
    addPenalty(5);
    fb.innerHTML = `<div class="feedback error">Dataバイト列が一致しません！（2バイトを16進数スペース区切りで入力）</div>`;
    return;
  }

  if (requireCrc) {
    const crcInput = document.getElementById('rx-crc-input').value.replace(/\s+/g, '');
    const expectedCrcBin = intToBits(mission.encoded.crc, 15).join('');
    if (!/^[01]{15}$/.test(crcInput)) {
      addPenalty(5);
      fb.innerHTML = `<div class="feedback warning">IDとDataは正解です！CRC-15は15桁の2進数（0と1）で入力してください。</div>`;
      return;
    }
    if (crcInput !== expectedCrcBin) {
      addPenalty(5);
      fb.innerHTML = `<div class="feedback error">IDとDataは正解ですが、CRC-15が一致しません！生成多項式 <code>1100010110011001</code> での筆算を見直してください。</div>`;
      return;
    }
  }

  handleMissionCleared(false);
}

/* ==================== CLEAR / RESULT ==================== */
function handleMissionCleared(wasSkipped = false) {
  stopTimersAndSim();

  if (appState.playStyle === 'time_attack') {
    appState.frameIndex++;
    if (appState.frameIndex < TIME_ATTACK_FRAMES) {
      appState.timerInterval = setInterval(updateHudTimer, 50);
      loadNextMission();
      return;
    }

    const finalMs = getElapsedMs();
    const recordKey = `${appState.mode}_${appState.difficulty}`;
    // Only save best time if no frames were skipped
    const saveResult =
      appState.skippedCount === 0
        ? saveBestTime(recordKey, finalMs)
        : { isNewBest: false, bestMs: loadRecords()[recordKey] };

    mainEl.innerHTML = `
      <div class="card" style="text-align:center; padding:2rem 1.5rem;">
        <h2 style="margin-top:0; color:var(--success)">🏆 タイムアタック クリア！</h2>
        <p style="color:var(--text-muted)">
          ${appState.mode.toUpperCase()} / ${appState.difficulty.toUpperCase()} (${TIME_ATTACK_FRAMES}フレーム連続)
        </p>
        <div style="font-family:var(--mono); font-size:2.4rem; font-weight:800; color:var(--accent); margin:1rem 0;">
          ${formatTimeMs(finalMs)}
        </div>
        ${
          appState.skippedCount > 0
            ? `<div class="pill pill-warn" style="margin-bottom:1rem;">スキップ使用 (${appState.skippedCount}回) のため自己ベスト対象外</div>`
            : saveResult.isNewBest
            ? '<div class="pill pill-warn" style="font-size:0.95rem; margin-bottom:1rem;">🎉 NEW RECORD! 自己ベスト更新！</div>'
            : `<p style="color:var(--text-muted)">自己ベスト: <code>${formatTimeMs(saveResult.bestMs)}</code></p>`
        }
        <p style="font-size:0.85rem; color:var(--text-muted)">ペナルティ合計: +${appState.penaltyMs / 1000}秒</p>
        <div style="display:flex; gap:0.8rem; justify-content:center; margin-top:1.5rem;">
          <button class="btn btn-primary" id="btn-retry">🔄 もう一度挑戦</button>
          <button class="btn btn-ghost" id="btn-to-menu">🏠 メニューへ</button>
        </div>
      </div>
    `;
  } else {
    const m = appState.mission;
    mainEl.innerHTML = `
      <div class="card" style="text-align:center; padding:2rem 1.5rem;">
        <h2 style="margin-top:0; color:var(--success)">✅ ${wasSkipped ? 'スキップ' : 'ミッション完了！'}</h2>
        <p style="color:var(--text-muted)">
          ${m.ecu} (${m.label}) — ID: <code>${toHex(m.id, 3)}</code> / Data: <code>${m.dataBytes
      .map((b) => toHex(b, 2))
      .join(' ')}</code>
        </p>
        <div style="display:flex; gap:0.8rem; justify-content:center; margin-top:1.5rem;">
          <button class="btn btn-primary" id="btn-next-practice">➡️ 次のフレームへ</button>
          <button class="btn btn-ghost" id="btn-to-menu">🏠 メニューへ</button>
        </div>
      </div>
    `;
    document.getElementById('btn-next-practice').addEventListener('click', startGame);
  }

  document.getElementById('btn-retry')?.addEventListener('click', startGame);
  document.getElementById('btn-to-menu').addEventListener('click', goMenu);
}

// Initial render
renderMenu();
