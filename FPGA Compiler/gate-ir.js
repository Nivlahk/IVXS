/**
 * kh-gate-ir.js — KH Compiler: Gate IR
 * 
 * Lowers FPGA-partitioned KH AST nodes into a gate-level DAG.
 * This IR sits between the KH AST and RTLIL emission.
 * 
 * Gate types:
 *   AND, OR, NOT, XOR, NAND, NOR, XNOR  — standard logic
 *   MAJ, ONE, TWO, ODD                   — KH multi-input operators
 *   MUX                                  — if/else selector
 *   LUT                                  — generic lookup table (Xilinx primitive)
 *   FF                                   — D flip-flop (register bit)
 *   BRAM                                 — block RAM (buffer)
 *   CONST                                — compile-time constant
 *   WIRE                                 — named signal
 *   INPUT                                — external input
 *   OUTPUT                               — external output
 *   ADD, SUB, MUL, SHL, SHR, EQ, LT     — arithmetic (maps to DSP48 on Xilinx)
 *   COUNTER                              — loop counter primitive
 *   UNROLL                               — unrolled loop body
 */

'use strict';

// ── Gate Node ─────────────────────────────────────────────────────────────────

let _nextId = 0;

class GateNode {
  constructor(type, opts = {}) {
    this.id       = _nextId++;
    this.type     = type;         // gate type string
    this.inputs   = [];           // GateNode[] — fan-in
    this.outputs  = [];           // GateNode[] — fan-out (populated by connect())
    this.name     = opts.name ?? null;     // signal name if named
    this.value    = opts.value ?? null;    // CONST value or LUT table
    this.width    = opts.width ?? 1;       // bit width
    this.line     = opts.line ?? null;     // source line for diagnostics
    this.khNode   = opts.khNode ?? null;   // originating KH AST node
  }

  // Connect this node's output to another node's input
  connect(target) {
    if (!this.outputs.includes(target)) this.outputs.push(target);
    if (!target.inputs.includes(this)) target.inputs.push(this);
    return target;
  }

  toString() {
    const ins = this.inputs.map(n => n.name ?? `g${n.id}`).join(', ');
    return `${this.name ?? ('g' + this.id)} = ${this.type}(${ins})`;
  }
}

// ── Gate IR Graph ─────────────────────────────────────────────────────────────

class GateGraph {
  constructor() {
    this.nodes    = [];       // all GateNode instances
    this.inputs   = [];       // top-level INPUT nodes
    this.outputs  = [];       // top-level OUTPUT nodes
    this.signals  = new Map();// name → GateNode for named signals
  }

  add(node) {
    this.nodes.push(node);
    if (node.name) this.signals.set(node.name, node);
    return node;
  }

  // Create and register a gate
  gate(type, opts = {}) {
    return this.add(new GateNode(type, opts));
  }

  // Named wire signal
  wire(name, opts = {}) {
    return this.add(new GateNode('WIRE', { name, ...opts }));
  }

  // Compile-time constant
  const_(value, width = 1) {
    return this.add(new GateNode('CONST', { value, width }));
  }

  // Look up a named signal
  signal(name) {
    return this.signals.get(name) ?? null;
  }

  // Stats
  stats() {
    const counts = {};
    for (const n of this.nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
    return counts;
  }
}

// ── Lowering Pass ─────────────────────────────────────────────────────────────
// Walks FPGA-tagged AST nodes and emits GateNodes into a GateGraph.

class GateLowering {
  constructor(constants) {
    this.graph     = new GateGraph();
    this.constants = constants ?? new Map(); // from constant folding pass
    this.scope     = new Map();              // variable name → GateNode
    this.errors    = [];
    this.warnings  = [];
  }

  error(msg, node) { this.errors.push({ msg, line: node?.line }); }
  warn(msg, node)  { this.warnings.push({ msg, line: node?.line }); }

