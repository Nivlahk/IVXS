// ── ivx_lower.js ────────────────────────────────────────────────────────────
// Phase 2: the lowerer itself. Kinded IVX UAST -> compileCFSource text
// dialect + a total source map, conforming to ivx_lower_contract.js.
//
// Input is the AST word_kh.js already produces (verified node-for-node
// against the real KH parser), optionally kind-tagged by ivx_semantic.js.
// Output is valid input to stage2Allocate() -- symbolic names only, no
// physical registers, no compound conditions, no out-of-range immediates.
//
// ── ABI: TESTED, AND THE FIRST DECISION WAS WRONG ───────────────────────────
// `def name():` is strictly zero-arg with no return value, so the lowerer
// owns the calling convention outright.
//
// FIRST CHOICE (fixed symbolic names __arg0..N / __ret0, relying on
// stage2Allocate to spill anything live across a call) IS UNSOUND FOR
// RECURSION, and abi_tests.js now proves it: fact(4) returns 8 instead of
// 24 -- 2^3, because every frame reads the innermost frame's saved value.
// The reasoning behind that choice was that the allocator's spilling would
// cover re-entrancy. It does not, and cannot: a spill slot is a FIXED dmem
// address per name, not a stack, so recursion overwrites it exactly the way
// a register would. "The allocator handles it" was the wrong inference.
//
// Worse, fact(2) PASSES -- only one frame ever needs preserving and it is
// the last one written. A shallow smoke test would have shipped this.
//
// CORRECTED ABI: a real call stack in dmem.
//   - abiPrologue() builds the stack-capability token from CF source using
//     only li/sll/or -- the same 12 instructions generateStackCapTokenLines
//     emits, but with symbolic names instead of the spill machinery's
//     reserved registers. No engine change needed for this part.
//   - __sp starts at the top of the dmem region and grows DOWN; spill slots
//     grow UP from SPILL_BASE_ADDR, so the two only meet after a few
//     hundred frames.
//   - A caller pushes anything live across the call, and pops it after.
// Verified: fact(8) = 40320, and a recursive program that ALSO spills keeps
// both regions intact.
//
// Non-recursive calls work under either convention; the fixed-slot form is
// still used for argument PASSING (__arg0..N / __ret0), since those are
// dead across the call by construction. It is only values live ACROSS a
// call that need the stack.
//
// ── THE ONE UNVERIFIED TABLE ────────────────────────────────────────────────
// SEER_OPS below is the only place in this file that guesses. Every
// mnemonic marked `verified: true` was read verbatim out of
// Soak_tester.html. The 3-operand register-register ALU mnemonics were
// NOT -- SIM_ALU_R's key list was never in view. They follow the obvious
// RISC naming and `slt` is corroborated by the x86-64 lens work, but
// obvious is not verified. checkOpTable() below diffs this table against
// the real OPCODES map and is the first thing the conformance run should
// call. If a name is wrong, exactly one table changes and nothing else in
// this file moves.
'use strict';

const { CFEmitter, REFUSAL_CODES, FIDELITY } = require('./ivx_lower_contract.js');

// All CHECKED against the real engine now. The check inverted the guess:
// add/sub/mul/slt -- the four flagged as unverified -- were all correct,
// while `li`, marked verified because stage2Allocate emits it, is not in
// OPCODES at all. It is a PP PSEUDO-OP resolved inside encode(), which is
// why checkOpTable() consults FORMAT as well. Assuming "the allocator emits
// it, so it must be an instruction" was the wrong inference.
const SEER_OPS = {
  li:    { pseudo: true },   // PP -> li.captr (0..0xFFFF) or addi rd,zr,imm8 (-128..-1)
  addi:  {}, subi: {}, muli: {}, slli: {}, srli: {}, srai: {}, slti: {},
  andi:  {}, ori: {}, xori: {},
  add:   {}, sub: {}, mul: {}, div: {}, mod: {},
  and:   {}, or: {}, xor: {}, sll: {}, srl: {}, sra: {}, slt: {},
  hlt:   {}, nop: {}, ecall: {},
};

const IMM8 = [-128, 127];

// Diff SEER_OPS against the engine's real opcode table. Call this first.
// A mnemonic is legitimate if it is a real opcode OR a pseudo-op that
// encode() knows how to resolve. Checking only OPCODES reports `li` as
// missing, which is how the pseudo-op distinction surfaced.
function checkOpTable(OPCODES, FORMAT) {
  const missing = Object.keys(SEER_OPS).filter(m => {
    if (OPCODES && m in OPCODES) return false;
    if (FORMAT && FORMAT[m] === 'PP') return false;
    return true;
  });
  const pseudos = Object.entries(SEER_OPS).filter(([, d]) => d.pseudo).map(([m]) => m);
  return {
    ok: missing.length === 0, missing, pseudos,
    message: missing.length
      ? `SEER_OPS names in neither OPCODES nor FORMAT-as-PP: ${missing.join(', ')}. `
        + `Fix SEER_OPS; nothing else in ivx_lower.js needs to change.`
      : `all ${Object.keys(SEER_OPS).length} mnemonics resolve `
        + `(${pseudos.length} pseudo-op: ${pseudos.join(', ')})`,
  };
}

