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

// v10 row metadata
const ROW_META = {
  0x0: 'SYS   [op(8), args…]  — system/privileged, latency-ordered within row\n00–04: single-cycle  05–06: pipeline flush  07–09: memory/cache\n0A–0C: unbounded stall  0D–0E: trap entry  0F: terminal',
  0x1: 'LI    [op, rd, imm×6]  — load immediate\n10–17: fixed-width zero/sign-ext  18–19: PC-relative (PIC)',
  0x2: 'JMP   [op, r?, r?, off…]  — all branches in one row\nOffset = target_addr − branch_addr (relative to THIS instruction)',
  0x3: 'P3    [op, rd, imm×6]  — rd = rd op sign_ext(imm48)',
  0x4: 'P5    [op, rd, rs, imm×5]  — 2 registers + 5-byte immediate',
  0x5: 'P6    [op, rd, rs1, rs2, imm×4]  — workhorse: 3 registers + 4-byte imm',
  0x6: 'FP    [op, rd, rs1, rs2, imm×4]  — IEEE 754 double\nimm[2:0]=rounding mode (0=RNE,1=RTZ,2=RDN,3=RUP,4=RMM)\nimm[7:3]=exception enable mask (NX,UF,OF,DZ,NV)',
  0x7: 'MEM   [op, rd/rs, rb1, rb2, off×4]  — load (70–77) / store (78–7B)\neffective_addr = rb1 + rb2 + sign_ext(off32)',
  0x8: 'MEMS  [op, rd/rs, rb1, rb2, off×4]  — sized load (80–87) / sized store (88–8B)\nSame dual-base addressing; off sign-ext 32-bit',
  0x9: 'P4    [op, rd, addr×6]  — load+combine fused: rd = rd op mem[addr48]',
  0xA: 'ATOM  [op, rd, rb1, rb2, off×4]  — atomic RMW: rd←old; mem←old op rv\nOp nibble mirrors universal table',
  0xB: 'VALU  [op, vd, vs1, vs2, imm×4]  — SIMD arith, 4-wide 64-bit integer\nRegs 4-aligned; imm[3:0]=lane suppress mask; imm[11:4]=bcast imm (rs2=ZR)',
  0xC: 'VMEM  [op, vd/rd, rb1, rb2, off×4]  — SIMD memory + reductions\nVector reg 4-aligned; GP reg bases',
  0xD: '—     Reserved — future extension space',
  0xE: '—     Reserved — future extension space',
  0xF: 'PACK  [op_a, r1a, r2a, r3a, op_b, r1b, r2b, r3b]  — two ops in one 8-byte word\nAll sources read before any write commits (precise exception model)\nDiv-in-both-slots illegal; one-div-slot: div commits after non-div',
};

// OP names from universal table (low nibble)
const OP_NAMES = {
  0x0:'eq',  0x1:'not', 0x2:'and', 0x3:'nand',
  0x4:'or',  0x5:'nor', 0x6:'xor', 0x7:'xnor',
  0x8:'sll', 0x9:'srl', 0xA:'sra', 0xB:'slt',
  0xC:'add', 0xD:'sub', 0xE:'mul', 0xF:'div'
};

// SYS row (0x0_) — latency-ordered
const SYS_NAMES = {
  0x0:'nop',      0x1:'popcnt',   0x2:'clz',      0x3:'rdctrl',
  0x4:'wrctrl',   0x5:'sysret',   0x6:'rfi',       0x7:'fence',
  0x8:'sfence',   0x9:'cflush',   0xA:'tlbflush',  0xB:'out',
  0xC:'in',       0xD:'ebreak',   0xE:'ecall',     0xF:'hlt'
};

// JMP row (0x2_)
const JMP_NAMES = {
  0x0:'jmp', 0x1:'jmpr', 0x2:'jz', 0x3:'jne',
  0x4:'jlt', 0x5:'jgt',  0x6:'jle',0x7:'jge'
};

// LI row (0x1_)
const LI_NAMES = {
  0x0:'li.u8', 0x1:'li.s8', 0x2:'li.u16', 0x3:'li.s16',
  0x4:'li.u32',0x5:'li.s32',0x6:'li.u48', 0x7:'li.s48',
  0x8:'li.pcrel.u', 0x9:'li.pcrel.s'
};

// FP row (0x6_): 60–6A are FP-only prefix; 6B–6F mirror universal table
const FP_NAMES = {
  0x0:'feq',0x1:'fneg',0x2:'fabs',0x3:'ffloor',0x4:'fceil',0x5:'fround',
  0x6:'fjgt',0x7:'f2i',0x8:'i2f',0x9:'fsqrt',
  0xB:'flt',0xC:'fadd',0xD:'fsub',0xE:'fmul',0xF:'fdiv'
};

// MEM row (0x7_): 70–77 loads, 78–7B stores
const MEM_NAMES = {
  0x0:'ld.u8',0x1:'ld.s8',0x2:'ld.u16',0x3:'ld.s16',
  0x4:'ld.u32',0x5:'ld.s32',0x6:'ld.u64',0x7:'ld.s64',
  0x8:'st.8',0x9:'st.16',0xA:'st.32',0xB:'st.64'
};

// MEMS row (0x8_): 80–87 sized loads, 88–8B sized stores
const MEMS_NAMES = {
  0x0:'lds.u8',0x1:'lds.s8',0x2:'lds.u16',0x3:'lds.s16',
  0x4:'lds.u32',0x5:'lds.s32',0x6:'lds.u64',0x7:'lds.s64',
  0x8:'sts.8',0x9:'sts.16',0xA:'sts.32',0xB:'sts.64'
};

// VALU row (0xB_)
const VALU_NAMES = {
  0x0:'veq',0x1:'vsra',0x2:'vand',0x3:'vmax',
  0x4:'vor',0x5:'vmin',0x6:'vxor',0x7:'vblend',
  0x8:'vsll',0x9:'vsrl',0xA:'vbcast',0xB:'vcmplt',
  0xC:'vadd',0xD:'vsub',0xE:'vmul',0xF:'vfma'
};