  // ── Entry point ─────────────────────────────────────────────────────────────
  lower(ast) {
    for (const node of (ast.body ?? [])) {
      if (node.__partition !== 'fpga') continue;
      this.lowerNode(node);
    }
    return { graph: this.graph, errors: this.errors, warnings: this.warnings };
  }

  // ── Statement lowering ───────────────────────────────────────────────────────
  lowerNode(node) {
    if (!node || node.__partition !== 'fpga') return null;

    switch (node.type) {

      case 'Make': {
        const sig = this.lowerExpr(node.expr);
        if (!sig) return null;
        // Name the signal after the variable
        sig.name = node.name;
        this.graph.signals.set(node.name, sig);
        this.scope.set(node.name, sig);
        return sig;
      }

      case 'If': {
        return this.lowerIf(node);
      }

      case 'Loop': {
        return this.lowerLoop(node);
      }

      case 'ExprStatement': {
        return this.lowerExpr(node.expr);
      }

      case 'Fun': {
        // Functions become named subgraphs — lower body in new scope
        const saved = new Map(this.scope);
        for (const n of (node.body ?? [])) this.lowerNode(n);
        this.scope = saved;
        return null;
      }

      default:
        return null;
    }
  }

  // ── If/else → MUX ───────────────────────────────────────────────────────────
  lowerIf(node) {
    const condGate = this.lowerExpr(node.condition);
    if (!condGate) return null;

    // Lower both branches
    const thenOutputs = this.lowerBlock(node.body);
    const elseOutputs = this.lowerBlock(node.else_ ?? []);

    // For each output produced by the branches, insert a MUX
    const muxOutputs = [];
    const len = Math.max(thenOutputs.length, elseOutputs.length);
    for (let i = 0; i < len; i++) {
      const thenSig = thenOutputs[i] ?? this.graph.const_(0);
      const elseSig = elseOutputs[i] ?? this.graph.const_(0);
      const mux = this.graph.gate('MUX', { line: node.line, khNode: node });
      condGate.connect(mux);  // select
      thenSig.connect(mux);   // d1
      elseSig.connect(mux);   // d0
      muxOutputs.push(mux);
    }

    return muxOutputs[0] ?? null;
  }

  // ── Loop lowering ────────────────────────────────────────────────────────────
  lowerLoop(node) {
    switch (node.loopType) {

      case 'repeat': {
        // Unroll: duplicate body n times in the gate network
        const n = this.constants.get(node.variable) ?? node.count?.value ?? 1;
        const unroll = this.graph.gate('UNROLL', {
          name: `unroll_${node.line}`,
          value: n,
          line: node.line,
          khNode: node,
        });
        for (let i = 0; i < n; i++) {
          this.lowerBlock(node.body);
        }
        return unroll;
      }

      case 'fold': {
        // Single gate network + counter
        const counter = this.graph.gate('COUNTER', {
          name: `fold_ctr_${node.line}`,
          line: node.line,
          khNode: node,
        });
        this.lowerBlock(node.body);
        return counter;
      }

      case 'cycle': {
        // Infinite loop — persistent gate network, no counter
        const cycleGate = this.graph.gate('WIRE', {
          name: `cycle_${node.line}`,
          line: node.line,
          khNode: node,
        });
        this.lowerBlock(node.body);
        return cycleGate;
      }

      default: {
        // loop x < n — worst-case allocation with runtime counter
        const counter = this.graph.gate('COUNTER', {
          name: node.variable ? `ctr_${node.variable}` : `ctr_${node.line}`,
          line: node.line,
          khNode: node,
        });
        if (node.variable) this.scope.set(node.variable, counter);
        this.lowerBlock(node.body);
        return counter;
      }
    }
  }

  // Lower a block, return array of output signals produced
  lowerBlock(block) {
    const outputs = [];
    for (const n of (block ?? [])) {
      const sig = this.lowerNode(n);
      if (sig) outputs.push(sig);
    }
    return outputs;
  }