// KH's `=` is equality. CF's native branch ops are == != < >= <u >=u;
// `>` and `<=` are operand-swap sugar that parseCFCondition resolves, so
// emitting them is legal -- but the map records the canonical native form
// so Phase 3 never shows a reversed comparison.
const CMP = {
  '=':  { cf: '==', native: '==', swap: false },
  '!=': { cf: '!=', native: '!=', swap: false },
  '<':  { cf: '<',  native: '<',  swap: false },
  '>=': { cf: '>=', native: '>=', swap: false },
  '>':  { cf: '>',  native: '<',  swap: true  },
  '<=': { cf: '<=', native: '>=', swap: true  },
};
const INVERT = { '=': '!=', '!=': '=', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
// div and mod are real opcodes and both truncate toward zero on the signed
// value (SIM_ALU_R uses BigInt division), and both return 0 on a zero
// divisor rather than trapping -- worth knowing, since that differs from
// most host languages and silently produces 0 instead of raising.
const ARITH = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod' };

// ── ABI emitters ────────────────────────────────────────────────────────────
// Kept as standalone functions so the ABI is testable (and tested) before
// the front end grows function syntax -- word_kh's subset has no `fun`, so
// nothing in the current lowering path emits a `def` yet.

/**
 * The 12-instruction stack-capability token build, in CF-dialect form.
 * Constants come from the engine rather than being hardcoded here, so a
 * change to STACK_CAP_* cannot silently desynchronise the two.
 */
function abiPrologue(engine, names = {}) {
  const cap = names.cap || '__cap';
  const s1 = names.s1 || '__cs1';
  const s2 = names.s2 || '__cs2';
  const sp = names.sp || '__sp';
  const macLo = Number(engine.STACK_CAP_MAC & 0xFFFFn);
  const macHi = Number((engine.STACK_CAP_MAC >> 16n) & 0xFFFFn);
  return [
    `li ${cap}, ${engine.STACK_CAP_IDX}`,
    `li ${s1}, ${engine.STACK_CAP_GEN}`,
    `li ${s2}, 16`,
    `sll ${s1}, ${s1}, ${s2}`,
    `or ${cap}, ${cap}, ${s1}`,
    `li ${s1}, ${macHi}`,
    `sll ${s1}, ${s1}, ${s2}`,
    `li ${s2}, ${macLo}`,
    `or ${s1}, ${s1}, ${s2}`,
    `li ${s2}, 32`,
    `sll ${s1}, ${s1}, ${s2}`,
    `or ${cap}, ${cap}, ${s1}`,
    // Grows DOWN from the top of dmem; spill slots grow UP from
    // SPILL_BASE_ADDR, so they only meet after a few hundred frames.
    `li ${sp}, ${engine.STACK_CAP_SIZE - 8}`,
  ];
}

/** Push a value that must survive a call. */
function abiPush(name, cap = '__cap', sp = '__sp') {
  return [`sts64 ${name}, ${cap}, ${sp}`, `subi ${sp}, ${sp}, 8`];
}

/** Pop it back afterwards. Must mirror abiPush exactly, or __sp drifts. */
function abiPop(name, cap = '__cap', sp = '__sp') {
  return [`addi ${sp}, ${sp}, 8`, `ld64 ${name}, ${cap}, ${sp}`];
}

// NAMESPACE COLLISION, found by the function fuzzer: a user variable named
// `r0` is indistinguishable from physical register 0. stage2Allocate does
// not allocate it (it looks already-allocated) and substituteSymbolicNames
// leaves it alone, so it silently collides with whatever the allocator puts
// in that register -- confirmed: `make r0 5` produced a program where the
// allocator handed r0 to a different variable.
//
// Mangled rather than rejected: `r0` is a perfectly reasonable name in KH,
// and the collision is an artifact of the target dialect, not the user's
// problem. Only colliding names are touched, so ordinary names stay
// readable in the emitted CF and in the Phase 3 altitude views.
const REGISTER_SHAPED = /^(?:r\d+|zr)$/i;
function safeName(name) {
  return REGISTER_SHAPED.test(name) ? `__u_${name}` : name;
}

// ── Liveness for caller-saves ───────────────────────────────────────────────
// A local only needs pushing across a call if something READS it afterwards.
// The first version saved every local unconditionally, which was correct but
// made ABI scaffolding 64% of a recursive program and capped recursion at
// ~149 frames (usable stack / 8 / saves-per-frame).
//
// This is a syntactic approximation, not a real CFG liveness pass, and it is
// deliberately biased toward saving too much:
//   - a read at any LATER pre-order position counts;
//   - if the call sits inside a loop, a read ANYWHERE in that loop counts,
//     because the back edge makes "later in the text" the wrong question.
// Both rules can only ADD names to the save set. Getting this wrong in the
// other direction is precisely the fixed-slot failure (fact(4) == 8), so the
// bias is the whole point.
function analyzeFunctionLiveness(fnNode) {
  // Ordered events, reads before writes within a statement (an assignment
  // evaluates its right-hand side before it stores).
  const events = [];       // {pos, name, kind: 'read'|'write'}
  const loops = [];        // {start, end}
  let pos = 0;

  const readExpr = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier') { events.push({ pos, name: safeName(node.name), kind: 'read' }); return; }
    for (const k of ['left', 'right', 'operand', 'expr']) readExpr(node[k]);
    if (Array.isArray(node.args)) node.args.forEach(readExpr);
  };

  const walk = stmts => {
    for (const st of stmts || []) {
      pos++;
      switch (st.type) {
        case 'Assign':
          readExpr(st.expr);
          events.push({ pos, name: safeName(st.name), kind: 'write' });
          break;
        case 'Print': case 'Speak': case 'Give': readExpr(st.expr); break;
        case 'If':
          readExpr(st.condition);
          walk(st.body); walk(st.else_);
          break;
        case 'Loop': {
          const start = pos;
          readExpr(st.condition);
          walk(st.body);
          loops.push({ start, end: pos });
          break;
        }
        case 'For': {
          const start = pos;
          walk(st.body);
          loops.push({ start, end: pos });
          break;
        }
        default: break;
      }
    }
  };
  walk(fnNode.body || []);

  return {
    /**
     * Names that must survive a call at pre-order position p.
     *
     * A name is live iff its FIRST event after p is a read: if it is
     * written first, the old value is dead and pushing it is pure cost.
     * Without this kill-tracking, fib saved 4 values per frame where 2 are
     * genuinely needed -- `make y fb(b)` was pushing `y`, whose only later
     * read comes after `y` is reassigned.
     *
     * Approximations, all of which can only ADD names (never remove one
     * that is genuinely needed):
     *   - a call inside a loop saves everything read anywhere in that loop,
     *     because the back edge makes "later in the text" the wrong test;
     *   - branches are not distinguished, so a read on one arm counts.
     * The bias is deliberate: under-saving is the fixed-slot failure
     * (fact(4) == 8), and it is silent.
     */
    liveAfter(p) {
      const out = new Set();
      const seen = new Set();
      for (const e of events) {
        if (e.pos <= p || seen.has(e.name)) continue;
        seen.add(e.name);
        if (e.kind === 'read') out.add(e.name);
      }
      for (const lp of loops) {
        if (p >= lp.start && p <= lp.end) {
          for (const e of events) {
            if (e.pos >= lp.start && e.pos <= lp.end && e.kind === 'read') out.add(e.name);
          }
        }
      }
      return out;
    },
  };
}