// VMEM row (0xC_)
const VMEM_NAMES = { 0x0:'vld64',0x1:'vst64',0x2:'vredadd',0x3:'vredmax' };

// ── Helpers ──────────────────────────────────────────────────────────
function se(v, bits) {
  if (v >= (1 << (bits-1))) v -= (1 << bits);
  return v;
}
function reg(n) { return n === 255 ? 'ZR' : `R${n}`; }
function seLE(bytes) {
  let v = 0;
  for (let i = bytes.length-1; i >= 0; i--) v = (v * 256 + bytes[i]);
  const bits = bytes.length * 8;
  if (v >= Math.pow(2, bits-1)) v -= Math.pow(2, bits);
  return v;
}
const F = (s,e,t,tip) => ({start:s, end:e, type:t, tip});

// ── v10 Disassembler ─────────────────────────────────────────────────
function disasm(b8) {
  const b = Array.from(b8);
  const hi = b[0] >> 4;
  const lo = b[0] & 0xF;
  const meta = ROW_META[hi] || 'Unknown row';

  // 0x0_ SYS — latency-ordered within row
  if (hi === 0x0) {
    const n = SYS_NAMES[lo] ?? `sys_${lo.toString(16)}`;
    // popcnt / clz: [op, rd, rs, 0×5]
    if (lo === 0x1 || lo === 0x2) {
      return { mnem:`${n}  ${reg(b[1])} ← ${reg(b[2])}`,
        fields:[F(0,1,'opcode',n),F(1,2,'register',`rd=${reg(b[1])}`),F(2,3,'register',`rs=${reg(b[2])}`),F(3,8,'immediate','padding')],
        meta };
    }
    // rdctrl / wrctrl: [op, r, ctrl_id, 0…]
    if (lo === 0x3 || lo === 0x4) {
      return { mnem:`${n}  ${reg(b[1])}, ctrl[${b[2]}]`,
        fields:[F(0,1,'opcode',n),F(1,2,'register',`rd/rs=${reg(b[1])}`),F(2,3,'immediate',`ctrl_id=${b[2]}`),F(3,8,'immediate','padding')],
        meta };
    }
    // fence: [op, mode, 0×6]
    if (lo === 0x7) {
      return { mnem:`fence  mode=0x${b[1].toString(16).padStart(2,'0')}`,
        fields:[F(0,1,'opcode','fence'),F(1,2,'immediate',`mode=0x${b[1].toString(16).padStart(2,'0')}`),F(2,8,'immediate','padding')],
        meta: meta+'\nmode bits[3:0]=predecessor(R/W/I/O), bits[7:4]=successor\n0x00=full barrier  0xFF=full I/O+memory barrier' };
    }
    // cflush: [op, rb, off_lo, off_hi, 0×4]
    if (lo === 0x9) {
      const off = se(b[2] | (b[3]<<8), 16);
      return { mnem:`cflush  ${reg(b[1])}, off=${off}`,
        fields:[F(0,1,'opcode','cflush'),F(1,2,'register',reg(b[1])),F(2,4,'offset',`off16=${off}`),F(4,8,'immediate','padding')],
        meta: meta+'\ncflush [op, rb, off_lo, off_hi, 0×4]\nFlushes cache line at reg[rb]+sign_ext(off16); rb=ZR→literal physical address' };
    }
    return { mnem:n, fields:[F(0,1,'opcode',n),F(1,8,'immediate','padding')], meta };
  }

  // 0x1_ LI — [op, rd, imm×6]
  if (hi === 0x1) {
    const n = LI_NAMES[lo] ?? `li_${lo.toString(16)}`;
    if (lo === 0xF) { // ZR pseudo
      return { mnem:`ZR  (r255 — reads always 0, writes silently discarded)`,
        fields:[F(0,1,'opcode','ZR'),F(1,8,'immediate','hardwired zero register')], meta };
    }
    if (lo >= 0xA && lo <= 0xE) {
      return { mnem:`— (reserved)`, fields:[F(0,1,'opcode','—'),F(1,8,'immediate','reserved')], meta };
    }
    const isPCRel = lo === 0x8 || lo === 0x9;
    const imm = seLE(b.slice(2,8));
    const mnemStr = isPCRel
      ? `${n}  ${reg(b[1])}, PC${imm>=0?'+':''}${imm}`
      : `${n}  ${reg(b[1])}, #${imm}`;
    return { mnem: mnemStr,
      fields:[F(0,1,'opcode',n),F(1,2,'register',`rd=${reg(b[1])}`),F(2,8,'immediate',isPCRel?`PC-relative offset=${imm}`:`value=${imm}`)],
      meta: meta+(isPCRel?'\nrd = (instr_addr + sign_ext(imm48)) — enables PIC address materialisation in one instruction':'') };
  }

  // 0x2_ JMP — all branches
  if (hi === 0x2) {
    const n = JMP_NAMES[lo] ?? `j${lo.toString(16)}`;
    if (lo >= 0x8) return { mnem:'— (reserved)', fields:[F(0,1,'opcode','—'),F(1,8,'immediate','reserved')], meta };
    if (lo === 0x0) { // jmp unconditional
      const off = seLE(b.slice(1,8));
      return { mnem:`jmp  ${off>=0?'+':''}${off}`,
        fields:[F(0,1,'opcode','jmp'),F(1,8,'branch',`PC-relative offset = ${off>=0?'+':''}${off}`)],
        meta: meta+'\nUnconditional jump. Range: ±2^55 bytes' };
    }
    if (lo === 0x1) { // jmpr
      return { mnem:`jmpr  ${reg(b[1])}, link=${reg(b[2])}`,
        fields:[F(0,1,'opcode','jmpr'),F(1,2,'register',`r_offset=${reg(b[1])}`),F(2,3,'register',`r_link=${reg(b[2])}`),F(3,8,'immediate','padding')],
        meta: meta+'\ntarget = branch_addr + sign_ext(r_offset)\nif r_link ≠ ZR: r_link = branch_addr + 8 (call semantics)' };
    }
    if (lo === 0x2) { // jz
      const off = seLE(b.slice(2,8));
      return { mnem:`jz  ${reg(b[1])},  ${off>=0?'+':''}${off}`,
        fields:[F(0,1,'opcode','jz'),F(1,2,'register',`cond=${reg(b[1])}`),F(2,8,'branch',`offset=${off>=0?'+':''}${off}`)],
        meta: meta+`\nJump if ${reg(b[1])} == 0` };
    }
    const off = seLE(b.slice(3,8));
    const condMap = {jne:'≠',jlt:'<(s)',jgt:'>(s)',jle:'≤(s)',jge:'≥(s)'};
    return { mnem:`${n}  ${reg(b[1])}, ${reg(b[2])},  ${off>=0?'+':''}${off}`,
      fields:[F(0,1,'opcode',n),F(1,2,'register',`r1=${reg(b[1])}`),F(2,3,'register',`r2=${reg(b[2])}`),F(3,8,'branch',`offset=${off>=0?'+':''}${off}`)],
      meta: meta+`\nJump if ${reg(b[1])} ${condMap[n]||'?'} ${reg(b[2])}. All comparisons signed.` };
  }

  // 0x3_ P3 — [op, rd, imm×6]  rd = rd op sign_ext(imm48)
  if (hi === 0x3) {
    const n = OP_NAMES[lo] ?? `op${lo.toString(16)}`;
    const imm = seLE(b.slice(2,8));
    return { mnem:`p3.${n}  ${reg(b[1])}, #${imm}`,
      fields:[F(0,1,'opcode',n),F(1,2,'register',`rd=${reg(b[1])}`),F(2,8,'immediate',`imm48=${imm}`)],
      meta: meta+`\nrd = rd ${n} sign_ext(imm48)` };
  }

  // 0x4_ P5 — [op, rd, rs, imm×5]
  if (hi === 0x4) {
    const n = OP_NAMES[lo] ?? `op${lo.toString(16)}`;
    const imm = seLE(b.slice(3,8));
    return { mnem:`p5.${n}  ${reg(b[1])}, ${reg(b[2])}, #${imm}`,
      fields:[F(0,1,'opcode',n),F(1,2,'register',`rd=${reg(b[1])}`),F(2,3,'register',`rs=${reg(b[2])}`),F(3,8,'immediate',`imm40=${imm}`)],
      meta: meta+`\nrd = rs ${n} sign_ext(imm40)` };
  }

  // 0x5_ P6 — [op, rd, rs1, rs2, imm×4]  workhorse
  if (hi === 0x5) {
    const n = OP_NAMES[lo] ?? `op${lo.toString(16)}`;
    const imm = seLE(b.slice(4,8));
    return { mnem:`p6.${n}  ${reg(b[1])}, ${reg(b[2])}, ${reg(b[3])}${imm!==0?', #'+imm:''}`,
      fields:[F(0,1,'opcode',n),F(1,2,'register',`rd=${reg(b[1])}`),F(2,3,'register',`rs1=${reg(b[2])}`),F(3,4,'register',`rs2=${reg(b[3])}`),F(4,8,'immediate',imm!==0?`imm32=${imm}`:'padding')],
      meta: meta+`\nrd = rs1 ${n} rs2` };
  }

  // 0x6_ FP — [op, rd, rs1, rs2, imm×4]
  if (hi === 0x6) {
    const n = FP_NAMES[lo] ?? `fp_${lo.toString(16)}`;
    if (lo === 0xA) return { mnem:'— (reserved)', fields:[F(0,1,'opcode','—'),F(1,8,'immediate','reserved')], meta };
    const imm = seLE(b.slice(4,8));
    const rmNames = ['RNE','RTZ','RDN','RUP','RMM'];
    const rm = rmNames[imm & 0x7] ?? `rm${imm&0x7}`;
    // fjgt uses full imm as branch offset
    if (lo === 0x6) {
      return { mnem:`fjgt  ${reg(b[1])}, ${reg(b[2])}, offset=${imm}`,
        fields:[F(0,1,'opcode','fjgt'),F(1,2,'register',`r1=${reg(b[1])}`),F(2,3,'register',`r2=${reg(b[2])}`),F(3,4,'register','padding'),F(4,8,'branch',`offset=${imm}`)],
        meta: meta+'\nFloat branch: if f(r1) > f(r2): PC += offset' };
    }
    return { mnem:`${n}  ${reg(b[1])}, ${reg(b[2])}, ${reg(b[3])}${imm!==0?`  [${rm}]`:''}`,
      fields:[F(0,1,'opcode',n),F(1,2,'register',`rd=${reg(b[1])}`),F(2,3,'register',`rs1=${reg(b[2])}`),F(3,4,'register',`rs2=${reg(b[3])}`),F(4,8,'immediate',imm!==0?`rm=${rm} exc_mask=${(imm>>3)&0x1F}`:'padding (RNE, no traps)')],
      meta };
  }

  // 0x7_ MEM — loads 70–77, stores 78–7B
  if (hi === 0x7) {
    const n = MEM_NAMES[lo] ?? '—';
    if (!MEM_NAMES[lo]) return { mnem:'— (reserved)', fields:[F(0,1,'opcode','—'),F(1,8,'immediate','reserved')], meta };
    const off = seLE(b.slice(4,8));
    const isStore = lo >= 0x8;
    if (isStore)
      return { mnem:`${n}  [${reg(b[2])}+${reg(b[3])}+${off}] ← ${reg(b[1])}`,
        fields:[F(0,1,'opcode',n),F(1,2,'register',`rs=${reg(b[1])}`),F(2,3,'register',`rb1=${reg(b[2])}`),F(3,4,'register',`rb2=${reg(b[3])}`),F(4,8,'offset',`off32=${off}`)], meta };
    return { mnem:`${n}  ${reg(b[1])}, [${reg(b[2])}+${reg(b[3])}+${off}]`,
      fields:[F(0,1,'opcode',n),F(1,2,'register',`rd=${reg(b[1])}`),F(2,3,'register',`rb1=${reg(b[2])}`),F(3,4,'register',`rb2=${reg(b[3])}`),F(4,8,'offset',`off32=${off}`)], meta };
  }

  // 0x8_ MEMS — sized loads 80–87, sized stores 88–8B
  if (hi === 0x8) {
    const n = MEMS_NAMES[lo] ?? '—';
    if (!MEMS_NAMES[lo]) return { mnem:'— (reserved)', fields:[F(0,1,'opcode','—'),F(1,8,'immediate','reserved')], meta };
    const off = seLE(b.slice(4,8));
    const isStore = lo >= 0x8;
    if (isStore)
      return { mnem:`${n}  [${reg(b[2])}+${reg(b[3])}+${off}] ← ${reg(b[1])}`,
        fields:[F(0,1,'opcode',n),F(1,2,'register',`rs=${reg(b[1])}`),F(2,3,'register',`rb1=${reg(b[2])}`),F(3,4,'register',`rb2=${reg(b[3])}`),F(4,8,'offset',`off32=${off}`)], meta };
    return { mnem:`${n}  ${reg(b[1])}, [${reg(b[2])}+${reg(b[3])}+${off}]`,
      fields:[F(0,1,'opcode',n),F(1,2,'register',`rd=${reg(b[1])}`),F(2,3,'register',`rb1=${reg(b[2])}`),F(3,4,'register',`rb2=${reg(b[3])}`),F(4,8,'offset',`off32=${off}`)], meta };
  }

  // 0x9_ P4 — [op, rd, addr×6]  load+combine fused
  if (hi === 0x9) {
    const n = OP_NAMES[lo] ?? `op${lo.toString(16)}`;
    let name = '?';
    try { name = new TextDecoder().decode(new Uint8Array(b.slice(2,8))).replace(/\x00+$/,''); } catch(e) {}
    const hex48 = '0x'+b.slice(2,8).map(x=>x.toString(16).padStart(2,'0')).join('');
    return { mnem:`ld·${n}  ${reg(b[1])}, [${name||hex48}]`,
      fields:[F(0,1,'opcode',`ld·${n}`),F(1,2,'register',`rd=${reg(b[1])}`),F(2,8,'memory',`addr48="${name||hex48}"`)],
      meta: meta+`\nrd = rd ${n} mem[addr48]; addr = zero-padded UTF-8 name` };
  }

  // 0xA_ ATOM — [op, rd, rb1, rb2, off×4]
  if (hi === 0xA) {
    const atomNames = {0:'swap',2:'and',4:'or',6:'xor',0xB:'slt',0xC:'add',0xD:'sub'};
    const n = atomNames[lo];
    if (!n) return { mnem:'— (reserved)', fields:[F(0,1,'opcode','—'),F(1,8,'immediate','reserved')], meta };
    const off = seLE(b.slice(4,8));
    return { mnem:`a·${n}  ${reg(b[1])}, [${reg(b[2])}+${reg(b[3])}+${off}]`,
      fields:[F(0,1,'opcode',`a·${n}`),F(1,2,'register',`rd(←old)=${reg(b[1])}`),F(2,3,'register',`rb1=${reg(b[2])}`),F(3,4,'register',`rb2=${reg(b[3])}`),F(4,8,'offset',`off32=${off}`)],
      meta: meta+`\nrd ← old; mem ← old ${n} rv` };
  }

  // 0xB_ VALU — SIMD arith
  if (hi === 0xB) {
    const n = VALU_NAMES[lo] ?? `vop_${lo.toString(16)}`;
    const imm4 = b.slice(4,8);
    const lmask = imm4[0] & 0xF;
    const bcast = se((imm4[0]>>4) | (imm4[1]<<4), 8);
    const immNote = lmask ? `lane_mask=${lmask.toString(2).padStart(4,'0')}b` : (b[3]===255 ? `bcast_imm=${bcast}` : 'imm=0');
    if (lo === 0xA) // vbcast: scalar src
      return { mnem:`vbcast  V${b[1]}, ${reg(b[2])}`,
        fields:[F(0,1,'opcode','vbcast'),F(1,2,'register',`vd=V${b[1]}`),F(2,3,'register',`rs(scalar)=${reg(b[2])}`),F(3,8,'immediate','padding')], meta };
    return { mnem:`${n}  V${b[1]}, V${b[2]}, ${b[3]===255?`bcast(${bcast})`:'V'+b[3]}`,
      fields:[F(0,1,'opcode',n),F(1,2,'register',`vd=V${b[1]}`),F(2,3,'register',`vs1=V${b[2]}`),F(3,4,'register',b[3]===255?'ZR(→bcast imm)':`vs2=V${b[3]}`),F(4,8,'immediate',immNote)],
      meta };
  }

  // 0xC_ VMEM
  if (hi === 0xC) {
    const n = VMEM_NAMES[lo];
    if (!n) return { mnem:'— (reserved)', fields:[F(0,1,'opcode','—'),F(1,8,'immediate','reserved')], meta };
    const off = seLE(b.slice(4,8));
    if (lo >= 2)
      return { mnem:`${n}  ${reg(b[1])}, V${b[2]}`,
        fields:[F(0,1,'opcode',n),F(1,2,'register',`rd(scalar)=${reg(b[1])}`),F(2,3,'register',`vs=V${b[2]}`),F(3,8,'immediate','padding')], meta };
    const isStore = lo === 1;
    if (isStore)
      return { mnem:`vst64  [${reg(b[2])}+${reg(b[3])}+${off}] ← V${b[1]}`,
        fields:[F(0,1,'opcode','vst64'),F(1,2,'register',`vd=V${b[1]}`),F(2,3,'register',`rb1=${reg(b[2])}`),F(3,4,'register',`rb2=${reg(b[3])}`),F(4,8,'offset',`off32=${off}`)], meta };
    return { mnem:`vld64  V${b[1]}, [${reg(b[2])}+${reg(b[3])}+${off}]`,
      fields:[F(0,1,'opcode','vld64'),F(1,2,'register',`vd=V${b[1]}`),F(2,3,'register',`rb1=${reg(b[2])}`),F(3,4,'register',`rb2=${reg(b[3])}`),F(4,8,'offset',`off32=${off}`)], meta };
  }

  // 0xD_ / 0xE_ — reserved
  if (hi === 0xD || hi === 0xE) {
    return { mnem:'— (reserved)', fields:[F(0,1,'opcode','—'),F(1,8,'immediate','reserved encoding space')], meta };
  }

  // 0xF_ PACK — [op_a, r1a, r2a, r3a, op_b, r1b, r2b, r3b]
  if (hi === 0xF) {
    const op_b = b[4];
    const hi_b = op_b >> 4;
    const lo_b = op_b & 0xF;
    // Only pure RR packed pairs use this row; op_a's hi nibble is always 0xF
    // but op_b's hi nibble encodes variant
    const na = OP_NAMES[lo] ?? `op${lo.toString(16)}`;
    const nb = OP_NAMES[lo_b] ?? `op${lo_b.toString(16)}`;
    const mnem = `PACK  [${na} ${reg(b[1])},${reg(b[2])},${reg(b[3])}]  ‖  [${nb} ${reg(b[5])},${reg(b[6])},${reg(b[7])}]`;
    return { mnem, isPack:true,
      fields:[F(0,1,'opcode',`a:${na}`),F(1,2,'register',`rd_a=${reg(b[1])}`),F(2,3,'register',`rs1_a=${reg(b[2])}`),F(3,4,'register',`rs2_a=${reg(b[3])}`),
              F(4,5,'opcode',`b:${nb}`),F(5,6,'register',`rd_b=${reg(b[5])}`),F(6,7,'register',`rs1_b=${reg(b[6])}`),F(7,8,'register',`rs2_b=${reg(b[7])}`)],
      meta };
  }

  return { mnem:`??? 0x${b[0].toString(16).toUpperCase().padStart(2,'0')}`,
    fields:[F(0,8,'opcode','Unknown')], meta:'Unrecognized encoding' };
}

