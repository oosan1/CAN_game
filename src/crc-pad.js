/**
 * Interactive CRC-15 Long Division (筆算) Workspace
 * Does NOT auto-compute XOR — the player performs every XOR bit by hand
 * on an aligned 50-column grid.
 */

const POLY = [1, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]; // 16-bit: 0x18B33 (x^15+...+1)

export function mountCrcLongDivisionPad(container) {
  const state = {
    inputStr: '',
    workBits: [], // original 35 + 15 zeros
    steps: [], // { offset, topSlice, xorResult }
    currentXor: Array(16).fill(null),
  };

  function getCurrentWorkingArray() {
    const arr = [...state.workBits];
    for (const st of state.steps) {
      for (let i = 0; i < 16; i++) {
        arr[st.offset + i] = st.xorResult[i];
      }
    }
    return arr;
  }

  function findNextOffset(arr) {
    const limit = arr.length - 15; // if >= limit, only 15-bit remainder remains
    for (let i = 0; i < limit; i++) {
      if (arr[i] === 1) return i;
    }
    return arr.length; // done
  }

  function render(focusXorIdx = null) {
    const arr = getCurrentWorkingArray();
    const totalLen = arr.length;
    const nextOffset = totalLen >= 16 ? findNextOffset(arr) : totalLen;
    const isDone = totalLen >= 16 && nextOffset >= totalLen - 15;
    const remainderBits = isDone ? arr.slice(totalLen - 15).join('') : null;

    container.innerHTML = `
      <div class="card">
        <div class="card-title">
          <span>🧮 CRC-15 割り算の筆算パッド (手計算用)</span>
          <span class="pill pill-accent">生成多項式: 1100010110011001 (16bit)</span>
        </div>
        <p style="font-size:0.82rem; color:var(--text-muted); margin-top:0;">
          デスタッフした <code>SOF〜Data</code> のビット列を入力して「筆算開始」を押すと、末尾に <code>0</code> を15個付けた筆算用紙が展開されます。
          各ステップで <code>0</code> / <code>1</code> キー（またはクリック）でXOR結果を埋めてください。
        </p>

        <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.75rem;">
          <input type="text" class="hex-input" id="crc-pad-dividend" style="flex:1; min-width:220px; text-transform:none;"
            value="${state.inputStr}" placeholder="SOF〜Data (35bit) を入力 (例: 0001101000110000010...)" />
          <button class="btn btn-primary btn-sm" id="crc-pad-start">📝 筆算セット</button>
          ${
            state.workBits.length > 0
              ? `<button class="btn btn-ghost btn-sm" id="crc-pad-undo" ${state.steps.length === 0 ? 'disabled' : ''}>↩ 1行戻る</button>
                 <button class="btn btn-ghost btn-sm" id="crc-pad-reset">🗑 リセット</button>`
              : ''
          }
        </div>

        ${
          state.workBits.length === 0
            ? ''
            : `
          <div class="ld-scroll">
            <div class="ld-grid" style="grid-template-columns: 64px repeat(${totalLen}, 22px);">
              <!-- Header row -->
              <div class="ld-label">桁</div>
              ${arr
                .map(
                  (_, col) =>
                    `<div class="ld-col-hdr ${col >= totalLen - 15 ? 'is-rem' : ''}">${col}</div>`
                )
                .join('')}

              <!-- Initial Dividend row -->
              <div class="ld-label">被除数</div>
              ${state.workBits
                .map(
                  (b, col) =>
                    `<div class="ld-cell ${col >= totalLen - 15 ? 'is-zero-pad' : ''}">${b}</div>`
                )
                .join('')}

              <!-- Completed steps -->
              ${state.steps
                .map((st, sIdx) => {
                  const afterArr = [...state.workBits];
                  for (let k = 0; k <= sIdx; k++) {
                    for (let i = 0; i < 16; i++) {
                      afterArr[state.steps[k].offset + i] = state.steps[k].xorResult[i];
                    }
                  }
                  const nextOffAfter = findNextOffset(afterArr);
                  const showUntil =
                    nextOffAfter >= totalLen - 15
                      ? totalLen
                      : Math.min(totalLen, nextOffAfter + 16);

                  return `
                    <div class="ld-label">÷ 多項式</div>
                    ${Array.from({ length: totalLen }, (_, col) => {
                      const pIdx = col - st.offset;
                      if (pIdx >= 0 && pIdx < 16) {
                        return `<div class="ld-cell is-poly">${POLY[pIdx]}</div>`;
                      }
                      return `<div class="ld-cell is-blank"></div>`;
                    }).join('')}

                    <div class="ld-label">結果 ${sIdx + 1}</div>
                    ${Array.from({ length: totalLen }, (_, col) => {
                      if (col < st.offset) return `<div class="ld-cell is-blank"></div>`;
                      if (col < st.offset + 16) {
                        return `<div class="ld-cell is-xor-done">${st.xorResult[col - st.offset]}</div>`;
                      }
                      if (col < showUntil) {
                        return `<div class="ld-cell is-brought">${afterArr[col]}</div>`;
                      }
                      return `<div class="ld-cell is-blank"></div>`;
                    }).join('')}
                  `;
                })
                .join('')}

              <!-- Current active step -->
              ${
                !isDone
                  ? `
                <div class="ld-label" style="color:var(--accent)">÷ 多項式</div>
                ${Array.from({ length: totalLen }, (_, col) => {
                  const pIdx = col - nextOffset;
                  if (pIdx >= 0 && pIdx < 16) {
                    return `<div class="ld-cell is-poly">${POLY[pIdx]}</div>`;
                  }
                  return `<div class="ld-cell is-blank"></div>`;
                }).join('')}

                <div class="ld-label" style="color:var(--warning)">XOR入力</div>
                ${Array.from({ length: totalLen }, (_, col) => {
                  const pIdx = col - nextOffset;
                  if (pIdx >= 0 && pIdx < 16) {
                    const val = state.currentXor[pIdx];
                    return `<button type="button" class="ld-input-cell ${
                      val === null ? 'is-empty' : val === 0 ? 'bit-0' : 'bit-1'
                    }" data-xidx="${pIdx}">${val === null ? '·' : val}</button>`;
                  }
                  return `<div class="ld-cell is-blank"></div>`;
                }).join('')}
              `
                  : ''
              }
            </div>
          </div>

          <div style="margin-top:0.75rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
            ${
              isDone
                ? `<div class="feedback success" style="margin:0; flex:1;">
                    🎉 筆算完了！最後の15bit（余り）: <code>${remainderBits}</code>
                  </div>`
                : `<div style="font-size:0.82rem; color:var(--text-muted);">
                    現在の位置: 列 <strong>${nextOffset}</strong>（先頭の <code>1</code> に合わせてXORを計算してください）
                  </div>
                  <button class="btn btn-success btn-sm" id="crc-pad-commit">↵ この行を確定して次へ</button>`
            }
          </div>
        `
        }
      </div>
    `;

    container.querySelector('#crc-pad-start')?.addEventListener('click', () => {
      const raw = container.querySelector('#crc-pad-dividend').value.replace(/\s+/g, '');
      if (!/^[01]+$/.test(raw)) return;
      state.inputStr = raw;
      state.workBits = [...raw.split('').map(Number), ...Array(15).fill(0)];
      state.steps = [];
      state.currentXor = Array(16).fill(null);
      render(0);
    });

    container.querySelector('#crc-pad-undo')?.addEventListener('click', () => {
      if (state.steps.length > 0) {
        const last = state.steps.pop();
        state.currentXor = [...last.xorResult];
        render(0);
      }
    });

    container.querySelector('#crc-pad-reset')?.addEventListener('click', () => {
      state.steps = [];
      state.currentXor = Array(16).fill(null);
      render(0);
    });

    container.querySelector('#crc-pad-commit')?.addEventListener('click', () => {
      if (state.currentXor.some((v) => v === null)) return;
      state.steps.push({
        offset: nextOffset,
        xorResult: [...state.currentXor],
      });
      state.currentXor = Array(16).fill(null);
      render(0);
    });

    container.querySelectorAll('.ld-input-cell').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.xidx);
        const cur = state.currentXor[idx];
        state.currentXor[idx] = cur === null ? 0 : cur === 0 ? 1 : 0;
        render(idx);
      });

      btn.addEventListener('keydown', (e) => {
        const idx = Number(btn.dataset.xidx);
        if (e.key === '0' || e.key === '1') {
          e.preventDefault();
          state.currentXor[idx] = Number(e.key);
          const next = idx < 15 ? idx + 1 : 15;
          render(next);
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          state.currentXor[idx] = null;
          render(Math.max(0, idx - 1));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          container.querySelector('#crc-pad-commit')?.click();
        }
      });
    });

    if (focusXorIdx !== null) {
      container.querySelector(`.ld-input-cell[data-xidx="${focusXorIdx}"]`)?.focus();
    }
  }

  render();
}