function readsName(node, name) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Identifier') return safeName(node.name) === name;
  return ['left', 'right', 'operand', 'expr'].some(k => readsName(node[k], name))
      || (Array.isArray(node.args) && node.args.some(a => readsName(a, name)));
}

function containsCall(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Call') return true;
  return ['left', 'right', 'operand', 'expr'].some(k => containsCall(node[k]))
      || (Array.isArray(node.args) && node.args.some(containsCall));
}

let __uid = 0;
function nextId(kind) { return `${kind}#${__uid++}`; }
// null, not 0: 0 reads as a plausible line number to a consumer that only
// checks the upper bound, and the FLAT altitude test caught exactly that.
function locOf(node) { return { line: node.line ?? null, col: node.col ?? null }; }

class Lowerer {
  constructor(ctx) {
    this.ctx = ctx;
    this.e = new CFEmitter();
    this.outputs = [];      // names to read back at halt -- see NO_OBSERVABLE_ECALL
    this.definedFns = new Map();   // name -> {params, node}
    this.fnStack = [];             // enclosing function contexts
    this.pendingFns = [];          // def bodies, emitted after main
    this.usesCallStack = false;
  }

  get inFunction() { return this.fnStack.length > 0; }
  get currentFn()  { return this.fnStack[this.fnStack.length - 1]; }