  // ── Expression lowering ───────────────────────────────────────────────────────
  lowerExpr(node) {
    if (!node) return null;

    switch (node.type) {

      case 'NumberLit':
      case 'BoolLit': {
        const width = typeof node.value === 'number'
          ? Math.max(1, Math.ceil(Math.log2(Math.abs(node.value) + 1)))
          : 1;
        return this.graph.const_(node.value, width);
      }

      case 'StringLit':
        // Strings don't lower to gates — should have been pushed to CPU
        this.warn('String literal in FPGA partition — treating as constant 0', node);
        return this.graph.const_(0);

      case 'Identifier': {
        // Look up in scope
        const sig = this.scope.get(node.name);
        if (sig) return sig;
        // Check compile-time constants
        if (this.constants.has(node.name)) {
          return this.graph.const_(this.constants.get(node.name));
        }
        // Create an INPUT node — this signal comes from outside the FPGA partition
        const input = this.graph.gate('INPUT', { name: node.name, line: node.line });
        this.graph.inputs.push(input);
        this.scope.set(node.name, input);
        return input;
      }

      case 'BinOp': {
        return this.lowerBinOp(node);
      }

      case 'UnaryOp': {
        return this.lowerUnaryOp(node);
      }

      case 'MultiInputOp': {
        return this.lowerMultiInputOp(node);
      }

      default:
        this.warn(`Cannot lower expression type '${node.type}' to gates`, node);
        return this.graph.const_(0);
    }
  }

  // ── Binary op → gate ─────────────────────────────────────────────────────────
  lowerBinOp(node) {
    const left  = this.lowerExpr(node.left);
    const right = this.lowerExpr(node.right);
    if (!left || !right) return null;

    // Map KH binary ops to gate types
    const gateType = {
      'and':  'AND',
      'or':   'OR',
      'same': 'XNOR',   // same = equivalence = XNOR
      'xor':  'XOR',
      'nand': 'NAND',
      'nor':  'NOR',
      '+':    'ADD',
      '-':    'SUB',
      '*':    'MUL',
      '=':    'EQ',
      '!=':   'XOR',    // != on 1-bit is XOR
      '<':    'LT',
      '>':    'LT',     // a > b = b < a, inputs swapped below
      '<=':   'LT',     // a <= b = NOT (b < a)
      '>=':   'LT',     // a >= b = NOT (a < b)
    }[node.op];

    if (!gateType) {
      this.warn(`No gate mapping for op '${node.op}' — emitting constant 0`, node);
      return this.graph.const_(0);
    }

    const gate = this.graph.gate(gateType, { line: node.line, khNode: node });

    // Handle comparison direction swaps
    if (node.op === '>') {
      right.connect(gate);
      left.connect(gate);
    } else {
      left.connect(gate);
      right.connect(gate);
    }

    // Wrap negation for <= and >=
    if (node.op === '<=' || node.op === '>=') {
      const inv = this.graph.gate('NOT', { line: node.line });
      gate.connect(inv);
      return inv;
    }

    return gate;
  }

  // ── Unary op → gate ──────────────────────────────────────────────────────────
  lowerUnaryOp(node) {
    const operand = this.lowerExpr(node.operand);
    if (!operand) return null;

    if (node.op === 'not') {
      const inv = this.graph.gate('NOT', { line: node.line, khNode: node });
      operand.connect(inv);
      return inv;
    }

    if (node.op === '-') {
      // Negate: SUB(0, x)
      const zero = this.graph.const_(0);
      const neg  = this.graph.gate('SUB', { line: node.line, khNode: node });
      zero.connect(neg);
      operand.connect(neg);
      return neg;
    }

    this.warn(`No gate mapping for unary op '${node.op}'`, node);
    return operand;
  }

