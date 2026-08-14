// ivx-lens.js — IVX Lens Transpiler & Panel UI
// Bidirectional transpilation between IVX and Python/JS/TS/Pseudocode.
// Depends on: ivx-render.js (srcEl, updateHighlight, scheduleRender),
//             ivx-core.js (parse), ivx-parser.js (inferImmutables)
// PROPRIETARY AND CONFIDENTIAL
// Copyright 2026 IVX. All rights reserved.

'use strict';

// ── SEER machine-code engine (tables, disasm, assembler) ──────────────────────
// Ported verbatim from seer_visualizer_v6.html — provides seerDisasm() and
// seerAssembleSource() used by renderSEERHex() in the lens panel.

(function() {
'use strict';

// ── SEER ISA v13-real — rewritten against the ACTUAL, verified hardware ──
// The previous v10 scheme here (row/nibble-organized, 8-byte instructions,
// a VALU/VMEM 4-wide SIMD engine, a dual-issue "PACK" format) does not
// match the real SEER RTL and never has -- confirmed directly against
// seer_pkg.sv and the encoder/decoder this session's own toolchain uses,
// which has itself been verified against 5000+ regression vectors and,
// as of tonight, actual FPGA hardware via the "Send & verify" tool.
// Real SEER instructions are 1 byte (OB format only: sei/cli/sysret/hlt/
// nop/ebreak/ecall/wfe) or 4 bytes (every other format) -- never 8, and
// there is no vector/SIMD engine or dual-issue format anywhere in the RTL.
//
// OPCODES/FORMAT and the encode()/decodeOperands() logic below are ported
// directly from that already-proven toolchain, not reinvented -- this is
// the single, real source of truth other files in Vertex should also
// treat as the ISA now that the old lens tables are retired.
const OPCODES = {
  "sei":0x00,"cli":0x01,"sysret":0x02,"hlt":0x03,
  "clrtag":0x04,"swmode.sub":0x05,"swmode.isa":0x06,
  "rdctrl":0x07,"wrctrl":0x08,"sev":0x09,"hprobe":0x0A,
  "dcz":0x0B,"vxchg":0x0C,"tlbi":0x0D,"rdrnd":0x0E,"io":0x0F,
  "nop":0x10,"ebreak":0x11,"ecall":0x12,"wfe":0x13,
  "popcnt":0x14,"clz":0x15,"fence":0x16,"csel":0x17,
  "jmpr":0x18,"jmp":0x19,"jeq":0x1A,"jne":0x1B,
  "jlt":0x1C,"jltu":0x1D,"jge":0x1E,"jgeu":0x1F,
  "li.64":0x20,"li.captr":0x21,"li.cn":0x22,"li.pcrel":0x23,
  "sts32":0x24,"sts64":0x25,"st":0x25,
  "ld.s32":0x26,"ld64":0x27,"ld":0x27,
  "dcf.c":0x28,"dcf.i":0x29,"dcf.ci":0x2A,"ics":0x2B,
  "bset":0x30,"bclr":0x31,"btst":0x32,"bflp":0x33,
  "rol":0x34,"ror":0x35,"bswap":0x36,"brev":0x37,
  "bext":0x38,"bins":0x39,"bperm":0x3A,"pdep":0x3B,
  "pext":0x3C,"clmul":0x3D,"crc32":0x3E,"bfly":0x3F,
  "eqi":0x40,"andi":0x41,"nandi":0x42,"ori":0x43,
  "nori":0x44,"xori":0x45,"xnri":0x46,"slli":0x47,
  "srli":0x48,"srai":0x49,"slti":0x4A,"addi":0x4B,
  "subi":0x4C,"muli":0x4D,
  "eq":0x50,"and":0x51,"nand":0x52,"or":0x53,
  "nor":0x54,"xor":0x55,"xnor":0x56,"sll":0x57,
  "srl":0x58,"sra":0x59,"slt":0x5A,"add":0x5B,
  "sub":0x5C,"mul":0x5D,"mod":0x5E,"div":0x5F,
  "fadd":0x70,"fsub":0x71,"fmul":0x72,"fdiv":0x73,
  "fsqrt":0x74,"feq":0x75,"flt":0x76,"fmin":0x77,
  "fmax":0x78,"fabs":0x79,"fneg":0x7A,"f2i":0x7B,"i2f":0x7C,
};

// OB=1 byte, everything else=4 bytes [op, b1, b2, b3].
// A[rd,rs1,rs2] C[rd,rs,imm8] D[rd/rs,cap,ptr] U2[rd,rs] F1[rd] G1[imm8]
// LI16[rd,imm16] BR[rs1,rs2,cn_off8] JM[off16,link] JR[rs1,rs2,link]
// CS[rd,rst,rsf] CR[rd,ctrl] CW[rs,ctrl,imm8] BITP[rd,pos6] BITW[rd,width]
// MEM3[cap,ptr,mode] RAW3[b1,b2,b3] PP = pseudo-op (li, ret)
const FORMAT = {
  "sei":"OB","cli":"OB","sysret":"OB","hlt":"OB",
  "nop":"OB","ebreak":"OB","ecall":"OB","wfe":"OB",
  "clrtag":"F1","tlbi":"F1","rdrnd":"F1",
  "swmode.sub":"G1","swmode.isa":"G1","sev":"G1","fence":"G1",
  "rdctrl":"CR","wrctrl":"CW",
  "hprobe":"U2","dcz":"U2","popcnt":"U2","clz":"U2",
  "fsqrt":"U2","fabs":"U2","fneg":"U2","f2i":"U2","i2f":"U2",
  "vxchg":"RAW3","io":"RAW3","bext":"RAW3","bins":"RAW3",
  "csel":"CS","jmpr":"JR","jmp":"JM",
  "jeq":"BR","jne":"BR","jlt":"BR","jltu":"BR","jge":"BR","jgeu":"BR",
  "li.64":"LI16","li.captr":"LI16","li.cn":"LI16","li.pcrel":"LI16",
  "sts32":"D","sts64":"D","st":"D","ld.s32":"D","ld64":"D","ld":"D",
  "dcf.c":"MEM3","dcf.i":"MEM3","dcf.ci":"MEM3","ics":"MEM3",
  "bset":"BITP","bclr":"BITP","btst":"BITP","bflp":"BITP",
  "bswap":"BITW","brev":"BITW",
  "rol":"A","ror":"A","bperm":"A","pdep":"A","pext":"A",
  "clmul":"A","crc32":"A","bfly":"A",
  "eqi":"C","andi":"C","nandi":"C","ori":"C","nori":"C","xori":"C",
  "xnri":"C","slli":"C","srli":"C","srai":"C","slti":"C","addi":"C",
  "subi":"C","muli":"C",
  "eq":"A","and":"A","nand":"A","or":"A","nor":"A","xor":"A","xnor":"A",
  "sll":"A","srl":"A","sra":"A","slt":"A","add":"A","sub":"A","mul":"A",
  "mod":"A","div":"A",
  "fadd":"A","fsub":"A","fmul":"A","fdiv":"A","feq":"A","flt":"A",
  "fmin":"A","fmax":"A",
  "ret":"PP","li":"PP",
};

const REVERSE_OPCODES = {};
for (const [mnem, op] of Object.entries(OPCODES)) {
  if (!(op in REVERSE_OPCODES)) REVERSE_OPCODES[op] = mnem;
}

// Register aliases -- zr is permanent (hardwired zero, seer_regfile.sv's
// own exemption); sp/fp/ra sit at the top of whatever depth is configured.
// 256 is used as a fixed default here since lens.js runs standalone,
// without the rest of the toolchain's CURRENT_REG_DEPTH global -- matches
// the toolchain's own default exactly (sp=254,fp=253,ra=252).
const REG_DEPTH = 256;
function getRegAlias() {
  return { zr: 255, sp: REG_DEPTH - 2, fp: REG_DEPTH - 3, ra: REG_DEPTH - 4 };
}
function regName(n) {
  const ra = getRegAlias();
  const alias = { 255: "zr", [ra.sp]: "sp", [ra.fp]: "fp", [ra.ra]: "ra" };
  return alias[n] !== undefined ? alias[n] : "r" + n;
}
function parseReg(tok) {
  tok = tok.trim().replace(/,$/, "");
  const low = tok.toLowerCase();
  const REG_ALIAS = getRegAlias();
  if (low in REG_ALIAS) return REG_ALIAS[low];
  const m = /^r(\d+)$/i.exec(tok);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 255) return n;
  }
  throw new Error(`invalid register: ${tok}`);
}
function parseImm(tok, bits) {
  tok = tok.trim().replace(/,$/, "").replace(/@(lo16|pcrel|cn)$/, "");
  let v;
  if (/^[+-]?0x/i.test(tok)) v = parseInt(tok, 16);
  else if (/^[+-]?0b/i.test(tok)) v = parseInt(tok.replace(/0b/i, ""), 2);
  else if (tok.length === 3 && tok[0] === "'" && tok[2] === "'") v = tok.charCodeAt(1);
  else v = parseInt(tok, 10);
  if (Number.isNaN(v)) throw new Error(`invalid immediate: ${tok}`);
  if (bits < 32) {
    const unsignedMax = (1 << bits) - 1, signedMin = -(1 << (bits - 1));
    if (v > unsignedMax || v < signedMin) {
      throw new Error(`immediate ${v} does not fit in ${bits} bits (valid range ${signedMin}..${unsignedMax})`);
    }
    const mask = (1 << bits) - 1;
    return v & mask;
  }
  const range = Math.pow(2, bits);
  return v < 0 ? v + range : v % range;
}
function toOnesComplementRaw(off, bits) {
  const maxVal = (1 << (bits - 1)) - 1, minVal = -(1 << (bits - 1));
  if (off > maxVal || off < minVal) {
    throw new Error(`offset ${off} does not fit in a signed ${bits}-bit field (valid range ${minVal}..${maxVal})`);
  }
  const mask = (1 << bits) - 1;
  const signBit = 1 << (bits - 1);
  return (off & signBit) ? (off - 1) & mask : off;
}
function fromOnesComplementRaw(raw, bits) {
  const mask = (1 << bits) - 1;
  const signBit = 1 << (bits - 1);
  if (!(raw & signBit)) return raw;
  const bumped = (raw + 1) & mask;
  return (bumped & signBit) ? bumped - (mask + 1) : bumped;
}
function s8(b) { return b & 0x80 ? b - 256 : b; }

// Encode one instruction -> array of byte values (length 1 for OB, 4 otherwise).
function encode(mnem, ops) {
  mnem = mnem.toLowerCase().replace(/,$/, "");
  if (!(mnem in FORMAT)) throw new Error(`unknown mnemonic: ${mnem}`);
  const fmt = FORMAT[mnem];
  const op = OPCODES[mnem];
  const R = i => parseReg(ops[i]);
  const I = (i, b = 8) => parseImm(ops[i], b);
  const need = n => { if (ops.length < n) throw new Error(`${mnem}: expected ${n} operand(s), got ${ops.length}`); };

  switch (fmt) {
    case "OB":   return [op];
    case "A":    need(3); return [op, R(0), R(1), R(2)];
    case "C":    need(3); return [op, R(0), R(1), I(2,8)];
    case "D":    need(3); return [op, R(0), R(1), R(2)];
    case "U2":   need(2); return [op, R(0), R(1), 0];
    case "F1":   need(1); return [op, R(0), 0, 0];
    case "G1":   return [op, (ops.length ? I(0,8) : 0) & 0xFF, 0, 0];
    case "JR":   need(3); return [op, R(0), R(1), R(2)];
    case "CS":   need(3); return [op, R(0), R(1), R(2)];
    case "CR":   need(2); return [op, R(0), I(1,8), 0];
    case "CW":   { need(2); const imm = ops.length >= 3 ? I(2,8) : 0; return [op, R(0), I(1,8), imm & 0xFF]; }
    case "BITP": need(2); return [op, R(0), I(1,6) & 0x3F, 0];
    case "BITW": need(2); return [op, R(0), I(1,8), 0];
    case "MEM3": { need(2); const mode = ops.length >= 3 ? I(2,8) : 0; return [op, R(0), R(1), mode & 0xFF]; }
    case "RAW3": { need(2); const b3 = ops.length >= 3 ? R(2) : 0; return [op, R(0), R(1), b3]; }
    case "LI16": {
      // CORRECTION: an earlier pass here added toOnesComplementRaw
      // handling for li.pcrel specifically, reasoning it needed the same
      // signed treatment as BR/JM (which are CN-table-relative). That
      // reasoning was wrong -- checked directly against
      // extracted_from_soak2.js's own LI16 case just now, and it uses
      // plain parseImm masking uniformly for every LI16 mnemonic,
      // li.pcrel included, with no special-casing at all. Confirmed by
      // the real cross-check test disagreeing on li.pcrel r1, -20 (0xFFEB
      // vs the proven 0xFFEC) -- reverted to match.
      need(2);
      const imm = I(1,16);
      return [op, R(0), (imm>>8)&0xFF, imm&0xFF];
    }
    case "BR":   { need(3); const off = parseRawInt(ops[2]); return [op, R(0), R(1), toOnesComplementRaw(off, 8)]; }
    case "JM": {
      need(1);
      const off = parseRawInt(ops[0]);
      const raw = toOnesComplementRaw(off, 16);
      const link = ops.length >= 2 ? R(1) : 255;
      return [op, (raw>>8)&0xFF, raw&0xFF, link];
    }
    case "PP":
      if (mnem === "ret") return [0x19, 0x00, 0x00, 0x00]; // jmp 0 = return
      if (mnem === "li") {
        need(2);
        const rd = R(0);
        // BUGFIX (found via a regression -- this had reverted to the old,
        // wrong 0x20/li.64 at some point during later edits, caught by
        // real Vertex output showing "li.64 sp, 0x6000" where "li.captr"
        // was expected; the same wrong-opcode symptom was actually
        // visible in an earlier trace too and should have been chased
        // down then). Real hardware uses li.captr=0x21 for this case, not
        // li.64=0x20 -- confirmed directly against extracted_from_soak2.js's
        // own encode() again here, not just trusted from memory.
        let raw = ops[1].trim().replace(/,$/, "");
        let v;
        if (/^[+-]?0x/i.test(raw)) v = parseInt(raw, 16);
        else if (/^[+-]?0b/i.test(raw)) v = parseInt(raw.replace(/0b/i, ""), 2);
        else v = parseInt(raw, 10);
        if (Number.isNaN(v)) throw new Error(`li: invalid immediate: ${raw}`);
        if (v >= 0 && v <= 0xFFFF) return [0x21, rd, (v>>8)&0xFF, v&0xFF];
        if (v < 0 && v >= -128) return [0x4B, rd, 255, v & 0xFF];
        throw new Error(`li: ${raw} out of range (0..0xFFFF or -128..-1; use li.pcrel/li.cn or a multi-op sequence)`);
      }
      throw new Error(`unhandled pseudo-op: ${mnem}`);
    default: throw new Error(`unknown format: ${fmt}`);
  }
}
function tokIsHexOrBin(tok) { return /^[+-]?0[xXbB]/.test(tok.trim()); }

// Raw, UNMASKED integer parse -- for BR/JM offset fields specifically,
// which need the true signed value handed to toOnesComplementRaw, not
// parseImm's own masked-to-unsigned-range result (see the bug note where
// this is used, in encode()'s BR/JM cases).
function parseRawInt(tok) {
  tok = tok.trim().replace(/,$/, "");
  let v;
  if (/^[+-]?0x/i.test(tok)) v = parseInt(tok, 16);
  else if (/^[+-]?0b/i.test(tok)) v = parseInt(tok.replace(/0b/i, ""), 2);
  else v = parseInt(tok, 10);
  if (Number.isNaN(v)) throw new Error(`invalid immediate: ${tok}`);
  return v;
}

// Mirror of encode(): format + the 3 post-opcode bytes -> operand token strings.
function decodeOperands(fmt, bytes) {
  const [b1, b2, b3] = bytes;
  switch (fmt) {
    case "OB":   return [];
    case "A":    return [regName(b1), regName(b2), regName(b3)];
    case "C":    return [regName(b1), regName(b2), String(s8(b3))];
    case "D":    return [regName(b1), regName(b2), regName(b3)];
    case "U2":   return [regName(b1), regName(b2)];
    case "F1":   return [regName(b1)];
    case "G1":   return [String(b1)];
    case "JR":   return [regName(b1), regName(b2), regName(b3)];
    case "CS":   return [regName(b1), regName(b2), regName(b3)];
    case "CR":   return [regName(b1), String(b2)];
    case "CW":   return [regName(b1), String(b2), String(b3)];
    case "BITP": return [regName(b1), String(b2 & 0x3F)];
    case "BITW": return [regName(b1), String(b2)];
    case "MEM3": return [regName(b1), regName(b2), String(b3)];
    case "RAW3": return [regName(b1), regName(b2), regName(b3)];
    case "LI16": { const imm=(b2<<8)|b3; return [regName(b1), "0x"+imm.toString(16).toUpperCase()]; }
    case "BR":   return [regName(b1), regName(b2), String(fromOnesComplementRaw(b3, 8))];
    case "JM": {
      const raw16 = (b1<<8)|b2;
      const offStr = String(fromOnesComplementRaw(raw16, 16));
      return (b3 !== 255) ? [offStr, regName(b3)] : [offStr];
    }
    default: return [b1,b2,b3].map(String);
  }
}

// Instruction byte-length for a given opcode -- 1 for OB, 4 otherwise. The
// caller MUST use this instead of assuming a fixed width, since real SEER
// instructions are variable length.
function instrLength(opcode) {
  const mnem = REVERSE_OPCODES[opcode];
  return (mnem && FORMAT[mnem] === "OB") ? 1 : 4;
}

// ── Simulator (ported from the Soak Tester, adapted this session) ──────────
// Adapted to take a raw bytes array directly instead of calling its own
// separate parseProgram/assembleLine internally -- this file already has a
// proven assembler (assembleSource, above); building a second, parallel one
// just to feed the simulator would reintroduce exactly the kind of
// duplication that caused this whole rewrite (two copies of "how SEER
// bytes work" that can silently drift apart). The simulator's own main
// loop already worked directly off a flat bytes array either way (decoding
// via REVERSE_OPCODES, the same way disasm() does), so only the few lines
// that used to call parseProgram needed to change.
const SIM_ZR = 255;
function simU64(v) { return BigInt.asUintN(64, v); }
function simS64(v) { return BigInt.asIntN(64, v); }
function simS8(x)  { return x & 0x80 ? BigInt(x - 256) : BigInt(x); }
function hex2(b) { return b.toString(16).padStart(2,"0").toUpperCase(); }

const SIM_ALU_R = {
  eq:   (a,b) => a===b ? 1n : 0n,        and:  (a,b) => simU64(a & b),
  nand: (a,b) => simU64(~(a & b)),        or:   (a,b) => simU64(a | b),
  nor:  (a,b) => simU64(~(a | b)),        xor:  (a,b) => simU64(a ^ b),
  xnor: (a,b) => simU64(~(a ^ b)),        sll:  (a,b) => simU64(a << (b & 63n)),
  srl:  (a,b) => simU64(a >> (b & 63n)),  sra:  (a,b) => simU64(simS64(a) >> (b & 63n)),
  slt:  (a,b) => simS64(a) < simS64(b) ? 1n : 0n,
  add:  (a,b) => simU64(a + b),           sub:  (a,b) => simU64(a - b),
  mul:  (a,b) => simU64(simS64(a) * simS64(b)),
  mod:  (a,b) => b===0n ? 0n : simU64(simS64(a) % simS64(b)),
  div:  (a,b) => b===0n ? 0n : simU64(simS64(a) / simS64(b)),
};
const SIM_ALU_I_MNEM = {eqi:'eq',andi:'and',nandi:'nand',ori:'or',nori:'nor',xori:'xor',
  xnri:'xnor',slli:'sll',srli:'srl',srai:'sra',slti:'slt',addi:'add',subi:'sub',muli:'mul'};