  // ── Expressions ─────────────────────────────────────────────────────────
  // Every expression lowers INTO a named destination. Returns the symbolic
  // name holding the value. Identifiers return themselves without emitting,
  // which keeps the map from acquiring zero-width entries.
  expr(node, hint = 't') {
    switch (node.type) {
      case 'Identifier':
        return safeName(node.name);

      case 'NumberLit': {
        if (!Number.isInteger(node.value)) {
          this.e.refuse(nextId('NumberLit'), REFUSAL_CODES.NO_FP,
            `${node.value} is not an integer; only the scalar OPU tier is implemented in RTL`);
          return null;
        }
        return this.e.constant(node.value, hint);
      }

      case 'BoolLit': {
        if (node.value === null) {
          this.e.refuse(nextId('BoolLit'), REFUSAL_CODES.UNSUPPORTED_KIND,
            `'none' has no integer representation; use an explicit sentinel`);
          return null;
        }
        return this.e.constant(node.value ? 1 : 0, 'b');
      }

      case 'StringLit':
        this.e.refuse(nextId('StringLit'), REFUSAL_CODES.NO_STRING_OPS,
          `string literal ${JSON.stringify(node.value)} has no lowering; `
          + `there is no allocator and no observable output channel yet`);
        return null;

      case 'UnaryOp': {
        if (node.op !== 'not') {
          this.e.refuse(nextId('UnaryOp'), REFUSAL_CODES.UNSUPPORTED_KIND, `unary '${node.op}'`);
          return null;
        }
        // `not x` as a VALUE (not a condition) is x == 0.
        const v = this.expr(node.operand, 'n');
        if (v === null) return null;
        const zero = this.e.constant(0, 'z');
        const dst = this.e.gensym('not');
        this.e.emit(`slt ${dst}, ${v}, ${zero}`);   // placeholder shape; see note below
        this.e.refuse(nextId('UnaryOp'), REFUSAL_CODES.UNSUPPORTED_KIND,
          `'not' as a value (rather than as a condition) needs a set-if-zero primitive `
          + `that is not confirmed present in the ISA -- use it in an if/while condition instead`);
        return dst;
      }

      case 'BinOp': {
        if (ARITH[node.op]) return this.arith(node, hint);
        if (CMP[node.op] || node.op === 'and' || node.op === 'or') {
          this.e.refuse(nextId('BinOp'), REFUSAL_CODES.UNSUPPORTED_KIND,
            `comparison/boolean '${node.op}' used as a value; SEER branches on comparisons `
            + `rather than materializing them. Use it directly in an if/while condition.`);
          return null;
        }
        this.e.refuse(nextId('BinOp'), REFUSAL_CODES.UNSUPPORTED_KIND,
          `operator '${node.op}' has no lowering`
          + (node.op === '/' ? ' (integer division needs a routine or a div instruction)' : ''));
        return null;
      }

      case 'Call':
        return this.callExpr(node);

      default:
        this.e.refuse(nextId(node.type), REFUSAL_CODES.UNSUPPORTED_KIND,
          `expression kind '${node.type}'`);
        return null;
    }
  }

  // Constant-folds the immediate form where it is in range, because the
  // alternative -- always li-ing then add-ing -- burns a register and four
  // extra bytes on every `x + 1` in the program, and the byte budget is
  // imemBudget - 2048, not infinity.
  arith(node, hint) {
    const mnem = ARITH[node.op];
    const rightIsSmallInt = node.right.type === 'NumberLit'
      && Number.isInteger(node.right.value)
      && (node.op === '+' || node.op === '-');
    const left = this.expr(node.left, hint);
    if (left === null) return null;

    if (rightIsSmallInt) {
      const v = node.op === '+' ? node.right.value : -node.right.value;
      // SUBI_IMM8: the field is 8-bit SIGNED and WRAPS SILENTLY. 136 became
      // -120 once already. Range-check, then fall through to the register
      // form rather than emitting something that assembles and lies.
      if (v >= IMM8[0] && v <= IMM8[1]) {
        const dst = this.e.gensym(hint);
        this.e.emit(`addi ${dst}, ${left}, ${v}`);
        return dst;
      }
    }
    const right = this.expr(node.right, hint);
    if (right === null) return null;
    const dst = this.e.gensym(hint);
    this.e.emit(`${mnem} ${dst}, ${left}, ${right}`);
    return dst;
  }

  // ── Conditions ──────────────────────────────────────────────────────────
  // Returns a CF condition string, or null after refusing. Both operands
  // are forced into registers first: the `if rX == LITERAL:` sugar emits
  // the literal as a BR-format operand, which the simulator tolerates and
  // real SEER cannot execute. That divergence is silent, so it gets closed
  // here rather than discovered on the board.
  condition(node, negate = false) {
    if (node.type === 'UnaryOp' && node.op === 'not') return this.condition(node.operand, !negate);

    if (node.type === 'BinOp' && CMP[node.op]) {
      const op = negate ? INVERT[node.op] : node.op;
      const a = this.expr(node.left, 'c');
      const b = this.expr(node.right, 'c');
      if (a === null || b === null) return null;
      return { text: `${a} ${CMP[op].cf} ${b}`, native: CMP[op].native, swapped: CMP[op].swap };
    }

    // A bare value as a condition means "!= 0".
    const v = this.expr(node, 'c');
    if (v === null) return null;
    const zero = this.e.constant(0, 'z');
    return { text: `${v} ${negate ? '==' : '!='} ${zero}`, native: negate ? '==' : '!=', swapped: false };
  }

  // ── Statements ──────────────────────────────────────────────────────────
  block(stmts) {
    for (const s of stmts) {
      if (this.inFunction) this.currentFn.pos++;
      this.stmt(s);
    }
  }