  // ── Multi-input ops → gate networks ──────────────────────────────────────────
  lowerMultiInputOp(node) {
    const inputs = node.items.map(i => this.lowerExpr(i)).filter(Boolean);
    if (inputs.length === 0) return this.graph.const_(0);

    switch (node.op) {

      case 'maj': {
        // Majority: true if more than half inputs are true.
        // Implemented as a popcount > n/2 comparison.
        // For 3 inputs: MAJ(a,b,c) = (a AND b) OR (b AND c) OR (a AND c)
        // For arbitrary n: sum inputs, compare to n/2.
        return this.buildMajGate(inputs, node);
      }

      case 'one': {
        // Exactly one true — equivalent to multi-input XOR tree
        // with a popcount = 1 check
        return this.buildExactlyN(inputs, 1, node);
      }

      case 'two': {
        return this.buildExactlyN(inputs, 2, node);
      }

      case 'odd': {
        // Odd number true — XOR tree (parity)
        return this.buildXorTree(inputs, node);
      }

      default:
        this.warn(`Unknown MultiInputOp '${node.op}'`, node);
        return this.graph.const_(0);
    }
  }

  // MAJ gate network — for small n uses AND/OR tree, larger n uses popcount
  buildMajGate(inputs, node) {
    const n = inputs.length;
    if (n === 1) return inputs[0];

    if (n === 3) {
      // Classic 3-input majority: (a&b)|(b&c)|(a&c)
      const [a, b, c] = inputs;
      const ab = this.graph.gate('AND', { line: node.line }); a.connect(ab); b.connect(ab);
      const bc = this.graph.gate('AND', { line: node.line }); b.connect(bc); c.connect(bc);
      const ac = this.graph.gate('AND', { line: node.line }); a.connect(ac); c.connect(ac);
      const or1 = this.graph.gate('OR', { line: node.line }); ab.connect(or1); bc.connect(or1);
      const or2 = this.graph.gate('OR', { line: node.line }); or1.connect(or2); ac.connect(or2);
      return or2;
    }

    // General case: popcount > n/2
    // Emit a MAJ primitive — synthesis tool will map to LUT cascade
    const maj = this.graph.gate('MAJ', {
      line: node.line,
      khNode: node,
      value: Math.floor(n / 2) + 1, // threshold
    });
    for (const inp of inputs) inp.connect(maj);
    return maj;
  }

  // Exactly-N gate network — popcount == n
  buildExactlyN(inputs, target, node) {
    const gate = this.graph.gate(target === 1 ? 'ONE' : 'TWO', {
      line: node.line,
      khNode: node,
      value: target,
    });
    for (const inp of inputs) inp.connect(gate);
    return gate;
  }

  // XOR tree — parity (odd number of true inputs)
  buildXorTree(inputs, node) {
    if (inputs.length === 1) return inputs[0];
    let acc = inputs[0];
    for (let i = 1; i < inputs.length; i++) {
      const xor = this.graph.gate('XOR', { line: node.line, khNode: node });
      acc.connect(xor);
      inputs[i].connect(xor);
      acc = xor;
    }
    return acc;
  }
}

// ── Gate IR → DOT (for visualisation) ────────────────────────────────────────

function graphToDot(graph) {
  const lines = ['digraph GateIR {', '  rankdir=LR;', '  node [fontname="Courier"];'];
  for (const node of graph.nodes) {
    const label = node.name
      ? `${node.type}\\n${node.name}`
      : node.type + (node.value !== null ? `\\n${node.value}` : '');
    const shape = {
      INPUT: 'invtriangle', OUTPUT: 'triangle',
      CONST: 'rectangle',  WIRE: 'point',
      FF: 'Mbox',          BRAM: 'box3d',
      MUX: 'trapezium',    COUNTER: 'oval',
    }[node.type] ?? 'ellipse';
    lines.push(`  g${node.id} [label="${label}", shape=${shape}];`);
  }
  for (const node of graph.nodes) {
    for (const out of node.outputs) {
      lines.push(`  g${node.id} -> g${out.id};`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

// ── Exports ───────────────────────────────────────────────────────────────────

function lowerToGateIR(ast, constants) {
  const lowering = new GateLowering(constants);
  return lowering.lower(ast);
}

if (typeof module !== 'undefined') {
  module.exports = { GateNode, GateGraph, GateLowering, lowerToGateIR, graphToDot };
}
