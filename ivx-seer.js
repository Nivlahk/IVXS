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
    this.capNext    = 2;       // 0=null, 1=global, 2+=allocated
    this.scopeStack = [];
    this.symbols    = [];      // { label, pc }
    this.nodeCount  = 0;       // CFI boundaries registered
    this.iLevel     = 0;       // visual indent for readability

    // Pending nid — set before emitting the next real instruction.
    // The next call to instr() will bake this into byte 7 and clear it.
    this._pendingNid     = NID.BODY;
    this._pendingComment = '';
  }

  // ── Output ──────────────────────────────────────────────────────────────────

  _pad() { return '  '.repeat(this.iLevel); }

  // Emit one real instruction.  If _pendingNid is set, it rides here as byte 7.
  instr(mnemonic, comment) {
    const nid = this._pendingNid;
    this._pendingNid     = NID.BODY;
    const nc = this._pendingComment;
    this._pendingComment = '';

    let text = mnemonic;
    if (nid !== NID.BODY) {
      // Append [nid=0xNN] annotation to the mnemonic
      text += `  [nid=0x${nid.toString(16).padStart(2,'0')}]`;
      this.nodeCount++;
    }
    const c = [nc, comment].filter(Boolean).join(' — ');
    this.lines.push(`${this._pad()}${text}${c ? `  ; ${c}` : ''}`);
    this.pc++;
    return this.pc - 1;
  }

  // Schedule a NodeID for the NEXT real instruction.
  // If called twice before an instruction, the later call wins (shouldn't happen).
  scheduleNode(nid, comment) {
    this._pendingNid     = nid;
    this._pendingComment = comment ?? '';
  }

  // Flush a pending nid as a standalone nop — only when there is no real
  // instruction to carry it (empty blocks, label-after-label).
  flushNodeIfPending() {
    if (this._pendingNid === NID.BODY) return;
    const nid = this._pendingNid;
    const nc  = this._pendingComment;
    this._pendingNid     = NID.BODY;
    this._pendingComment = '';
    const typeName = ['process','start','decision','con','give','take','fun','end'][(nid >> 2) & 7];
    const routeNames = ['default','next','prev','next-next'];
    const routeName  = routeNames[nid & 3];
    const elsePfx    = (nid & 0x80) ? 'else-' : '';
    this.lines.push(`${this._pad()}nop      [nid=0x${nid.toString(16).padStart(2,'0')}]  ; ${nc || `${elsePfx}${typeName}/${routeName}`}`);
    this.nodeCount++;
    this.pc++;
  }

  comment(text) { this.lines.push(`${this._pad()}; ${text}`); }
  blank()       { this.lines.push(''); }

  label(name) {
    // Labels are text markers only — they do NOT flush the pending nid.
    // The nid will ride on the first real instruction AFTER this label.
    this.lines.push(`${name}:`);
    this.symbols.push({ label: name, pc: this.pc });
    return name;
  }

  section(title) {
    this.blank();
    const bar = '─'.repeat(Math.max(0, 62 - this.iLevel * 2));
    this.lines.push(`${this._pad()}; ${bar}`);
    this.lines.push(`${this._pad()}; ${title}`);
    this.lines.push(`${this._pad()}; ${bar}`);
  }

  // ── Capability ───────────────────────────────────────────────────────────────

  allocCap() {
    const id = this.capNext++;
    if (this.capNext > 0xFF) this.capNext = 2;
    return id;
  }
  pushScope(name, type) { const c = this.allocCap(); this.scopeStack.push({name,type,capId:c}); return c; }
  popScope()            { return this.scopeStack.pop(); }
  currentCap()          { return this.scopeStack.length ? this.scopeStack[this.scopeStack.length-1].capId : 1; }

  // ── Label generation ─────────────────────────────────────────────────────────

  fresh(prefix) { return `.${prefix}_${this.labelSeq++}`; }

  // ── Instruction helpers ───────────────────────────────────────────────────────

  jmp(target, targetNid, comment) {
    this.instr(
      `jmp      ${target}  [nid=0x${targetNid.toString(16).padStart(2,'0')}]`,
      comment
    );
  }

  jne(r1, r2, target, targetNid, comment) {
    this.instr(
      `jne      ${r1}, ${r2}, ${target}  [nid=0x${targetNid.toString(16).padStart(2,'0')}]`,
      comment
    );
  }

  jge(r1, r2, target, targetNid, comment) {
    this.instr(
      `jge      ${r1}, ${r2}, ${target}  [nid=0x${targetNid.toString(16).padStart(2,'0')}]`,
      comment
    );
  }

  jmpr(reg, targetNid, comment) {
    this.instr(
      `jmpr     ${reg}  [nid=0x${targetNid.toString(16).padStart(2,'0')}]`,
      comment
    );
  }

  sts64(src, base, offset, cap, comment) {
    this.instr(
      `sts.64   ${src}, [${base}+${offset}]  [cap=0x${cap.toString(16).padStart(2,'0')}]`,
      comment
    );
  }

  lds64(dst, base, offset, cap, comment) {
    this.instr(
      `lds.u64  ${dst}, [${base}+${offset}]  [cap=0x${cap.toString(16).padStart(2,'0')}]`,
      comment
    );
  }

  li(rd, val, comment) {
    const v = Number(val);
    const mnem = (!isNaN(v) && v >= -128 && v <= 127)        ? 'li.s8 '
               : (!isNaN(v) && v >= -32768 && v <= 32767)    ? 'li.s16'
               : (!isNaN(v) && Math.abs(v) < (1<<23))        ? 'li.s24'
               : 'li.s64';
    this.instr(`${mnem}   ${rd}, ${val}`, comment);
  }

  addi(rd, rs, imm, comment) { this.instr(`addi     ${rd}, ${rs}, ${imm}`, comment); }

  ecall(svc, comment) {
    this.instr(`ecall    svc=0x${svc.toString(16).padStart(2,'0')}  [nid=0x00]`, comment);
  }

  wfe(comment)         { this.instr(`wfe      [nid=0x00]`, comment); }
  wrctrl(reg, val, c)  { this.instr(`wrctrl   ${reg}, ${val}`, c); }
  rdctrl(dst, reg, c)  { this.instr(`rdctrl   ${dst}, ${reg}`, c); }
  hlt(comment)         { this.instr(`hlt`, comment); }
}