  stmt(node) {
    const id = nextId(node.type);
    switch (node.type) {
      case 'Assign':    return this.sAssign(node, id);
      case 'If':        return this.sIf(node, id);
      case 'Loop':      return this.sLoop(node, id);
      case 'For':       return this.sFor(node, id);
      case 'Print':     return this.sPrint(node, id);
      case 'FunctionDef': return this.sFunctionDef(node, id);
      case 'Give':      return this.sGive(node, id);
      case 'Speak':
        this.nopStmt(id, 'Speak', node);
        return this.e.refuse(id, REFUSAL_CODES.NO_STRING_OPS,
          `'say' produces text output; there is no ecall ABI and ecall has no `
          + `architectural effect in the simulator`);
      case 'End':       return; // KH's bare 'end' marker; no code
      default:
        this.nopStmt(id, node.type, node);
        return this.e.refuse(id, REFUSAL_CODES.UNSUPPORTED_KIND, `statement kind '${node.type}'`);
    }
  }

  sAssign(node, id) {
    if (this.inFunction) {
      this.currentFn.locals.add(safeName(node.name));
      // The call's result overwrites this name, so its OLD value need not
      // survive the call -- unless the right-hand side also reads it
      // (`make s s + f(m)`), in which case it must.
      const dst = safeName(node.name);
      this.currentFn.deadTarget = readsName(node.expr, dst) ? null : dst;
    }
    this.e.begin(id, 'Assign', locOf(node), 'body');
    // Peephole: a plain integer literal goes straight into the user's own
    // name. The general path would emit `li __t, v` + `add name, __t, zr`
    // -- two instructions and a temp the allocator then has to colour, on
    // every single constant assignment in the program.
    const dstName = safeName(node.name);
    if (node.expr && node.expr.type === 'NumberLit' && Number.isInteger(node.expr.value)) {
      // _materialize, not a bare `li` -- the range is 0..0xFFFF or -128..-1
      // and `make a 70000` threw at assembly time when this emitted directly.
      this.e._materialize(dstName, node.expr.value);
      this.e.close();
      return;
    }
    const src = this.expr(node.expr, node.name);
    if (this.inFunction) this.currentFn.deadTarget = null;
    if (src !== null) {
      // Anchor into the user's own name. If the expression already landed
      // in a temp, one move; if it was an identifier, still one move --
      // aliasing the user's name to another live name would break the
      // map's claim that this line is where `name` gets its value.
      this.e.emit(`add ${dstName}, ${src}, zr`);
    } else {
      this.e.emit('nop');
    }
    this.e.close();
  }

  // `or` becomes an if/elif chain -- CF has elif natively, and each arm
  // duplicates the body. `and` becomes nesting. Neither can stay compound:
  // parseCFCondition's regex is strictly `<operand> <op> <operand>`.
  //
  // Body duplication across `or` arms is a REAL BYTE COST: n disjuncts
  // means n copies of the body, and the budget is imemBudget - 2048. A
  // three-way `or` around a large body is how you discover that check the
  // unpleasant way, so it is flagged rather than silently emitted.
  sIf(node, id) {
    const disjuncts = this.flattenOr(node.condition);
    if (disjuncts === null) return this.nopStmt(id, 'If', node);
    const chain = disjuncts.map(alt => this.flattenAnd(alt));
    if (chain.some(c => c === null)) return this.nopStmt(id, 'If', node);
    if (chain.length > 1) {
      this.e.warn(id, REFUSAL_CODES.OR_BODY_DUPLICATION,
        `'or' with ${chain.length} disjuncts duplicates the body ${chain.length} times; `
        + `check the compiled size against imemBudget - 2048`);
    }

    // BUG FOUND BY THE FIRST `or` TEST: condition operands must be
    // materialized for EVERY arm before the chain starts. Lowering them
    // lazily put `li __c3, 2` between arm 1's body and the `elif`, and
    // parseCFSource only continues an elif chain while the next line at the
    // same indent literally starts with `elif` -- one intervening
    // instruction silently detaches the rest of the chain and the elif
    // falls through to the generic `instr` case. Constants are side-effect
    // free and loop-invariant, so hoisting all of them is both correct and
    // the only thing that parses.
    this.e.begin(id, 'If', locOf(node), 'cond');
    const armConds = chain.map(conjuncts => conjuncts.map(c => this.condition(c)));
    this.e.close();
    if (armConds.some(arm => arm.some(c => c === null))) return this.nopStmt(id, 'If', node);

    let armIndex = 0;
    for (const conds of armConds) {
      this.e.begin(id, 'If', locOf(node), 'cond');
      conds.forEach((c, i) => {
        this.e.emit(`${i === 0 && armIndex === 0 ? 'if' : i === 0 ? 'elif' : 'if'} ${c.text}:`);
        this.e.indent();
      });
      this.e.close();

      this.e.begin(nextId('IfBody'), 'If', locOf(node), 'body');
      this.body(node.body);
      this.e.close();
      for (let i = 0; i < conds.length; i++) this.e.dedent();
      armIndex++;
    }

    if (node.else_ && node.else_.length) {
      this.e.begin(id, 'If', locOf(node), 'cond');
      this.e.emit('else:');
      this.e.indent();
      this.e.close();
      this.e.begin(nextId('ElseBody'), 'If', locOf(node), 'body');
      this.body(node.else_);
      this.e.close();
      this.e.dedent();
    }
  }