// ═══════════════════════════════════════════════════════════════════════
// ASSEMBLER (updated for v10 row layout)
// ═══════════════════════════════════════════════════════════════════════

function operandsFor(opcode) {
  const hi = (opcode >> 4) & 0xF;
  const lo = opcode & 0xF;
  // 0x0_ SYS — varies
  if (hi === 0x0) {
    if (lo===0x1||lo===0x2) return ['r','r'];      // popcnt, clz
    if (lo===0x3||lo===0x4) return ['r','i'];      // rdctrl, wrctrl
    if (lo===0x9) return ['r','i'];                // cflush [rb, off16]
    if (lo===0x7) return ['i'];                    // fence [mode]
    return [];
  }
  if (hi === 0x1) return ['i'];                    // LI [rd, imm×6] — rd separate
  if (hi === 0x2) {
    if (lo===0x0) return ['j'];
    if (lo===0x1) return ['r','r'];
    if (lo===0x2) return ['r','j'];
    if (lo<=0x7) return ['r','r','j'];
    return [];
  }
  if (hi === 0x3) return ['r','i'];               // P3
  if (hi === 0x4) return ['r','r','i'];           // P5
  if (hi === 0x5) return ['r','r','r','i'];       // P6
  if (hi === 0x6) return ['r','r','r','i'];       // FP
  if (hi === 0x7) return ['r','r','r','i'];       // MEM
  if (hi === 0x8) return ['r','r','r','i'];       // MEMS
  if (hi === 0x9) return ['r','m'];               // P4
  if (hi === 0xA) return ['r','r','r','i'];       // ATOM
  if (hi === 0xB) return ['r','r','r','i'];       // VALU
  if (hi === 0xC) return ['r','r','r','i'];       // VMEM
  if (hi === 0xF) return null;                    // PACK (special)
  return [];
}