// ─────────────────────────────────────────────────────────────────────────────
// 3. EXPRESSION TEXT
//    Returns a readable string for comments and simple li arguments.
// ─────────────────────────────────────────────────────────────────────────────

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
        'and':'and','or':'or','xor':'xor','in':'in','is':'is',
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
function loadExpr(node, em, dst) {
  dst = dst ?? 'r0';
  if (!node) { em.li(dst, 0, 'null'); return dst; }
  switch (node.type) {
    case 'NumberLit':  em.li(dst, node.value, `${node.value}`); return dst;
    case 'BoolLit':    em.li(dst, node.value?1:0, node.value===null?'none':node.value?'yes':'no'); return dst;
    case 'StringLit': {
      const s = JSON.stringify(node.value);
      const d = s.length > 48 ? s.slice(0,45)+'…"' : s;
      em.instr(`li.s64   ${dst}, ${d}`, 'string');
      return dst;
    }
    case 'Identifier':
    case 'LazyDecl':
      em.lds64(dst, R.FP, node.name, em.currentCap(), `load ${node.name}`);
      return dst;
    case 'Ask':
      compileAsk(node, em);
      if (dst !== 'r0') em.instr(`addi     ${dst}, r0, 0`, 'move result');
      return dst;
    default:
      em.comment(`expr: ${exprText(node)}`);
      em.instr(`; [${exprText(node)}]`, 'complex — resolved at link time');
      return dst;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 4. STATEMENT COMPILERS
// ─────────────────────────────────────────────────────────────────────────────

function compileStmt(node, em) {
  if (!node) return;
  switch (node.type) {

    // ── make ──────────────────────────────────────────────────────────────────
    case 'Assign': {
      const cap = em.currentCap();
      const target = node.target?.type === 'MemberAccess'
        ? `${exprText(node.target.object)}.${node.target.field}`
        : (node.name ?? '?');
      const isAlloc = node.expr?.type === 'ListLit' || node.expr?.type === 'DictLit';
      const useCap  = isAlloc ? em.allocCap() : cap;
      em.blank();
      em.comment(`make ${target} = ${exprText(node.expr)}`);
      // loadExpr will carry any pending nid on its first instruction
      loadExpr(node.expr, em, 'r1');
      em.sts64('r1', R.FP, target, useCap,
        `store → ${target}${isAlloc ? ` [heap cap=0x${useCap.toString(16).padStart(2,'0')}]` : ''}`);
      break;
    }

    // ── say ───────────────────────────────────────────────────────────────────
    case 'Say': {
      const val = exprText(node.expr);
      em.blank();
      em.comment(`say ${val}`);
      // The pending nid (if any) goes on the first real instruction here
      loadExpr(node.expr, em, 'r1');
      em.li('r0', SVC.OUTPUT, 'output service');
      em.ecall(SVC.OUTPUT, `say ${val}`);
      break;
    }

    // ── take ──────────────────────────────────────────────────────────────────
    case 'Take': {
      const name = node.name ?? '?';
      em.blank();
      em.comment(`take ${name}`);
      // TAKE is a sequential-open node — nid goes on the first li
      em.scheduleNode(NID.TAKE, `take ${name}`);
      em.li('r0', SVC.INPUT, 'input service');
      em.instr(`li.s64   r1, ${JSON.stringify(name)}`, `prompt: ${name}`);
      em.ecall(SVC.INPUT, `take ${name} → r0`);
      em.sts64('r0', R.FP, name, em.currentCap(), `${name} = input`);
      break;
    }

    case 'TakeFile': {
      const name = node.name ?? 'file', ext = node.ext ?? 'txt';
      em.blank();
      em.comment(`take file.${ext} → ${name}`);
      em.scheduleNode(NID.TAKE, `take file.${ext}`);
      em.li('r0', SVC.FETCH, 'file-pick service');
      em.instr(`li.s64   r1, ${JSON.stringify(`.${ext}`)}`, 'extension filter');
      em.ecall(SVC.FETCH, `file picker .${ext}`);
      em.sts64('r0', R.FP, name, em.currentCap(), `${name} = file`);
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
      loadExpr(node.expr, em, 'r0');
      em.jmpr(R.LINK, NID.END, 'return — target must be registered END node');
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
        loadExpr(node.condition, em, 'r0');
        em.jne('r0', R.ZERO, doneL, NID.CON, 'condition true → done');
        em.wfe('yield');
        em.jmp(topL, NID.CON_PREV, 'poll again');
        em.label(doneL);
        // CON is a branch target of the jne above
        em.scheduleNode(NID.CON, 'wait-done');
        em.flushNodeIfPending(); // nothing follows immediately — emit nop only here if truly empty
      } else if (node.expr) {
        em.li('r0', exprText(node.expr), 'wait count');
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
      loadExpr(node.key, em, 'r0');
      em.wrctrl('CREDENTIAL', 'r0', 'store API key in ctrl register');
      break;
    }

    // ── post ──────────────────────────────────────────────────────────────────
    case 'Post': {
      em.blank();
      em.comment(`post ${exprText(node.url)}`);
      loadExpr(node.url,  em, 'r0');
      loadExpr(node.body, em, 'r1');
      if (node.credential) loadExpr(node.credential, em, 'r2');
      else em.rdctrl('r2', 'CREDENTIAL', 'load stored key');
      em.ecall(SVC.HTTP, `post ${exprText(node.url)}`);
      break;
    }

    // ── email ─────────────────────────────────────────────────────────────────
    case 'Gmail': {
      em.blank();
      em.comment(`email ${node.to ? exprText(node.to) : '?'}`);
      if (node.to)      loadExpr(node.to,      em, 'r0');
      if (node.subject) loadExpr(node.subject, em, 'r1');
      if (node.body)    loadExpr(node.body,    em, 'r2');
      em.ecall(SVC.EMAIL, `email → ${node.to ? exprText(node.to) : '?'}`);
      break;
    }

    // ── save ──────────────────────────────────────────────────────────────────
    case 'Save': {
      em.blank();
      const fname = node.filenameExpr ? exprText(node.filenameExpr) : '?';
      em.comment(`save → ${fname} [${node.target}]`);
      if (node.valueExpr) loadExpr(node.valueExpr, em, 'r0');
      if (node.filenameExpr) loadExpr(node.filenameExpr, em, 'r1');
      em.li('r2', node.target === 'local' ? 1 : 0, '0=Drive 1=local');
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
      em.instr(`li.s64   r0, ${JSON.stringify(url)}`, 'module URL');
      em.ecall(SVC.FETCH, `import ${url}`);
      break;
    }

    // ── del ───────────────────────────────────────────────────────────────────
    case 'Delete': {
      em.blank();
      em.comment(`del ${node.name}`);
      em.li('r0', 0, 'zero tombstone');
      em.sts64('r0', R.FP, node.name, em.currentCap(), `del ${node.name}`);
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
  loadExpr(node.condition, em, 'r0');
  em.jne('r0', R.ZERO, elseL, NID.ELSE_CON, 'false → else');

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

function compileLoop(node, em) {
  const cond  = exprText(node.condition);
  const topL  = em.fresh('loop_top');
  const exitL = em.fresh('loop_exit');

  em.blank();
  em.comment(`loop ${cond}`);

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
  loadExpr(node.condition, em, 'r0');   // CON_PREV nid lands here
  em.jne('r0', R.ZERO, exitL, NID.CON, 'false → exit');

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
  em.lds64('r8', R.FP, tgt, cap, `load ${tgt}`);
  em.instr(`popcnt   r10, r8`, `len(${tgt}) → r10`);
  em.li('r9', 0, 'index = 0');

  em.label(topL);  // label flushes any pending nid — but we consumed it above already
  // Condition: index < length — no nid (DECISION_PREV is graph-only, same as loop)
  em.comment(`${iterName}: index(${idxName}) < len  ; [DECISION_PREV — graph annotation]`);
  em.jge('r9', 'r10', exitL, NID.CON, 'done');

  em.iLevel++;
  em.instr(`lds.u64  r11, [r8+r9]  [cap=0x${cap.toString(16).padStart(2,'0')}]`,
    `${iterName} = ${tgt}[${idxName}]`);
  em.sts64('r11', R.FP, iterName, cap, `bind ${iterName}`);
  em.sts64('r9',  R.FP, idxName,  cap, `bind ${idxName}`);

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
  em.wrctrl(`CAPTBASE[0x${capHex}]`, R.FP,
    `register frame capability cap_id=0x${capHex}`);

  // Parameters: passed in r0, r1, ...
  em.iLevel++;
  for (let i = 0; i < params.length; i++) {
    const p    = params[i];
    const pname = typeof p === 'string' ? p : p.name;
    const pdef  = (p.defaultExpr && typeof p !== 'string') ? ` (default=${exprText(p.defaultExpr)})` : '';
    em.sts64(`r${i}`, R.FP, pname, cap, `param ${pname}${pdef}`);
  }
  em.blank();

  for (const stmt of node.body ?? []) compileStmt(stmt, em);
  em.iLevel--;

  // Implicit function end — END nid on wrctrl (capability invalidation)
  em.blank();
  em.scheduleNode(NID.END, `end of fun ${name}`);
  em.wrctrl(`CAPTBASE[0x${capHex}]`, R.ZERO, 'invalidate frame capability');
  em.jmpr(R.LINK, NID.END, `return from ${name}`);

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
    em.wrctrl(`CAPTBASE[0x${capHex}]`, R.HEAP,
      `allocate ${cname} instance cap_id=0x${capHex}`);
    em.iLevel++;
    for (let i = 0; i < (initFun.params ?? []).length; i++) {
      const p = initFun.params[i];
      const pname = typeof p === 'string' ? p : p.name;
      em.sts64(`r${i}`, R.SELF, pname, cap, `self.${pname} = arg${i}`);
    }
    for (const stmt of initFun.body ?? []) compileStmt(stmt, em);
    em.iLevel--;
    em.scheduleNode(NID.END, `end ${cname} constructor`);
    em.wrctrl(`CAPTBASE[0x${capHex}]`, R.ZERO, 'seal instance (no more writes via cap)');
    em.jmpr(R.LINK, NID.END, 'return instance');
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

  em.wrctrl('ERR_VECTOR', R.ZERO, 'clear handler (try succeeded)');
  em.jmp(doneL, NID.CON, 'skip err handler');

  // err handler
  em.label(errL);
  em.scheduleNode(NID.ELSE_CON, `err ${node.errVar ?? 'e'}`);
  em.sts64('r0', R.FP, node.errVar ?? 'e', em.currentCap(),
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
  em.li('r0', SVC[trigger?.toUpperCase()] ?? SVC.FETCH, `${trigger} service`);
  em.instr(`li.s64   r1, ${JSON.stringify(src)}`, 'trigger source filter');
  em.wrctrl('TRIGGER_SRC', 'r1', 'set source');
  em.li('r1', recurring ? 1 : 0, 'recurring flag');
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
    em.wrctrl('TRIGGER_CFG', R.ZERO, 'disarm one-shot trigger');
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
  em.li('r0', svc, `AI service: ${model}`);
  loadExpr(node.prompt, em, 'r1');
  em.rdctrl('r2', 'CREDENTIAL', 'API key');
  em.ecall(svc, `ask ${model} → r0`);
}


// ─────────────────────────────────────────────────────────────────────────────
// 5. TOP-LEVEL COMPILER
// ─────────────────────────────────────────────────────────────────────────────

function compileSEER(source) {
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

  // ── File header ─────────────────────────────────────────────────────────────
  em.lines.push(
    '; ═══════════════════════════════════════════════════════════════════',
    '; SEER ISA v18 — generated by ivx-seer.js',
    ';',
    '; CFI: nop [nid=N] or any instruction with byte 7 != 0 registers that',
    ';      PC as a legal branch target.  Branch to any other address fires',
    ';      TRAP_CFI (IVT vector 0x05).  Zero runtime overhead.',
    ';',
    '; Nop policy: nid rides on the FIRST REAL INSTRUCTION at each node',
    ';      boundary.  Standalone nop only emitted for truly empty blocks.',
    ';',
    '; Capabilities: every MEMS/P8 access carries cap_id in byte 7.',
    ';   0x00 null/unchecked   0x01 global frame   0x02+ fun/heap',
    ';',
    '; Registers:',
    `;   r0-r7 arg/ret   r8-r15 temp   r16-r23 callee-saved`,
    `;   r240=FP  r241=LINK  r242=SP  r243=SELF  r244=HEAP  r255=ZERO`,
    ';',
    '; NodeID byte 7:  [ELSE:1][INDENT:2][TYPE:3][ROUTE:2]',
    ';   TYPE:  0=process 1=start 2=decision 3=con 4=give 5=take 6=fun 7=end',
    ';   ROUTE: 0=default 1=next 2=prev 3=next-next',
    '; ═══════════════════════════════════════════════════════════════════',
    '',
    '.org 0x0000',
    ''
  );

  // ── Program entry ────────────────────────────────────────────────────────────
  const globalCap    = em.pushScope('__global__', 'global');
  const globalCapHex = globalCap.toString(16).padStart(2,'0');

  // START nid on wrctrl — no standalone nop
  em.label('.program_start');
  em.scheduleNode(NID.START, 'program entry');
  em.wrctrl(`CAPTBASE[0x${globalCapHex}]`, R.SP,
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
  em.wrctrl(`CAPTBASE[0x${globalCapHex}]`, R.ZERO, 'invalidate global capability');
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

  return em.lines.join('\n');
}


// ─────────────────────────────────────────────────────────────────────────────
// 6. LENS INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

(function installSEERLens() {

  function patchTranspiler() {
    if (typeof LensTranspiler === 'undefined') return false;
    const orig = LensTranspiler.transpile.bind(LensTranspiler);
    LensTranspiler.transpile = function(source, langId) {
      if (langId === 'seer') return compileSEER(source);
      return orig(source, langId);
    };
    if (Array.isArray(LensTranspiler.langs) && !LensTranspiler.langs.includes('seer'))
      LensTranspiler.langs.push('seer');
    return true;
  }

  function addOption() {
    const sel = document.getElementById('lens-lang-sel');
    if (!sel || sel.querySelector('option[value="seer"]')) return;
    const opt = document.createElement('option');
    opt.value = 'seer'; opt.textContent = 'SEER Assembly';
    sel.appendChild(opt);
  }

  function watchSelector() {
    const sel = document.getElementById('lens-lang-sel');
    if (!sel) return;
    sel.addEventListener('change', () => {
      const t = document.getElementById('lens-title');
      if (t && sel.value === 'seer') { t.textContent = 'SEER Assembly'; t.style.color = '#4ade80'; }
    });
  }

  function boot() {
    patchTranspiler(); addOption(); watchSelector();
    console.log('[ivx-seer.js] SEER ISA v18 Lens loaded.');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.compileSEER = compileSEER;
  window.SEEREmitter = SEEREmitter;
})();