  sLoop(node, id) {
    // COMPOUND_LOOP_COND: `while a and b:` cannot be expressed directly.
    // Lowering it needs the condition recomputed into a flag at the top of
    // every iteration -- a real transform with a real correctness argument
    // about where the recomputation lands relative to the back edge.
    // Refused rather than half-implemented.
    const flatOr = this.flattenOr(node.condition);
    const flatAnd = flatOr && flatOr.length === 1 ? this.flattenAnd(flatOr[0]) : null;
    if (!flatOr || flatOr.length > 1 || !flatAnd || flatAnd.length > 1) {
      this.nopStmt(id, 'Loop', node);
      return this.e.refuse(id, REFUSAL_CODES.COMPOUND_LOOP_COND,
        `while with a compound condition needs a recomputed loop flag; `
        + `not implemented rather than approximated`);
    }

    // The condition's own setup (materialized constants) must be recomputed
    // every iteration, so it goes INSIDE nothing -- CF's `while cond:` re-
    // evaluates only the comparison, not the li that produced the operand.
    // Constants are loop-invariant, so hoisting them above the loop is
    // correct AND cheaper; anything non-invariant in a condition would not
    // be, which is why only literals are materialized here.
    this.e.begin(id, 'Loop', locOf(node), 'cond');
    const c = this.condition(flatAnd[0]);
    if (c === null) { this.e.emit('nop'); this.e.close(); return; }
    this.e.emit(`while ${c.text}:`);
    this.e.indent();
    this.e.close();

    this.e.begin(nextId('LoopBody'), 'Loop', locOf(node), 'body');
    this.body(node.body);
    this.e.close();
    this.e.dedent();
  }

  /**
   * ARCHITECTURAL GAP, found by the differential: a value that is written
   * and never READ is dead the instant it is written, so stage2Allocate
   * (correctly) gave every single __outN the same register and all of them
   * read back identical. Anchoring a value in a name does NOT keep it
   * observable -- only being read does.
   *
   * There is no live-out declaration in the engine: stage2Allocate calls
   * s2LiveList(mainStmts, new Set(), ctx) with a hardcoded empty live-out
   * set, and ecall has no architectural effect, so a program currently has
   * NO defined output channel at all.
   *
   * Until one exists, the epilogue reads every anchor into a sink chain.
   * That extends each __outN's live range to the end of the program, which
   * forces distinct registers and makes the register file at halt a real
   * read-back channel. It costs one instruction per output and is tagged
   * role:'epilogue' so Phase 3 hides it -- this is scaffolding, not the
   * user's code. See PROPOSED_ENGINE_PATCH in the README for the two-line
   * stage2Allocate change that makes it unnecessary.
   */
  emitOutputEpilogue() {
    if (!this.outputs.length) return;
    if (this.ctx.outputMode === 'liveout') return;   // engine patch applied; not needed
    const sink = '__sink';
    this.e.begin('<epilogue>', 'Epilogue', { line: null, col: null }, 'epilogue');
    this.outputs.forEach((o, i) => {
      this.e.emit(i === 0 ? `add ${sink}, ${o.name}, zr` : `add ${sink}, ${sink}, ${o.name}`);
    });
    this.e.close();
  }

  // ── Functions ─────────────────────────────────────────────────────────
  // `def name():` is zero-arg with no return value, so the convention is
  // entirely ours: arguments arrive in __arg0..N, the result leaves in
  // __ret0, and anything the CALLER needs after the call is pushed onto a
  // real dmem stack. Fixed slots alone are unsound under recursion --
  // abi_tests.js pins fact(4) == 8 as proof -- because a spill slot is one
  // fixed address per name, not a stack.
  //
  // Bodies are collected and emitted AFTER main rather than inline:
  // compileCFSource already lays main out first and links calls eagerly, so
  // this only keeps the emitted text in the order the compiler produces.
  sFunctionDef(node, id) {
    if (this.definedFns.has(node.name)) {
      return this.e.refuse(id, REFUSAL_CODES.UNSUPPORTED_KIND,
        `function '${node.name}' is defined more than once; call targets are resolved `
        + `statically, so a redefinition has no meaning`);
    }
    if (this.inFunction) {
      return this.e.refuse(id, REFUSAL_CODES.NO_CLOSURE,
        `nested function '${node.name}': def has no environment capture`);
    }
    this.definedFns.set(node.name, { params: node.params || [], node });
    this.pendingFns.push({ node, id });
  }