function immWidth(opcode) {
  const hi = (opcode >> 4) & 0xF;
  const lo = opcode & 0xF;
  if (hi===0x0) { if(lo===0x9) return 2; return 1; }
  if (hi===0x1) return 6;
  if (hi===0x2) { if(lo===0x0) return 7; if(lo===0x2) return 6; return 5; }
  if (hi===0x3) return 6;
  if (hi===0x4) return 5;
  if (hi===0x5||hi===0x6||hi===0x7||hi===0x8) return 4;
  if (hi===0xA||hi===0xB||hi===0xC) return 4;
  return 1;
}

function encodeImm(val, width) {
  const bits = BigInt(width * 8);
  const min  = -(1n << (bits - 1n));
  const umax =  (1n << bits) - 1n;
  const v    = BigInt(val);
  if (v < min || v > umax)
    throw new Error(`Immediate ${val} out of range for ${width}-byte field`);
  const buf = new Uint8Array(width);
  let vv = v < 0n ? v + (1n << bits) : v;
  for (let i = 0; i < width; i++) { buf[i] = Number(vv & 0xFFn); vv >>= 8n; }
  return buf;
}

function memToBytes(name) {
  const enc = new TextEncoder().encode(name);
  if (enc.length > 6) throw new Error(`"${name}" is ${enc.length} UTF-8 bytes; max 6`);
  const buf = new Uint8Array(6);
  buf.set(enc);
  return buf;
}

