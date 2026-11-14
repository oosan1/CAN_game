import { encodeStandardFrame } from './can-protocol.js';

/**
 * Pick a competitor ID that creates an interesting arbitration scenario.
 * @param {number} playerId
 * @param {'lose'|'win'} outcome
 */
function pickCompetitorId(playerId, outcome) {
  if (outcome === 'lose') {
    // Flip one of the lower/mid '1' bits in playerId to '0' so they tie for a few bits first
    for (let bit = 3; bit <= 10; bit++) {
      if ((playerId >> bit) & 1) {
        return playerId & ~(1 << bit);
      }
    }
    // Fallback if all upper bits are 0
    for (let bit = 0; bit <= 2; bit++) {
      if ((playerId >> bit) & 1) {
        return playerId & ~(1 << bit);
      }
    }
    return playerId; // 0x000 cannot lose
  } else {
    // Flip a '0' bit to '1' so player wins
    for (let bit = 3; bit <= 10; bit++) {
      if (!((playerId >> bit) & 1)) {
        return playerId | (1 << bit);
      }
    }
    return Math.min(0x7ff, playerId | 1);
  }
}

export class CanBusSimulator {
  /**
   * @param {{
   *   playerId: number,
   *   playerWireBits: number[],
   *   difficulty: 'easy'|'normal'|'hard',
   *   onUpdate: (state: any) => void,
   *   onComplete: (stats: { penalties: number }) => void
   * }} opts
   */
  constructor(opts) {
    this.playerId = opts.playerId;
    this.playerWireBits = opts.playerWireBits;
    this.difficulty = opts.difficulty;
    this.onUpdate = opts.onUpdate;
    this.onComplete = opts.onComplete;

    this.penalties = 0;
    this.attempt = 0;
    this.timer = null;
    this.trace = []; // Recent bus bits: { bit, source: 'other'|'you'|'both'|'idle'|'ack'|'err' }
    this.arbHistory = []; // { index, myBit, compBit, busBit, status: 'sof'|'tie'|'lose'|'win' }
    this.state = 'WAIT_IDLE';
    this.message = '他ECUがバスを使用中です。IDLE (EOF+IFS完了) を待って SOF を送信してください。';
    this.messageType = 'info';

    this.busyRemaining = 8;
    this.compId = null;
    this.compWireBits = null;
    this.bitIndex = 0;
    this.arbLostDeadline = null;
    this.arbLostTicksLeft = 0;

    this._initWaitIdle();
  }

  _pushTrace(bit, source) {
    this.trace.push({ bit, source });
    if (this.trace.length > 48) {
      this.trace.shift();
    }
  }