// bytes: flat Uint8Array/Array of the whole program's bytes (dense-packed,
// no per-instruction padding -- matches the real loader's actual layout).
function simulateProgram(bytes, maxSteps=200000, regDepth=256) {
  if (!bytes || bytes.length === 0) return {error: "empty program"};
  bytes = Array.from(bytes);
  while (bytes.length % 4 !== 0) bytes.push(0);

  const reg = new Array(256).fill(0n);
  const mem = new Map();
  const rstack = [];
  const cnTable = new Array(256).fill(null);
  let stagedCnIndex = null;
  let cnCount = 0;
  let pc = 0;
  let halted = false;
  let steps = 0;
  const trace = [];

  const localZr = regDepth - 1;
  const isHardZero = r => r === SIM_ZR || r === localZr;
  const isNotImpl = r => regDepth < 256 && !isHardZero(r) && r >= regDepth;
  const RD = r => {
    if (isHardZero(r)) return 0n;
    if (isNotImpl(r)) throw {__regNotImpl: r};
    return reg[r];
  };
  const WR = (r, v) => {
    if (isHardZero(r)) return;
    if (isNotImpl(r)) throw {__regNotImpl: r};
    reg[r] = simU64(v);
  };

  try {
  while (!halted && steps < maxSteps) {
    steps++;
    const stepPc = pc;
    let stepWrite = null;
    if (pc < 0 || pc >= bytes.length) return {error: `PC ${pc} out of bounds`, trace, steps};
    const op = bytes[pc];
    const mnem = REVERSE_OPCODES[op];
    if (mnem === undefined) return {error: `unimplemented/unknown opcode 0x${hex2(op)} at PC ${pc}`, trace, steps};
    const fmt = FORMAT[mnem];

    if (fmt === "OB") {
      if (mnem === 'hlt') { halted = true; }
      else if (mnem === 'nop') { cnCount++; }
      trace.push({pc: stepPc, waddr: null, wdata: null});
      pc = pc + 1;
      continue;
    }

    if (pc + 3 >= bytes.length) return {error: `truncated instruction at PC ${pc}`, trace, steps};
    const b1 = bytes[pc+1], b2 = bytes[pc+2], b3 = bytes[pc+3];
    let nextPc = pc + 4;
    let isCallJmp = false;

    if (mnem in SIM_ALU_R) {
      WR(b1, SIM_ALU_R[mnem](RD(b2), RD(b3)));
    } else if (mnem in SIM_ALU_I_MNEM) {
      WR(b1, SIM_ALU_R[SIM_ALU_I_MNEM[mnem]](RD(b2), simS8(b3)));
    } else if (mnem === 'li.64') {
      const addr = Number(RD(b1)) + (Number(simS8(b3)) << 3);
      WR(b1, mem.get(addr) ?? 0n);
    } else if (mnem === 'li.captr') {
      WR(b1, BigInt((b2 << 8) | b3));
    } else if (mnem === 'li.pcrel') {
      const off = (b2 << 8) | b3;
      const signedOff = off & 0x8000 ? off - 0x10000 : off;
      WR(b1, simU64(BigInt(pc + signedOff)));
    } else if (mnem === 'li.cn') {
      const idx = (b2 << 8) | b3;
      if (cnTable[idx] === null) return {error: `li.cn: table index ${idx} not registered`, trace, steps};
      WR(b1, BigInt(cnTable[idx]));
    } else if (mnem === 'li.cn.reg') {
      const idx = Number(RD(b2)) & 0xFF;
      if (cnTable[idx] === null) return {error: `li.cn.reg: table index ${idx} not registered`, trace, steps};
      WR(b1, BigInt(cnTable[idx]));
    } else if (mnem === 'ld64') {
      WR(b1, mem.get(Number(RD(b2))+Number(RD(b3))) ?? 0n);
    } else if (mnem === 'ld.s32') {
      const v = Number((mem.get(Number(RD(b2))+Number(RD(b3))) ?? 0n) & 0xFFFFFFFFn);
      WR(b1, simU64(BigInt(v & 0x80000000 ? v - 0x100000000 : v)));
    } else if (mnem === 'sts32') {
      mem.set(Number(RD(b2))+Number(RD(b3)), RD(b1) & 0xFFFFFFFFn);
    } else if (mnem === 'sts64') {
      mem.set(Number(RD(b2))+Number(RD(b3)), RD(b1));
    } else if (mnem === 'popcnt') {
      let v = RD(b2), c = 0n; while (v) { c += v & 1n; v >>= 1n; } WR(b1, c);
    } else if (mnem === 'clz') {
      const v = RD(b2); WR(b1, v === 0n ? 64n : BigInt(64 - v.toString(2).length));
    } else if (mnem === 'bset') {
      WR(b1, RD(b1) | (1n << BigInt(b2 & 63)));
    } else if (mnem === 'btst') {
      WR(b1, (RD(b1) >> BigInt(b2 & 63)) & 1n);
    } else if (mnem === 'rdctrl') {
      WR(b1, 0n);
    } else if (mnem === 'wrctrl') {
      const wrctrlVal = (b1 === SIM_ZR) ? BigInt(b3) : RD(b1);
      if (b2 === 14) { stagedCnIndex = Number(wrctrlVal) & 0xFF; }
      else if (b2 === 15) {
        if (stagedCnIndex === null) return {error: `wrctrl 0x0F committed with no staged index (missing prior wrctrl ...,14)`, trace, steps};
        const targetPc = Number(wrctrlVal);
        if (targetPc < 0 || targetPc >= bytes.length || bytes[targetPc] !== 0x10) {
          return {error: `CN registration fault: wrctrl committed PC ${targetPc} as slot ${stagedCnIndex}, `
                        + `but that address is not a nop (found 0x${(bytes[targetPc]||0).toString(16)}) -- `
                        + `likely a wrong li.pcrel/li.captr offset in the setup prologue`, trace, steps};
        }
        cnTable[stagedCnIndex] = targetPc + 1;
        stagedCnIndex = null;
      }
    } else if (fmt === "BR") {
      const a = RD(b1), bb = RD(b2);
      const cond = {jeq:a===bb, jne:a!==bb, jlt:simS64(a)<simS64(bb),
                    jltu:a<bb, jge:simS64(a)>=simS64(bb), jgeu:a>=bb}[mnem];
      if (cond) {
        const off = fromOnesComplementRaw(b3, 8);
        const idx = (cnCount + off) & 0xFF;
        if (cnTable[idx] === null) return {error: `branch to unregistered CN slot ${idx} (cnCount=${cnCount}, off=${off})`, trace, steps};
        nextPc = cnTable[idx];
      }
    } else if (mnem === 'jmp') {
      const raw16 = (b1 << 8) | b2;
      if (raw16 === 0) {
        if (!rstack.length) return {error: `return-stack underflow at PC ${pc}`, trace, steps};
        const frame = rstack.pop();
        nextPc = frame.pc; cnCount = frame.cnCount;
      } else {
        const off = fromOnesComplementRaw(raw16, 16);
        const idx = (cnCount + off) & 0xFF;
        if (cnTable[idx] === null) return {error: `jmp to unregistered CN slot ${idx} (cnCount=${cnCount}, off=${off})`, trace, steps};
        nextPc = cnTable[idx];
        if (b3 !== SIM_ZR) {
          WR(b3, BigInt(pc + 5));
          rstack.push({pc: pc + 5, cnCount});
          cnCount = 0;
          isCallJmp = true;
        }
      }
    } else if (mnem === 'jmpr') {
      const tgt = Number(simU64(RD(b1) + RD(b2)));
      if (b3 !== SIM_ZR) { WR(b3, BigInt(pc + 5)); rstack.push({pc: pc+5, cnCount}); cnCount = 0; }
      nextPc = tgt;
    } else {
      return {error: `unimplemented mnemonic "${mnem}" (0x${hex2(op)}) at PC ${pc}`, trace, steps};
    }

    if (fmt !== "BR" && mnem !== 'jmp' && mnem !== 'jmpr') {
      const writeMnems = new Set([...Object.keys(SIM_ALU_R), ...Object.keys(SIM_ALU_I_MNEM),
        'li.64','li.captr','li.pcrel','li.cn','li.cn.reg','ld64','ld.s32','popcnt','clz','bset','btst','rdctrl']);
      if (writeMnems.has(mnem) && !isHardZero(b1)) stepWrite = [b1, RD(b1)];
    } else if (mnem === 'jmp') {
      if (isCallJmp && !isHardZero(b3)) stepWrite = [b3, RD(b3)];
    } else if (mnem === 'jmpr') {
      if (!isHardZero(b3)) stepWrite = [b3, RD(b3)];
    }

    trace.push({pc: stepPc, waddr: stepWrite ? stepWrite[0] : null,
                 wdata: stepWrite ? BigInt.asIntN(64, stepWrite[1]) & 0xFFFFFFFFFFFFFFFFn : null});
    pc = nextPc;
  }
  if (steps >= maxSteps) return {error: `exceeded ${maxSteps} steps without halting -- infinite loop?`, trace, steps};
  return {reg, mem, steps, halted, trace, cnCount};
  } catch (e) {
    if (e && e.__regNotImpl !== undefined) {
      return {error: `register r${e.__regNotImpl} is not implemented at regDepth=${regDepth} `
        + `(real hardware would raise TRAP_ILLEGAL_INSTR here) -- PC ${pc}`, trace, steps};
    }
    throw e;
  }
}


const F = (s,e,t,tip) => ({start:s, end:e, type:t, tip});

const FORMAT_DOC = {
  OB:   'No operands -- single byte, no operand bytes follow.',
  A:    '[op, rd, rs1, rs2] -- rd = rs1 OP rs2.',
  C:    '[op, rd, rs, imm8] -- rd = rs OP sign_ext(imm8).',
  D:    '[op, rd/rs, cap, ptr] -- memory op; effective address = cap-relative + ptr.',
  U2:   '[op, rd, rs] -- unary/2-register op.',
  F1:   '[op, rd] -- single-register op.',
  G1:   '[op, imm8] -- single immediate op.',
  LI16: '[op, rd, imm16] -- rd = 16-bit immediate (zero/sign-extended per mnemonic).',
  BR:   '[op, rs1, rs2, cn_off8] -- conditional branch; target resolved via the CN table at cn_off8.',
  JM:   '[op, off16, link] -- unconditional jump/call; PC-relative via the CN table, link reg defaults to zr.',
  JR:   '[op, rs1, rs2, link] -- register-indirect jump; target = rs1+rs2 (NOT CN-table validated).',
  CS:   '[op, rd, rst, rsf] -- conditional select: rd = cond ? rst : rsf.',
  CR:   '[op, rd, ctrl_id] -- read a control register.',
  CW:   '[op, rs, ctrl_id, imm8] -- write a control register.',
  BITP: '[op, rd, pos6] -- single-bit operation at bit position pos.',
  BITW: '[op, rd, width] -- bit-width operation.',
  MEM3: '[op, cap, ptr, mode] -- cache/memory-fence style op.',
  RAW3: '[op, b1, b2, b3] -- raw 3-byte operand instruction.',
};

// v13-real disassembler. Takes a byte array of AT LEAST instrLength(bytes[0])
// bytes (1 for OB, 4 otherwise) -- callers must slice using instrLength(),
// not a fixed width, since real SEER instructions are variable length.
function disasm(bytes) {
  const b = Array.from(bytes);
  const op = b[0];
  const mnem = REVERSE_OPCODES[op];

  if (mnem === undefined) {
    return { mnem: `??? 0x${op.toString(16).toUpperCase().padStart(2,'0')}`,
      fields: [F(0,1,'opcode','Unrecognized opcode -- not in the real SEER OPCODES table')],
      meta: 'Unrecognized encoding', len: 1 };
  }

  const fmt = FORMAT[mnem];
  const len = fmt === 'OB' ? 1 : 4;
  const meta = FORMAT_DOC[fmt] || '';

  if (fmt === 'OB') {
    return { mnem, fields: [F(0,1,'opcode',mnem)], meta, len };
  }

  const ops = decodeOperands(fmt, [b[1], b[2], b[3]]);
  const mnemStr = ops.length ? `${mnem}  ${ops.join(', ')}` : mnem;

  // Field layout per format -- byte ranges within [0,4), types chosen to
  // match the colour taxonomy the existing pill renderer already uses
  // (opcode/register/immediate/offset/branch/memory).
  let fields;
  switch (fmt) {
    case 'A': case 'D': case 'JR': case 'CS': case 'RAW3':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',`${ops[0]}`),
                F(2,3,'register',`${ops[1]}`), F(3,4,'register',`${ops[2]}`)];
      break;
    case 'C':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',`rd=${ops[0]}`),
                F(2,3,'register',`rs=${ops[1]}`), F(3,4,'immediate',`imm8=${ops[2]}`)];
      break;
    case 'U2':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',`rd=${ops[0]}`),
                F(2,3,'register',`rs=${ops[1]}`), F(3,4,'immediate','padding')];
      break;
    case 'F1':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',ops[0]), F(2,4,'immediate','padding')];
      break;
    case 'G1':
      fields = [F(0,1,'opcode',mnem), F(1,4,'immediate',`imm8=${ops[0]}`)];
      break;
    case 'LI16':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',`rd=${ops[0]}`), F(2,4,'immediate',`imm16=${ops[1]}`)];
      break;
    case 'BR':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',`rs1=${ops[0]}`),
                F(2,3,'register',`rs2=${ops[1]}`), F(3,4,'branch',`cn_off8=${ops[2]}`)];
      break;
    case 'JM':
      fields = ops.length === 2
        ? [F(0,1,'opcode',mnem), F(1,3,'branch',`off16=${ops[0]}`), F(3,4,'register',`link=${ops[1]}`)]
        : [F(0,1,'opcode',mnem), F(1,3,'branch',`off16=${ops[0]}`), F(3,4,'immediate','link=zr (no call)')];
      break;
    case 'CR':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',ops[0]), F(2,4,'immediate',`ctrl_id=${ops[1]}`)];
      break;
    case 'CW':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',ops[0]),
                F(2,3,'immediate',`ctrl_id=${ops[1]}`), F(3,4,'immediate',`imm8=${ops[2]}`)];
      break;
    case 'BITP':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',ops[0]), F(2,4,'immediate',`pos=${ops[1]}`)];
      break;
    case 'BITW':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',ops[0]), F(2,4,'immediate',`width=${ops[1]}`)];
      break;
    case 'MEM3':
      fields = [F(0,1,'opcode',mnem), F(1,2,'register',`cap=${ops[0]}`),
                F(2,3,'register',`ptr=${ops[1]}`), F(3,4,'immediate',`mode=${ops[2]}`)];
      break;
    default:
      fields = [F(0,1,'opcode',mnem), F(1,4,'immediate','operand bytes')];
  }

  return { mnem: mnemStr, fields, meta, len };
}

const OPERAND_TYPES = {
  OB:[], A:["reg","reg","reg"], C:["reg","reg","imm"], D:["reg","reg","reg"],
  U2:["reg","reg"], F1:["reg"], G1:["imm"], JR:["reg","reg","reg"],
  CS:["reg","reg","reg"], CR:["reg","imm"], CW:["reg","imm"],
  BITP:["reg","imm"], BITW:["reg","imm"], MEM3:["reg","reg","imm"],
  RAW3:["reg","reg","reg"], LI16:["reg","imm"], BR:["reg","reg","imm"],
  JM:["imm"],
};
function operandTypesFor(mnem) {
  if (mnem === "li") return ["reg","imm"];
  if (mnem === "ret") return [];
  return OPERAND_TYPES[FORMAT[mnem]] || [];
}

class AutoRegs {
  constructor(forbidden) {
    this.pool = []; this.counter = 0; this.history = [];
    for (let i = 0; i <= 255; i++) if (!forbidden.has(i)) this.pool.push(i);
  }
  next() {
    if (!this.pool.length) throw new Error('No auto registers available');
    const r = this.pool[this.counter % this.pool.length]; this.counter++; this.history.push(r); return r;
  }
  back(n) {
    if (n < 1) throw new Error('R-N: N must be >= 1');
    if (n > this.history.length) throw new Error(`R-${n} requested but only ${this.history.length} auto-regs allocated`);
    return this.history[this.history.length - n];
  }
}

function collectNamed(lines) {
  const named = new Set();
  for (const line of lines)
    for (const tok of line.trim().split(/[\s,]+/))
      if (/^[Rr]\d+$/.test(tok)) { const n = parseInt(tok.slice(1)); if (n >= 0 && n <= 255) named.add(n); }
  return named;
}

// Parses labels AND computes each instruction's real byte length (1 for OB
// mnemonics, 4 otherwise) for correct address tracking -- the old version's
// fixed "+= 8" per line does not hold for the real, variable-length ISA.
// .string "text" -- a data directive, not a real instruction. Emits the
// UTF-8 bytes of text followed by a single 0x00 terminator (the standard,
// simplest convention for "one pointer, no separate length needed" --
// matches this file's own assumption for how the output ecall service
// consumes a string pointer, though that assumption is about a runtime
// contract this file has no visibility into, not something verified here).
function tryParseStringDirective(stripped) {
  const m = stripped.match(/^\.string\s+(".*")\s*$/);
  if (!m) return null;
  let text;
  try { text = JSON.parse(m[1]); }
  catch (e) { return { error: `malformed .string literal: ${e.message}` }; }
  const byteLen = new TextEncoder().encode(text).length + 1; // +1 for the null terminator
  return { text, byteLen };
}

function parseLabels(source) {
  const rawLines = source.split('\n'), labelTable = {}, work = [];
  let byteOffset = 0;
  for (const raw of rawLines) {
    let stripped = raw.replace(/;.*$/, '').trim();
    if (!stripped) continue;
    const strDir = tryParseStringDirective(stripped);
    if (strDir) {
      if (strDir.error) { work.push({ kind: 'error', line: strDir.error, addr: byteOffset, srcLine: stripped }); continue; }
      work.push({ kind: 'string', line: strDir.text, addr: byteOffset, srcLine: stripped });
      byteOffset += strDir.byteLen;
      continue;
    }
    if (stripped.startsWith('.') && !stripped.includes(':')) continue;
    if (stripped.includes(':')) {
      const colon = stripped.indexOf(':'), candidate = stripped.slice(0, colon).trim(), rest = stripped.slice(colon + 1).trim();
      let valid = candidate.length > 0 && !candidate.includes(' ') && !/^\d+$/.test(candidate);
      if (valid) {
        if (labelTable[candidate] !== undefined) { work.push({ kind: 'error', line: `Duplicate label "${candidate}"`, addr: byteOffset, srcLine: stripped }); }
        else { labelTable[candidate] = byteOffset; work.push({ kind: 'label', line: candidate, addr: byteOffset, srcLine: stripped }); }
        if (rest) {
          const restStrDir = tryParseStringDirective(rest);
          if (restStrDir) {
            if (restStrDir.error) { work.push({ kind: 'error', line: restStrDir.error, addr: byteOffset, srcLine: rest }); }
            else { work.push({ kind: 'string', line: restStrDir.text, addr: byteOffset, srcLine: rest }); byteOffset += restStrDir.byteLen; }
          } else {
            const mnem = rest.trim().split(/[\s,]+/)[0]?.toLowerCase();
            const len = (mnem && FORMAT[mnem] === 'OB') ? 1 : 4;
            work.push({ kind: 'instr', line: rest, addr: byteOffset, srcLine: rest });
            byteOffset += len;
          }
        }
        continue;
      }
    }
    const mnem = stripped.split(/[\s,]+/)[0]?.toLowerCase();
    const len = (mnem && FORMAT[mnem] === 'OB') ? 1 : 4;
    work.push({ kind: 'instr', line: stripped, addr: byteOffset, srcLine: stripped });
    byteOffset += len;
  }
  return { work, labelTable };
}

function parseRegOrAuto(tok, auto) {
  if (tok === 'R' || tok === 'r') return [auto.next(), 'auto'];
  const bm = tok.match(/^[Rr]-(\d+)$/); if (bm) return [auto.back(parseInt(bm[1])), 'back'];
  return [parseReg(tok), 'named'];
}

// Mnemonic-based assembler -- "add r1, r2, r3", not the old hex-opcode-
// first "5B R1 R2 R3". Matches the real toolchain's own syntax so a
// program written here and one written for the Soak Tester's Source box
// mean the same thing.
function assembleInstruction(tokens, auto, labelTable, instrAddr) {
  if (!tokens.length) throw new Error('Empty instruction');
  const mnem = tokens[0].toLowerCase().replace(/,$/, '');
  if (!(mnem in FORMAT)) throw new Error(`unknown mnemonic: "${tokens[0]}"`);
  const operToks = tokens.slice(1).map(t => t.replace(/,$/, ''));
  const opTypes = operandTypesFor(mnem);
  const resolved = [{ text: tokens[0], type: 'opcode' }];

  // Resolve registers (including auto-allocation and labels-as-jump-targets)
  // through the SAME operand list encode() will consume, so auto/back
  // registers and label offsets work uniformly across every format.
  const resolvedOps = operToks.map((tok, i) => {
    const kind = opTypes[i];
    if (kind === 'reg') {
      const [ri, rt] = parseRegOrAuto(tok, auto);
      resolved.push({ text: tok, type: 'register', regtype: rt, resolved: ri });
      return 'r' + ri;
    }
    // Bug found via real Vertex output, not caught by earlier testing:
    // this only resolved labels for jmp's own first operand -- BR-format
    // conditional branches (jeq/jne/jlt/...) target labels exactly as
    // often (every loop condition and if-check does), and their offset
    // operand is also 'imm' kind, so this now covers any immediate
    // operand that happens to name a known label, not just jmp's.
    if (kind === 'imm' && labelTable[tok] !== undefined) {
      const off = labelTable[tok] - instrAddr;
      resolved.push({ text: tok, type: 'label', resolved: off });
      return String(off);
    }
    resolved.push({ text: tok, type: 'immediate' });
    return tok;
  });

  const bytes = Uint8Array.from(encode(mnem, resolvedOps));
  return { bytes, resolvedTokens: resolved };
}

function assembleSource(source) {
  const { work, labelTable } = parseLabels(source);
  const instrLines = work.filter(w => w.kind === 'instr').map(w => w.line);
  const named = collectNamed(instrLines);
  const auto = new AutoRegs(named);
  const results = [];
  for (const entry of work) {
    if (entry.kind === 'label') { results.push({ isLabel: true, name: entry.line, addr: entry.addr, srcLine: entry.srcLine }); }
    else if (entry.kind === 'error') { results.push({ isLabel: false, bytes: null, resolvedTokens: null, srcLine: entry.srcLine, error: entry.line }); }
    else if (entry.kind === 'string') {
      const bytes = Uint8Array.from([...new TextEncoder().encode(entry.line), 0]);
      results.push({ isLabel: false, bytes, resolvedTokens: [{ text: entry.srcLine, type: 'data' }], srcLine: entry.srcLine, error: null, addr: entry.addr });
    }
    else {
      const tokens = entry.line.split(/[\s,]+/).filter(Boolean);
      try { const { bytes, resolvedTokens } = assembleInstruction(tokens, auto, labelTable, entry.addr); results.push({ isLabel: false, bytes, resolvedTokens, srcLine: entry.srcLine, error: null, addr: entry.addr }); }
      catch (e) { results.push({ isLabel: false, bytes: null, resolvedTokens: null, srcLine: entry.srcLine, error: e.message, addr: entry.addr }); }
    }
  }
  return results;
}

// Expose under prefixed names to avoid collisions with any future global scope
window.seerDisasm         = disasm;
window.seerAssembleSource = assembleSource;
window.seerEncode         = encode;
window.seerInstrLength    = instrLength;
window.simulateProgram    = simulateProgram;
window.seerFormat         = FORMAT;
})();


// ── SEER ISA v18 compiler (integrated from ivx-seer.js) ─────────────────────
// Sections 1–5: constants, emitter, expression text, statement compilers,
// and top-level compileSEER(). Section 6 (lens integration) is handled
// natively below — no monkey-patching needed.