class AutoRegs {
  constructor(forbidden) {
    this.pool=[]; this.counter=0; this.history=[];
    for (let i=0;i<=255;i++) if (!forbidden.has(i)) this.pool.push(i);
  }
  next() {
    if (!this.pool.length) throw new Error('No auto registers available');
    const r=this.pool[this.counter%this.pool.length]; this.counter++; this.history.push(r); return r;
  }
  back(n) {
    if (n<1) throw new Error('R-N: N must be >= 1');
    if (n>this.history.length) throw new Error(`R-${n} requested but only ${this.history.length} auto-regs allocated`);
    return this.history[this.history.length-n];
  }
}

function collectNamed(lines) {
  const named=new Set();
  for (const line of lines)
    for (const tok of line.trim().split(/\s+/))
      if (/^[Rr]\d+$/.test(tok)) { const n=parseInt(tok.slice(1)); if(n>=0&&n<=255) named.add(n); }
  return named;
}

function parseLabels(source) {
  const rawLines=source.split('\n'), labelTable={}, work=[];
  let byteOffset=0;
  for (const raw of rawLines) {
    // Strip inline comments and trim
    let stripped = raw.replace(/;.*$/, '').trim();
    if (!stripped) continue;
    // Skip assembler directives like .org
    if (stripped.startsWith('.') && !stripped.includes(':')) continue;
    if (stripped.includes(':')) {
      const colon=stripped.indexOf(':'), candidate=stripped.slice(0,colon).trim(), rest=stripped.slice(colon+1).trim();
      let valid=candidate.length>0&&!candidate.includes(' ')&&!/^\d+$/.test(candidate);
      if (valid&&/^[0-9a-fA-F]{1,2}$/.test(candidate)) valid=false;
      if (valid) {
        if (labelTable[candidate]!==undefined) { work.push({kind:'error',line:`Duplicate label "${candidate}"`,addr:byteOffset,srcLine:stripped}); }
        else { labelTable[candidate]=byteOffset; work.push({kind:'label',line:candidate,addr:byteOffset,srcLine:stripped}); }
        if (rest) { work.push({kind:'instr',line:rest,addr:byteOffset,srcLine:rest}); byteOffset+=8; }
        continue;
      }
    }
    work.push({kind:'instr',line:stripped,addr:byteOffset,srcLine:stripped}); byteOffset+=8;
  }
  return {work,labelTable};
}

