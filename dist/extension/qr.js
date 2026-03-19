/**
 * qr.js – Minimal QR code generator (client-side, no external dependencies)
 *
 * Generates a QR code as a data-URI PNG or draws to a canvas.
 * Supports alphanumeric and byte-mode encoding with error correction level M.
 *
 * Usage:
 *   const dataUri = QR.toDataURL("otpauth://totp/...", { size: 180 });
 *   imgElement.src = dataUri;
 */

/* eslint-disable no-bitwise */
const QR = (() => {
  // ── GF(256) arithmetic for Reed-Solomon ──────────────────────────
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function rsGenPoly(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGenPoly(ecLen);
    const msg = new Uint8Array(data.length + ecLen);
    msg.set(data);
    for (let i = 0; i < data.length; i++) {
      const coeff = msg[i];
      if (coeff !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coeff);
        }
      }
    }
    return msg.slice(data.length);
  }

  // ── QR version/format tables ──────────────────────────────────────
  // EC level M (01), mask patterns 0-7
  // Version info: capacity in data codewords (EC level M)
  const VERSION_DATA_CODEWORDS_M = [
    0,    // v0 unused
    16,   // v1: 26 total - 10 EC = 16
    28,   // v2: 44 - 16 = 28
    44,   // v3: 70 - 26 = 44
    64,   // v4: 100 - 36 = 64
    86,   // v5: 134 - 48 = 86
    108,  // v6: 172 - 64 = 108
    124,  // v7: 196 - 72 = 124
    154,  // v8: 242 - 88 = 154
    182,  // v9: 292 - 110 = 182
    216,  // v10: 346 - 130 = 216
    254,  // v11: 404 - 150 = 254
    290,  // v12: 466 - 176 = 290
    334,  // v13: 532 - 198 = 334
  ];

  const VERSION_EC_CODEWORDS_M = [
    0, 10, 16, 26, 36, 48, 64, 72, 88, 110, 130, 150, 176, 198
  ];

  // Number of EC blocks for level M
  const VERSION_EC_BLOCKS_M = [
    0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 4, 4, 4, 4
  ];

  // Alignment pattern locations by version
  const ALIGN_POSITIONS = [
    [],         // v1
    [6, 18],    // v2
    [6, 22],    // v3
    [6, 26],    // v4
    [6, 30],    // v5
    [6, 34],    // v6
    [6, 22, 38],// v7
    [6, 24, 42],// v8
    [6, 26, 46],// v9
    [6, 28, 50],// v10
    [6, 30, 54],// v11
    [6, 32, 58],// v12
    [6, 34, 62],// v13
  ];

  function getVersion(dataLen) {
    // Byte mode: 4-bit mode indicator + character count indicator + data
    for (let v = 1; v <= 13; v++) {
      const ccBits = v <= 9 ? 8 : 16;
      const dataBits = 4 + ccBits + dataLen * 8;
      const capacity = VERSION_DATA_CODEWORDS_M[v] * 8;
      if (dataBits <= capacity) return v;
    }
    throw new Error("Data too long for QR (max ~330 bytes at EC level M)");
  }

  // ── Bit buffer ────────────────────────────────────────────────────
  class BitBuffer {
    constructor() { this.bits = []; }
    put(value, length) {
      for (let i = length - 1; i >= 0; i--) {
        this.bits.push((value >> i) & 1);
      }
    }
    get length() { return this.bits.length; }
  }

  // ── Encode data as byte-mode codewords ────────────────────────────
  function encodeData(text, version) {
    const utf8 = new TextEncoder().encode(text);
    const buf = new BitBuffer();
    // Mode indicator: byte mode = 0100
    buf.put(0b0100, 4);
    // Character count
    const ccBits = version <= 9 ? 8 : 16;
    buf.put(utf8.length, ccBits);
    // Data
    for (const b of utf8) buf.put(b, 8);
    // Terminator (up to 4 bits)
    const capacity = VERSION_DATA_CODEWORDS_M[version] * 8;
    const termLen = Math.min(4, capacity - buf.length);
    buf.put(0, termLen);
    // Pad to byte boundary
    while (buf.length % 8 !== 0) buf.put(0, 1);
    // Pad codewords
    const padBytes = [0xec, 0x11];
    let pi = 0;
    while (buf.length < capacity) {
      buf.put(padBytes[pi], 8);
      pi = (pi + 1) % 2;
    }
    // Convert to byte array
    const bytes = new Uint8Array(buf.length / 8);
    for (let i = 0; i < bytes.length; i++) {
      let val = 0;
      for (let b = 0; b < 8; b++) val = (val << 1) | buf.bits[i * 8 + b];
      bytes[i] = val;
    }
    return bytes;
  }

  // ── Build final message with error correction ─────────────────────
  function buildMessage(data, version) {
    const ecLen = VERSION_EC_CODEWORDS_M[version];
    const numBlocks = VERSION_EC_BLOCKS_M[version];
    const ecPerBlock = ecLen / numBlocks;
    const totalData = VERSION_DATA_CODEWORDS_M[version];
    const shortBlockLen = Math.floor(totalData / numBlocks);
    const longBlocks = totalData % numBlocks;

    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;

    for (let i = 0; i < numBlocks; i++) {
      const blockLen = shortBlockLen + (i >= numBlocks - longBlocks ? 1 : 0);
      const block = data.slice(offset, offset + blockLen);
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, ecPerBlock));
      offset += blockLen;
    }

    // Interleave data blocks
    const result = [];
    const maxDataLen = shortBlockLen + (longBlocks > 0 ? 1 : 0);
    for (let i = 0; i < maxDataLen; i++) {
      for (let j = 0; j < numBlocks; j++) {
        if (i < dataBlocks[j].length) result.push(dataBlocks[j][i]);
      }
    }
    // Interleave EC blocks
    for (let i = 0; i < ecPerBlock; i++) {
      for (let j = 0; j < numBlocks; j++) {
        result.push(ecBlocks[j][i]);
      }
    }
    return result;
  }

  // ── Matrix operations ─────────────────────────────────────────────
  function createMatrix(version) {
    const size = version * 4 + 17;
    const matrix = Array.from({ length: size }, () => new Int8Array(size)); // 0=unset, 1=black, -1=white(fixed), 2=black(fixed)
    return matrix;
  }

  function setModule(matrix, row, col, val) {
    matrix[row][col] = val;
  }

  function placeFinderPattern(matrix, row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const mr = row + r, mc = col + c;
        if (mr < 0 || mr >= matrix.length || mc < 0 || mc >= matrix.length) continue;
        const inOuter = r === 0 || r === 6 || c === 0 || c === 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const inSep = r === -1 || r === 7 || c === -1 || c === 7;
        setModule(matrix, mr, mc, (inOuter || inInner) && !inSep ? 2 : -1);
      }
    }
  }

  function placeAlignmentPattern(matrix, row, col) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const val = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 2 : -1;
        setModule(matrix, row + r, col + c, val);
      }
    }
  }

  function placeFixedPatterns(matrix, version) {
    const size = matrix.length;
    // Finder patterns
    placeFinderPattern(matrix, 0, 0);
    placeFinderPattern(matrix, 0, size - 7);
    placeFinderPattern(matrix, size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      if (matrix[6][i] === 0) setModule(matrix, 6, i, i % 2 === 0 ? 2 : -1);
      if (matrix[i][6] === 0) setModule(matrix, i, 6, i % 2 === 0 ? 2 : -1);
    }

    // Alignment patterns
    if (version >= 2) {
      const positions = ALIGN_POSITIONS[version - 1];
      for (const r of positions) {
        for (const c of positions) {
          if (matrix[r][c] !== 0) continue; // Skip if overlaps finder
          placeAlignmentPattern(matrix, r, c);
        }
      }
    }

    // Dark module
    setModule(matrix, size - 8, 8, 2);

    // Reserve format info areas
    for (let i = 0; i < 8; i++) {
      if (matrix[8][i] === 0) setModule(matrix, 8, i, -1);
      if (matrix[8][size - 1 - i] === 0) setModule(matrix, 8, size - 1 - i, -1);
      if (matrix[i][8] === 0) setModule(matrix, i, 8, -1);
      if (matrix[size - 1 - i][8] === 0) setModule(matrix, size - 1 - i, 8, -1);
    }
    if (matrix[8][8] === 0) setModule(matrix, 8, 8, -1);

    // Reserve version info (v7+)
    if (version >= 7) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 3; j++) {
          if (matrix[i][size - 11 + j] === 0) setModule(matrix, i, size - 11 + j, -1);
          if (matrix[size - 11 + j][i] === 0) setModule(matrix, size - 11 + j, i, -1);
        }
      }
    }
  }

  function placeData(matrix, message) {
    const size = matrix.length;
    let bitIdx = 0;
    const totalBits = message.length * 8;

    // Data placement: right-to-left, bottom-to-top in 2-column strips
    let col = size - 1;
    while (col >= 0) {
      if (col === 6) col--; // Skip timing column
      for (let row = 0; row < size; row++) {
        for (let c = 0; c < 2; c++) {
          const actualCol = col - c;
          const isUpward = ((size - 1 - col) >> 1) % 2 === 0;
          const actualRow = isUpward ? size - 1 - row : row;
          if (actualCol < 0 || matrix[actualRow][actualCol] !== 0) continue;
          if (bitIdx < totalBits) {
            const byteIdx = bitIdx >> 3;
            const bitPos = 7 - (bitIdx & 7);
            const bit = (message[byteIdx] >> bitPos) & 1;
            matrix[actualRow][actualCol] = bit ? 1 : -1;
          } else {
            matrix[actualRow][actualCol] = -1;
          }
          bitIdx++;
        }
      }
      col -= 2;
    }
  }

  // ── Masking ───────────────────────────────────────────────────────
  const MASK_FNS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function applyMask(matrix, maskIdx) {
    const size = matrix.length;
    const fn = MASK_FNS[maskIdx];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (Math.abs(matrix[r][c]) <= 1 && matrix[r][c] !== 0) {
          if (fn(r, c)) matrix[r][c] = -matrix[r][c];
        }
      }
    }
  }

  // ── Format info ───────────────────────────────────────────────────
  const FORMAT_BITS = [
    0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
    0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
    0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b,
    0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed,
  ];

  function placeFormatInfo(matrix, maskIdx) {
    const size = matrix.length;
    // EC level M = 00, mask pattern
    const formatIdx = (0b00 << 3) | maskIdx; // M=00
    const bits = FORMAT_BITS[formatIdx];

    // Horizontal: left side around top-left finder + right side
    const hPositions = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
      [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
    ];
    // Vertical: top side around top-left finder + bottom side
    const vPositions = [
      [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
      [size - 7, 8], [size - 6, 8], [size - 5, 8], [size - 4, 8],
      [size - 3, 8], [size - 2, 8], [size - 1, 8],
    ];

    for (let i = 0; i < 15; i++) {
      const bit = (bits >> i) & 1;
      const val = bit ? 2 : -1;
      if (i < hPositions.length) {
        const [r, c] = hPositions[i];
        setModule(matrix, r, c, val);
      }
    }
    for (let i = 0; i < 15; i++) {
      const bit = (bits >> i) & 1;
      const val = bit ? 2 : -1;
      if (i < vPositions.length) {
        const [r, c] = vPositions[i];
        setModule(matrix, r, c, val);
      }
    }
  }

  // ── Penalty scoring ───────────────────────────────────────────────
  function penaltyScore(matrix) {
    const size = matrix.length;
    let score = 0;

    // Rule 1: 5+ same-color in row/col
    for (let r = 0; r < size; r++) {
      let count = 1;
      for (let c = 1; c < size; c++) {
        if (isDark(matrix[r][c]) === isDark(matrix[r][c - 1])) {
          count++;
          if (count === 5) score += 3;
          else if (count > 5) score += 1;
        } else count = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      let count = 1;
      for (let r = 1; r < size; r++) {
        if (isDark(matrix[r][c]) === isDark(matrix[r - 1][c])) {
          count++;
          if (count === 5) score += 3;
          else if (count > 5) score += 1;
        } else count = 1;
      }
    }

    // Rule 2: 2x2 same-color blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const d = isDark(matrix[r][c]);
        if (d === isDark(matrix[r][c + 1]) && d === isDark(matrix[r + 1][c]) && d === isDark(matrix[r + 1][c + 1])) {
          score += 3;
        }
      }
    }

    // Rule 4: Proportion of dark modules
    let darkCount = 0;
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (isDark(matrix[r][c])) darkCount++;
    const pct = (darkCount / (size * size)) * 100;
    score += Math.abs(Math.floor(pct / 5) * 5 - 50) * 2;

    return score;
  }

  function isDark(val) {
    return val > 0; // 1 or 2 = dark
  }

  // ── Main generation ───────────────────────────────────────────────
  function generate(text) {
    const version = getVersion(new TextEncoder().encode(text).length);
    const data = encodeData(text, version);
    const message = buildMessage(data, version);
    const size = version * 4 + 17;

    // Try all 8 masks, pick lowest penalty
    let bestMatrix = null;
    let bestPenalty = Infinity;
    let bestMask = 0;

    for (let mask = 0; mask < 8; mask++) {
      const matrix = createMatrix(version);
      placeFixedPatterns(matrix, version);
      placeData(matrix, message);
      applyMask(matrix, mask);
      placeFormatInfo(matrix, mask);

      const penalty = penaltyScore(matrix);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMatrix = matrix;
        bestMask = mask;
      }
    }

    return { matrix: bestMatrix, size };
  }

  // ── Render to data URL (PNG via canvas) ───────────────────────────
  function toDataURL(text, { size = 180, margin = 4 } = {}) {
    const { matrix, size: modules } = generate(text);
    const total = modules + margin * 2;
    const scale = Math.max(1, Math.floor(size / total));
    const canvasSize = total * scale;

    const canvas = document.createElement("canvas");
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext("2d");

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    // Draw modules
    ctx.fillStyle = "#000000";
    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        if (isDark(matrix[r][c])) {
          ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
        }
      }
    }

    return canvas.toDataURL("image/png");
  }

  return { toDataURL, generate };
})();