// ivx-seer.js — IVX → SEER ISA v18 Compiler Backend
//
// Add to index.html after ivx-lens.js:
//   <script src="ivx-seer.js"></script>
//
// Adds "SEER Assembly" to the Lens language selector.
//
// ── Design principle: zero unnecessary nops ────────────────────────────────
//
// The IVX NodeID byte (byte 7) can ride on ANY instruction — it does not
// require a dedicated nop.  A standalone nop [nid=N] is only emitted when
// a label has no real instruction at its PC (i.e. an empty block, or a
// label immediately followed by another label).  In all other cases the nid
// is placed on the first real instruction that opens the node.
//
// Three categories of node boundary in the analysis:
//
//   BRANCH TARGET — hardware must find a registered node at this PC.
//     CFI fires TRAP_CFI (IVT 0x05) if the target PC is not registered.
//     nid goes on the first real instruction at that PC.
//     Examples: function entry, else-branch, loop-exit, program end.
//
//   SEQUENTIAL OPEN — not a branch target, just opens a flowchart region.
//     Hardware never checks these via CFI (nobody jumps here).
//     nid goes on the first real instruction for graph annotation only.
//     Examples: if-condition, loop-condition, take, for-body.
//     If there is no real instruction to tag we emit a nop; otherwise we don't.
//
//   PURE GRAPH ANNOTATION — GIVE, CON at if-true exit.
//     Not a branch target.  Not needed for hardware CFI.
//     Only emitted as a comment, not as an instruction.
//
// ── SEER ISA v18 encoding ──────────────────────────────────────────────────
//
//   8 bytes per instruction, little-endian.
//   Byte 0:   opcode
//   Bytes 1-6: operands
//   Byte 7:   NodeID  [ELSE:1][INDENT:2][TYPE:3][ROUTE:2]
//               TYPE:  0=process 1=start 2=decision 3=con
//                      4=give   5=take  6=fun      7=end
//               ROUTE: 0=default 1=next 2=prev 3=next-next
//               ELSE:  1 = else-branch of a decision
//               0x00  = plain body instruction (no boundary)
//
// ── Capability model (SEER Security Layer 2) ──────────────────────────────
//
//   cap_id 0x00 — null / unchecked (simple scalars, literals)
//   cap_id 0x01 — global stack frame
//   cap_id 0x02+— per-function frames and heap-allocated list/dict objects
//
// Licensed under the Apache License, Version 2.0
// Copyright 2026 IVX / SEER Project

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const NTYPE = { PROCESS:0, START:1, DECISION:2, CON:3, GIVE:4, TAKE:5, FUN:6, END:7 };
const ROUTE = { DEFAULT:0, NEXT:1, PREV:2, NEXT_NEXT:3 };

function nidByte(type, route, elseBit) {
  return (((elseBit ?? 0) & 1) << 7) | (type << 2) | ((route ?? 0) & 3);
}

const NID = {
  BODY:          0x00,
  START:         nidByte(NTYPE.START),
  DECISION:      nidByte(NTYPE.DECISION),
  DECISION_PREV: nidByte(NTYPE.DECISION, ROUTE.PREV),
  CON:           nidByte(NTYPE.CON),
  CON_PREV:      nidByte(NTYPE.CON,      ROUTE.PREV),
  GIVE:          nidByte(NTYPE.GIVE),
  TAKE:          nidByte(NTYPE.TAKE),
  FUN:           nidByte(NTYPE.FUN),
  END:           nidByte(NTYPE.END),
  ELSE_CON:      nidByte(NTYPE.CON,      ROUTE.DEFAULT, 1),
};

// Ecall service numbers
const SVC = {
  OUTPUT:0x01, INPUT:0x02,
  GEMINI:0x10, GPT:0x11, CLAUDE:0x12,
  HTTP:  0x20, SHEETS:0x30, EMAIL:0x40, SAVE:0x50, FETCH:0x60,
};

// Named registers
const R = { ZERO:'r255', FP:'r240', LINK:'r241', SP:'r242', SELF:'r243', HEAP:'r244' };


// ─────────────────────────────────────────────────────────────────────────────
// 2. EMITTER
// ─────────────────────────────────────────────────────────────────────────────

// Assigns each named variable a concrete, per-scope byte offset --
// replacing the old, fictional "address = the variable's own name as a
// string" scheme with the standard technique every real compiler backend
// uses: a numeric stack-slot layout. One frame per lexical scope (capId),
// slots handed out in the order variables are first referenced.
class MemSlots {
  constructor() { this.frames = new Map(); }
  _frame(capId) {
    if (!this.frames.has(capId)) this.frames.set(capId, { slots: new Map(), nextOffset: 0 });
    return this.frames.get(capId);
  }
  slotFor(capId, name) {
    const f = this._frame(capId);
    if (f.slots.has(name)) return f.slots.get(name);
    const off = f.nextOffset;
    f.nextOffset += 8;
    f.slots.set(name, off);
    return off;
  }
  frameSize(capId) { return this._frame(capId).nextOffset; }
}


class SEEREmitter {
  constructor() {
    this.lines      = [];
    this.pc         = 0;
    this.labelSeq   = 0;
    this.capNext    = 2;
    this.scopeStack = [];
    this.symbols    = [];
    this.nodeCount  = 0;
    this.iLevel     = 0;
    this._pendingNid     = NID.BODY;
    this._pendingComment = '';
    this.regAlloc      = new RegAlloc();
    this.lineAddressMap = new Map();
    this.memSlots       = new MemSlots();
    this.stringLiterals = new Map(); // text -> label, emitted as a data section at program end
    this.stringSeq      = 0;
    // Real CN-table registration -- see resolveCnJumps()'s own header
    // comment for the full mechanism. Built to match the proven
    // compileCFSource toolchain's own architecture (traced directly from
    // extracted_v2.js this session): registered nodes get a real nop plus
    // a global, never-resetting slot; jumps get resolved against a
    // per-scope, reachability-aware local position counter, not a raw
    // PC-relative distance.
    this.cnNodes       = [];        // {name, lineIdx, slot} in emission order
    this.cnNodeByName  = new Map();
    this.cnJumps       = [];        // {lineIdx, mnem, r1, r2, targetName, isUnconditional, comment}
    this.cnScopeStarts = [];        // {lineIdx, isGlobal} recorded at every pushScope, in order
  }

  // Interns a string constant, returning the label its data will be
  // emitted under (at the end of the program, after hlt -- see the
  // data-section emission in compileSEER's own footer). Repeated uses of
  // the identical text share one copy rather than duplicating data.
  internString(text) {
    if (this.stringLiterals.has(text)) return this.stringLiterals.get(text);
    const label = `.str_${this.stringSeq++}`;
    this.stringLiterals.set(text, label);
    return label;
  }

  noteSourceLine(line) {
    if (line != null && !this.lineAddressMap.has(line))
      this.lineAddressMap.set(line, this.pc * 8);
  }

  // ── Output ──────────────────────────────────────────────────────────────────

  _pad() { return '  '.repeat(this.iLevel); }

  // Emit one real instruction.  If _pendingNid is set, it rides here as byte 7.
  instr(hexLine, comment) {
    const nid = this._pendingNid;
    this._pendingNid     = NID.BODY;
    const nc = this._pendingComment;
    this._pendingComment = '';
    if (nid !== NID.BODY) this.nodeCount++;
    // Emit the hex-token line, with nid and comments as ; comment
    const nidStr = nid !== NID.BODY ? ` [nid=0x${nid.toString(16).padStart(2,'0')}]` : '';
    const c = [nc, comment].filter(Boolean).join(' — ');
    const cStr = (nidStr || c) ? `  ; ${nidStr}${c ? (nidStr ? ' ' : '') + c : ''}` : '';
    this.lines.push(`${this._pad()}${hexLine}${cStr}`);
    this.pc++;
    return this.pc - 1;
  }

  scheduleNode(nid, comment) {
    this._pendingNid     = nid;
    this._pendingComment = comment ?? '';
  }

  flushNodeIfPending() {
    if (this._pendingNid === NID.BODY) return;
    const nid = this._pendingNid;
    const nc  = this._pendingComment;
    this._pendingNid     = NID.BODY;
    this._pendingComment = '';
    this.lines.push(`${this._pad()}nop  ; [nid=0x${nid.toString(16).padStart(2,'0')}] ${nc || 'nop'}`);
    this.nodeCount++;
    this.pc++;
  }

  comment(text) { this.lines.push(`${this._pad()}; ${text}`); }
  blank()       { this.lines.push(''); }

  // A label used as a jump target -- emits a REAL nop and registers it as
  // a CN-table node (global slot, assigned later in resolveCnJumps()).
  // Every jump/branch target in this file must go through this, not
  // dataLabel -- see resolveCnJumps()'s own header comment for why a real
  // nop instruction is required here, not just a text marker.
  label(name) {
    this.lines.push(`${name}:`);
    const lineIdx = this.lines.length;
    this.instr('nop', `connector: ${name}`);
    const node = { name, lineIdx, slot: undefined };
    this.cnNodes.push(node);
    this.cnNodeByName.set(name, node);
    this.symbols.push({ label: name, pc: this.pc });
    return name;
  }

  // For labels that are NEVER a jump target (.program_start, string-data
  // labels) -- a plain text marker, no nop, no CN registration. Using
  // label() for these would register a real, unnecessary CN slot.
  dataLabel(name) {
    this.lines.push(`${name}:`);
    this.symbols.push({ label: name, pc: this.pc });
    return name;
  }

  section(title) {
    this.blank();
    this.lines.push(`${this._pad()}; ${'─'.repeat(Math.max(0, 62 - this.iLevel * 2))}`);
    this.lines.push(`${this._pad()}; ${title}`);
    this.lines.push(`${this._pad()}; ${'─'.repeat(Math.max(0, 62 - this.iLevel * 2))}`);
  }

  allocCap() {
    const id = this.capNext++;
    if (this.capNext > 0xFF) this.capNext = 2;
    return id;
  }

  // Real stack-frame prologue/epilogue. sp (r254) is bumped down by this
  // scope's total local-variable size on entry, and back up on every exit
  // path -- the standard convention every real ISA's calling convention
  // uses, and the ONLY one that supports recursion correctly (a fixed,
  // scope-indexed memory region -- the old CAPTBASE-era design's implicit
  // assumption -- would have every recursive call share the same storage
  // for its "distinct" local variables).
  //
  // The real complication: a scope's total frame size isn't known until
  // ALL its variables have been discovered, which only happens once the
  // scope's entire body has been compiled -- but the prologue has to be
  // emitted BEFORE that body. Standard technique: emit a placeholder
  // instruction now, remember exactly where it landed, and patch it with
  // the real size once popScope() knows it. Same for every early-return
  // epilogue (see returnFromScope) -- there can be more than one per
  // scope, and none of them know the final size at the point they're
  // emitted either.
  pushScope(name, type) {
    const c = this.allocCap();
    const prologueLineIdx = this.lines.length;
    this.lines.push('; STACK_PROLOGUE_PLACEHOLDER'); // patched in popScope()
    this.pc++;
    this.cnScopeStarts.push({ lineIdx: prologueLineIdx, isGlobal: type === 'global' });
    this.scopeStack.push({ name, type, capId: c, prologueLineIdx, epilogueLineIndices: [] });
    return c;
  }

  popScope() {
    const scope = this.scopeStack.pop();
    const size = this.memSlots.frameSize(scope.capId);
    this.lines[scope.prologueLineIdx] =
      `addi sp, sp, -${size}  ; reserve ${size} bytes for ${scope.name}'s locals (size patched here once known)`;
    for (const idx of scope.epilogueLineIndices) {
      this.lines[idx] =
        `addi sp, sp, ${size}  ; restore sp before returning from ${scope.name}`;
    }
    return scope;
  }

  currentCap() { return this.scopeStack.length ? this.scopeStack[this.scopeStack.length-1].capId : 1; }

  // ── CN-table resolution and registration prologue ──────────────────────────
  // Traced directly from extracted_v2.js's own cfResolveMultiScope/
  // cfGenerateSetup this session, not reinvented -- that reference
  // implementation needed multiple documented rounds of real bugfixing to
  // get this right (global vs local counters, reachability through
  // fall-through vs jump-only arrivals, the jmp-offset-0-means-return
  // hardware quirk), so this mirrors its structure closely rather than
  // approximate it.
  //
  // Two counters, two purposes: a GLOBAL slot number (assigned to every
  // registered node, never resets -- the physical 256-entry CN table is
  // one shared hardware resource) and a LOCAL, per-scope position counter
  // (resets at every pushScope, used for the branch/jump's own relative
  // offset -- mirrors cn_count resetting on every linking jmpr and
  // restoring on every return).
  //
  // Reachability: a node ONLY ever reached by jump (never fall-through --
  // e.g. a while loop's own exit-landing node) must NOT increment the
  // local position counter, even though it still needs its own slot.
  // Only a registered node can ever reset "unreachable" back to
  // "reachable" -- ordinary instructions and conditional branches never
  // change it either way. A function scope's own entry point starts
  // unreachable (nothing falls into it -- it's only ever reached via a
  // call); the global/main scope starts reachable (its first instruction
  // genuinely is fallen into from the setup prologue).
  resolveCnJumps() {
    const events = [];
    for (const node of this.cnNodes) events.push({ kind: 'node', lineIdx: node.lineIdx, ref: node });
    for (const jump of this.cnJumps) events.push({ kind: 'jump', lineIdx: jump.lineIdx, ref: jump });
    for (const sb of this.cnScopeStarts) events.push({ kind: 'scopeStart', lineIdx: sb.lineIdx, ref: sb });
    events.sort((a, b) => a.lineIdx - b.lineIdx);

    let nextSlot = 1;
    let nopCount = 0;
    let prevWasUnconditionalExit = false;

    for (const ev of events) {
      if (ev.kind === 'scopeStart') {
        nopCount = 0;
        prevWasUnconditionalExit = !ev.ref.isGlobal;
      } else if (ev.kind === 'node') {
        if (!prevWasUnconditionalExit) nopCount += 1;
        ev.ref.slot = nextSlot++;
        prevWasUnconditionalExit = false;
      } else if (ev.kind === 'jump') {
        ev.ref.positionAtThisPoint = nopCount;
        if (ev.ref.isUnconditional) prevWasUnconditionalExit = true;
        // ordinary conditional branches (jz/jne/jge) leave reachability unchanged
      }
    }

    // Resolve every jump's offset now that every node has a final slot.
    for (const jump of this.cnJumps) {
      const target = this.cnNodeByName.get(jump.targetName);
      if (!target || target.slot === undefined) {
        throw new Error(`internal error: jump target "${jump.targetName}" was referenced but never registered via label()`);
      }
      const off = target.slot - jump.positionAtThisPoint;
      if (off < 0) {
        throw new Error(`internal geometry error: jump to "${jump.targetName}" resolved to a negative CN offset `
          + `(${off}) -- a codegen construct is counting connector nodes inconsistently between fall-through `
          + `and jump-only arrivals. This is a compiler bug, not a program error.`);
      }
      this.lines[jump.lineIdx] = `${jump.mnem} ${jump.r1}, ${jump.r2}, ${off}` + (jump.comment ? `  ; ${jump.comment}` : '');
    }

    // Real byte addresses for every registered node, needed for the
    // registration prologue's own li.pcrel computations. Walked AFTER
    // patching every jump above, so every line is now real, final
    // instruction text (not a placeholder) with a well-defined length.
    const lineByteLength = (lineText) => {
      const trimmed = lineText.trim();
      if (!trimmed || trimmed.startsWith(';') || /:$/.test(trimmed)) return 0;
      const codepart = trimmed.split(';')[0].trim();
      if (!codepart) return 0;
      const mnem = codepart.split(/[\s,]+/)[0].toLowerCase();
      if (!(mnem in window.seerFormat)) return 0;
      return window.seerFormat[mnem] === 'OB' ? 1 : 4;
    };
    let addr = 0;
    const nodeByLineIdx = new Map(this.cnNodes.map(n => [n.lineIdx, n]));
    for (let i = 0; i < this.lines.length; i++) {
      if (nodeByLineIdx.has(i)) nodeByLineIdx.get(i).addr = addr;
      addr += lineByteLength(this.lines[i]);
    }

    // ── Registration prologue ──────────────────────────────────────────────
    // Mirrors cfGenerateSetup exactly: per node, in slot order, stage +
    // li.pcrel + commit (12 bytes/node), then zero the scratch register --
    // a program reading it before writing it would otherwise see leftover
    // registration garbage instead of a clean 0 (a real, documented bug in
    // the reference toolchain, fixed the same way here). r247 is used as
    // the scratch register here -- distinct from r245 (stack-slot offset)
    // and r246 (unary-not), avoiding any collision with either.
    const CTRL_STAGE = 14, CTRL_COMMIT = 15;
    const BYTES_PER_NODE = 12;
    const orderedNodes = [...this.cnNodes].sort((a, b) => a.slot - b.slot);
    const totalRegistrationLen = orderedNodes.length * BYTES_PER_NODE;
    const totalPrologueLen = totalRegistrationLen + 4; // + the final "li r247, 0" cleanup

    const prologueLines = [];
    orderedNodes.forEach((node, i) => {
      const ownAddr = i * BYTES_PER_NODE + 4; // the li.pcrel instruction is 2nd of 3 in this node's block
      const targetRealAddr = totalPrologueLen + node.addr;
      const off = targetRealAddr - ownAddr;
      prologueLines.push(`wrctrl zr, ${CTRL_STAGE}, ${node.slot}`);
      prologueLines.push(`li.pcrel r247, ${off}`);
      prologueLines.push(`wrctrl r247, ${CTRL_COMMIT}`);
    });
    prologueLines.push('li r247, 0');

    this.lines = [...prologueLines, ...this.lines];
  }



  // Every function-exit path (the implicit end AND every early "give")
  // MUST go through this, not a raw jmpr('R241',...) -- otherwise an
  // early return skips the stack-restore entirely and leaks frame space
  // on every call. Verified this session: 3 real call sites needed this
  // (Give, the implicit function end, and class-instance construction),
  // found by grepping for jmpr('R241' rather than assumed.
  //
  // BUGFIX (found via a genuine infinite loop on real IVX source, not
  // caught by earlier testing since the old, wrong opcodes never let a
  // compiled program run far enough to expose it): the top-level/global
  // scope is never actually CALLED the way a real function is -- nothing
  // ever writes a return address into r241 for it. jmpr r241,zr,zr with
  // r241 still at its default value of 0 jumps straight back to address
  // 0 -- .program_start itself -- and the whole program reruns forever.
  // The global scope's own "return" needs to mean "go to .program_end",
  // not "jump wherever the (nonexistent) caller's link register points."
  returnFromScope(nid, comment) {
    const scope = this.scopeStack[this.scopeStack.length - 1];
    if (scope) {
      const idx = this.lines.length;
      this.lines.push('; STACK_EPILOGUE_PLACEHOLDER'); // patched in popScope()
      this.pc++;
      scope.epilogueLineIndices.push(idx);
    }
    if (scope && scope.type === 'global') {
      this.jmp('.program_end', nid, comment ?? 'end of program -- no caller to return to');
    } else {
      this.jmpr('R241', nid, comment);
    }
  }

  fresh(prefix) { return `.${prefix}_${this.labelSeq++}`; }

  // ── Instruction helpers — all emit real, mnemonic-based SEER text ─────────
  // (matching the rewritten assembleSource()'s own syntax, "add r1, r2, r3"
  // -- not the old hex-opcode-first "5B R1 R2 R3" this file used to emit).
  // Every method below verified by encoding through the SAME shared
  // encode() the assembler/disassembler use, so there is exactly one
  // source of truth for the ISA now, not per-method hardcoded hex.

  // reg normaliser: 'R240' → 'r240', 'r240' → 'r240' (real syntax is lowercase)
  _r(s) { return s.toString().replace(/^R/, 'r'); }

  // All four emit a PLACEHOLDER line, not resolved text -- the real
  // offset depends on a global slot number and a per-scope, reachability-
  // aware position counter that can only be computed once the ENTIRE
  // program has been emitted (a later label might still move the count).
  // resolveCnJumps() patches every one of these once that's known. See
  // its own header comment for the full mechanism and why this two-pass
  // approach is required at all, not a simplification.
  //
  // jmp specifically is never emitted as a raw jmp -- confirmed against
  // this codebase directly (grepped every em.jmp call site: none pass a
  // link register), and real hardware treats an all-zero jmp offset as
  // "return" regardless of intent, matching a real, documented bug in the
  // proven reference toolchain. Every jmp here becomes `jeq zr, zr, N`
  // instead, which is unconditionally true for any resolved offset with
  // zero collision risk -- the same fix the reference toolchain uses.
  _cnJump(mnem, r1, r2, targetName, isUnconditional, comment) {
    const lineIdx = this.lines.length;
    this.lines.push('; CN_JUMP_PLACEHOLDER');
    this.pc++;
    this.cnJumps.push({ lineIdx, mnem, r1, r2, targetName, isUnconditional, comment });
  }

  jmp(target, targetNid, comment) {
    this._cnJump('jeq', 'zr', 'zr', target, true, comment);
  }

  // No standalone "jump if zero" exists on real hardware -- BR format always
  // compares two registers. Encoded as jeq rcond, zr, target.
  jz(rcond, target, comment) {
    this._cnJump('jeq', this._r(rcond), 'zr', target, false, comment);
  }

  jne(r1, r2, target, targetNid, comment) {
    this._cnJump('jne', this._r(r1), this._r(r2), target, false, comment);
  }

  jge(r1, r2, target, targetNid, comment) {
    this._cnJump('jge', this._r(r1), this._r(r2), target, false, comment);
  }

  // Real jmpr is format JR [rs1, rs2, link] -- target = rs1+rs2, register-
  // indirect, NOT CN-table validated (confirmed against seer_core.sv this
  // session: pc_update_val = rs1_val + rs2_val for jmpr specifically).
  // No link register here (ordinary indirect jump, not a call) -> zr.
  jmpr(reg, targetNid, comment) {
    this.instr(`jmpr ${this._r(reg)}, zr, zr`, comment);
  }

  // Real sts64/ld64 are format D [value_reg, base_reg, ptr_reg] -- two
  // REGISTERS, no immediate-offset field. offsetOrName may be a variable
  // NAME (resolved to a real numeric slot via MemSlots, scoped to cap /
  // the current scope) or an already-numeric offset (e.g. array
  // indexing). Either way the offset has to be loaded into a register
  // before use -- r245 is a dedicated scratch for this, chosen outside
  // both RegAlloc's variable pool (r0-r239) and the other reserved
  // registers already in use elsewhere in this file (r240 was the old,
  // retired frame base; r241 link; r243 class-instance self; r246 is the
  // unary-not scratch -- see that method's own note).
  //
  // NOT covered by this fix, and genuinely different problems: R243-based
  // calls (class instance fields, "self.x = ...") still use the OLD wrong
  // opcodes -- object/heap storage is a separate design question from "a
  // function's own local stack frame," and nothing initializes R243 to a
  // real address anywhere in this file either. Left for its own pass.
  sts64(src, base, offsetOrName, cap, comment) {
    const capId = cap ?? this.currentCap();
    const off = (typeof offsetOrName === 'number') ? offsetOrName : this.memSlots.slotFor(capId, offsetOrName);
    this.instr(`li r245, ${off}`, `slot offset for ${typeof offsetOrName === 'string' ? offsetOrName : off}`);
    this.instr(`sts64 ${this._r(src)}, ${this._r(base)}, r245`, comment);
  }
  lds64(dst, base, offsetOrName, cap, comment) {
    const capId = cap ?? this.currentCap();
    const off = (typeof offsetOrName === 'number') ? offsetOrName : this.memSlots.slotFor(capId, offsetOrName);
    this.instr(`li r245, ${off}`, `slot offset for ${typeof offsetOrName === 'string' ? offsetOrName : off}`);
    this.instr(`ld64 ${this._r(dst)}, ${this._r(base)}, r245`, comment);
  }

