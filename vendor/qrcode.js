/*
 * QR Code generator library (compact port of Project Nayuki's
 * public-domain "qrcodegen" reference implementation).
 *
 * Copyright (c) Project Nayuki. (MIT / Public Domain)
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Exposes a single global `qrcodegen` with:
 *   qrcodegen.QrCode.encodeBinary(byteArray, ecl) -> QrCode
 *   qrcode.getModule(x, y) -> boolean
 *   qrcode.size -> int
 *   qrcodegen.QrCode.Ecc.{LOW,MEDIUM,QUARTILE,HIGH}
 */
var qrcodegen = (function() {
  "use strict";

  /*---- QrCode constructor ----*/
  function QrCode(version, errCorLvl, dataCodewords, msk) {
    if (version < 1 || version > 40) throw "Version value out of range";
    if (msk < -1 || msk > 7) throw "Mask value out of range";
    this.version = version;
    this.errorCorrectionLevel = errCorLvl;
    this.size = version * 4 + 17;

    var row = [];
    for (var i = 0; i < this.size; i++) row.push(false);
    this.modules = [];
    this.isFunction = [];
    for (var i = 0; i < this.size; i++) {
      this.modules.push(row.slice());
      this.isFunction.push(row.slice());
    }

    this.drawFunctionPatterns();
    var allCodewords = this.addEccAndInterleave(dataCodewords);
    this.drawCodewords(allCodewords);

    if (msk == -1) {
      var minPenalty = 1000000000;
      for (var i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        var penalty = this.getPenaltyScore();
        if (penalty < minPenalty) { msk = i; minPenalty = penalty; }
        this.applyMask(i);
      }
    }
    this.mask = msk;
    this.applyMask(msk);
    this.drawFormatBits(msk);
    this.isFunction = null;
  }

  QrCode.prototype.getModule = function(x, y) {
    return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
  };

  QrCode.prototype.drawFunctionPatterns = function() {
    for (var i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 == 0);
      this.setFunctionModule(i, 6, i % 2 == 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);

    var alignPatPos = this.getAlignmentPatternPositions();
    var numAlign = alignPatPos.length;
    for (var i = 0; i < numAlign; i++) {
      for (var j = 0; j < numAlign; j++) {
        if (!(i == 0 && j == 0 || i == 0 && j == numAlign - 1 || i == numAlign - 1 && j == 0))
          this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  };

  QrCode.prototype.drawFormatBits = function(mask) {
    var data = this.errorCorrectionLevel.formatBits << 3 | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = (data << 10 | rem) ^ 0x5412;

    for (var i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (var i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));

    for (var i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
    for (var i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, this.size - 8, true);
  };

  QrCode.prototype.drawVersion = function() {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = this.version << 12 | rem;

    for (var i = 0; i < 18; i++) {
      var color = getBit(bits, i);
      var a = this.size - 11 + i % 3;
      var b = Math.floor(i / 3);
      this.setFunctionModule(a, b, color);
      this.setFunctionModule(b, a, color);
    }
  };

  QrCode.prototype.drawFinderPattern = function(x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = x + dx, yy = y + dy;
        if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size)
          this.setFunctionModule(xx, yy, dist != 2 && dist != 4);
      }
    }
  };

  QrCode.prototype.drawAlignmentPattern = function(x, y) {
    for (var dy = -2; dy <= 2; dy++)
      for (var dx = -2; dx <= 2; dx++)
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
  };

  QrCode.prototype.setFunctionModule = function(x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  };

  QrCode.prototype.addEccAndInterleave = function(data) {
    var ver = this.version;
    var ecl = this.errorCorrectionLevel;
    var numBlocks = QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    var blockEccLen = QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
    var rawCodewords = Math.floor(QrCode.getNumRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    var blocks = [];
    var rsDiv = reedSolomonComputeDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = reedSolomonComputeRemainder(dat, rsDiv);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    var result = [];
    for (var i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        if (i != shortBlockLen - blockEccLen || j >= numShortBlocks)
          result.push(blocks[j][i]);
      }
    }
    return result;
  };

  QrCode.prototype.drawCodewords = function(data) {
    var i = 0;
    for (var right = this.size - 1; right >= 1; right -= 2) {
      if (right == 6) right = 5;
      for (var vert = 0; vert < this.size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) == 0;
          var y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  };

  QrCode.prototype.applyMask = function(mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 == 0; break;
          case 1: invert = y % 2 == 0; break;
          case 2: invert = x % 3 == 0; break;
          case 3: invert = (x + y) % 3 == 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0; break;
          case 5: invert = x * y % 2 + x * y % 3 == 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 == 0; break;
          case 7: invert = ((x + y) % 2 + x * y % 3) % 2 == 0; break;
        }
        if (!this.isFunction[y][x] && invert)
          this.modules[y][x] = !this.modules[y][x];
      }
    }
  };

  QrCode.prototype.getPenaltyScore = function() {
    var result = 0;
    var size = this.size;
    var modules = this.modules;

    for (var y = 0; y < size; y++) {
      var runColor = false, runX = 0, runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (var x = 0; x < size; x++) {
        if (modules[y][x] == runColor) {
          runX++;
          if (runX == 5) result += 3;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * 40;
          runColor = modules[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * 40;
    }
    for (var x = 0; x < size; x++) {
      var runColor = false, runY = 0, runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (var y = 0; y < size; y++) {
        if (modules[y][x] == runColor) {
          runY++;
          if (runY == 5) result += 3;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * 40;
          runColor = modules[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * 40;
    }

    for (var y = 0; y < size - 1; y++) {
      for (var x = 0; x < size - 1; x++) {
        var color = modules[y][x];
        if (color == modules[y][x + 1] && color == modules[y + 1][x] && color == modules[y + 1][x + 1])
          result += 3;
      }
    }

    var dark = 0;
    for (var y = 0; y < size; y++)
      for (var x = 0; x < size; x++)
        if (modules[y][x]) dark++;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  };

  QrCode.prototype.getAlignmentPatternPositions = function() {
    if (this.version == 1) return [];
    var numAlign = Math.floor(this.version / 7) + 2;
    var step = (this.version == 32) ? 26 :
      Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = this.size - 7; result.length < numAlign; pos -= step)
      result.splice(1, 0, pos);
    return result;
  };

  QrCode.prototype.finderPenaltyCountPatterns = function(runHistory) {
    var n = runHistory[1];
    var core = n > 0 && runHistory[2] == n && runHistory[3] == n * 3 && runHistory[4] == n && runHistory[5] == n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
      + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  };

  QrCode.prototype.finderPenaltyTerminateAndCount = function(currentRunColor, currentRunLength, runHistory) {
    if (currentRunColor) {
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size;
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  };

  QrCode.prototype.finderPenaltyAddHistory = function(currentRunLength, runHistory) {
    if (runHistory[0] == 0) currentRunLength += this.size;
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  };

  /*---- Static factory + tables ----*/
  QrCode.getNumRawDataModules = function(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  };

  QrCode.getNumDataCodewords = function(ver, ecl) {
    return Math.floor(QrCode.getNumRawDataModules(ver) / 8)
      - QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver]
      * QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
  };

  QrCode.encodeBinary = function(byteArray, ecl, minVersion, maxVersion, mask, boostEcl) {
    minVersion = minVersion || 1;
    maxVersion = maxVersion || 40;
    mask = (mask === undefined) ? -1 : mask;
    boostEcl = (boostEcl === undefined) ? true : boostEcl;

    // Single byte-mode segment.
    var bb = [];
    for (var i = 0; i < byteArray.length; i++) appendBits(byteArray[i] & 0xFF, 8, bb);
    var seg = { numChars: byteArray.length, bitData: bb };

    var version, dataUsedBits;
    for (version = minVersion; ; version++) {
      var dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8;
      var ccBits = numCharCountBits(version);
      var usedBits = 4 + ccBits + seg.bitData.length;
      if (usedBits <= dataCapacityBits) { dataUsedBits = usedBits; break; }
      if (version >= maxVersion) throw "Data too long";
    }

    [QrCode.Ecc.MEDIUM, QrCode.Ecc.QUARTILE, QrCode.Ecc.HIGH].forEach(function(newEcl) {
      if (boostEcl && dataUsedBits <= QrCode.getNumDataCodewords(version, newEcl) * 8) ecl = newEcl;
    });

    var bits = [];
    appendBits(0x4, 4, bits); // byte mode indicator
    appendBits(seg.numChars, numCharCountBits(version), bits);
    for (var i = 0; i < seg.bitData.length; i++) bits.push(seg.bitData[i]);

    var dataCapacityBits = QrCode.getNumDataCodewords(version, ecl) * 8;
    appendBits(0, Math.min(4, dataCapacityBits - bits.length), bits);
    appendBits(0, (8 - bits.length % 8) % 8, bits);
    for (var padByte = 0xEC; bits.length < dataCapacityBits; padByte ^= 0xEC ^ 0x11)
      appendBits(padByte, 8, bits);

    var dataCodewords = [];
    while (dataCodewords.length * 8 < bits.length) dataCodewords.push(0);
    for (var i = 0; i < bits.length; i++)
      dataCodewords[i >>> 3] |= bits[i] << (7 - (i & 7));

    return new QrCode(version, ecl, dataCodewords, mask);
  };

  function numCharCountBits(ver) {
    // Byte mode char-count bits.
    return ver <= 9 ? 8 : 16;
  }

  function appendBits(val, len, bb) {
    for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  }

  function getBit(x, i) {
    return ((x >>> i) & 1) != 0;
  }

  /*---- Reed-Solomon ----*/
  function reedSolomonComputeDivisor(degree) {
    if (degree < 1 || degree > 255) throw "Degree out of range";
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = reedSolomonMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = reedSolomonMultiply(root, 0x02);
    }
    return result;
  }

  function reedSolomonComputeRemainder(data, divisor) {
    var result = divisor.map(function() { return 0; });
    data.forEach(function(b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function(coef, i) {
        result[i] ^= reedSolomonMultiply(coef, factor);
      });
    });
    return result;
  }

  function reedSolomonMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }

  /*---- ECC enum ----*/
  function Ecc(ordinal, formatBits) {
    this.ordinal = ordinal;
    this.formatBits = formatBits;
  }
  QrCode.Ecc = {
    LOW: new Ecc(0, 1),
    MEDIUM: new Ecc(1, 0),
    QUARTILE: new Ecc(2, 3),
    HIGH: new Ecc(3, 2)
  };

  QrCode.ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  QrCode.NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];

  return { QrCode: QrCode };
})();