  emitFunctionBody(node, id) {
    const params = node.params || [];
    this.fnStack.push({
      name: node.name, params, locals: new Set(params.map(safeName)),
      pos: 0, live: analyzeFunctionLiveness(node), deadTarget: null,
    });

    this.e.begin(id, 'FunctionDef', locOf(node), 'body');
    this.e.emit(`def ${node.name}():`);
    this.e.indent();
    this.e.close();

    // Parameters land in the fixed slots; copy them into the function's own
    // names immediately, so the body reads like the source and the slots
    // are free for the next call this body makes.
    if (params.length) {
      this.e.begin(id, 'FunctionDef', locOf(node), 'abi');
      params.forEach((p, i) => this.e.emit(`add ${safeName(p)}, __arg${i}, zr`));
      this.e.close();
    }

    this.e.begin(nextId('FnBody'), 'FunctionDef', locOf(node), 'body');
    this.body(node.body || []);
    this.e.close();

    this.e.dedent();
    this.fnStack.pop();
  }

  sGive(node, id) {
    if (!this.inFunction) {
      return this.e.refuse(id, REFUSAL_CODES.UNSUPPORTED_KIND,
        `'give' outside a function; the top level ends with hlt, not a return`);
    }
    this.e.begin(id, 'Give', locOf(node), 'body');
    if (node.expr) {
      const v = this.expr(node.expr, 'give');
      if (v !== null) this.e.emit(`add __ret0, ${v}, zr`);
      else this.e.emit('nop');
    }
    this.e.emit('return');
    this.e.close();
  }

  /** Placeholder for a refused statement; keeps line indices stable. */
  nopStmt(id, kind, node) {
    this.e.begin(id, kind, locOf(node), 'body');
    this.e.emit('nop');
    this.e.close();
  }

  sFor(node, id) {
    // KH's `for x in items` iterates a collection. There is no allocator
    // and no collection representation, so only a literal integer bound
    // has a lowering. Everything else is NO_HEAP.
    this.nopStmt(id, 'For', node);
    this.e.refuse(id, REFUSAL_CODES.NO_HEAP,
      `'for ${node.iterVar} in ${node.target ?? '<expr>'}' iterates a collection; `
      + `no allocator exists. A counted loop lowers fine -- rewrite as `
      + `'make ${node.iterVar} 0' + 'loop ${node.iterVar} < N'.`);
  }

  sPrint(node, id) {
    // NO_OBSERVABLE_ECALL: ecall assembles and runs but has no
    // architectural effect in simulateProgram. Lowering `print` to ecall
    // would produce a program that runs clean and prints nothing, which
    // reads as a lowering bug and is not one. Instead the value is anchored
    // into a stable, allocator-visible name and reported as an output, so
    // the harness reads it back out of the register file at halt -- the
    // same read-back channel bind() already uses in demo.js.
    this.e.begin(id, 'Print', locOf(node), 'body');
    const src = this.expr(node.expr, 'out');
    if (src === null) { this.e.emit('nop'); this.e.close(); return; }
    const name = `__out${this.outputs.length}`;
    this.e.emit(`add ${name}, ${src}, zr`);
    this.outputs.push({ name, uastId: id, loc: locOf(node) });
    this.e.close();
  }

  callExpr(node) {
    const id = nextId('Call');
    const target = this.definedFns.get(node.name);

    // Not a known function => it is a host boundary. Phase 1 resolves the
    // specifier and Phase 4 runs it; the value crosses as a constant.
    if (!target) return this.externCall(node, id);

    if (node.args.length !== target.params.length) {
      this.e.refuse(id, REFUSAL_CODES.UNSUPPORTED_KIND,
        `'${node.name}' takes ${target.params.length} argument(s), called with ${node.args.length}`);
      return null;
    }

    // Nested calls in an argument would need the inner result kept live
    // across the outer call's remaining argument evaluation. Refused rather
    // than half-handled -- this is precisely the shape that produced a
    // silently wrong answer under the fixed-slot ABI.
    if (node.args.some(a => containsCall(a))) {
      this.e.refuse(id, 'NESTED_CALL_ARG',
        `a call appears inside an argument to '${node.name}'; assign it to a variable first`);
      return null;
    }

    // Evaluate arguments BEFORE saving, so argument temps are already dead
    // by the time the call happens.
    const argVals = [];
    for (let i = 0; i < node.args.length; i++) {
      const v = this.expr(node.args[i], `a${i}`);
      if (v === null) return null;
      argVals.push(v);
    }

    // CALLER SAVES, conservatively: every name the enclosing function owns
    // is pushed, because the callee may be this same function and would
    // otherwise overwrite it. Conservative rather than liveness-driven --
    // the lowerer has no liveness pass, and guessing wrong here is the
    // exact failure the fixed-slot ABI already demonstrated.
    // Save only what is read after this call -- see analyzeFunctionLiveness.
    // Intersected with the locals we actually own, so a name that is only
    // ever a parameter of some other function is not pushed.
    let saves = [];
    if (this.inFunction) {
      const fn = this.currentFn;
      const live = fn.live.liveAfter(fn.pos);
      if (fn.deadTarget) live.delete(fn.deadTarget);
      saves = [...fn.locals].filter(n => live.has(n));
    }
    if (saves.length) this.usesCallStack = true;

    this.e.begin(id, 'Call', locOf(node), 'abi');
    for (const nm of saves) {
      this.e.emit(`sts64 ${nm}, __cap, __sp`);
      this.e.emit(`subi __sp, __sp, 8`);
    }
    argVals.forEach((v, i) => this.e.emit(`add __arg${i}, ${v}, zr`));
    this.e.close();

    this.e.begin(id, 'Call', locOf(node), 'body');
    this.e.emit(`call ${node.name}()`);
    this.e.close();

    // __ret0 must be captured before the pops, since a pop writes a
    // caller local and the allocator may colour it onto __ret0.
    const dst = this.e.gensym('call');
    this.e.begin(id, 'Call', locOf(node), 'abi');
    this.e.emit(`add ${dst}, __ret0, zr`);
    for (const nm of [...saves].reverse()) {
      this.e.emit(`addi __sp, __sp, 8`);
      this.e.emit(`ld64 ${nm}, __cap, __sp`);
    }
    this.e.close();
    return dst;
  }