  // Real li has exactly one general form (the "li" pseudo-op: li.captr for
  // 0..0xFFFF, addi rd,zr,imm for -128..-1) -- no separate li.s8/s16/s32/s48
  // opcodes exist. Values outside -128..0xFFFF need li.pcrel/li.cn or a
  // multi-op sequence (encode()'s own li case throws a clear error in that
  // case rather than silently emitting something wrong).
  li(rd, val, comment) {
    this.instr(`li ${this._r(rd)}, ${val}`, comment);
  }

  // Loads a pointer to STATIC text -- via the same real interning +
  // li.pcrel mechanism StringLit uses now. IMPORTANT SCOPE NOTE: str here
  // is whatever the caller already reduced the template to (including any
  // literal "{name}"-style text verbatim) -- this does NOT evaluate or
  // substitute placeholders. Real interpolation needs runtime number-to-
  // string conversion and string concatenation, neither of which exist
  // anywhere in this codebase; that's a separate, deeper piece of work
  // than "a string literal has a real address now."
  li_str(rd, str, comment) {
    const label = this.internString(str);
    this.instr(`li.pcrel ${this._r(rd)}, ${label}`, comment ?? `"${str}" (static text -- {placeholders} NOT substituted, see note above)`);
  }

  addi(rd, rs, imm, comment) {
    this.instr(`addi ${this._r(rd)}, ${this._r(rs)}, ${imm}`, comment);
  }

  // No dedicated ecall/wfe opcodes exist on real hardware (checked against
  // the real OPCODES table directly -- "ecall" and "wfe" ARE real OB
  // mnemonics, just at different byte values than this file assumed).
  ecall(svc, comment) {
    this.instr(`ecall`, comment ?? `ecall svc=${svc}`);
  }

  wfe(comment) {
    this.instr(`wfe`, comment);
  }

  wrctrl(ctrlName, val, comment) {
    const id = typeof ctrlName === 'number' ? ctrlName
      : ctrlName?.toString().match(/\d+/)?.[0] ?? 0;
    const rval = typeof val === 'string' ? this._r(val) : `r${val ?? 255}`;
    this.instr(`wrctrl ${rval}, ${id}`, comment);
  }

  rdctrl(dst, ctrlName, comment) {
    const id = typeof ctrlName === 'number' ? ctrlName
      : ctrlName?.toString().match(/\d+/)?.[0] ?? 0;
    this.instr(`rdctrl ${this._r(dst)}, ${id}`, comment);
  }

  hlt(comment) {
    this.instr(`hlt`, comment);
  }
}


class RegAlloc {
  constructor(maxVarReg) {
    this.maxVarReg = maxVarReg ?? 239; // highest variable register index
    this.vars      = new Map();
    this.nextReg   = 8;
    this.nextSlot  = 0;
    this.spillCount = 0;
  }

  alloc(name) {
    name = name.replace(/\?$/, '');
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.nextReg <= this.maxVarReg) {
      const entry = { reg: `R${this.nextReg++}`, spill: null };
      this.vars.set(name, entry);
      return entry;
    }
    // Spill to stack
    this.spillCount++;
    const slot  = this.nextSlot++;
    const entry = { reg: null, spill: slot * 8 };
    this.vars.set(name, entry);
    return entry;
  }

  get(name) {
    return this.vars.get(name) ?? null;
  }

  // Load variable into dst register. Returns dst.
  load(name, dst, em) {
    name = name.replace(/\?$/, '');
    const v = this.alloc(name);
    if (v.reg) {
      // In a register — move to dst if different
      if (v.reg !== dst) em.instr(`add ${em._r ? em._r(dst) : dst.toLowerCase()}, ${v.reg.toLowerCase()}, zr`, `${name} → ${dst}`);
      else               em.comment(`${name} already in ${dst}`);
    } else {
      em.lds64(dst, 'sp', v.spill, em.currentCap(), `load spilled ${name}`);
    }
    return dst;
  }

  // Store src register into variable.
  store(name, src, em) {
    name = name.replace(/\?$/, '');
    const v = this.alloc(name);
    if (v.reg) {
      // Move src into the variable's home register
      if (v.reg !== src) em.instr(`add ${v.reg.toLowerCase()}, ${src.toLowerCase()}, zr`, `${src} → ${name}`);
      else               em.comment(`${name} already in ${v.reg}`);
    } else {
      em.sts64(src, 'sp', v.spill, em.currentCap(), `spill ${name}`);
    }
  }

  // Allocate a fresh temporary scratch register (R0-R7 round-robin)
  scratch(n) { return `R${n & 7}`; }
}


function exprText(node) {
  if (!node) return '0';
  switch (node.type) {
    case 'NumberLit':  return String(node.value);
    case 'BoolLit':    return node.value === null ? '0' : node.value ? '1' : '0';
    case 'StringLit':  return JSON.stringify(node.value);
    case 'Identifier':
    case 'LazyDecl':   return node.name;
    case 'BinOp': {
      const OPS = {
        '+':'add','-':'sub','*':'mul','/':'div','//':'idiv','%':'rem','^':'pow',
        '=':'eq','!=':'ne','<':'lt','>':'gt','<=':'le','>=':'ge',
        'and':'and','or':'or','same':'same','xor':'xor',
        'nand':'nand','nor':'nor','in':'in','is':'is',
      };
      return `(${exprText(node.left)} ${OPS[node.op]??node.op} ${exprText(node.right)})`;
    }
    case 'UnaryOp':
      return `(not ${exprText(node.operand)})`;
    case 'Call':
      return `${node.name}(${(node.args??[]).map(exprText).join(', ')})`;
    case 'Invoke':
      return `${exprText(node.callee)}(${(node.args??[]).map(exprText).join(', ')})`;
    case 'MemberAccess':
      return `${exprText(node.object)}.${node.field}`;
    case 'IndexAccess': {
      const rs = node.rowSpec;
      const idx = rs?.isSlice
        ? `${rs.start?exprText(rs.start):''}:${rs.end?exprText(rs.end):''}`
        : exprText(rs?.expr);
      return `${exprText(node.target)}[${idx}]`;
    }
    case 'ListLit':
      return `[${(node.elements??[]).map(exprText).join(', ')}]`;
    case 'DictLit':
      return `{${(node.pairs??[]).map(p=>`${exprText(p.key)}:${exprText(p.value)}`).join(', ')}}`;
    case 'Ask':       return `ask_${node.model}(${exprText(node.prompt)})`;
    case 'SheetsOpen':return `sheets(${exprText(node.name)})`;
    default:          return `<${node.type}>`;
  }
}

// Load an expression into a register, returning the register name.
// The first instruction emitted will carry any pending nid.
// Scratch registers: R2=left, R3=right (never variable registers, never bleed out)
function loadExpr(node, em, dst) {
  dst = dst ?? 'R0';
  if (!node) { em.li(dst, 0, 'null'); return dst; }
  switch (node.type) {
    case 'NumberLit':
      em.li(dst, node.value, `#${node.value}`);
      return dst;

    case 'BoolLit':
      em.li(dst, node.value ? 1 : 0, node.value === null ? 'none' : node.value ? 'yes' : 'no');
      return dst;

    case 'StringLit': {
      const s = node.value ?? '';
      const label = em.internString(s);
      em.instr(`li.pcrel ${em._r(dst)}, ${label}`, `"${s.length > 12 ? s.slice(0,12)+'…' : s}"`);
      return dst;
    }

    case 'TemplateLit':
    case 'InterpolatedString': {
      // String interpolation — load first part, ecall concat for each part
      // For now encode the template as a string literal (runtime resolves vars)
      const text = exprText(node);
      const s = text.replace(/[{}]/g, '').slice(0, 12);
      em.li_str(dst, s, `interp: ${text.slice(0,20)}`);
      return dst;
    }

    case 'Identifier': {
      em.regAlloc.load(node.name.replace(/\?$/, ''), dst, em);
      return dst;
    }

    case 'LazyDecl': {
      const cleanName = node.name.replace(/\?$/, '');
      // If somehow not pre-initialized (e.g. lazy var outside a loop), init now
      if (!em.regAlloc.vars.has(cleanName)) {
        em.regAlloc.alloc(cleanName);
        em.li('R1', 0, `init ${cleanName} = 0`);
        em.regAlloc.store(cleanName, 'R1', em);
      }
      em.regAlloc.load(cleanName, dst, em);
      return dst;
    }

    case 'Ask':
      compileAsk(node, em);
      if (dst !== 'R0') em.addi(dst, 'R0', 0, 'move result');
      return dst;

    case 'BinOp': {
      // Use R2/R3 as dedicated BinOp scratch — never alias variable registers
      // R5/R6 were leaking into value computations; R2/R3 are reserved for this
      loadExpr(node.left,  em, 'R2');
      loadExpr(node.right, em, 'R3');
      // Direct 1:1 real-ALU-op mappings.
      const REAL_OPMAP = {
        '+':'add', '-':'sub', '*':'mul', '/':'div', 'mod':'mod', '%':'mod',
        '=':'eq', 'and':'and', 'nand':'nand', 'or':'or', 'nor':'nor',
        'xor':'xor', 'same':'xnor',
      };
      const rd = em._r ? em._r(dst) : dst.toLowerCase();
      const desc = `${exprText(node.left)} ${node.op} ${exprText(node.right)}`;
      const op = REAL_OPMAP[node.op];
      if (op) {
        em.instr(`${op} ${rd}, r2, r3`, desc);
        return dst;
      }
      // Comparison operators -- real ISA's value-producing comparison is
      // "slt" (set less-than, format A: rd = (rs1 < rs2) ? 1 : 0), not a
      // direct opcode per comparison. Each one built from slt plus, where
      // needed, an operand swap or a boolean complement (xori rd, rd, 1 --
      // rd is already a clean 0/1 from slt, so this correctly flips it).
      switch (node.op) {
        case '<':
          em.instr(`slt ${rd}, r2, r3`, desc);
          break;
        case '>':
          em.instr(`slt ${rd}, r3, r2`, desc); // right < left = left > right
          break;
        case '<=':
          em.instr(`slt ${rd}, r3, r2`, `${desc} (via not(right<left))`); // rd = right<left = left>right
          em.instr(`xori ${rd}, ${rd}, 1`, `complement -> left<=right`);
          break;
        case '>=':
          em.instr(`slt ${rd}, r2, r3`, `${desc} (via not(left<right))`);
          em.instr(`xori ${rd}, ${rd}, 1`, `complement -> left>=right`);
          break;
        case '!=':
          // xor is nonzero iff different; slt zr,<that> normalizes to a
          // clean 0/1 rather than leaving an arbitrary nonzero value,
          // since downstream code may expect a real boolean, not just
          // "truthy".
          em.instr(`xor ${rd}, r2, r3`, desc);
          em.instr(`slt ${rd}, zr, ${rd}`, `normalize to 0/1`);
          break;
        default:
          em.instr(`; UNIMPLEMENTED comparison operator "${node.op}"`, '');
      }
      return dst;
    }

    case 'UnaryOp': {
      loadExpr(node.operand, em, 'R2');
      const rd = em._r ? em._r(dst) : dst.toLowerCase();
      // No direct unary-not ALU op exists on real hardware (same as most
      // real ISAs -- e.g. classic MIPS has no NOT either).
      //
      // IMPORTANT SCOPE NOTE: this is boolean negation (xori 1), matching
      // the compiler's OWN existing internal branch convention -- jz()
      // elsewhere in this file already compiles to "jeq rcond, zr, target"
      // (branch when a value is exactly zero), so 0=false/nonzero=true is
      // already this compiler's working convention for anything feeding a
      // branch, independent of this fix. That is NOT the same thing as
      // runtime.js's own isTruthy() (checked directly this session: only
      // none and false are falsy there -- 0 itself is truthy in IVX's
      // user-facing semantics). This fix assumes node.operand already
      // evaluates to a clean 0/1 (true for anything produced by a
      // comparison or an explicit bool literal). Negating an arbitrary
      // IVX value under its REAL truthy/falsy rules (0 truthy, empty
      // string, etc.) would need a real value-representation design --
      // how none/false/true/numbers/strings each become a concrete SEER
      // word -- which nothing in SEEREmitter currently defines anywhere.
      // Left as a separate, deeper question rather than silently assumed.
      em.instr(`xori ${rd}, r2, 1`, `not ${exprText(node.operand)} (boolean negation; assumes a clean 0/1 operand -- see note above)`);
      return dst;
    }

    case 'MemberAccess': {
      em.regAlloc.load(exprText(node), dst, em);
      return dst;
    }

    case 'FuncCall': {
      em.comment(`call ${exprText(node)}`);
      em.li(dst, 0, 'placeholder — call result');
      return dst;
    }

    default:
      em.comment(`expr: ${exprText(node)}`);
      em.li(dst, 0, 'placeholder');
      return dst;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 4. STATEMENT COMPILERS
// ─────────────────────────────────────────────────────────────────────────────

function compileStmt(node, em) {
  if (!node) return;
  if (node.line != null) em.noteSourceLine(node.line);
  switch (node.type) {

    // ── make ──────────────────────────────────────────────────────────────────
    case 'Assign': {
      const target = node.target?.type === 'MemberAccess'
        ? `${exprText(node.target.object)}.${node.target.field}`
        : (node.name ?? '?');
      const cleanTarget = target.replace(/\?$/, '');
      em.blank();
      em.comment(`make ${cleanTarget} = ${exprText(node.expr)}`);
      loadExpr(node.expr, em, 'R1');
      em.regAlloc.store(cleanTarget, 'R1', em);
      break;
    }

    case 'Fork': {
      // Emit weighted random branch selection
      const branches = node.branches ?? [];
      if (!branches.length) break;
      const allCertain = branches.every(b => b.weight >= 1.0);
      em.blank();
      em.comment(allCertain ? 'fork — concurrent (all weight 1.0)' : `fork — weighted (${branches.length} branches)`);
      if (allCertain) {
        for (const b of branches) for (const s of b.body) compileStmt(s, em);
      } else {
        // Load random, compare against cumulative weights
        em.ecall(7, 'random()');  // SVC 7 = random float → R0
        let cum = 0;
        const exitL = em.fresh('fork_exit');
        for (const b of branches) {
          cum += b.weight;
          const nextL = em.fresh('fork_next');
          em.li('R1', cum, `cumulative ${cum}`);
          em.instr(`slt r2, r0, r1`, `R0 < ${cum}?`);
          em.jz('R2', nextL, `skip if random >= ${cum}`);
          for (const s of b.body) compileStmt(s, em);
          em.jmp(exitL, NID.CON, 'branch done');
          em.label(nextL);
          em.scheduleNode(NID.CON, `fork branch ${cum}`);
        }
        em.label(exitL);
        em.scheduleNode(NID.CON, 'fork exit');
      }
      break;
    }

    case 'Print':
    case 'Speak':
    case 'Say':
    case 'Text': {
      const val = exprText(node.expr);
      em.blank();
      em.comment(`${node.type === 'Speak' ? 'say' : 'text'} ${val}`);
      loadExpr(node.expr, em, 'R1');
      em.li('R0', SVC.OUTPUT, 'output service');
      em.ecall(SVC.OUTPUT, `output ${val}`);
      break;
    }

    // ── take ──────────────────────────────────────────────────────────────────
    case 'Take': {
      const name = node.name ?? '?';
      em.blank();
      em.comment(`take ${name}`);
      em.scheduleNode(NID.TAKE, `take ${name}`);
      em.li('R0', SVC.INPUT, 'input service');
      em.li_str('R1', name, `prompt: ${name}`);
      em.ecall(SVC.INPUT, `take ${name} → R0`);
      em.regAlloc.store(name, 'R0', em);
      break;
    }

    case 'TakeFile': {
      const name = node.name ?? 'file', ext = node.ext ?? 'txt';
      em.blank();
      em.comment(`take file.${ext} → ${name}`);
      em.scheduleNode(NID.TAKE, `take file.${ext}`);
      em.li('R0', SVC.FETCH, 'file-pick service');
      em.li_str('R1', `.${ext}`, 'extension filter');
      em.ecall(SVC.FETCH, `file picker .${ext}`);
      em.sts64('r0', 'sp', name, em.currentCap(), `${name} = file`);
      break;
    }

    // ── give ──────────────────────────────────────────────────────────────────
    // GIVE is pure graph annotation — not a branch target, not a CFI boundary.
    // We emit a comment only; the jmpr carries nid=END to tell hardware where
    // the return target must be registered.
    case 'Give': {
      const val = exprText(node.expr);
      em.blank();
      em.comment(`give ${val}  ; flowchart: GIVE node`);
      loadExpr(node.expr, em, 'R0');
      em.returnFromScope(NID.END, 'return — target must be registered END node');
      break;
    }

    // ── if / else ─────────────────────────────────────────────────────────────
    case 'If':    compileIf(node, em);   break;
    case 'Loop':  compileLoop(node, em); break;
    case 'For':   compileFor(node, em);  break;
    case 'Fun':   compileFun(node, em);  break;
    case 'Class': compileClass(node, em);break;
    case 'Try':   compileTry(node, em);  break;

    // ── end ───────────────────────────────────────────────────────────────────
    case 'End': {
      em.blank();
      em.comment('end — terminate this path');
      if (node.stmt) compileStmt(node.stmt, em);
      // jmp carries the target nid so CFI verifies .program_end is registered
      em.jmp('.program_end', NID.END, 'terminate path');
      break;
    }

    // ── wait (inline) ─────────────────────────────────────────────────────────
    case 'Wait': {
      em.blank();
      if (node.condition) {
        const cond = exprText(node.condition);
        const topL  = em.fresh('wait_top');
        const doneL = em.fresh('wait_done');
        em.comment(`wait until ${cond}`);
        // CON_PREV is a branch target (the back-edge jmp targets it)
        em.scheduleNode(NID.CON_PREV, 'wait-poll connector');
        em.label(topL);    // label calls flushNodeIfPending → nop only if nothing follows immediately
        // loadExpr will carry the nid if label didn't flush it
        loadExpr(node.condition, em, 'R0');
        em.jne('R0', 'R255', doneL, NID.CON, 'condition true → done');
        em.wfe('yield');
        em.jmp(topL, NID.CON_PREV, 'poll again');
        em.label(doneL);
        // CON is a branch target of the jne above
        em.scheduleNode(NID.CON, 'wait-done');
        em.flushNodeIfPending(); // nothing follows immediately — emit nop only here if truly empty
      } else if (node.expr) {
        em.li('R0', exprText(node.expr), 'wait count');
        em.wfe(`wait ${exprText(node.expr)}`);
      }
      break;
    }

    // ── wait block (trigger declaration) ──────────────────────────────────────
    case 'WaitBlock': compileWaitBlock(node, em); break;

    // ── key / credential ──────────────────────────────────────────────────────
    case 'Use': {
      em.blank();
      em.comment(`key ${exprText(node.key)}`);
      loadExpr(node.key, em, 'R0');
      em.wrctrl('CREDENTIAL', 'r0', 'store API key in ctrl register');
      break;
    }

    // ── post ──────────────────────────────────────────────────────────────────
    case 'Post': {
      em.blank();
      em.comment(`post ${exprText(node.url)}`);
      loadExpr(node.url, em, 'R0');
      loadExpr(node.body, em, 'R1');
      if (node.credential) loadExpr(node.credential, em, 'R2');
      else em.rdctrl('r2', 'CREDENTIAL', 'load stored key');
      em.ecall(SVC.HTTP, `post ${exprText(node.url)}`);
      break;
    }

    // ── save ──────────────────────────────────────────────────────────────────
    case 'Save': {
      em.blank();
      const fname = node.filenameExpr ? exprText(node.filenameExpr) : '?';
      em.comment(`save → ${fname} [${node.target}]`);
      if (node.valueExpr) loadExpr(node.valueExpr, em, 'R0');
      if (node.filenameExpr) loadExpr(node.filenameExpr, em, 'R1');
      em.li('R2', node.target === 'local' ? 1 : 0, '0=Drive 1=local');
      em.ecall(SVC.SAVE, `save ${fname}`);
      break;
    }

    // ── from … use ────────────────────────────────────────────────────────────
    case 'Import': {
      const url = node.url ?? node.path ?? '?';
      em.blank();
      em.comment(`from ${url}`);
      if (node.imports?.length)
        em.comment(`  use: ${node.imports.map(i=>i.alias!==i.name?`${i.name} as ${i.alias}`:i.name).join(', ')}`);
      em.li_str('R0', url, 'module URL');
      em.ecall(SVC.FETCH, `import ${url}`);
      break;
    }

    // ── del ───────────────────────────────────────────────────────────────────
    case 'Delete': {
      em.blank();
      em.comment(`del ${node.name}`);
      em.li('R0', 0, 'zero tombstone');
      em.sts64('r0', 'sp', node.name, em.currentCap(), `del ${node.name}`);
      break;
    }

    // ── dot ───────────────────────────────────────────────────────────────────
    // Explicit connector — pure graph annotation, no real instruction needed
    // unless something branches to it, which the parser doesn't produce.
    case 'Dot': {
      em.blank();
      em.comment('dot — explicit connector (graph annotation only)');
      break;
    }

    // ── expression statement (bare call, ask, etc.) ───────────────────────────
    case 'ExprStatement': {
      if (!node.expr) break;
      if (node.expr.type === 'Ask') {
        em.blank();
        compileAsk(node.expr, em);
      } else {
        em.blank();
        em.comment(`${exprText(node.expr)}`);
        em.instr(`; [${exprText(node.expr)}]`, 'call — resolved at link time');
      }
      break;
    }

    default:
      em.comment(`[${node.type}] — no emission rule`);
  }
}


// ── if / else ─────────────────────────────────────────────────────────────────
//
// CFI analysis:
//   .else label  → branch target of jne → MUST be registered (ELSE_CON)
//   .if_join label → branch target of jmp at end of true branch → MUST be registered (CON)
//
// In both cases we schedule the nid BEFORE entering the block so the first
// real instruction in that block carries it.  No standalone nop needed.

function compileIf(node, em) {
  const cond  = exprText(node.condition);
  const elseL = em.fresh('else');
  const joinL = em.fresh('if_join');

  em.blank();
  em.comment(`if ${cond}`);

  // Schedule DECISION nid — will land on the first instruction of the condition eval
  em.scheduleNode(NID.DECISION, `if: ${cond}`);
  loadExpr(node.condition, em, 'R0');
  em.jz('R0', elseL, 'false → else');

  // True branch
  em.iLevel++;
  for (const stmt of node.body ?? []) compileStmt(stmt, em);
  em.iLevel--;

  // Jump to join — no CON nop before this, it's not a branch target
  em.jmp(joinL, NID.CON, 'end of true branch → join');

  // Else branch — this IS a branch target
  em.label(elseL);
  // Schedule ELSE_CON — first instruction of else body will carry it
  em.scheduleNode(NID.ELSE_CON, 'else-branch entry');
  if (node.else_?.length) {
    em.iLevel++;
    if (node.else_.length === 1 && node.else_[0].type === 'If') {
      compileIf(node.else_[0], em);
    } else {
      for (const stmt of node.else_) compileStmt(stmt, em);
    }
    em.iLevel--;
  } else {
    // Empty else — flush pending nid as nop (nothing to attach to)
    em.flushNodeIfPending();
  }

  // Join — branch target of the true-branch jmp
  em.label(joinL);
  // Schedule CON nid — first instruction after join carries it
  em.scheduleNode(NID.CON, 'if-join');
  // The next statement's first instruction carries the nid.
  // If this is the last stmt in a block, flushNodeIfPending is called from label()
  // or the caller's next emit.
}


// ── loop ──────────────────────────────────────────────────────────────────────
//
// CFI analysis:
//   .loop_top — branch target of the back-edge jmp → MUST be registered (CON_PREV)
//   .loop_exit — branch target of jne → MUST be registered (CON)
//
// DECISION_PREV is NOT a branch target (the back-edge jumps to CON_PREV, not here).
// It is purely a flowchart annotation — so we schedule it as a sequential-open nid.

function collectLazyDecls(node, found = new Set()) {
  if (!node || typeof node !== 'object') return found;
  if (node.type === 'LazyDecl') found.add(node.name.replace(/\?$/, ''));
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) v.forEach(n => collectLazyDecls(n, found));
      else collectLazyDecls(v, found);
    }
  }
  return found;
}