  _initWaitIdle() {
    this.state = 'WAIT_IDLE';
    // Simulate tail of another ECU's frame: 2 data/crc bits + 7 EOF + 3 IFS = 12 ticks
    this.busyQueue = [0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    this.busyIdx = 0;
    this._scheduleTick(this.difficulty === 'normal' ? 420 : 300);
    this._emit();
  }

  _scheduleTick(ms) {
    this.stop();
    this.timer = setTimeout(() => this._tick(), ms);
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  _tick() {
    if (this.state === 'WAIT_IDLE') {
      if (this.busyIdx < this.busyQueue.length) {
        this._pushTrace(this.busyQueue[this.busyIdx], 'other');
        this.busyIdx++;
        if (this.busyIdx >= this.busyQueue.length) {
          this.state = 'IDLE';
          this.message = 'バスが IDLE になりました！今すぐ [SOF送信] を押してください！';
          this.messageType = 'success';
        }
        this._scheduleTick(this.difficulty === 'normal' ? 420 : 300);
        this._emit();
        return;
      }
    } else if (this.state === 'IDLE') {
      this._pushTrace(1, 'idle');
      this._scheduleTick(450);
      this._emit();
      return;
    } else if (this.state === 'ARBITRATION') {
      if (this.arbLostTicksLeft > 0) {
        if (this.difficulty === 'easy') {
          this._emit();
          return;
        }
        this.arbLostTicksLeft--;
        if (this.arbLostTicksLeft === 0) {
          this.penalties++;
          this.message = 'ビットエラー！調停負け (送信1 / バス0) なのに送信を続けてバスを破壊しました！リトライします。';
          this.messageType = 'error';
          for (let i = 0; i < 6; i++) this._pushTrace(0, 'err');
          this._initWaitIdle();
          return;
        }
        this._scheduleTick(this.difficulty === 'normal' ? 650 : 450);
        this._emit();
        return;
      }

      this._advanceArbitrationBit();
      return;
    } else if (this.state === 'COMPETITOR_FINISHING') {
      this.compStreamRemaining--;
      this._pushTrace(this.compStreamRemaining <= 10 ? 1 : (this.compStreamRemaining % 2), 'other');
      if (this.compStreamRemaining <= 0) {
        this.state = 'IDLE';
        this.message = '競合ECUのフレームが完了し、バスが IDLE になりました！[SOF送信] で再挑戦してください！';
        this.messageType = 'success';
        this._scheduleTick(450);
      } else {
        this._scheduleTick(45);
      }
      this._emit();
      return;
    } else if (this.state === 'STREAMING') {
      this.bitIndex++;
      if (this.bitIndex >= this.playerWireBits.length) {
        this.state = 'COMPLETE';
        this.message = 'ACK受信 & EOF完了！フレーム送信に成功しました！';
        this.messageType = 'success';
        this.stop();
        this._emit();
        this.onComplete({ penalties: this.penalties });
        return;
      }

      const isAckSlot = this.bitIndex === this.playerWireBits.length - 9;
      if (isAckSlot) {
        // Transmitter sends 1, receiver pulls bus to 0 (Dominant ACK)
        this._pushTrace(0, 'ack');
      } else {
        this._pushTrace(this.playerWireBits[this.bitIndex], 'you');
      }
      this._scheduleTick(35);
      this._emit();
    }
  }

  _advanceArbitrationBit() {
    this.bitIndex++;
    if (this.bitIndex >= 12 || this.bitIndex >= this.compWireBits.length) {
      this.state = 'STREAMING';
      this.message = '調停勝利！残りのフレームを送信中...';
      this.messageType = 'success';
      this._scheduleTick(45);
      this._emit();
      return;
    }

    const myBit = this.playerWireBits[this.bitIndex];
    const compBit = this.compWireBits[this.bitIndex];
    const busBit = myBit & compBit;
    const arbDelay = this.difficulty === 'easy' ? 950 : this.difficulty === 'normal' ? 600 : 420;

    if (myBit === 1 && compBit === 0) {
      this.arbHistory.push({ label: `ID${this.bitIndex}`, myBit, compBit, busBit, status: 'lose' });
      this._pushTrace(busBit, 'other');
      this.arbLostTicksLeft = this.difficulty === 'easy' ? 999 : this.difficulty === 'normal' ? 4 : 3;
      this.message = `調停負け検知！あなたが出した 1 (Recessive) は、競合ECUの 0 (Dominant) に上書きされました。[🛑 送信停止 (Back Off)] を押してバスを譲ってください！`;
      this.messageType = 'warning';
      if (this.difficulty !== 'easy') {
        this._scheduleTick(this.difficulty === 'normal' ? 650 : 450);
      } else {
        this.stop();
      }
      this._emit();
    } else if (myBit === 0 && compBit === 1) {
      this.arbHistory.push({ label: `ID${this.bitIndex}`, myBit, compBit, busBit, status: 'win' });
      this._pushTrace(busBit, 'you');
      this.state = 'STREAMING';
      this.message = `調停勝利！あなたが 0 (Dominant)、相手が 1 (Recessive) だったため、競合ECUが送信を停止しました！`;
      this.messageType = 'success';
      this._scheduleTick(45);
      this._emit();
    } else {
      this.arbHistory.push({ label: `ID${this.bitIndex}`, myBit, compBit, busBit, status: 'tie' });
      this._pushTrace(busBit, 'both');
      this.message = `調停中 (ID Bit ${this.bitIndex}): 両者とも ${busBit} で同じため引き分け → 次のビットへ`;
      this.messageType = 'info';
      if (this.difficulty !== 'easy') {
        this._scheduleTick(arbDelay);
      }
      this._emit();
    }
  }

  stepArbitration() {
    if (this.state === 'ARBITRATION' && this.arbLostTicksLeft === 0) {
      this.stop();
      this._advanceArbitrationBit();
    }
  }

  sendSof() {
    if (this.state === 'WAIT_IDLE') {
      this.penalties++;
      this.message = 'バス使用中 (BUSY) にSOFを送信してしまいました！衝突エラー！IDLEまで待ってください。';
      this.messageType = 'error';
      this._pushTrace(0, 'err');
      this._emit();
      return;
    }
    if (this.state !== 'IDLE') return;

    this.attempt++;
    this._pushTrace(0, 'you');
    this.bitIndex = 0;
    this.arbHistory = [{ label: 'SOF', myBit: 0, compBit: 0, busBit: 0, status: 'sof' }];
    const arbDelay = this.difficulty === 'easy' ? 950 : this.difficulty === 'normal' ? 650 : 450;

    // On 1st attempt, force an arbitration battle (lose if playerId > 0, else win)
    // On 2nd+ attempt, either win arbitration or uncontested
    if (this.attempt === 1 && this.playerId > 0) {
      this.compId = pickCompetitorId(this.playerId, 'lose');
      this.compWireBits = encodeStandardFrame(this.compId, [0x11]).wireBits;
      this.state = 'ARBITRATION';
      this.arbLostTicksLeft = 0;
      this.message = `SOF同時送信！競合ECU (ID: 0x${this.compId.toString(16).toUpperCase().padStart(3, '0')}) と同時に送信開始しました。${
        this.difficulty === 'easy'
          ? '[➡️ 次の1ビットを送る] を押して1ビットずつ比較しましょう！'
          : 'IDを1ビットずつ比較（調停）します！'
      }`;
      this.messageType = 'warning';
      if (this.difficulty === 'easy') {
        this.stop();
      } else {
        this._scheduleTick(arbDelay);
      }
    } else if (this.attempt === 2 && this.playerId < 0x7ff) {
      this.compId = pickCompetitorId(this.playerId, 'win');
      this.compWireBits = encodeStandardFrame(this.compId, [0x22]).wireBits;
      this.state = 'ARBITRATION';
      this.arbLostTicksLeft = 0;
      this.message = `別のECUと同時にSOF送信！${
        this.difficulty === 'easy'
          ? '[➡️ 次の1ビットを送る] で1ビットずつ調停を進めましょう！'
          : '再び1ビットずつ調停を行います...'
      }`;
      this.messageType = 'info';
      if (this.difficulty === 'easy') {
        this.stop();
      } else {
        this._scheduleTick(arbDelay);
      }
    } else {
      this.compId = null;
      this.arbHistory = [];
      this.state = 'STREAMING';
      this.message = 'バス独占！フレーム送信中...';
      this.messageType = 'success';
      this._scheduleTick(35);
    }
    this._emit();
  }

  backOff() {
    if (this.state !== 'ARBITRATION') return;
    if (this.arbLostTicksLeft > 0) {
      this.arbLostTicksLeft = 0;
      this.state = 'COMPETITOR_FINISHING';
      this.compStreamRemaining = 18;
      this.message = '調停負けを検知し、送信を停止しました！競合ECUの完了を待機中...';
      this.messageType = 'info';
      this._scheduleTick(45);
      this._emit();
    } else {
      this.penalties++;
      this.message = 'まだ調停に負けていません！（自分が 1 でバスが 0 のときだけ停止します）';
      this.messageType = 'error';
      this._emit();
    }
  }

  _emit() {
    this.onUpdate({
      state: this.state,
      trace: [...this.trace],
      arbHistory: [...this.arbHistory],
      message: this.message,
      messageType: this.messageType,
      penalties: this.penalties,
      bitIndex: this.bitIndex,
      totalBits: this.playerWireBits.length,
      arbLostPending: this.arbLostTicksLeft > 0,
      compId: this.compId,
      playerId: this.playerId,
    });
  }
}