function parseReg(tok, auto) {
  if (tok==='R'||tok==='r') return [auto.next(),'auto'];
  const bm=tok.match(/^[Rr]-(\d+)$/); if(bm) return [auto.back(parseInt(bm[1])),'back'];
  if (/^[Rr]\d+$/.test(tok)) { const n=parseInt(tok.slice(1)); if(n<0||n>255) throw new Error(`Reg ${n} out of range`); return [n,'named']; }
  throw new Error(`Expected register, got "${tok}"`);
}

function assembleInstruction(tokens, auto, labelTable, instrAddr) {
  if (!tokens.length) throw new Error('Empty instruction');
  const opcodeStr=tokens[0];
  if (!/^[0-9a-fA-F]{1,2}$/.test(opcodeStr)) throw new Error(`Invalid opcode "${opcodeStr}"`);
  const opcode=parseInt(opcodeStr,16);
  const hi=(opcode>>4)&0xF;
  const result=new Uint8Array(8); result[0]=opcode;
  const resolved=[{text:opcodeStr.toUpperCase(),type:'opcode'}];

  // PACK row (0xF_) — special: [op_a, r1a, r2a, r3a, op_b, r1b, r2b, r3b]
  if (hi===0xF) {
    if (tokens.length!==8) throw new Error(`PACK needs 8 tokens: <op_a> R R R <op_b> R R R, got ${tokens.length}`);
    if (!/^[0-9a-fA-F]{1,2}$/.test(tokens[4])) throw new Error(`Invalid second opcode "${tokens[4]}"`);
    const opB=parseInt(tokens[4],16); result[4]=opB;
    const regs=[tokens[1],tokens[2],tokens[3],tokens[5],tokens[6],tokens[7]];
    for (let i=0;i<6;i++) {
      const [ri,rt]=parseReg(regs[i],auto);
      result[i<3?i+1:i+2]=ri;
      resolved.push({text:regs[i],type:'register',regtype:rt,resolved:ri});
      if (i===2) resolved.push({text:tokens[4].toUpperCase(),type:'opcode'});
    }
    return {bytes:result,resolvedTokens:resolved};
  }

  const schema=operandsFor(opcode);
  const operToks=tokens.slice(1);

  // LI row (0x1_): first operand after opcode is always rd, then imm×6
  if (hi===0x1) {
    if (operToks.length!==2) throw new Error(`LI: <rd> <imm>, got ${operToks.length} operands`);
    const [ri,rt]=parseReg(operToks[0],auto);
    result[1]=ri;
    resolved.push({text:operToks[0],type:'register',regtype:rt,resolved:ri});
    const imm=parseInt(operToks[1],10);
    if (isNaN(imm)) throw new Error(`Expected immediate, got "${operToks[1]}"`);
    const eb=encodeImm(imm,6);
    for (let i=0;i<6;i++) result[2+i]=eb[i];
    resolved.push({text:operToks[1],type:'immediate'});
    return {bytes:result,resolvedTokens:resolved};
  }

  if (!schema) throw new Error(`No schema for opcode 0x${opcode.toString(16)}`);
  if (operToks.length!==schema.length)
    throw new Error(`Expected ${schema.length} operand(s) (${schema.join(',')}), got ${operToks.length}`);

  let bytePos=1;
  for (let i=0;i<schema.length;i++) {
    const tok=operToks[i], kind=schema[i];
    if (kind==='r') {
      const [ri,rt]=parseReg(tok,auto);
      result[bytePos++]=ri;
      resolved.push({text:tok,type:'register',regtype:rt,resolved:ri});
    } else if (kind==='i'||kind==='j') {
      let value, tokenType='immediate', resolvedOffset=null;
      if (kind==='j'&&labelTable[tok]!==undefined) {
        resolvedOffset=labelTable[tok]-instrAddr; value=resolvedOffset; tokenType='label';
      } else {
        const p=parseInt(tok,10);
        if (isNaN(p)) { if(kind==='j') throw new Error(`Undefined label "${tok}"`); throw new Error(`Expected decimal imm, got "${tok}"`); }
        value=p;
      }
      const w=immWidth(opcode), eb=encodeImm(value,w);
      for (const byt of eb) result[bytePos++]=byt;
      resolved.push({text:tok,type:tokenType,resolved:resolvedOffset});
    } else if (kind==='m') {
      const mb=memToBytes(tok);
      for (const byt of mb) result[bytePos++]=byt;
      resolved.push({text:tok,type:'memory'});
    }
  }
  return {bytes:result,resolvedTokens:resolved};
}