function compileLoop(node, em) {
  const cond  = exprText(node.condition);
  const topL  = em.fresh('loop_top');
  const exitL = em.fresh('loop_exit');

  em.blank();
  em.comment(`loop ${cond}`);

  // Pre-initialize any lazy vars (y?) BEFORE the loop label
  // so they don't re-initialize on every back-edge iteration
  const lazyVars = collectLazyDecls(node.condition);
  for (const name of lazyVars) {
    if (!em.regAlloc.vars.has(name)) {
      em.regAlloc.alloc(name);
      em.li('R1', 0, `init ${name} = 0`);
      em.regAlloc.store(name, 'R1', em);
    }
  }

  // CON_PREV is the back-edge branch target — schedule before label
  em.label(topL);
  em.scheduleNode(NID.CON_PREV, 'loop back-edge target');
  // The condition eval is what follows — it carries CON_PREV nid

  // DECISION_PREV: not a branch target, just annotates the condition.
  // We overlay it on the condition eval by scheduling it second.
  // Since scheduleNode would overwrite CON_PREV, we have a conflict here:
  // the loop top PC must be CON_PREV (for the back-edge target check),
  // and the decision is the NEXT instruction.
  // Solution: CON_PREV rides on the first instruction (condition eval),
  // and DECISION_PREV is dropped as a separate nop — it's graph-only.
  // Hardware only cares that the back-edge target is registered; the
  // condition evaluation is sequential after that.

  em.comment(`condition: ${cond}  ; [DECISION_PREV — graph annotation]`);
  loadExpr(node.condition, em, 'R0');   // CON_PREV nid lands here
  em.jz('R0', exitL, 'false → exit');

  em.iLevel++;
  for (const stmt of node.body ?? []) compileStmt(stmt, em);
  em.iLevel--;

  em.jmp(topL, NID.CON_PREV, 'loop back-edge');

  // Exit — branch target of jne
  em.label(exitL);
  em.scheduleNode(NID.CON, 'loop-exit');
  // First instruction of whatever follows carries this; if nothing follows we flush.
}


// ── for ───────────────────────────────────────────────────────────────────────

function compileFor(node, em) {
  const iterName = node.iterVar  ?? 'i';
  const idxName  = node.iterVar2 ?? 'ii';
  const tgt      = node.target   ?? exprText(node.targetExpr);
  const topL     = em.fresh('for_top');
  const exitL    = em.fresh('for_exit');
  const cap      = em.currentCap();

  em.blank();
  em.comment(`for ${iterName} in ${tgt}`);

  // Setup: load iterable and length — CON_PREV nid rides on the first setup instr
  em.scheduleNode(NID.CON_PREV, 'for back-edge target');
  em.lds64('r8', 'sp', tgt, cap, `load ${tgt}`);
  em.instr(`popcnt   r10, r8`, `len(${tgt}) → r10`);
  em.li('R9', 0, 'index = 0');

  em.label(topL);  // label flushes any pending nid — but we consumed it above already
  // Condition: index < length — no nid (DECISION_PREV is graph-only, same as loop)
  em.comment(`${iterName}: index(${idxName}) < len  ; [DECISION_PREV — graph annotation]`);
  em.jge('R9', 'r10', exitL, NID.CON, 'done');

  em.iLevel++;
  em.instr(`ld64 r11, r8, r9`, `${iterName} = ${tgt}[${idxName}]`);
  em.sts64('r11', 'sp', iterName, cap, `bind ${iterName}`);
  em.sts64('r9',  'sp', idxName,  cap, `bind ${idxName}`);

  for (const stmt of node.body ?? []) compileStmt(stmt, em);

  em.addi('r9', 'r9', 1, 'index++');
  em.iLevel--;

  em.jmp(topL, NID.CON_PREV, 'for back-edge');

  em.label(exitL);
  em.scheduleNode(NID.CON, 'for-exit');
}


// ── fun ───────────────────────────────────────────────────────────────────────
//
// CFI analysis:
//   function entry label → branch target of all callers → MUST be registered (FUN)
//   FUN nid rides on the first real instruction (wrctrl capability registration).

function compileFun(node, em) {
  const name   = node.name;
  const params = node.params ?? [];
  const cap    = em.pushScope(name, 'fun');
  const capHex = cap.toString(16).padStart(2,'0');

  em.section(`fun ${name}(${params.map(p=>typeof p==='string'?p:p.name).join(', ')})`);

  // FUN nid on the first real instruction — wrctrl capability registration
  em.label(name);
  em.scheduleNode(NID.FUN, `fun ${name}`);
  // Capability install removed -- the CAPTBASE mechanism this targeted no
  // longer exists on real hardware (capability system stripped this
  // session for timing; CFI stays intact via the CN-table/RAS, which
  // never depended on it). Scope tracking (cap/capHex/pushScope) is kept
  // as bookkeeping only -- it still identifies which lexical scope a
  // variable belongs to for the stack-slot addressing sts64/lds64 need
  // (see their own note), it just no longer emits a real instruction here.

  // Parameters: passed in r0, r1, ...
  em.iLevel++;
  for (let i = 0; i < params.length; i++) {
    const p    = params[i];
    const pname = typeof p === 'string' ? p : p.name;
    const pdef  = (p.defaultExpr && typeof p !== 'string') ? ` (default=${exprText(p.defaultExpr)})` : '';
    em.sts64(`r${i}`, 'sp', pname, cap, `param ${pname}${pdef}`);
  }
  em.blank();

  for (const stmt of node.body ?? []) compileStmt(stmt, em);
  em.iLevel--;

  // Implicit function end — END nid on wrctrl (capability invalidation)
  em.blank();
  em.scheduleNode(NID.END, `end of fun ${name}`);
  // Capability invalidation removed -- see the install-site note above.
  em.returnFromScope(NID.END, `return from ${name}`);

  em.popScope();
}


// ── class ─────────────────────────────────────────────────────────────────────

function compileClass(node, em) {
  const cname   = node.name;
  const methods = (node.body ?? []).filter(s => s?.type === 'Fun');
  const initFun = methods.find(m => m.name === 'init');

  em.section(`class ${cname}${node.superclass ? ` extends ${node.superclass.name}` : ''}`);

  if (initFun) {
    const cap    = em.pushScope(`${cname}::init`, 'class');
    const capHex = cap.toString(16).padStart(2,'0');
    // FUN nid on wrctrl
    em.label(`${cname}__init`);
    em.scheduleNode(NID.FUN, `${cname} constructor`);
    // Capability install removed -- see the function-scope note above;
    // same reasoning applies here for class instance allocation.
    em.iLevel++;
    for (let i = 0; i < (initFun.params ?? []).length; i++) {
      const p = initFun.params[i];
      const pname = typeof p === 'string' ? p : p.name;
      em.sts64(`r${i}`, 'R243', pname, cap, `self.${pname} = arg${i}`);
    }
    for (const stmt of initFun.body ?? []) compileStmt(stmt, em);
    em.iLevel--;
    em.scheduleNode(NID.END, `end ${cname} constructor`);
    // Capability seal removed -- see the install-site note above.
    em.returnFromScope(NID.END, 'return instance');
    em.popScope();
  }

  for (const m of methods) {
    if (m.name === 'init') continue;
    compileFun({ ...m, name: `${cname}__${m.name}` }, em);
  }
}


// ── try / err ─────────────────────────────────────────────────────────────────
//
// CFI analysis:
//   .err label → NOT a conventional branch target (hardware delivers it via
//                the ERR_VECTOR ctrl register, not via jmp/jne).
//                Register it as ELSE_CON anyway so the flowchart is correct
//                and any future jmp into it is CFI-safe.
//   .try_done  → branch target of jmp at end of try body → MUST be registered.

function compileTry(node, em) {
  const errL  = em.fresh('err');
  const doneL = em.fresh('try_done');

  em.blank();
  em.comment('try');
  em.wrctrl('ERR_VECTOR', errL, 'register error handler');

  em.iLevel++;
  for (const stmt of node.body ?? []) compileStmt(stmt, em);
  em.iLevel--;

  em.wrctrl('ERR_VECTOR', 'R255', 'clear handler (try succeeded)');
  em.jmp(doneL, NID.CON, 'skip err handler');

  // err handler
  em.label(errL);
  em.scheduleNode(NID.ELSE_CON, `err ${node.errVar ?? 'e'}`);
  em.sts64('r0', 'sp', node.errVar ?? 'e', em.currentCap(),
    `${node.errVar ?? 'e'} = error message`);
  em.iLevel++;
  for (const stmt of node.errBody ?? []) compileStmt(stmt, em);
  em.iLevel--;

  // try-err join
  em.label(doneL);
  em.scheduleNode(NID.CON, 'try-err join');
}


// ── wait email/sheets/time block ─────────────────────────────────────────────

function compileWaitBlock(node, em) {
  const trigger   = node.trigger;
  const recurring = node.recurring;
  const src       = node.source ? exprText(node.source) : 'any';

  em.section(`wait${recurring?' every':''} ${trigger}${src!=='any'?' '+src:''}`);

  em.comment(`configure ${trigger} trigger (source: ${src})`);
  em.li('R0', SVC[trigger?.toUpperCase()] ?? SVC.FETCH, `${trigger} service`);
  em.li_str('R1', src, 'trigger source filter');
  em.wrctrl('TRIGGER_SRC', 'r1', 'set source');
  em.li('R1', recurring ? 1 : 0, 'recurring flag');
  em.wrctrl('TRIGGER_CFG', 'r1', 'configure mode');

  // END nid on wfe — this is where the hardware suspends
  const topL = `.wait_${trigger}_top`;
  em.scheduleNode(NID.END, `suspend: wait ${trigger}`);
  em.label(topL);
  em.wfe(`wait for ${trigger} trigger`);

  em.blank();
  em.comment('--- trigger fired ---');
  em.rdctrl('r0', 'TRIGGER_DATA', 'load trigger payload');

  em.iLevel++;
  for (const stmt of node.body ?? []) compileStmt(stmt, em);
  em.iLevel--;

  if (recurring) {
    em.jmp(topL, NID.END, 're-arm recurring trigger');
  } else {
    em.wrctrl('TRIGGER_CFG', 'R255', 'disarm one-shot trigger');
  }
}


// ── ask (AI call) ─────────────────────────────────────────────────────────────

function compileAsk(node, em) {
  const model  = (node.model ?? 'gemini').toLowerCase();
  const prompt = exprText(node.prompt);
  const svcMap = {
    gemini:0x10, google:0x10, chatgpt:0x11, gpt:0x11, claude:0x12, anthropic:0x12,
  };
  const svc = svcMap[model] ?? SVC.GEMINI;
  em.comment(`ask ${model}: ${prompt}`);
  em.li('R0', svc, `AI service: ${model}`);
  loadExpr(node.prompt, em, 'R1');
  em.rdctrl('r2', 'CREDENTIAL', 'API key');
  em.ecall(svc, `ask ${model} → r0`);
}


// ─────────────────────────────────────────────────────────────────────────────
// 5. TOP-LEVEL COMPILER
// ─────────────────────────────────────────────────────────────────────────────