  externCall(node, id) {
    const argNames = [];
    for (let i = 0; i < node.args.length; i++) {
      const a = this.expr(node.args[i], `arg${i}`);
      if (a === null) return null;
      const slot = `__arg${i}`;
      this.e.emit(`add ${slot}, ${a}, zr`);
      argNames.push(slot);
    }
    this.e.emit('nop');
    this.e.extern({
      name: node.name, specifier: node.name, runtime: 'unresolved',
      argNames, readBack: ['__ret0'], cfLine: this.e.lines.length - 1,
    });
    this.e.refuse(id, REFUSAL_CODES.EXTERN_PENDING,
      `call to '${node.name}' is a host boundary: Phase 1 must resolve the specifier `
      + `and Phase 4 must run it. Emitted as HOSTED, not lowered.`);
    return '__ret0';
  }

  // `and`/`or` flattening. Returns null if a refusal happened inside.
  flattenOr(node) {
    if (node && node.type === 'BinOp' && node.op === 'or') {
      const l = this.flattenOr(node.left), r = this.flattenOr(node.right);
      return (l && r) ? [...l, ...r] : null;
    }
    return [node];
  }
  flattenAnd(node) {
    if (node && node.type === 'BinOp' && node.op === 'and') {
      const l = this.flattenAnd(node.left), r = this.flattenAnd(node.right);
      return (l && r) ? [...l, ...r] : null;
    }
    return [node];
  }

  // A CF block must not be empty -- parseBlock would consume nothing and
  // the enclosing if/while would swallow the next statement.
  body(stmts) {
    const before = this.e.lines.length;
    this.block(stmts);
    if (this.e.lines.length === before) this.e.emit('nop');
  }
}

async function lowerUAST(uastProgram, ctx = {}) {
  __uid = 0;
  const L = new Lowerer(ctx);
  const body = uastProgram.body || uastProgram.stmts || [];
  L.block(body);
  if (ctx.outputMode !== 'liveout') L.emitOutputEpilogue();
  for (const f of L.pendingFns) L.emitFunctionBody(f.node, f.id);
  const out = L.e.finish();

  // The call stack needs its capability token built before anything uses
  // it, and only when a call actually saves something -- a program with no
  // functions should not pay 13 instructions for a stack it never touches.
  if (L.usesCallStack) {
    if (!ctx.engine) {
      out.diagnostics.push({ severity: 'refuse', uastId: '<prologue>',
        code: 'ABI_NEEDS_ENGINE',
        message: 'this program makes calls that save state across them, which needs the '
               + 'stack-capability prologue. Pass ctx.engine (the loaded SEER engine) so the '
               + 'STACK_CAP_* constants come from the engine rather than being hardcoded here.' });
    } else {
      const pro = abiPrologue(ctx.engine);
      out.lines = pro.concat(out.lines);
      out.text = out.lines.join('\n');
      out.map = out.map.map(m => ({ ...m, cfStart: m.cfStart + pro.length, cfEnd: m.cfEnd + pro.length }));
      out.map.unshift({ uastId: '<prologue>', uastKind: 'AbiPrologue',
                        uastLoc: { line: null, col: null }, role: 'prologue',
                        cfStart: 0, cfEnd: pro.length - 1 });
      for (const ex of out.externs) ex.cfLine += pro.length;
    }
  }
  out.usesCallStack = L.usesCallStack;
  out.outputs = L.outputs;
  if (out.externs.length) out.fidelity = 'mixed';
  else out.fidelity = FIDELITY.ABSORBED;
  return out;
}

module.exports = { lowerUAST, Lowerer, SEER_OPS, checkOpTable, CMP, ARITH,
                   abiPrologue, abiPush, abiPop };