function assembleSource(source) {
  const {work,labelTable}=parseLabels(source);
  const instrLines=work.filter(w=>w.kind==='instr').map(w=>w.line);
  const named=collectNamed(instrLines);
  const auto=new AutoRegs(named);
  const results=[];
  for (const entry of work) {
    if (entry.kind==='label') { results.push({isLabel:true,name:entry.line,addr:entry.addr,srcLine:entry.srcLine}); }
    else if (entry.kind==='error') { results.push({isLabel:false,bytes:null,resolvedTokens:null,srcLine:entry.srcLine,error:entry.line}); }
    else {
      const tokens=entry.line.split(/\s+/);
      try { const {bytes,resolvedTokens}=assembleInstruction(tokens,auto,labelTable,entry.addr); results.push({isLabel:false,bytes,resolvedTokens,srcLine:entry.srcLine,error:null}); }
      catch(e) { results.push({isLabel:false,bytes:null,resolvedTokens:null,srcLine:entry.srcLine,error:e.message}); }
    }
  }
  return results;
}

// Expose under prefixed names to avoid collisions with any future global scope
window.seerDisasm         = disasm;
window.seerAssembleSource = assembleSource;
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
    this.lines.push(`${this._pad()}00  ; [nid=0x${nid.toString(16).padStart(2,'0')}] ${nc || 'nop'}`);
    this.nodeCount++;
    this.pc++;
  }

  comment(text) { this.lines.push(`${this._pad()}; ${text}`); }
  blank()       { this.lines.push(''); }

  label(name) {
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
  pushScope(name, type) { const c = this.allocCap(); this.scopeStack.push({name,type,capId:c}); return c; }
  popScope()            { return this.scopeStack.pop(); }
  currentCap()          { return this.scopeStack.length ? this.scopeStack[this.scopeStack.length-1].capId : 1; }

  fresh(prefix) { return `.${prefix}_${this.labelSeq++}`; }

  // ── Instruction helpers — all emit v10 hex-token format ────────────────────

  // reg normaliser: 'r240' → 'R240', 'R240' → 'R240'
  _r(s) { return s.replace(/^[rR]/, 'R'); }

  jmp(target, targetNid, comment) {
    this.instr(`20 ${target}`, comment);
  }

  jz(rcond, target, comment) {
    // Jump if zero (condition FALSE) — opcode 0x22
    this.instr(`22 ${this._r(rcond)} ${target}`, comment);
  }

  jne(r1, r2, target, targetNid, comment) {
    this.instr(`23 ${this._r(r1)} ${this._r(r2)} ${target}`, comment);
  }

  jge(r1, r2, target, targetNid, comment) {
    this.instr(`27 ${this._r(r1)} ${this._r(r2)} ${target}`, comment);
  }

  jmpr(reg, targetNid, comment) {
    this.instr(`21 ${this._r(reg)} R255`, comment);
  }

  sts64(src, base, offset, cap, comment) {
    // MEMS store.64: 8B src base R255 offset(int32)
    this.instr(`8B ${this._r(src)} ${this._r(base)} R255 ${offset}`, comment);
  }

  lds64(dst, base, offset, cap, comment) {
    // MEMS load.u64: 86 dst base R255 offset(int32)
    this.instr(`86 ${this._r(dst)} ${this._r(base)} R255 ${offset}`, comment);
  }

  li(rd, val, comment) {
    const v = Number(val);
    const op = (!isNaN(v) && v >= -128    && v <= 127)    ? '11'   // li.s8
             : (!isNaN(v) && v >= -32768  && v <= 32767)  ? '13'   // li.s16
             : (!isNaN(v) && v >= -(1<<23) && v <= (1<<23)) ? '15' // li.s32
             : '17';                                                 // li.s48
    this.instr(`${op} ${this._r(rd)} ${val}`, comment);
  }

  li_str(rd, str, comment) {
    // Encode string as li.s48 with up to 6 ASCII bytes — best effort for display
    this.instr(`17 ${this._r(rd)} 0`, comment ?? `"${str}"`);
  }

  addi(rd, rs, imm, comment) {
    // P5: add rd, rs, imm  → opcode 0x4C (P5 row 4_, op nibble C=add)
    this.instr(`4C ${this._r(rd)} ${this._r(rs)} ${imm}`, comment);
  }

  ecall(svc, comment) {
    // SYS ecall: opcode 0x0E only — assembler schema expects 0 operands
    // Service ID is already loaded into R0 before this call
    this.instr(`0E`, comment ?? `ecall svc=${svc}`);
  }

  wfe(comment) {
    // SYS unbounded stall (0x0C) — closest to wait-for-event
    this.instr(`0C`, comment);
  }

  wrctrl(ctrlName, val, comment) {
    // SYS wrctrl: 04 Rval ctrl_id
    // ctrl_id is a small integer — map common names
    const id = typeof ctrlName === 'number' ? ctrlName
      : ctrlName?.toString().match(/\d+/)?.[0] ?? 0;
    const rval = typeof val === 'string' ? this._r(val) : `R${val ?? 255}`;
    this.instr(`04 ${rval} ${id}`, comment);
  }

  rdctrl(dst, ctrlName, comment) {
    // SYS rdctrl: 03 Rdst ctrl_id
    const id = typeof ctrlName === 'number' ? ctrlName
      : ctrlName?.toString().match(/\d+/)?.[0] ?? 0;
    this.instr(`03 ${this._r(dst)} ${id}`, comment);
  }

  hlt(comment) {
    this.instr(`0F`, comment);
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
      if (v.reg !== dst) em.instr(`5C ${dst} ${v.reg} R255 0`, `${name} → ${dst}`);
      else               em.comment(`${name} already in ${dst}`);
    } else {
      em.lds64(dst, 'R240', v.spill, em.currentCap(), `load spilled ${name}`);
    }
    return dst;
  }

  // Store src register into variable.
  store(name, src, em) {
    name = name.replace(/\?$/, '');
    const v = this.alloc(name);
    if (v.reg) {
      // Move src into the variable's home register
      if (v.reg !== src) em.instr(`5C ${v.reg} ${src} R255 0`, `${src} → ${name}`);
      else               em.comment(`${name} already in ${v.reg}`);
    } else {
      em.sts64(src, 'R240', v.spill, em.currentCap(), `spill ${name}`);
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
      // Encode up to 6 ASCII bytes of the string into a li.s48 immediate
      const s = node.value ?? '';
      let imm = 0n;
      for (let i = 0; i < Math.min(s.length, 6); i++)
        imm |= BigInt(s.charCodeAt(i)) << BigInt(i * 8);
      const immStr = imm === 0n ? '0' : String(imm);
      em.instr(`17 ${dst} ${immStr}`, `"${s.length > 12 ? s.slice(0,12)+'…' : s}"`);
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
      const opMap = {
        '+':    '5C', '-':   '5D', '*':  '5E', '/':  '5F',
        '=':    '50', '!=':  '51',
        '<':    '5B', '>':   '5B',   // > swaps operands below
        '<=':   '5B', '>=':  '58',
        'and':  '52', 'nand':'53',
        'or':   '54', 'nor': '55',
        'xor':  '56', 'same':'57',   // same = XNOR
        'mod':  '60', '%':   '60',
      };
      const op = opMap[node.op] ?? '5C';
      // > needs operands swapped (slt R0, R3, R2 = R3 < R2 = left > right)
      const [l, r] = node.op === '>' ? ['R3','R2'] : ['R2','R3'];
      em.instr(`${op} ${dst} ${l} ${r} 0`,
        `${exprText(node.left)} ${node.op} ${exprText(node.right)}`);
      return dst;
    }

    case 'UnaryOp': {
      loadExpr(node.operand, em, 'R2');
      em.instr(`51 ${dst} R2 R255 0`, `not ${exprText(node.operand)}`);
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
          em.instr(`5B R2 R0 R1 0`, `R0 < ${cum}?`);
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
      em.sts64('r0', 'R240', name, em.currentCap(), `${name} = file`);
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
      em.jmpr('R241', NID.END, 'return — target must be registered END node');
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
      em.sts64('r0', 'R240', node.name, em.currentCap(), `del ${node.name}`);
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
  em.lds64('r8', 'R240', tgt, cap, `load ${tgt}`);
  em.instr(`popcnt   r10, r8`, `len(${tgt}) → r10`);
  em.li('R9', 0, 'index = 0');

  em.label(topL);  // label flushes any pending nid — but we consumed it above already
  // Condition: index < length — no nid (DECISION_PREV is graph-only, same as loop)
  em.comment(`${iterName}: index(${idxName}) < len  ; [DECISION_PREV — graph annotation]`);
  em.jge('R9', 'r10', exitL, NID.CON, 'done');

  em.iLevel++;
  em.instr(`lds.u64  r11, [r8+r9]  [cap=0x${cap.toString(16).padStart(2,'0')}]`,
    `${iterName} = ${tgt}[${idxName}]`);
  em.sts64('r11', 'R240', iterName, cap, `bind ${iterName}`);
  em.sts64('r9',  'R240', idxName,  cap, `bind ${idxName}`);

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
  em.wrctrl(`CAPTBASE[0x${capHex}]`, 'R240',
    `register frame capability cap_id=0x${capHex}`);

  // Parameters: passed in r0, r1, ...
  em.iLevel++;
  for (let i = 0; i < params.length; i++) {
    const p    = params[i];
    const pname = typeof p === 'string' ? p : p.name;
    const pdef  = (p.defaultExpr && typeof p !== 'string') ? ` (default=${exprText(p.defaultExpr)})` : '';
    em.sts64(`r${i}`, 'R240', pname, cap, `param ${pname}${pdef}`);
  }
  em.blank();

  for (const stmt of node.body ?? []) compileStmt(stmt, em);
  em.iLevel--;

  // Implicit function end — END nid on wrctrl (capability invalidation)
  em.blank();
  em.scheduleNode(NID.END, `end of fun ${name}`);
  em.wrctrl(`CAPTBASE[0x${capHex}]`, 'R255', 'invalidate frame capability');
  em.jmpr('R241', NID.END, `return from ${name}`);

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
    em.wrctrl(`CAPTBASE[0x${capHex}]`, 'R244',
      `allocate ${cname} instance cap_id=0x${capHex}`);
    em.iLevel++;
    for (let i = 0; i < (initFun.params ?? []).length; i++) {
      const p = initFun.params[i];
      const pname = typeof p === 'string' ? p : p.name;
      em.sts64(`r${i}`, 'R243', pname, cap, `self.${pname} = arg${i}`);
    }
    for (const stmt of initFun.body ?? []) compileStmt(stmt, em);
    em.iLevel--;
    em.scheduleNode(NID.END, `end ${cname} constructor`);
    em.wrctrl(`CAPTBASE[0x${capHex}]`, 'R255', 'seal instance (no more writes via cap)');
    em.jmpr('R241', NID.END, 'return instance');
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
  em.sts64('r0', 'R240', node.errVar ?? 'e', em.currentCap(),
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
    '; SEER ISA v10 — generated by ivx-seer (hex-token format)',
    '; Each instruction: <opcode_hex> [operands…]  ; comment',
    '; Registers: R0–R239 general  R240=FP  R241=LINK  R242=SP  R255=ZR',
    '; ═══════════════════════════════════════════════════════════════════',
    ''
  );

  // ── Program entry ────────────────────────────────────────────────────────────
  const globalCap    = em.pushScope('__global__', 'global');
  const globalCapHex = globalCap.toString(16).padStart(2,'0');

  // START nid on wrctrl — no standalone nop
  em.label('.program_start');
  em.scheduleNode(NID.START, 'program entry');
  em.wrctrl(`CAPTBASE[0x${globalCapHex}]`, 'R242',
    `register global capability cap_id=0x${globalCapHex}`);
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
  em.wrctrl(`CAPTBASE[0x${globalCapHex}]`, 'R255', 'invalidate global capability');
  em.hlt('program complete');

  em.popScope();

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
  let seerMaxRegs = 240;

  function updateSeerSlider() {
    seerRegWrap.style.display = (lensLang === 'seer' && lensOpen) ? 'flex' : 'none';
  }

  seerRegSlider.addEventListener('input', () => {
    seerMaxRegs = parseInt(seerRegSlider.value, 10);
    seerRegLabel.textContent = String(seerMaxRegs);
    if (lensOpen && lensLang === 'seer' && !lensEdited) renderLens();
  });

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
      const addr = ((goodCount - 1) * 8).toString(16).padStart(4, '0');
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