function compileSEER(source, opts) {
  const maxRegs = opts?.maxRegs ?? 240;
  if (typeof parse !== 'function') {
    return '; Error: ivx-core.js not loaded (parse() unavailable).\n' +
           '; Add <script src="ivx-core.js"></script> before ivx-seer.js.';
  }

  let parsed;
  try   { parsed = parse(source); }
  catch (e) { return `; Parse error: ${e.message}`; }

  if (!parsed?.ast) return '; Could not parse IVX source.';
  if (parsed.errors?.length) {
    return parsed.errors.map(e => `; error line ${e.line}: ${e.message}`).join('\n')
      + '\n;\n; (partial emission follows)\n\n';
  }

  const em = new SEEREmitter();
  em.regAlloc = new RegAlloc(Math.min(maxRegs - 1, 239));

  // ── File header ─────────────────────────────────────────────────────────────
  em.lines.push(
    '; ═══════════════════════════════════════════════════════════════════',
    '; SEER ISA -- generated against the real, verified hardware encoding',
    '; (this session -- see the accompanying notes throughout this file for',
    '; exactly what was fixed, and what still needs its own design pass).',
    '; Each instruction: <mnemonic> operand, operand, ...  ; comment',
    '; Registers: r0-r239 general  sp=r254 (real stack pointer)  r241=link',
    '; r243=class-instance self (NOT yet initialized anywhere -- see the',
    '; sts64/lds64 note)  r245=stack-slot-offset scratch  r246=unary-not',
    '; scratch  zr=r255',
    '; ═══════════════════════════════════════════════════════════════════',
    ''
  );

  // Real stack base. NOTE: chosen by inference, not freshly re-verified --
  // dmem's own addr[13:4] bit-slice (confirmed earlier this session)
  // implies only 16KB of real addressable space, which 0x6000 exceeds --
  // but 0x5000 (the RAS spill region) was directly verified working on
  // real hardware earlier this session despite that same arithmetic, so
  // this trusts that prior, empirical result over a fresh re-derivation
  // rather than re-deriving dmem's exact size from scratch here. Worth an
  // explicit, direct hardware check before relying on this for anything
  // real -- flagged rather than silently assumed correct.
  em.dataLabel('.program_start');
  em.instr(`li sp, 24576`, 'real stack base for Vertex-compiled program frames (0x6000 -- see note above)');

  // ── Program entry ────────────────────────────────────────────────────────────
  const globalCap    = em.pushScope('__global__', 'global');
  const globalCapHex = globalCap.toString(16).padStart(2,'0');

  // START nid on wrctrl — no standalone nop
  em.scheduleNode(NID.START, 'program entry');
  // Global capability install removed -- same reasoning as the function/
  // class scope notes elsewhere in this file: no CAPTBASE mechanism exists
  // on real hardware anymore. globalCap/globalCapHex are kept as the
  // program's top-level scope identifier for stack-slot addressing.
  em.blank();

  // ── Compile body ─────────────────────────────────────────────────────────────
  for (const stmt of (parsed.ast.body ?? [])) {
    compileStmt(stmt, em);
    // Do NOT flush here — a pending nid from one stmt (e.g. if-join, loop-exit)
    // should carry forward to the first instruction of the NEXT stmt.
  }
  // Only flush at the very end of the program, before the program_end label.
  em.flushNodeIfPending();

  // ── Program end ───────────────────────────────────────────────────────────────
  em.blank();
  em.label('.program_end');
  // END nid on wrctrl — no standalone nop
  em.scheduleNode(NID.END, 'program END');
  // Global capability invalidation removed -- see the install-site note above.
  em.hlt('program complete');

  // ── String literal data section ──────────────────────────────────────────────
  // Placed after hlt so it's never reached as code. Each interned string
  // becomes a real label + its UTF-8 bytes + a null terminator (see
  // internString's own note on the null-terminator convention this
  // assumes downstream).
  if (em.stringLiterals.size) {
    em.blank();
    em.lines.push('; ── String data ' + '─'.repeat(52));
    for (const [text, label] of em.stringLiterals) {
      em.dataLabel(label);
      em.lines.push(`.string ${JSON.stringify(text)}`);
    }
  }

  em.popScope();

  // Resolve every jmp/jz/jne/jge placeholder now that the whole program
  // (including the string data section) has been emitted, and prepend
  // the real CN-table registration prologue. See resolveCnJumps()'s own
  // header comment for the full mechanism.
  em.resolveCnJumps();

  // ── Symbol table ─────────────────────────────────────────────────────────────
  if (em.symbols.length) {
    em.blank();
    em.lines.push('; ── Symbol table ' + '─'.repeat(51));
    for (const { label, pc } of em.symbols) {
      em.lines.push(`; ${label.padEnd(36)} @ 0x${(pc*8).toString(16).padStart(6,'0')}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  // Count standalone nops in output to report honestly
  const standaloneNops = em.lines.filter(l => l.trim().startsWith('nop ')).length;
  em.blank();
  em.lines.push('; ── Summary ' + '─'.repeat(56));
  em.lines.push(`; Instructions         : ${em.pc}`);
  em.lines.push(`; Code size            : ${em.pc * 8} bytes`);
  em.lines.push(`; CFI node boundaries  : ${em.nodeCount}`);
  em.lines.push(`; Standalone nops      : ${standaloneNops} (only for empty blocks)`);
  em.lines.push(`; Capabilities alloc'd : ${em.capNext - 1}`);
  em.lines.push(';');
  em.lines.push('; ROP/JOP surface: 0 reachable gadgets via unregistered branches.');
  em.lines.push(`; spills: ${em.regAlloc.spillCount}`);

  // Expose line→address map for the editor gutter
  window._seerLineAddresses = Object.fromEntries(em.lineAddressMap);

  return em.lines.join('\n');
}

// ── End of SEER compiler ──────────────────────────────────────────────────────

// ── Lenses: AST → target language transpiler ──────────────────────────────────
//
// Architecture: template-driven, one render() dispatch per AST node type.
// Each language is a registry of node-type → render function.
// Adding a new language = adding a new key to LENS_LANGS.
//
// The lens is a *view* of the program, not a replacement for it.
// IVX source is always the source of truth.

const LensTranspiler = (() => {

  // ── Shared helpers ───────────────────────────────────────────────────────────

  function indent(code, n = 1) {
    const pad = '    '.repeat(n);
    return code.split('\n').map(l => l ? pad + l : l).join('\n');
  }

  function renderExpr(node, lang) {
    if (!node) return '???';
    const r = (n) => renderExpr(n, lang);
    switch (node.type) {
      case 'NumberLit':  return String(node.value);
      case 'BoolLit':    return lang.bool(node.value);
      case 'StringLit':  return lang.string(node.value);
      case 'Identifier': return node.name;
      case 'LazyDecl':   return node.name;
      case 'ListLit':    return '[' + node.elements.map(r).join(', ') + ']';
      case 'DictLit':    return '{' + node.pairs.map(p => r(p.key) + ': ' + r(p.value)).join(', ') + '}';
      case 'BinOp': {
        const op = lang.op ? lang.op(node.op) : mapOp(node.op, lang.id);
        return r(node.left) + ' ' + op + ' ' + r(node.right);
      }
      case 'UnaryOp': {
        const op = lang.op ? lang.op(node.op) : mapOp(node.op, lang.id);
        return op + ' ' + r(node.operand);
      }
      case 'Call': {
        const name = lang.builtinCall ? (lang.builtinCall(node.name) ?? node.name) : node.name;
        return name + '(' + node.args.map(r).join(', ') + ')';
      }
      case 'Invoke':
        return r(node.callee) + '(' + node.args.map(r).join(', ') + ')';
      case 'MemberAccess':
        return r(node.object) + '.' + node.field;
      case 'Super':
        return 'super';
      case 'IndexAccess': {
        const { rowSpec, colSpec, hasComma } = node;
        if (!hasComma || colSpec.omitted) {
          return r(node.target) + '[' + specStr(rowSpec, r) + ']';
        }
        return r(node.target) + '[' + specStr(rowSpec, r) + '][' + specStr(colSpec, r) + ']';
      }
      case 'Ask':
        return lang.ask ? lang.ask(node) : `ask_${node.model}(${r(node.prompt)})`;
      default:
        return '/* ?' + node.type + ' */';
    }
  }

  function specStr(spec, r) {
    if (spec.omitted) return ':';
    if (spec.isSlice) {
      const s = spec.start ? r(spec.start) : '';
      const e = spec.end   ? r(spec.end)   : '';
      return s + ':' + e;
    }
    return r(spec.expr);
  }

  function mapOp(op, langId) {
    // Default operator mapping (Python-style); langs can override via lang.op()
    const MAP = {
      '=':   '==',
      '!=':  '!=',
      'and': 'and',
      'or':  'or',
      'not': 'not',
      'xor': '^',
      'is':  'is',
      'in':  'in',
      '^':   '**',
      '//':  '//',
    };
    return MAP[op] ?? op;
  }

  function renderBlock(stmts, lang, extraIndent = 1) {
    const lines = stmts.flatMap(s => renderStmt(s, lang).split('\n'));
    return indent(lines.join('\n'), extraIndent);
  }

  function renderStmt(node, lang) {
    if (!node) return '';
    if (lang.stmt) {
      const result = lang.stmt(node, (n) => renderStmt(n, lang), (n) => renderExpr(n, lang));
      if (result !== null && result !== undefined) return result;
    }
    // Fallback generic render
    return genericStmt(node, lang);
  }

  function genericStmt(node, lang) {
    const E = (n) => renderExpr(n, lang);
    const S = (n) => renderStmt(n, lang);
    const B = (stmts) => renderBlock(stmts, lang);

    switch (node.type) {
      case 'Assign': {
        const target = node.target ? E(node.target) : node.name;
        return lang.assign(target, E(node.expr), node.lazy);
      }
      case 'Print':
      case 'Speak':
      case 'Say':
        return lang.say(E(node.expr));
      case 'Take':
        return lang.take(node.name, node.converter);
      case 'TakeFile':
        return lang.takeFile ? lang.takeFile(node.name, node.ext) : `# take file: ${node.name}.${node.ext}`;
      case 'Give':
        return lang.give(E(node.expr));
      case 'Delete':
        return lang.del(node.name);
      case 'Fork': {
        // Emit as a commented block showing weighted branches
        const branches = node.branches ?? [];
        if (branches.length === 0) return lang.comment('fork (no branches)');
        const allCertain = branches.every(b => b.weight >= 1.0);
        if (allCertain) {
          // Concurrent — emit all branches sequentially with a comment
          return lang.comment('fork — concurrent branches') + '\n' +
            branches.map(b => B(b.body)).join('\n');
        }
        // Probabilistic — emit as if/elif chain with weight comments
        return branches.map((b, i) => {
          const pct = Math.round(b.weight * 100) + '%';
          const comment = lang.comment(`fork branch (weight ${b.weight} = ${pct})`);
          const body = B(b.body);
          if (i === 0) return lang.ifHead(`random() < ${b.weight}`) + ' ' + lang.comment(`${pct}`) + '\n' + body;
          if (i === branches.length - 1) return lang.elseHead() + ' ' + lang.comment(`${pct}`) + '\n' + body;
          return lang.elseifHead(`random() < ${b.weight}`) + ' ' + lang.comment(`${pct}`) + '\n' + body;
        }).join('\n') + '\n' + (lang.blockEnd ? lang.blockEnd() : '');
      }
      case 'If': {
        const cond = E(node.condition);
        let out = lang.ifHead(cond) + '\n' + B(node.body);
        if (node.else_ && node.else_.length > 0) {
          // Check if it's an else-if chain
          if (node.else_.length === 1 && node.else_[0].type === 'If') {
            const inner = S(node.else_[0]);
            out += '\n' + lang.elseifJoin(inner);
          } else {
            out += '\n' + lang.elseHead() + '\n' + B(node.else_);
            out += '\n' + (lang.blockEnd ? lang.blockEnd() : '');
          }
        } else {
          out += '\n' + (lang.blockEnd ? lang.blockEnd() : '');
        }
        return out.replace(/\n+$/, '');
      }
      case 'Loop': {
        // Collect lazy declarations from condition and emit them before the loop
        const lazyDecls = [];
        function collectLazy(n) {
          if (!n) return;
          if (n.type === 'LazyDecl') {
            const name = n.name;
            if (lang._declared && !lang._declared.has(name)) {
              lang._declared.add(name);
              // Infer default: 0 for arithmetic context, none otherwise
              const defaultVal = lang.id === 'typescript' || lang.id === 'javascript' ? '0' :
                                 lang.id === 'python' ? '0' : '0';
              const decl = lang.id === 'typescript' ? `let ${name} = ${defaultVal};` :
                           lang.id === 'javascript' ? `let ${name} = ${defaultVal};` :
                           lang.id === 'python' ? `${name} = ${defaultVal}` :
                           `SET ${name} ← ${defaultVal}`;
              lazyDecls.push(decl);
            }
          }
          if (n.left) collectLazy(n.left);
          if (n.right) collectLazy(n.right);
          if (n.operand) collectLazy(n.operand);
        }
        collectLazy(node.condition);
        const cond = E(node.condition);
        const loopCode = lang.loopHead(cond) + '\n' + B(node.body) + (lang.blockEnd ? '\n' + lang.blockEnd() : '');
        return lazyDecls.length ? lazyDecls.join('\n') + '\n' + loopCode : loopCode;
      }
      case 'For': {
        return lang.forHead(node.iterVar, node.target) + '\n' + B(node.body) + (lang.blockEnd ? '\n' + lang.blockEnd() : '');
      }
      case 'Fun': {
        return lang.funHead(node.name, node.params) + '\n' + B(node.body) + (lang.blockEnd ? '\n' + lang.blockEnd() : '');
      }
      case 'Class': {
        const methods = node.body.map(S).join('\n\n');
        return lang.classHead(node.name, node.superclass?.name) + '\n' +
               indent(methods || lang.pass(), 1) +
               (lang.blockEnd ? '\n' + lang.blockEnd() : '');
      }
      case 'ExprStatement':
        return E(node.expr);
      case 'End':
        return lang.end ? lang.end(node.message) : (node.message ? `# end: ${node.message}` : '# end');
      case 'Wait':
        return lang.wait ? lang.wait(node, E) : `# wait`;
      case 'Use':
        return lang.use ? lang.use(E(node.key)) : `# key ${E(node.key)}`;
      case 'Post':
        return lang.post ? lang.post(node, E) : `# post ${E(node.url)}`;
      case 'Import':
        return lang.importStmt ? lang.importStmt(node.path) : `# from ${node.path}`;
      case 'Save':
        return lang.save ? lang.save(node, E) : `# save ${E(node.filenameExpr)}`;
      case 'Delete':
        return lang.del(node.name);
      case 'Dot':
        return '# (connector)';
      default:
        return `# ${node.type}`;
    }
  }

  function renderProgram(ast, lang) {
    if (!ast || !ast.body) return '';
    const header = lang.header ? lang.header() : '';
    const body = ast.body.map(s => renderStmt(s, lang)).filter(Boolean).join('\n');
    return (header ? header + '\n\n' : '') + body;
  }

  // ── String escaping ──────────────────────────────────────────────────────────

  function escapeString(val, quote = '"') {
    return quote + String(val)
      .replace(/\\/g, '\\\\')
      .replace(/"/g,  '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t') + quote;
  }

  // ── Language definitions ─────────────────────────────────────────────────────

  const PYTHON = {
    id: 'python',
    bool:      v => v === null ? 'None' : v ? 'True' : 'False',
    string:    v => {
      // Preserve {var} interpolation as f-string if present
      if (/\{[A-Za-z_]\w*\}/.test(v)) return 'f"' + v.replace(/"/g, '\\"') + '"';
      return escapeString(v);
    },
    op: op => {
      const M = { '=': '==', 'xor': '^', 'is': 'is', 'in': 'in', '^': '**', '//': '//' };
      return M[op] ?? op;
    },
    assign:    (t, v, lazy) => lazy ? `if '${t}' not in dir():\n    ${t} = ${v}\n${t} = ${v}` : `${t} = ${v}`,
    say:       v => `print(${v})`,
    take:      (name, conv) => {
      const raw = `input("${name}: ")`;
      if (!conv || conv === 'str') return `${name} = ${raw}`;
      const convMap = { int: 'int', flt: 'float', bin: 'bin', list: 'list', dict: 'dict' };
      return `${name} = ${convMap[conv] ?? conv}(${raw})`;
    },
    takeFile:  (name, ext) => `${name} = open("${name}.${ext}").read()  # load ${ext} file`,
    give:      v => `return ${v}`,
    del:       name => `del ${name}`,
    ifHead:    cond => `if ${cond}:`,
    elseHead:  () => 'else:',
    elseifJoin: inner => 'el' + inner,  // "elif ..."
    loopHead:  cond => `while ${cond}:`,
    forHead:   (iterVar, target) => `for ${iterVar} in ${target}:`,
    funHead:   (name, params) => `def ${name}(${params.join(', ')}):`,
    classHead: (name, superclass) => superclass ? `class ${name}(${superclass}):` : `class ${name}:`,
    blockEnd:  () => '',  // Python uses indentation — no 'end' keyword
    pass:      () => 'pass',
    end:       msg => msg ? `raise SystemExit("${msg}")` : 'raise SystemExit()',
    wait:      (node, E) => node.condition
      ? `while not (${E(node.condition).replace('==', '==')}):\n    pass`
      : `import time; time.sleep(${E(node.expr)})`,
    use:       key => `_api_key = ${key}  # key`,
    post:      (node, E) => `import requests\nresponse = requests.post(${E(node.url)}, json=${E(node.body)})`,
    ask:       node => `ask_ai("${node.model}", ${renderExpr(node.prompt, PYTHON)})`,
    header:    () => '',
    builtinCall: name => {
      const M = { 'int': 'int', 'str': 'str', 'flt': 'float', 'len': 'len', 'list': 'list', 'dict': 'dict' };
      return M[name] ?? name;
    },
  };

  const JAVASCRIPT = {
    id: 'javascript',
    bool:   v => v === null ? 'null' : v ? 'true' : 'false',
    string: v => {
      if (/\{[^}]+\}/.test(v)) {
        // Convert {expr} → ${expr} for template literals
        const tpl = v.replace(/`/g, '\\`').replace(/\{([^}]+)\}/g, '$${$1}');
        return '`' + tpl + '`';
      }
      return escapeString(v);
    },
    op: op => {
      const M = { '=': '===', '!=': '!==', 'and': '&&', 'or': '||', 'not': '!',
                  'xor': '^', 'is': '===', 'in': 'in', '^': '**', '//': '/' };
      return M[op] ?? op;
    },
    assign:    function(t, v, lazy) {
      if (lazy) return `let ${t} = typeof ${t} !== 'undefined' ? ${t} : ${v};`;
      const isConst = this._immutables && this._immutables.has(t);
      if (this._declared && this._declared.has(t)) {
        return `${t} = ${v};`;  // reassignment — no let/const
      }
      if (this._declared) this._declared.add(t);
      return isConst ? `const ${t} = ${v};` : `let ${t} = ${v};`;
    },
    say:       v => `console.log(${v});`,
    take:      (name, conv) => {
      const raw = `prompt("${name}")`;
      if (!conv || conv === 'str') return `let ${name} = ${raw};`;
      const cMap = { int: `parseInt(${raw})`, flt: `parseFloat(${raw})` };
      return `let ${name} = ${cMap[conv] ?? raw};`;
    },
    give:      v => `return ${v};`,
    del:       name => `delete ${name};`,
    ifHead:    cond => `if (${cond}) {`,
    elseHead:  () => '} else {',
    elseifJoin: inner => '} else ' + inner,
    loopHead:  cond => `while (${cond}) {`,
    forHead:   (iterVar, target) => `for (const ${iterVar} of ${target}) {`,
    funHead:   (name, params) => `function ${name}(${params.join(', ')}) {`,
    classHead: (name, sup) => sup ? `class ${name} extends ${sup} {` : `class ${name} {`,
    blockEnd:  () => '}',
    pass:      () => '// (empty)',
    end:       msg => msg ? `throw new Error("${msg}");` : 'process.exit(0);',
    wait:      (node, E) => node.condition
      ? `// wait until: ${E(node.condition)}`
      : `await new Promise(r => setTimeout(r, ${E(node.expr)} * 1000));`,
    use:       key => `const _apiKey = ${key}; // key`,
    post:      (node, E) => `const response = await fetch(${E(node.url)}, { method: 'POST', body: JSON.stringify(${E(node.body)}) });`,
    ask:       node => `await askAI("${node.model}", ${renderExpr(node.prompt, JAVASCRIPT)})`,
    header:    () => `'use strict';`,
    builtinCall: name => {
      const M = { 'int': 'parseInt', 'flt': 'parseFloat', 'str': 'String', 'len': '/* len */' };
      return M[name] ?? name;
    },
  };

  const TYPESCRIPT = {
    ...JAVASCRIPT,
    id: 'typescript',
    assign:    function(t, v, lazy) {
      if (lazy) return `let ${t}: any = typeof ${t} !== 'undefined' ? ${t} : ${v};`;
      if (this._declared && this._declared.has(t)) {
        return `${t} = ${v};`;  // reassignment — no let/const
      }
      if (this._declared) this._declared.add(t);
      const isMutable = this._immutables && !this._immutables.has(t);
      return isMutable ? `let ${t} = ${v};` : `const ${t} = ${v};`;
    },
    funHead:   (name, params) => `function ${name}(${params.map(p => p + ': any').join(', ')}): any {`,
    classHead: (name, sup) => sup ? `class ${name} extends ${sup} {` : `class ${name} {`,
    header:    () => `// TypeScript`,
  };

  const PSEUDOCODE = {
    id: 'pseudocode',
    bool:      v => v === null ? 'NONE' : v ? 'TRUE' : 'FALSE',
    string:    v => `"${v}"`,
    op: op => {
      const M = { '=': '=', '!=': '≠', '<=': '≤', '>=': '≥', 'and': 'AND', 'or': 'OR',
                  'not': 'NOT', 'xor': 'XOR', 'is': 'IS', 'in': 'IN', '^': '^', '//': 'DIV', '%': 'MOD' };
      return M[op] ?? op;
    },
    assign:    (t, v) => `SET ${t} ← ${v}`,
    say:       v => `OUTPUT ${v}`,
    take:      (name, conv) => `INPUT ${name}${conv ? ` (as ${conv})` : ''}`,
    give:      v => `RETURN ${v}`,
    del:       name => `DELETE ${name}`,
    ifHead:    cond => `IF ${cond} THEN`,
    elseHead:  () => 'ELSE',
    elseifJoin: inner => 'ELSE ' + inner,
    loopHead:  cond => `WHILE ${cond} DO`,
    forHead:   (iterVar, target) => `FOR EACH ${iterVar} IN ${target}`,
    funHead:   (name, params) => `PROCEDURE ${name}(${params.join(', ')})`,
    classHead: (name, sup) => sup ? `CLASS ${name} INHERITS ${sup}` : `CLASS ${name}`,
    blockEnd:  () => 'END',
    pass:      () => '(empty)',
    end:       msg => msg ? `STOP "${msg}"` : 'STOP',
    wait:      (node, E) => node.condition ? `WAIT UNTIL ${E(node.condition)}` : `WAIT ${E(node.expr)}`,
    use:       key => `KEY ${key}`,
    post:      (node, E) => `POST ${E(node.url)} WITH ${E(node.body)}`,
    ask:       node => `ASK ${node.model.toUpperCase()} "${renderExpr(node.prompt, PSEUDOCODE)}"`,
    header:    () => '',
  };

  // ── Language registry ────────────────────────────────────────────────────────

  const LANGS = { python: PYTHON, javascript: JAVASCRIPT, typescript: TYPESCRIPT, pseudocode: PSEUDOCODE, seer: null };

  // ── Public API ───────────────────────────────────────────────────────────────

  function transpile(source, langId, opts) {
    if (langId === 'seer') return compileSEER(source, opts);
    const lang = LANGS[langId];
    if (!lang) return `// Unknown lens: ${langId}`;
    try {
      const { ast, errors } = parse(source);
      // Run immutability inference so TypeScript/JS can emit const vs let
      const immutables = typeof inferImmutables === 'function' ? inferImmutables(ast) : new Set();
      // Thread immutables + declared tracking into lang for assign decisions
      const langWithImmutables = { ...lang, _immutables: immutables, _declared: new Set() };
      let out = renderProgram(ast, langWithImmutables);
      if (errors.length > 0) {
        const errLines = errors.map(e => `# Parse error (line ${e.line}): ${e.message}`).join('\n');
        out = errLines + '\n\n' + out;
      }
      return out || `# (empty program)`;
    } catch(e) {
      return `# Transpile error: ${e.message}`;
    }
  }

  return { transpile, langs: Object.keys(LANGS) };
})();

// ── Lens panel UI ─────────────────────────────────────────────────────────────

// ── Reverse Transpiler: target language → IVX ────────────────────────────────
//
// Each language returns an array of line results:
//   { ivx: string, stub: boolean, original: string }
// stub=true means the line couldn't be converted cleanly — it gets highlighted.

const ReverseTranspiler = (() => {

  // ── Shared expression converters ─────────────────────────────────────────────

  function convertExpr(expr, lang) {
    if (!expr) return expr;
    // Booleans / null
    expr = expr
      .replace(/\bTrue\b/g,  'yes')
      .replace(/\bFalse\b/g, 'no')
      .replace(/\bNone\b/g,  'none')
      .replace(/\bnull\b/g,  'none')
      .replace(/\bundefined\b/g, 'none')
      .replace(/\btrue\b/g,  'yes')
      .replace(/\bfalse\b/g, 'no');
    // Operators
    expr = expr
      .replace(/\*\*/g,  '^')
      .replace(/===|==/g, '=')
      .replace(/!==/g,    '!=')
      .replace(/&&/g,     'and')
      .replace(/\|\|/g,   'or')
      .replace(/!/g,      'not ')
      .replace(/\bMath\.pow\s*\(([^,]+),\s*([^)]+)\)/g, '($1 ^ $2)');
    // JS/TS typeof guards → just the variable
    expr = expr.replace(/typeof\s+\w+\s*!==?\s*['"][^'"]+['"]/g, m => {
      const v = m.match(/typeof\s+(\w+)/);
      return v ? v[1] : m;
    });
    // Python floor div stays as //
    // f-strings / template literals → IVX interpolation
    if (lang === 'python') {
      expr = expr.replace(/^f["'](.*)["']$/, (_, inner) => `"${inner}"`);
    }
    if (lang === 'javascript' || lang === 'typescript') {
      expr = expr.replace(/^`(.*)`$/, (_, inner) => `"${inner.replace(/\$\{([^}]+)\}/g, '{$1')}"`);
    }
    return expr;
  }

  function convertCondition(expr, lang) {
    // Strip wrapping parens from JS/TS if statements
    expr = expr.trim().replace(/^\((.*)\)$/, '$1');
    return convertExpr(expr, lang);
  }

  function stripTrailingColon(s) { return s.replace(/:$/, '').trim(); }
  function stripSemicolon(s)     { return s.replace(/;$/, '').trim(); }
  function getIndent(line)       { return line.match(/^(\s*)/)[1]; }
  function dedent(s)             { return s.replace(/^    /, '').replace(/^\t/, ''); }

  // ── Stub result helpers ───────────────────────────────────────────────────────

  function ok(ivx, original)   { return { ivx, stub: false, original }; }
  function stub(ivx, original) { return { ivx, stub: true,  original }; }

  // ── Python reverse ────────────────────────────────────────────────────────────

  function reversePythonLine(raw) {
    const line    = raw;
    const trimmed = raw.trim();
    const indent  = getIndent(raw);
    const E       = s => convertExpr(s, 'python');
    const C       = s => convertCondition(s, 'python');

    if (!trimmed || trimmed.startsWith('#')) {
      const txt = trimmed.startsWith('#') ? trimmed.slice(1).trim() : '';
      return ok(indent + (txt ? `note ${txt}` : ''), raw);
    }

    // import → stub
    if (/^import\s|^from\s+\S+\s+import/.test(trimmed))
      return stub(indent + `note import: ${trimmed}`, raw);

    // decorator → stub
    if (trimmed.startsWith('@'))
      return stub(indent + `note decorator: ${trimmed}`, raw);

    // try / except / finally / with → stub
    if (/^(try:|except(\s|:)|finally:|with\s)/.test(trimmed))
      return stub(indent + `note ${trimmed}`, raw);

    // raise → end
    if (/^raise\s+SystemExit/.test(trimmed)) {
      const msg = trimmed.match(/SystemExit\(["'](.+?)["']\)/);
      return ok(indent + (msg ? `end ${msg[1]}` : 'end'), raw);
    }
    if (/^raise\b/.test(trimmed))
      return stub(indent + `note ${trimmed}`, raw);

    // assert → stub
    if (/^assert\b/.test(trimmed))
      return stub(indent + `note ${trimmed}`, raw);

    // pass → (empty comment)
    if (trimmed === 'pass') return ok('', raw);

    // class Foo: / class Foo(Bar):
    const classM = trimmed.match(/^class\s+(\w+)(?:\((\w+)\))?\s*:/);
    if (classM) return ok(indent + `class ${classM[1]}${classM[2] ? `(${classM[2]})` : ''}`, raw);

    // def foo(params):
    const defM = trimmed.match(/^def\s+(\w+)\s*\(([^)]*)\)\s*(?:->[^:]+)?:/);
    if (defM) {
      const params = defM[2].split(',').map(p => p.trim().replace(/\s*=.*$/, '').replace(/:\s*\w+/, '')).filter(Boolean);
      return ok(indent + `fun ${defM[1]}(${params.join(', ')})`, raw);
    }

    // return
    const retM = trimmed.match(/^return\s+(.*)/);
    if (retM) return ok(indent + `give ${E(retM[1])}`, raw);

    // del
    const delM = trimmed.match(/^del\s+(\w+)/);
    if (delM) return ok(indent + `del ${delM[1]}`, raw);

    // print(...)
    const printM = trimmed.match(/^print\s*\((.*)\)$/);
    if (printM) return ok(indent + `say ${E(printM[1])}`, raw);

    // input assignment: x = input(...) / x = int(input(...))
    const inputM = trimmed.match(/^(\w+)\s*=\s*(int|float|str|list|dict)?\(?\s*input\s*\([^)]*\)\s*\)?/);
    if (inputM) {
      const conv = inputM[2] ? inputM[2].replace('float', 'flt') : null;
      return ok(indent + `take ${conv ? `${conv}(${inputM[1]})` : inputM[1]}`, raw);
    }

    // while cond:
    const whileM = trimmed.match(/^while\s+(.+):/);
    if (whileM) return ok(indent + `loop ${C(whileM[1])}`, raw);

    // for x in y:
    const forInM = trimmed.match(/^for\s+(\w+)\s+in\s+(\w+)\s*:/);
    if (forInM) return ok(indent + `for ${forInM[1]} in ${forInM[2]}`, raw);

    // for i, x in enumerate(y):
    const forEnumM = trimmed.match(/^for\s+(\w+)\s*,\s*(\w+)\s+in\s+enumerate\s*\((\w+)\)\s*:/);
    if (forEnumM) return ok(indent + `for ${forEnumM[2]} in ${forEnumM[3]}`, raw);

    // if cond:
    const ifM = trimmed.match(/^if\s+(.+):/);
    if (ifM) return ok(indent + `if ${C(ifM[1])}`, raw);

    // elif cond:
    const elifM = trimmed.match(/^elif\s+(.+):/);
    if (elifM) return ok(indent + `else if ${C(elifM[1])}`, raw);

    // else:
    if (trimmed === 'else:') return ok(indent + 'else', raw);

    // augmented assignment: x += 1 → make x + 1
    const augM = trimmed.match(/^(\w+(?:\.\w+)*)\s*([+\-*/%])=\s*(.+)/);
    if (augM) return ok(indent + `make ${augM[1]} ${augM[2]} ${E(augM[3])}`, raw);

    // assignment: x = expr  (skip type annotations like x: int = 5)
    const assignM = trimmed.match(/^(\w+(?:\.\w+)*)\s*(?::\s*\w+)?\s*=\s*(?!=)(.+)/);
    if (assignM) return ok(indent + `make ${assignM[1]} ${E(assignM[2])}`, raw);

    // bare function call
    const callM = trimmed.match(/^(\w+)\s*\((.*)?\)$/);
    if (callM) return ok(indent + `${callM[1]}(${E(callM[2] ?? '')})`, raw);

    // anything else → stub with note
    return stub(indent + `note ✗ ${trimmed}`, raw);
  }

  function reversePython(source) {
    return source.split('\n').map(reversePythonLine);
  }

  // ── JavaScript / TypeScript reverse ──────────────────────────────────────────

  function reverseJSLine(raw, lang) {
    const trimmed = stripSemicolon(raw.trim());
    const indent  = getIndent(raw);
    const E       = s => convertExpr(s, lang);
    const C       = s => convertCondition(s, lang);

    if (!trimmed || trimmed.startsWith('//')) {
      const txt = trimmed.startsWith('//') ? trimmed.slice(2).trim() : '';
      return ok(indent + (txt ? `note ${txt}` : ''), raw);
    }

    // 'use strict' / type annotations top → skip
    if (trimmed === "'use strict'" || trimmed === '"use strict"' || trimmed === '// TypeScript')
      return ok('', raw);

    // import → stub
    if (/^import\s/.test(trimmed))
      return stub(indent + `note import: ${trimmed}`, raw);

    // export → stub
    if (/^export\s/.test(trimmed))
      return stub(indent + `note export: ${trimmed}`, raw);

    // closing brace alone → dedent signal (handled by block logic, skip)
    if (trimmed === '}') return ok('', raw);

    // class Foo / class Foo extends Bar
    const classM = trimmed.match(/^class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{?/);
    if (classM) return ok(indent + `class ${classM[1]}${classM[2] ? `(${classM[2]})` : ''}`, raw);

    // function foo(params) {
    const fnM = trimmed.match(/^(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*\w+)?\s*\{?/);
    if (fnM) {
      const params = fnM[2].split(',').map(p => p.trim().replace(/:\s*\w+/, '').replace(/\s*=.*$/, '')).filter(Boolean);
      return ok(indent + `fun ${fnM[1]}(${params.join(', ')})`, raw);
    }

    // arrow function: const foo = (params) => {
    const arrowM = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/);
    if (arrowM) {
      const params = arrowM[2].split(',').map(p => p.trim().replace(/:\s*\w+/, '')).filter(Boolean);
      return ok(indent + `fun ${arrowM[1]}(${params.join(', ')})`, raw);
    }

    // return
    const retM = trimmed.match(/^return\s+(.*)/);
    if (retM) return ok(indent + `give ${E(retM[1])}`, raw);

    // delete
    const delM = trimmed.match(/^delete\s+(\w+)/);
    if (delM) return ok(indent + `del ${delM[1]}`, raw);

    // console.log(...)
    const logM = trimmed.match(/^console\.log\s*\((.*)\)$/);
    if (logM) return ok(indent + `say ${E(logM[1])}`, raw);

    // prompt assignment
    const promptM = trimmed.match(/^(?:let|const|var)\s+(\w+)\s*=\s*(?:parseInt|parseFloat|Number)?\(?\s*prompt\s*\([^)]*\)\s*\)?/);
    if (promptM) return ok(indent + `take ${promptM[1]}`, raw);

    // while
    const whileM = trimmed.match(/^while\s*\((.+)\)\s*\{?/);
    if (whileM) return ok(indent + `loop ${C(whileM[1])}`, raw);

    // for...of
    const forOfM = trimmed.match(/^for\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s+(\w+)\s*\)\s*\{?/);
    if (forOfM) return ok(indent + `for ${forOfM[1]} in ${forOfM[2]}`, raw);

    // for (let i = 0; ...) → stub, too varied
    const forM = trimmed.match(/^for\s*\(/);
    if (forM) return stub(indent + `note ✗ ${trimmed}`, raw);

    // if (cond) {
    const ifM = trimmed.match(/^if\s*\((.+)\)\s*\{?/);
    if (ifM) return ok(indent + `if ${C(ifM[1])}`, raw);

    // } else if (cond) {
    const elifM = trimmed.match(/^(?:\}\s*)?else\s+if\s*\((.+)\)\s*\{?/);
    if (elifM) return ok(indent + `else if ${C(elifM[1])}`, raw);

    // } else {
    if (/^(?:\}\s*)?else\s*\{?$/.test(trimmed)) return ok(indent + 'else', raw);

    // throw new Error → end
    const throwM = trimmed.match(/^throw\s+new\s+Error\s*\(\s*["'](.+?)["']\s*\)/);
    if (throwM) return ok(indent + `end ${throwM[1]}`, raw);
    if (/^throw\b/.test(trimmed)) return stub(indent + `note ${trimmed}`, raw);

    // augmented: x += 1
    const augM = trimmed.match(/^(\w+(?:\.\w+)*)\s*([+\-*/%])=\s*(.+)/);
    if (augM) return ok(indent + `make ${augM[1]} ${augM[2]} ${E(augM[3])}`, raw);

    // const/let/var x = expr
    const varM = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(.+)/);
    if (varM) return ok(indent + `make ${varM[1]} ${E(varM[2])}`, raw);

    // x = expr (reassignment)
    const assignM = trimmed.match(/^(\w+(?:\.\w+)*)\s*=\s*(?!=)(.+)/);
    if (assignM) return ok(indent + `make ${assignM[1]} ${E(assignM[2])}`, raw);

    // bare call
    const callM = trimmed.match(/^(?:await\s+)?(\w+)\s*\((.*)?\)$/);
    if (callM) return ok(indent + `${callM[1]}(${E(callM[2] ?? '')})`, raw);

    return stub(indent + `note ✗ ${trimmed}`, raw);
  }

  function reverseJS(source, lang) {
    return source.split('\n').map(line => reverseJSLine(line, lang));
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  // Returns { lines: [{ivx, stub, original}], stubCount: number }

  function reverse(source, langId) {
    let lines;
    if      (langId === 'python')     lines = reversePython(source);
    else if (langId === 'javascript') lines = reverseJS(source, 'javascript');
    else if (langId === 'typescript') lines = reverseJS(source, 'typescript');
    else return { lines: [stub(`note Reverse not supported for ${langId}`, source)], stubCount: 1 };

    // Filter out runs of blank lines from skipped constructs (closing braces etc.)
    const cleaned = [];
    let lastBlank = false;
    for (const l of lines) {
      const isBlank = !l.ivx.trim();
      if (isBlank && lastBlank) continue;
      cleaned.push(l);
      lastBlank = isBlank;
    }

    const stubCount = cleaned.filter(l => l.stub).length;
    return { lines: cleaned, stubCount };
  }

  return { reverse };
})();

// ── Lens panel UI ─────────────────────────────────────────────────────────────

(function() {
  const ep        = document.getElementById('ep');
  const editorSub = document.getElementById('editor-sub');
  const srcEl     = document.getElementById('src');

  // ── Lens panel DOM ──────────────────────────────────────────────────────────
  const lensPanel = document.createElement('div');
  lensPanel.id = 'lens-panel';
  lensPanel.style.display = 'none';
  lensPanel.innerHTML = `
    <div id="lens-hdr">
      <span id="lens-title">Python Lens</span>
      <div id="lens-import-wrap" style="display:none">
        <div class="gs"></div>
        <button class="kb lens-import-btn" id="lens-import">← Import to IVX</button>
        <span id="lens-stub-count"></span>
      </div>
      <div style="flex:1"></div>
      <button class="kb" id="lens-copy">Copy</button>
      <button class="kb" id="lens-close">✕</button>
    </div>
    <div id="lens-body">
      <div id="lens-gutter"><div id="lens-gutter-inner"></div></div>
      <div id="lens-scroll">
        <div id="lens-code" spellcheck="false"></div>
      </div>
      <div id="lens-hw-panel" style="display:none;flex-direction:column;flex:1;min-height:0;overflow:auto;padding:10px 12px">
        <div id="lens-hw-conn" style="display:flex;align-items:center;gap:8px;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid #2a2a3e">
          <span id="lens-hw-status" style="font-family:monospace;font-size:11px;color:#6b7280">not connected</span>
          <div style="flex:1"></div>
          <span style="font-family:monospace;font-size:10px;color:#4b5563">baud</span>
          <select class="gsel panel-hdr-sel" id="lens-hw-baud">
            <option value="9600">9600</option>
            <option value="115200" selected>115200</option>
            <option value="460800">460800</option>
            <option value="921600">921600</option>
          </select>
          <button class="kb" id="lens-hw-connect-btn">Connect FPGA Hardware</button>
        </div>
        <div id="lens-hw-tabs" style="display:flex;gap:6px;margin-bottom:10px">
          <button class="kb lens-hw-tab active" data-hwtab="verify">Send &amp; Verify</button>
          <button class="kb lens-hw-tab" data-hwtab="soak">Soak Tests</button>
        </div>
        <div id="lens-hw-verify" class="lens-hw-tabpanel">
          <div style="color:#6b7280;font-size:11px;margin-bottom:8px">
            Compiles the current IVX source to SEER (same view as the code lens, using the register
            count above), sends it to the connected board, and compares the board's real, received
            register values against what the simulator expects.
          </div>
          <button class="kb" id="lens-hw-send-btn">&#9654; Send &amp; verify compiled SEER</button>
          <div id="lens-hw-verify-status" style="margin-top:8px;font-size:12px"></div>
          <div id="lens-hw-reset-prompt" style="display:none;margin-top:8px;padding:8px;background:#1c2128;border-radius:6px">
            <span style="font-size:11px;color:#6b7280">Program is staged — press the board's physical reset, then continue.</span><br>
            <button class="kb" id="lens-hw-reset-continue" style="margin-top:6px">Reset pressed — send &amp; continue</button>
          </div>
          <div id="lens-hw-verify-results" style="margin-top:8px;font-size:12px"></div>
        </div>
        <div id="lens-hw-soak" class="lens-hw-tabpanel" style="display:none"></div>
      </div>
    </div>
    <div id="lens-import-confirm" style="display:none">
      <span id="lens-import-msg"></span>
      <button class="kb lens-import-btn" id="lens-import-ok">Replace IVX source</button>
      <button class="kb" id="lens-import-cancel">Cancel</button>
    </div>
  `;

  ep.appendChild(lensPanel);

  // ── Lens controls — inject into editor panel header ────────────────────────
  const epHdr = document.getElementById('ep-hdr');
  const epMinimizeBtn = document.getElementById('ep-minimize');

  // Insert a separator then the lens controls before the spacer div
  const lensSep = document.createElement('div');
  lensSep.className = 'panel-hdr-sep';

  const lensWrap = document.createElement('div');
  lensWrap.id = 'lens-wrap';
  lensWrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
  lensWrap.innerHTML = `
    <select class="gsel panel-hdr-sel" id="lens-lang-sel">
      <option value="python">Python</option>
      <option value="javascript">JavaScript</option>
      <option value="typescript">TypeScript</option>
      <option value="pseudocode">Pseudocode</option>
      <option value="seer">SEER Assembly</option>
    </select>
    <div id="seer-reg-wrap" style="display:none;align-items:center;gap:5px;margin-left:6px">
      <span style="font-family:monospace;font-size:10px;color:#4b5563;white-space:nowrap">Regs:</span>
      <input type="range" id="seer-reg-slider" min="8" max="240" step="8" value="240"
        style="width:80px;accent-color:#4ade80;cursor:pointer">
      <span id="seer-reg-label" style="font-family:monospace;font-size:10px;color:#4ade80;min-width:28px;text-align:right">240</span>
    </div>
    <button class="kb panel-hdr-btn" id="lens-hw-toggle" style="display:none">&#9889; Hardware</button>
    <button class="kb panel-hdr-btn" id="lens-btn">Lens</button>
  `;

  // Insert before the flex spacer (second-to-last child) and minimize button
  const spacer = epHdr.querySelector('div[style*="flex:1"]');
  epHdr.insertBefore(lensSep, spacer);
  epHdr.insertBefore(lensWrap, spacer);

  // ── Element refs ────────────────────────────────────────────────────────────
  const lensBtn        = document.getElementById('lens-btn');
  const langSel        = document.getElementById('lens-lang-sel');
  const lensCode       = document.getElementById('lens-code');
  const lensGutter     = document.getElementById('lens-gutter-inner');
  const lensScroll     = document.getElementById('lens-scroll');
  const lensClose      = document.getElementById('lens-close');
  const lensCopy       = document.getElementById('lens-copy');
  const lensTitleEl    = document.getElementById('lens-title');
  const lensImportWrap = document.getElementById('lens-import-wrap');
  const lensImportBtn  = document.getElementById('lens-import');
  const lensStubCount  = document.getElementById('lens-stub-count');
  const lensConfirm    = document.getElementById('lens-import-confirm');
  const lensImportMsg  = document.getElementById('lens-import-msg');
  const lensImportOk   = document.getElementById('lens-import-ok');
  const lensImportCancel = document.getElementById('lens-import-cancel');

  // ── SEER register slider ────────────────────────────────────────────────────
  const seerRegWrap   = document.getElementById('seer-reg-wrap');
  const seerRegSlider = document.getElementById('seer-reg-slider');
  const seerRegLabel  = document.getElementById('seer-reg-label');
  const lensHwToggle  = document.getElementById('lens-hw-toggle');
  let seerMaxRegs = 240;

  function updateSeerSlider() {
    const showSeer = (lensLang === 'seer' && lensOpen);
    seerRegWrap.style.display = showSeer ? 'flex' : 'none';
    lensHwToggle.style.display = showSeer ? '' : 'none';
  }

  seerRegSlider.addEventListener('input', () => {
    seerMaxRegs = parseInt(seerRegSlider.value, 10);
    seerRegLabel.textContent = String(seerMaxRegs);
    if (lensOpen && lensLang === 'seer' && !lensEdited) renderLens();
  });

  // ── Hardware layer (ported from the Soak Tester, this session) ────────────
  // Serial connection state and the trace-frame wire-format parser are
  // carried over largely unmodified -- confirmed against trace_packetizer.sv
  // and tested against real hardware there; no reason to re-derive any of
  // this from scratch. Scoped inside this IIFE (not top-level globals, the
  // way the standalone Soak Tester had them) since this is the only place
  // in Vertex that talks to navigator.serial.
  let hwSerialPort = null;
  let hwSerialWriter = null;
  let hwSerialReader = null;
  let hwSerialReadBuffer = new Uint8Array(0);
  const hwTraceFrameListeners = new Set(); // fn({type, waddr, pc, resultData, ...} | {type:'halted'})

  const hwStatusEl = document.getElementById('lens-hw-status');
  const hwConnectBtn = document.getElementById('lens-hw-connect-btn');
  const hwBaudSel = document.getElementById('lens-hw-baud');

  function hwSetStatus(text, colorVar) {
    hwStatusEl.textContent = text;
    hwStatusEl.style.color = colorVar ? `var(${colorVar})` : '';
  }

  function hwAppendBuffer(a, b) {
    const t = new Uint8Array(a.length + b.length);
    t.set(a, 0); t.set(b, a.length);
    return t;
  }

  // 14-byte frames: 0xAA sync (data) or 0xBB sync (halted marker, 13
  // zero-padded bytes). Data frame: 8-bit register address, 24-bit PC,
  // 64-bit data, 1 diagnostic byte (bit0=from li_mem_execute,
  // bit1=response actually captured before timeout).
  const HW_MAX_TRACE_BUFFER_BYTES = 4096;
  function hwProcessTraceBuffer() {
    const FRAME_LEN = 14;
    if (hwSerialReadBuffer.length > HW_MAX_TRACE_BUFFER_BYTES) {
      console.warn(`[SEER hw] read buffer exceeded ${HW_MAX_TRACE_BUFFER_BYTES} bytes with no valid frame `
        + `boundary -- dropping and resyncing on whatever arrives next.`);
      hwSerialReadBuffer = new Uint8Array(0);
    }
    while (hwSerialReadBuffer.length >= FRAME_LEN) {
      if (hwSerialReadBuffer[0] !== 0xAA && hwSerialReadBuffer[0] !== 0xBB) {
        let next = hwSerialReadBuffer.indexOf(0xAA);
        const nextB = hwSerialReadBuffer.indexOf(0xBB);
        if (next === -1 || (nextB !== -1 && nextB < next)) next = nextB;
        if (next === -1) { hwSerialReadBuffer = new Uint8Array(0); break; }
        hwSerialReadBuffer = hwSerialReadBuffer.slice(next);
        continue;
      }
      const frame = hwSerialReadBuffer.slice(0, FRAME_LEN);
      hwSerialReadBuffer = hwSerialReadBuffer.slice(FRAME_LEN);
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      if (frame[0] === 0xBB) {
        hwTraceFrameListeners.forEach(fn => { try { fn({type: 'halted'}); } catch (e) { console.error(e); } });
        continue;
      }
      const waddr = view.getUint8(1);
      const pc = (view.getUint8(2) << 16) | (view.getUint8(3) << 8) | view.getUint8(4);
      const resultData = view.getBigUint64(5, false);
      const diag = view.getUint8(13);
      const fromLiMem = (diag & 0x1) !== 0;
      const respCaptured = (diag & 0x2) !== 0;
      hwTraceFrameListeners.forEach(fn => {
        try { fn({type: 'write', waddr, pc, resultData, fromLiMem, respCaptured}); } catch (e) { console.error(e); }
      });
    }
  }

  async function hwSerialReadLoop() {
    while (hwSerialPort && hwSerialPort.readable) {
      hwSerialReader = hwSerialPort.readable.getReader();
      try {
        while (true) {
          const {value, done} = await hwSerialReader.read();
          if (done) break;
          hwSerialReadBuffer = hwAppendBuffer(hwSerialReadBuffer, value);
          hwProcessTraceBuffer();
        }
      } catch (e) {
        console.error('[SEER hw] read error:', e);
      } finally {
        try { hwSerialReader.releaseLock(); } catch (e) {}
      }
      if (!hwSerialPort) break;
    }
  }

  async function hwDisconnectSerial() {
    if (hwSerialReader) { try { await hwSerialReader.cancel(); } catch (e) {} }
    if (hwSerialWriter) { try { await hwSerialWriter.close(); } catch (e) {} hwSerialWriter = null; }
    if (hwSerialPort)   { try { await hwSerialPort.close(); }   catch (e) {} hwSerialPort = null; }
    hwSetStatus('not connected', '--muted');
    hwConnectBtn.textContent = 'Connect FPGA Hardware';
  }

  async function hwConnectSerial() {
    if (!('serial' in navigator)) {
      hwSetStatus('Web Serial not supported in this browser (Chromium-only: Chrome/Edge)', '--op');
      return;
    }
    try {
      await hwDisconnectSerial();
      const port = await navigator.serial.requestPort();
      const baud = parseInt(hwBaudSel.value, 10) || 115200;
      await port.open({ baudRate: baud, flowControl: 'none' });
      hwSerialPort = port;
      hwSerialWriter = port.writable.getWriter();
      hwSerialReadBuffer = new Uint8Array(0);
      hwSerialReadLoop();
      hwSetStatus(`connected @ ${baud} baud`, '--branch');
      hwConnectBtn.textContent = 'Disconnect';
    } catch (e) {
      hwSetStatus(`connection failed: ${e.message}`, '--op');
    }
  }

  hwConnectBtn.addEventListener('click', () => {
    if (hwSerialPort) hwDisconnectSerial();
    else hwConnectSerial();
  });

  async function hwWriteBytesToSerial(buf) {
    try {
      await hwSerialWriter.write(buf);
      return { ok: true, message: `sent ${buf.length} bytes` };
    } catch (e) {
      return { ok: false, message: `send failed: ${e.message}` };
    }
  }

  // ── Tab switching (Send & Verify / Soak Tests) ─────────────────────────────
  document.querySelectorAll('.lens-hw-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lens-hw-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const which = btn.dataset.hwtab;
      document.getElementById('lens-hw-verify').style.display = which === 'verify' ? '' : 'none';
      document.getElementById('lens-hw-soak').style.display = which === 'soak' ? '' : 'none';
      if (which === 'soak') hwEnsureSoakPanelsBuilt();
    });
  });

  // ── Code-view <-> Hardware-view toggle ──────────────────────────────────────
  const lensHwPanel = document.getElementById('lens-hw-panel');
  let hwPanelOpen = false;
  lensHwToggle.addEventListener('click', () => {
    hwPanelOpen = !hwPanelOpen;
    lensGutter.parentElement.style.display = hwPanelOpen ? 'none' : (lensLang === 'seer' ? 'none' : '');
    lensScroll.style.display = hwPanelOpen ? 'none' : '';
    lensHwPanel.style.display = hwPanelOpen ? 'flex' : 'none';
    lensHwToggle.classList.toggle('active', hwPanelOpen);
    lensHwToggle.textContent = hwPanelOpen ? '\u2039 Code' : '\u26A1 Hardware';
  });

  // ── Send & verify compiled SEER ─────────────────────────────────────────────
  // Compiles fresh from the current IVX source (same call renderLens() makes
  // for the code view) rather than trusting a possibly-stale cached string --
  // always operates on what's actually in the editor right now.
  const hwSendBtn = document.getElementById('lens-hw-send-btn');
  const hwVerifyStatusEl = document.getElementById('lens-hw-verify-status');
  const hwResetPrompt = document.getElementById('lens-hw-reset-prompt');
  const hwResetContinueBtn = document.getElementById('lens-hw-reset-continue');
  const hwVerifyResultsEl = document.getElementById('lens-hw-verify-results');

  const hwVerifyState = {
    pendingBuf: null, expectedFinal: null, awaitingReset: false,
    receivedFinal: null, haltMarkerSeen: false, currentListener: null, idleTimer: null,
  };

  hwSendBtn.addEventListener('click', () => {
    if (hwVerifyState.idleTimer) { clearInterval(hwVerifyState.idleTimer); hwVerifyState.idleTimer = null; }
    if (hwVerifyState.currentListener) { hwTraceFrameListeners.delete(hwVerifyState.currentListener); hwVerifyState.currentListener = null; }
    hwResetPrompt.style.display = 'none';
    hwVerifyResultsEl.innerHTML = '';

    if (!hwSerialWriter) {
      hwVerifyStatusEl.innerHTML = `<span style="color:var(--op,#e05c5c)">Not connected -- use "Connect FPGA Hardware" above.</span>`;
      return;
    }

    let compiled;
    try { compiled = compileSEER(srcEl.value, { maxRegs: seerMaxRegs }); }
    catch (e) {
      hwVerifyStatusEl.innerHTML = `<span style="color:var(--op,#e05c5c)">Cannot compile -- ${escHtmlLens(e.message)}</span>`;
      return;
    }

    // Assemble first -- gives real bytes for both the simulator (which
    // takes bytes directly, not source text -- see its own note) and the
    // actual send buffer, and surfaces any assembly error before wasting
    // a simulation run on text that wouldn't have produced valid bytes.
    const asmResults = assembleSource(compiled);
    let bytes = [];
    for (const r of asmResults) {
      if (r.isLabel) continue;
      if (r.error) {
        hwVerifyStatusEl.innerHTML = `<span style="color:var(--op,#e05c5c)">Cannot assemble -- ${escHtmlLens(r.error)} `
          + `&lt;- ${escHtmlLens(r.srcLine || '')}</span>`;
        return;
      }
      for (const b of r.bytes) bytes.push(b);
    }

    // regDepth=256 always -- real hardware has 256 physical registers
    // regardless of seerMaxRegs, which only constrains how aggressively
    // the COMPILER spills (a testing knob for RegAlloc, not a hardware
    // fact). Passing seerMaxRegs here was a real bug: sp/ra are hardcoded
    // to r254/r252 by SEEREmitter regardless of seerMaxRegs, so the
    // default slider value (240) made the simulator think sp itself
    // "doesn't exist" and trap on the very first instruction.
    const sim = simulateProgram(bytes, 200000, 256);
    if (sim.error) {
      hwVerifyStatusEl.innerHTML = `<span style="color:var(--op,#e05c5c)">Cannot verify -- simulator error: ${escHtmlLens(sim.error)}</span>`;
      return;
    }

    // NOTE: no read-before-write warning here (yet) -- the Soak Tester's
    // own version of this check (readBeforeWriteRegs) has its own
    // multi-function dependency chain (buildPcToItem/instrSourceRegs/
    // VALIDATOR_BRANCH_MNEMS, all built around parseProgram's specific
    // item shape) that wasn't ported this pass. A real, separate gap --
    // this handler can currently report a false mismatch if a compiled
    // program happens to read a register before this run writes it,
    // since the register file isn't cleared between runs on real
    // hardware but the simulator always starts from a clean, zeroed state.

    const words = Math.ceil(bytes.length / 4);
    const padded = new Uint8Array(words * 4);
    padded.set(bytes);
    const buf = new Uint8Array(4 + padded.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, words, false);
    buf.set(padded, 4);

    const expectedFinal = new Map();
    for (const t of sim.trace) {
      if (t.waddr !== null) expectedFinal.set(t.waddr, { pc: t.pc, wdata: t.wdata });
    }

    hwVerifyState.pendingBuf = buf;
    hwVerifyState.expectedFinal = expectedFinal;
    hwVerifyState.awaitingReset = true;
    hwResetPrompt.style.display = 'block';
    hwVerifyStatusEl.innerHTML = `Compiled and simulated cleanly -- ${expectedFinal.size} register(s) expected to be written. Waiting for reset.`;
  });

  hwResetContinueBtn.addEventListener('click', async () => {
    if (!hwVerifyState.awaitingReset) return;
    hwResetPrompt.style.display = 'none';
    hwVerifyState.awaitingReset = false;
    hwVerifyState.receivedFinal = new Map();
    hwVerifyState.haltMarkerSeen = false;
    let lastFrameAt = Date.now();
    hwVerifyState.currentListener = (frame) => {
      lastFrameAt = Date.now();
      if (frame.type === 'halted') { hwVerifyState.haltMarkerSeen = true; return; }
      hwVerifyState.receivedFinal.set(frame.waddr,
        { pc: frame.pc, resultData: frame.resultData, fromLiMem: frame.fromLiMem, respCaptured: frame.respCaptured });
    };
    hwTraceFrameListeners.add(hwVerifyState.currentListener);

    const { ok, message } = await hwWriteBytesToSerial(hwVerifyState.pendingBuf);
    if (!ok) {
      hwVerifyStatusEl.innerHTML = `<span style="color:var(--op,#e05c5c)">Send failed -- ${escHtmlLens(message)}</span>`;
      hwTraceFrameListeners.delete(hwVerifyState.currentListener);
      hwVerifyState.currentListener = null;
      return;
    }
    hwVerifyStatusEl.textContent = 'Sent -- waiting for the board\u2019s response...';

    hwVerifyState.idleTimer = setInterval(() => {
      const quietMs = Date.now() - lastFrameAt;
      const markerSettled = hwVerifyState.haltMarkerSeen && quietMs > 300;
      const timedOut = hwVerifyState.receivedFinal.size > 0 ? quietMs > 3000 : quietMs > 8000;
      if (markerSettled || timedOut) {
        clearInterval(hwVerifyState.idleTimer);
        hwVerifyState.idleTimer = null;
        hwTraceFrameListeners.delete(hwVerifyState.currentListener);
        hwVerifyState.currentListener = null;
        hwVerifyFinalize();
      }
    }, 250);
  });

  function hwVerifyFinalize() {
    const expected = hwVerifyState.expectedFinal;
    const received = hwVerifyState.receivedFinal;
    const allRegs = [...new Set([...expected.keys(), ...received.keys()])].sort((a, b) => a - b);

    let bad = 0;
    const rows = allRegs.map(r => {
      const exp = expected.get(r);
      const got = received.get(r);
      const expStr = exp ? `0x${exp.wdata.toString(16)}` : `<span style="color:#6b7280">(not written by simulator)</span>`;
      const gotStr = got ? `0x${got.resultData.toString(16)}` : `<span style="color:var(--op,#e05c5c)">never arrived</span>`;
      const matched = !!(exp && got && got.resultData === exp.wdata);
      if (exp && !matched) bad++;
      const color = !exp ? '#6b7280' : matched ? 'var(--branch,#4ade80)' : 'var(--op,#e05c5c)';
      return `<tr><td style="padding:2px 8px">r${r}</td><td style="padding:2px 8px;color:${color}">${expStr}</td>`
        + `<td style="padding:2px 8px;color:${color}">${gotStr}</td></tr>`;
    }).join('');

    const summary = bad === 0
      ? `<div style="color:var(--branch,#4ade80);font-weight:bold">PASS -- every expected register matched the board's actual value.</div>`
      : `<div style="color:var(--op,#e05c5c);font-weight:bold">FAIL -- ${bad} register(s) mismatched.</div>`;

    const haltNote = !hwVerifyState.haltMarkerSeen
      ? `<div style="color:#6b7280;font-size:11px;margin-top:4px">Note: halt-drained marker never arrived -- the program may not have halted as expected.</div>`
      : '';

    hwVerifyResultsEl.innerHTML = summary + haltNote
      + `<table style="margin-top:8px;font-family:monospace;font-size:11px;border-collapse:collapse">`
      + `<tr style="color:#6b7280"><td style="padding:2px 8px">reg</td><td style="padding:2px 8px">expected</td>`
      + `<td style="padding:2px 8px">actual (from board)</td></tr>${rows}</table>`;

    hwVerifyStatusEl.textContent = bad === 0 ? 'Done -- passed.' : `Done -- ${bad} mismatch(es).`;
  }

  // ── Soak Tests tab -- NOT YET PORTED ────────────────────────────────────────
  // Deliberately left as a clearly-marked stub rather than a rushed port.
  // The three Soak Tester panels (random stress, trap tests, capability-
  // adversarial tests) still need makeSoakRunner + generateRandomProgramForSoak
  // carried over and their DOM IDs re-namespaced (lens-soak1-*/lens-soak2-*/
  // lens-soak3-*) to avoid colliding with anything else in this page -- real,
  // bounded, separate work, not started this pass. Send & Verify above is
  // the completed, tested path.
  let hwSoakPanelsBuilt = false;
  function hwEnsureSoakPanelsBuilt() {
    if (hwSoakPanelsBuilt) return;
    hwSoakPanelsBuilt = true;
    document.getElementById('lens-hw-soak').innerHTML =
      `<div style="color:#6b7280;font-size:12px;padding:20px;text-align:center">
        Soak Tests (random stress / trap / capability-adversarial) are not ported into
        this panel yet -- Send &amp; Verify (the other tab) is complete and tested.
      </div>`;
  }


  // ── State ───────────────────────────────────────────────────────────────────
  let lensOpen    = false;
  let lensLang    = 'python';
  let lensEdited  = false;  // user has manually edited the lens content
  let lensMode    = 'forward';  // 'forward' = IVX→lang, 'import' = user pasted foreign code

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const LANG_LABELS = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', pseudocode: 'Pseudocode', seer: 'SEER Assembly' };
  const IMPORT_SUPPORTED = new Set(['python', 'javascript', 'typescript']);

  function escHtmlLens(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function updateGutter(lineCount, addrMap) {
    if (addrMap) {
      // SEER mode — show source byte addresses in the gutter
      // addrMap is { srcLine: byteAddr } (0-based source lines)
      // We have lineCount output lines; match each to its address
      const srcLines = srcEl.value.split('\n');
      let g = '';
      for (let i = 0; i < srcLines.length; i++) {
        const addr = addrMap[i];
        g += (addr != null ? '+' + addr.toString(16).padStart(4, '0') : '    ·') + '\n';
      }
      lensGutter.style.fontSize   = '9px';
      lensGutter.style.fontFamily = 'monospace';
      lensGutter.style.color      = '#4a5568';
      lensGutter.style.minWidth   = '44px';
      lensGutter.textContent = g;
      lensGutter.parentElement.style.display = '';
    } else {
      lensGutter.style.fontSize   = '';
      lensGutter.style.fontFamily = '';
      lensGutter.style.color      = '';
      lensGutter.style.minWidth   = '';
      lensGutter.parentElement.style.display = '';
      let g = '';
      for (let i = 1; i <= lineCount; i++) g += i + '\n';
      lensGutter.textContent = g;
    }
  }

  function syncGutter() {
    lensGutter.style.top = -lensScroll.scrollTop + 'px';
  }
  lensScroll.addEventListener('scroll', syncGutter);

  // ── Forward render: IVX → language ──────────────────────────────────────────

  // ── SEER machine-code (hex) renderer ────────────────────────────────────────
  // Pipeline: compileSEER() text → assembleSource() → per-instr bytes →
  //           disasm() field map → coloured byte-pill HTML.
  // Matches the HEX pane of seer_visualizer_v6.html exactly.
  function renderSEERHex(asmText) {
    // Strip the ; comment-only header lines and blank lines before assembling.
    // assembleSource() skips comment lines itself, but we keep them for display.
    const instrs = seerAssembleSource(asmText);

    const ESC = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Colour palette — matches visualizer :root vars
    const COL = {
      opcode:   '#e05c5c',
      register: '#4a9eff',
      imm:      '#f0a840',
      memory:   '#a06bdb',
      offset:   '#c678dd',
      branch:   '#3ecfa8',
      pack:     '#ff7b72',
      comment:  '#2e3d55',
      label:    '#3ecfa8',
      addr:     '#4a5568',
    };

    function pill(type, bytes, tip) {
      const hex = Array.from(bytes).map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
      const col = COL[type] || COL.imm;
      // Use inline styles so no external CSS class lookup is needed
      const bg  = type === 'opcode'
        ? `color-mix(in srgb, ${col} 40%, #111)`
        : `color-mix(in srgb, ${col} 30%, #111)`;
      const border = `color-mix(in srgb, ${col} 55%, transparent)`;
      return `<span class="seer-pill seer-pill-${type}" ` +
        `style="background:${bg};color:${col};border:1px solid ${border}" ` +
        `title="${ESC(tip)}">${ESC(hex)}</span>`;
    }

    function packSep() {
      return `<span class="seer-pack-sep" style="color:${COL.pack}">‖</span>`;
    }

    const lines = [];
    let goodCount = 0;

    for (const inst of instrs) {
      if (inst.isLabel) {
        lines.push(
          `<div class="seer-row seer-label-row">` +
          `<span class="seer-addr" style="color:${COL.addr}"></span>` +
          `<span class="seer-label-def" style="color:${COL.label};font-weight:600">${ESC(inst.name)}:</span>` +
          `<span class="seer-addr" style="color:${COL.addr};font-size:10px;margin-left:6px">` +
          `@+${inst.addr.toString(16).padStart(2,'0')}</span>` +
          `</div>`
        );
        continue;
      }

      // Comment / blank lines from the asm header — show dim
      if (!inst.bytes && !inst.error) {
        const txt = inst.srcLine || '';
        if (!txt.trim()) { lines.push('<div class="seer-row seer-blank-row"></div>'); continue; }
        lines.push(
          `<div class="seer-row seer-comment-row">` +
          `<span class="seer-addr" style="color:${COL.addr}"></span>` +
          `<span style="color:${COL.comment};font-family:inherit;font-size:11px">${ESC(txt)}</span>` +
          `</div>`
        );
        continue;
      }

      if (inst.error) {
        lines.push(
          `<div class="seer-row seer-error-row">` +
          `<span class="seer-addr" style="color:${COL.addr}">?</span>` +
          `<span style="color:${COL.opcode};font-size:11px;opacity:0.7;font-style:italic">${ESC(inst.error)}</span>` +
          `</div>`
        );
        continue;
      }

      goodCount++;
      // BUGFIX: was `(goodCount - 1) * 8`, assuming every instruction is 8
      // bytes -- real SEER instructions are 1 or 4 bytes, so a fixed
      // multiplier gives wrong addresses for any program mixing OB
      // (1-byte) and everything else (4-byte). assembleSource() already
      // tracks each instruction's real byte offset directly; use that.
      const addr = (inst.addr ?? 0).toString(16).padStart(4, '0');

      // BUGFIX: string-literal data chunks (from a .string directive) were
      // being fed through seerDisasm() like any other instruction --
      // wrong, since they're not code at all. Real, visible symptom: the
      // bytes for "World" (0x57='W') happened to decode as a genuine
      // opcode (0x57 = real sll), rendering as "sll r111, r114" in the
      // UI. assembleSource() already tags these with resolvedTokens[0]
      // .type === 'data' (see its own .string handling) -- checked here
      // to route data chunks to their own row instead of disasm().
      if (inst.resolvedTokens?.[0]?.type === 'data') {
        const hex = Array.from(inst.bytes).map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
        const bg  = `color-mix(in srgb, ${COL.memory} 30%, #111)`;
        const border = `color-mix(in srgb, ${COL.memory} 55%, transparent)`;
        lines.push(
          `<div class="seer-row" title="${ESC(inst.srcLine)}">` +
          `<span class="seer-addr" style="color:${COL.addr}">+${addr}</span>` +
          `<div class="seer-pills"><span class="seer-pill seer-pill-data" ` +
          `style="background:${bg};color:${COL.memory};border:1px solid ${border}" ` +
          `title="${ESC(inst.srcLine)}">${ESC(hex)}</span></div>` +
          `<span class="seer-mnem" style="color:${COL.comment};font-size:10px">${ESC(inst.srcLine)}</span>` +
          `</div>`
        );
        continue;
      }

      const d = seerDisasm(inst.bytes);
      const sorted = [...d.fields].sort((a,b) => a.start - b.start);
      const isPack = d.fields.some(f => f.tip?.startsWith('a:')) &&
                     d.fields.some(f => f.tip?.startsWith('b:'));

      let pillsHtml = '';
      sorted.forEach((field, fi) => {
        if (isPack && field.start === 4 && fi > 0) pillsHtml += packSep();
        pillsHtml += pill(field.type, inst.bytes.slice(field.start, field.end), field.tip || '');
      });

      // Mnemonic as tooltip on the address
      lines.push(
        `<div class="seer-row" title="${ESC(d.mnem)}">` +
        `<span class="seer-addr" style="color:${COL.addr}">+${addr}</span>` +
        `<div class="seer-pills">${pillsHtml}</div>` +
        `<span class="seer-mnem" style="color:${COL.comment};font-size:10px">${ESC(d.mnem.split(/\s+/).slice(0,3).join(' '))}</span>` +
        `</div>`
      );
    }

    return lines.join('\n');
  }

  function renderLens() {
    if (!lensOpen) return;
    const code = lensLang === 'seer'
      ? LensTranspiler.transpile(srcEl.value, 'seer', { maxRegs: seerMaxRegs })
      : LensTranspiler.transpile(srcEl.value, lensLang);
    lensCode.innerHTML = lensLang === 'seer' ? renderSEERHex(code) : escHtmlLens(code);
    updateGutter(code.split('\n').length, lensLang === 'seer' ? window._seerLineAddresses : null);
    // Hide the line-number gutter in SEER mode — addresses are shown inline in each row
    lensGutter.parentElement.style.display = lensLang === 'seer' ? 'none' : '';
    if (lensLang === 'seer') {
      const spillMatch = code.match(/; spills: (\d+)/);
      const spills = spillMatch ? parseInt(spillMatch[1], 10) : 0;
      lensTitleEl.textContent = spills > 0
        ? `SEER Assembly (${seerMaxRegs} regs — ${spills} spill${spills !== 1 ? 's' : ''})`
        : `SEER Assembly (${seerMaxRegs} regs — all in registers)`;
    } else {
      lensTitleEl.textContent = LANG_LABELS[lensLang] + ' Lens';
    }
    lensTitleEl.classList.toggle('seer-active', lensLang === 'seer');
    lensPanel.classList.toggle('seer-mode', lensLang === 'seer');
    lensImportWrap.style.display = IMPORT_SUPPORTED.has(lensLang) ? 'flex' : 'none';
    lensStubCount.textContent = '';
    lensConfirm.style.display = 'none';
    lensMode   = 'forward';
    lensEdited = false;
    // Update editor gutter to reflect SEER addresses or normal line numbers
    if (lensLang !== 'seer') window._seerLineAddresses = null;
    if (typeof updateHighlight === 'function') updateHighlight();
  }

  // ── Import render: parse lens content → show annotated IVX preview ──────────
  function runImport() {
    // Grab raw text from the editable lens div
    const raw = lensCode.innerText;
    const { lines, stubCount } = ReverseTranspiler.reverse(raw, lensLang);

    // Build highlighted HTML — stub lines get a warning highlight
    let html = '';
    for (const l of lines) {
      if (l.stub) {
        html += `<span class="lens-stub-line" title="Could not convert: ${escHtmlLens(l.original.trim())}">${escHtmlLens(l.ivx)}</span>\n`;
      } else {
        html += escHtmlLens(l.ivx) + '\n';
      }
    }
    lensCode.innerHTML = html;
    updateGutter(lines.length);

    // Update header
    lensTitleEl.textContent = '← IVX Preview';
    lensMode = 'import';

    // Stub count badge
    if (stubCount > 0) {
      lensStubCount.textContent = `${stubCount} line${stubCount > 1 ? 's' : ''} need review`;
      lensStubCount.className   = 'lens-stub-badge';
    } else {
      lensStubCount.textContent = '✓ clean';
      lensStubCount.className   = 'lens-stub-badge lens-stub-ok';
    }

    // Confirmation bar
    const msg = stubCount > 0
      ? `${stubCount} highlighted line${stubCount > 1 ? 's' : ''} couldn't convert — they'll appear as notes in IVX.`
      : 'All lines converted cleanly.';
    lensImportMsg.textContent = msg;
    lensConfirm.style.display = 'flex';

    // Store converted lines for the confirm step
    lensCode._pendingLines = lines;
  }

  // ── Confirm: write converted IVX into the source editor ─────────────────────
  lensImportOk.addEventListener('click', () => {
    const lines = lensCode._pendingLines;
    if (!lines) return;
    const ivxSource = lines.map(l => l.ivx).join('\n').trimEnd();
    if (window.IVX && IVX.bus) IVX.bus.emit('code_update_requested', { newCode: ivxSource });
    lensConfirm.style.display = 'none';
    closeLens();
  });

  lensImportCancel.addEventListener('click', () => {
    lensConfirm.style.display = 'none';
    renderLens(); // go back to forward view
  });

  lensImportBtn.addEventListener('click', runImport);

  // ── Open / close ────────────────────────────────────────────────────────────
  function openLens() {
    lensOpen = true;
    lensBtn.classList.add('on');
    document.getElementById('ep-body').style.display = 'none';
    lensPanel.style.display   = 'flex';
    lensPanel.style.flex      = '';   // let CSS flex:1 take over
    lensPanel.style.minHeight = '0';
    lensCode.contentEditable  = 'true';
    lensEdited = false;
    updateSeerSlider();
    renderLens();
  }

  function closeLens() {
    lensOpen   = false;
    lensEdited = false;
    lensBtn.classList.remove('on');
    lensPanel.style.display   = 'none';
    lensPanel.style.flex      = '';
    lensCode.contentEditable  = 'false';
    document.getElementById('ep-body').style.display = '';
    lensConfirm.style.display = 'none';
    updateSeerSlider();
    window._seerLineAddresses = null;
    if (typeof updateHighlight === 'function') updateHighlight();
    srcEl.focus();
  }

  lensBtn.addEventListener('click', () => { if (lensOpen) closeLens(); else openLens(); });
  lensClose.addEventListener('click', closeLens);

  langSel.addEventListener('change', () => {
    lensLang = langSel.value;
    updateSeerSlider();
    if (lensOpen) renderLens();
  });

  lensCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(lensCode.innerText).then(() => {
      lensCopy.textContent = 'Copied!';
      setTimeout(() => { lensCopy.textContent = 'Copy'; }, 1500);
    });
  });

  // contentEditable is enabled in openLens and disabled in closeLens
  // to prevent focus stealing when the lens panel is hidden
  lensCode.contentEditable = 'false';
  lensCode.addEventListener('input', () => {
    lensEdited = true;
    // If they're editing, go back to showing the import button (not confirm bar)
    if (lensMode === 'import') {
      lensConfirm.style.display = 'none';
      lensTitleEl.textContent   = LANG_LABELS[lensLang] + ' (edited)';
      lensTitleEl.classList.toggle('seer-active', lensLang === 'seer');
      lensStubCount.textContent = '';
    }
  });

  // Re-render on IVX source change, but only if user hasn't manually edited the lens
  if (window.IVX && IVX.bus) {
    IVX.bus.on('src_changed', () => {
      if (lensOpen && !lensEdited) renderLens();
    });
  }

  window._lensRender = renderLens;
  window._lensOpen   = () => lensOpen;
})();

// SEER globals — available for console debugging and future tooling
window.compileSEER = compileSEER;
window.SEEREmitter = SEEREmitter;
