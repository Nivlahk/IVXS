/**
 * kh-rtlil-emitter.js — KH Compiler: RTLIL Emitter
 * 
 * Takes a GateGraph (from gate-ir.js) and emits Yosys RTLIL text.
 * The output can be fed directly to Yosys for Xilinx synthesis:
 * 
 *   yosys -p "read_rtlil out.rtlil; synth_xilinx -top kh_module; write_edif out.edif"
 * 
 * RTLIL concepts used:
 *   wire      — named signal, 1 or more bits wide
 *   cell      — a logic primitive instance
 *   connect   — direct wire assignment
 *   process   — procedural block (used for MUX/FF)
 *   memory    — block RAM declaration (BRAM nodes)
 * 
 * Xilinx primitive mapping:
 *   AND/OR/NOT/XOR/NAND/NOR/XNOR  → $_AND_ $_OR_ $_NOT_ etc. (Yosys internal cells)
 *   MAJ (3-input)                  → LUT3 with MAJ truth table
 *   MAJ (n-input)                  → LUT cascade or CARRY8 chain
 *   ONE/TWO                        → LUT cascade
 *   MUX                            → $_MUX_
 *   FF                             → $_DFF_P_ (positive edge D flip-flop)
 *   BRAM                           → RAMB36E2 (Xilinx UltraScale block RAM)
 *   COUNTER                        → CARRY8 + FF chain
 *   ADD/SUB                        → DSP48E2
 *   MUL                            → DSP48E2
 */

'use strict';

// ── RTLIL Wire naming ─────────────────────────────────────────────────────────

function wireName(node) {
  if (node.name) return `\\${node.name}`;
  return `\\__g${node.id}__`;
}

function constVal(value, width = 1) {
  if (typeof value === 'boolean') return `${width}'${value ? '1' : '0'}`;
  if (typeof value === 'number') {
    const bits = Math.abs(Math.floor(value)).toString(2).padStart(width, '0');
    return `${width}'${bits}`;
  }
  return `${width}'${'0'.repeat(width)}`;
}

// ── RTLIL Emitter ─────────────────────────────────────────────────────────────

class RTLILEmitter {
  constructor(moduleName = 'kh_module') {
    this.moduleName = moduleName;
    this.lines      = [];
    this.indent     = 0;
    this.cellCount  = 0;
    this.errors     = [];
    this.warnings   = [];
  }

  // ── Output helpers ────────────────────────────────────────────────────────
  emit(line = '') {
    this.lines.push('  '.repeat(this.indent) + line);
  }

  cellId() {
    return `$kh_cell_${this.cellCount++}`;
  }

  error(msg, node) { this.errors.push({ msg, line: node?.line }); }
  warn(msg, node)  { this.warnings.push({ msg, line: node?.line }); }

  // ── Main entry ────────────────────────────────────────────────────────────
  emit_module(graph) {
    this.emit(`module \\${this.moduleName}`);
    this.emit();
    this.indent++;

    // Declare all wires
    this.emit('# Wire declarations');
    for (const node of graph.nodes) {
      this.emitWireDecl(node);
    }
    this.emit();

    // Emit all cells
    this.emit('# Cell instances');
    for (const node of graph.nodes) {
      this.emitCell(node);
    }
    this.emit();

    // Emit top-level connections for INPUT/OUTPUT nodes
    this.emit('# I/O connections');
    for (const node of graph.inputs) {
      this.emit(`input  ${node.width} ${wireName(node)}`);
    }
    for (const node of graph.outputs) {
      this.emit(`output ${node.width} ${wireName(node)}`);
    }

    this.indent--;
    this.emit('end');
    this.emit();

    return this.lines.join('\n');
  }

  // ── Wire declaration ──────────────────────────────────────────────────────
  emitWireDecl(node) {
    if (node.type === 'INPUT') {
      this.emit(`wire width ${node.width} input ${node.id} ${wireName(node)}`);
    } else if (node.type === 'OUTPUT') {
      this.emit(`wire width ${node.width} output ${node.id} ${wireName(node)}`);
    } else if (node.type === 'CONST') {
      // Constants are inlined at use sites, no wire needed
    } else {
      this.emit(`wire width ${node.width} ${wireName(node)}`);
    }
  }

  // ── Cell emission ─────────────────────────────────────────────────────────
  emitCell(node) {
    switch (node.type) {

      // ── Standard logic gates → Yosys internal cells ─────────────────────
      case 'AND':  return this.emitBinaryCell('$_AND_',  node);
      case 'OR':   return this.emitBinaryCell('$_OR_',   node);
      case 'XOR':  return this.emitBinaryCell('$_XOR_',  node);
      case 'XNOR': return this.emitBinaryCell('$_XNOR_', node);
      case 'NAND': return this.emitBinaryCell('$_NAND_', node);
      case 'NOR':  return this.emitBinaryCell('$_NOR_',  node);

      case 'NOT':  return this.emitUnaryCell('$_NOT_', node);

      // ── MUX ─────────────────────────────────────────────────────────────
      case 'MUX':  return this.emitMuxCell(node);

      // ── D Flip-Flop ──────────────────────────────────────────────────────
      case 'FF':   return this.emitFFCell(node);

      // ── Block RAM ────────────────────────────────────────────────────────
      case 'BRAM': return this.emitBRAMCell(node);

      // ── Arithmetic → DSP48E2 ─────────────────────────────────────────────
      case 'ADD':  return this.emitDSPCell('ADD', node);
      case 'SUB':  return this.emitDSPCell('SUB', node);
      case 'MUL':  return this.emitDSPCell('MUL', node);

      // ── Comparisons ──────────────────────────────────────────────────────
      case 'EQ':   return this.emitCompareCell('$eq',  node);
      case 'LT':   return this.emitCompareCell('$lt',  node);

      // ── Counter ──────────────────────────────────────────────────────────
      case 'COUNTER': return this.emitCounterCell(node);

      // ── KH multi-input operators → LUT networks ──────────────────────────
      case 'MAJ':  return this.emitMAJCell(node);
      case 'ONE':  return this.emitExactlyNCell(node, 1);
      case 'TWO':  return this.emitExactlyNCell(node, 2);
      case 'ODD':  return this.emitXORTreeCell(node);  // parity = XOR tree

      // ── UNROLL — no cell needed, body was inlined ─────────────────────────
      case 'UNROLL': return;

      // ── CONST — inlined at use sites ─────────────────────────────────────
      case 'CONST': return;

      // ── WIRE / INPUT / OUTPUT — declared, no cell ─────────────────────────
      case 'WIRE':
      case 'INPUT':
      case 'OUTPUT': return;

      default:
        this.warn(`No RTLIL mapping for gate type '${node.type}' — skipping`, node);
    }
  }

  // ── Binary cell (2 inputs → 1 output) ────────────────────────────────────
  emitBinaryCell(cellType, node) {
    if (node.inputs.length < 2) {
      this.error(`${node.type} gate needs 2 inputs, got ${node.inputs.length}`, node);
      return;
    }
    const id = this.cellId();
    this.emit(`cell ${cellType} ${id}`);
    this.indent++;
    this.emit(`connect \\A ${this.inputSig(node.inputs[0])}`);
    this.emit(`connect \\B ${this.inputSig(node.inputs[1])}`);
    this.emit(`connect \\Y ${wireName(node)}`);
    this.indent--;
    this.emit('end');
  }

  // ── Unary cell (1 input → 1 output) ──────────────────────────────────────
  emitUnaryCell(cellType, node) {
    if (node.inputs.length < 1) {
      this.error(`${node.type} gate needs 1 input, got 0`, node);
      return;
    }
    const id = this.cellId();
    this.emit(`cell ${cellType} ${id}`);
    this.indent++;
    this.emit(`connect \\A ${this.inputSig(node.inputs[0])}`);
    this.emit(`connect \\Y ${wireName(node)}`);
    this.indent--;
    this.emit('end');
  }

  // ── MUX cell: inputs[0]=select, inputs[1]=D1(then), inputs[2]=D0(else) ──
  emitMuxCell(node) {
    const id = this.cellId();
    this.emit(`cell $_MUX_ ${id}`);
    this.indent++;
    this.emit(`connect \\S ${this.inputSig(node.inputs[0])}`);  // select
    this.emit(`connect \\B ${this.inputSig(node.inputs[1])}`);  // then
    this.emit(`connect \\A ${this.inputSig(node.inputs[2] ?? node.inputs[1])}`); // else
    this.emit(`connect \\Y ${wireName(node)}`);
    this.indent--;
    this.emit('end');
  }

  // ── D Flip-Flop ───────────────────────────────────────────────────────────
  emitFFCell(node) {
    const id = this.cellId();
    this.emit(`cell $_DFF_P_ ${id}`);
    this.indent++;
    this.emit(`parameter \\WIDTH ${node.width}`);
    this.emit(`connect \\C \\clk`);                             // clock (global)
    this.emit(`connect \\D ${this.inputSig(node.inputs[0])}`);  // data in
    this.emit(`connect \\Q ${wireName(node)}`);                 // data out
    this.indent--;
    this.emit('end');
  }

  // ── Block RAM (RAMB36E2 — Xilinx UltraScale) ─────────────────────────────
  emitBRAMCell(node) {
    const id = this.cellId();
    const depth = node.value ?? 1024;
    const width = node.width ?? 8;
    this.emit(`cell RAMB36E2 ${id}`);
    this.indent++;
    this.emit(`parameter \\READ_WIDTH_A  ${width}`);
    this.emit(`parameter \\WRITE_WIDTH_A ${width}`);
    this.emit(`parameter \\RAM_DEPTH     ${depth}`);
    this.emit(`connect \\CLKARDCLK  \\clk`);
    this.emit(`connect \\CLKBWRCLK  \\clk`);
    if (node.inputs[0]) this.emit(`connect \\ADDRA ${this.inputSig(node.inputs[0])}`);
    if (node.inputs[1]) this.emit(`connect \\DINA  ${this.inputSig(node.inputs[1])}`);
    this.emit(`connect \\DOUTA ${wireName(node)}`);
    this.indent--;
    this.emit('end');
  }

  // ── DSP48E2 (Xilinx UltraScale arithmetic) ───────────────────────────────
  emitDSPCell(op, node) {
    const id = this.cellId();
    // OPMODE encodes the operation:
    //   ADD: OPMODE = 9'b000110101 (P = A + B)
    //   SUB: OPMODE = 9'b000110011 (P = A - B)
    //   MUL: OPMODE = 9'b000000101 (P = A * B via pre-adder bypass)
    const opmode = { ADD: "9'b000110101", SUB: "9'b000110011", MUL: "9'b000000101" }[op];
    this.emit(`cell DSP48E2 ${id}`);
    this.indent++;
    this.emit(`parameter \\OPMODE ${opmode}`);
    this.emit(`parameter \\AWIDTH ${node.inputs[0]?.width ?? 18}`);
    this.emit(`parameter \\BWIDTH ${node.inputs[1]?.width ?? 18}`);
    this.emit(`connect \\CLK \\clk`);
    if (node.inputs[0]) this.emit(`connect \\A ${this.inputSig(node.inputs[0])}`);
    if (node.inputs[1]) this.emit(`connect \\B ${this.inputSig(node.inputs[1])}`);
    this.emit(`connect \\P ${wireName(node)}`);
    this.indent--;
    this.emit('end');
  }

  // ── Comparator ───────────────────────────────────────────────────────────
  emitCompareCell(cellType, node) {
    const id = this.cellId();
    const w = Math.max(node.inputs[0]?.width ?? 1, node.inputs[1]?.width ?? 1);
    this.emit(`cell ${cellType} ${id}`);
    this.indent++;
    this.emit(`parameter \\A_SIGNED 0`);
    this.emit(`parameter \\B_SIGNED 0`);
    this.emit(`parameter \\A_WIDTH ${w}`);
    this.emit(`parameter \\B_WIDTH ${w}`);
    this.emit(`parameter \\Y_WIDTH 1`);
    if (node.inputs[0]) this.emit(`connect \\A ${this.inputSig(node.inputs[0])}`);
    if (node.inputs[1]) this.emit(`connect \\B ${this.inputSig(node.inputs[1])}`);
    this.emit(`connect \\Y ${wireName(node)}`);
    this.indent--;
    this.emit('end');
  }

  // ── Counter (CARRY8 + FF chain) ───────────────────────────────────────────
  emitCounterCell(node) {
    const id  = this.cellId();
    const w   = node.width ?? 8;
    // Emit a Yosys $counter cell — synth_xilinx maps this to CARRY8+FF
    this.emit(`cell $counter ${id}`);
    this.indent++;
    this.emit(`parameter \\WIDTH ${w}`);
    this.emit(`parameter \\INCREMENT 1`);
    this.emit(`connect \\CLK  \\clk`);
    this.emit(`connect \\COUT ${wireName(node)}`);
    this.indent--;
    this.emit('end');
  }

  // ── MAJ gate network ──────────────────────────────────────────────────────
  // For n=3: LUT3 with MAJ truth table (0xE8 = 11101000)
  // For n>3: emit a $reduce_add cell compared to threshold
  emitMAJCell(node) {
    const n         = node.inputs.length;
    const threshold = node.value ?? Math.floor(n / 2) + 1;
    const id        = this.cellId();

    if (n === 3) {
      // LUT3 with MAJ truth table
      this.emit(`cell LUT3 ${id}`);
      this.indent++;
      this.emit(`parameter \\INIT 8'b11101000`); // MAJ truth table
      this.emit(`connect \\I0 ${this.inputSig(node.inputs[0])}`);
      this.emit(`connect \\I1 ${this.inputSig(node.inputs[1])}`);
      this.emit(`connect \\I2 ${this.inputSig(node.inputs[2])}`);
      this.emit(`connect \\O  ${wireName(node)}`);
      this.indent--;
      this.emit('end');
      return;
    }

    // General n: $reduce_add then $ge comparison
    const sumWire = `\\__maj_sum_${node.id}__`;
    const sumW    = Math.ceil(Math.log2(n + 1));
    this.emit(`wire width ${sumW} ${sumWire}`);

    const sumId = this.cellId();
    this.emit(`cell $reduce_add ${sumId}`);
    this.indent++;
    this.emit(`parameter \\A_SIGNED 0`);
    this.emit(`parameter \\A_WIDTH  ${n}`);
    this.emit(`parameter \\Y_WIDTH  ${sumW}`);
    this.emitConcatInputs(node.inputs, n);
    this.emit(`connect \\Y ${sumWire}`);
    this.indent--;
    this.emit('end');

    // Compare sum >= threshold
    const cmpId = this.cellId();
    this.emit(`cell $ge ${cmpId}`);
    this.indent++;
    this.emit(`parameter \\A_SIGNED 0`);
    this.emit(`parameter \\B_SIGNED 0`);
    this.emit(`parameter \\A_WIDTH  ${sumW}`);
    this.emit(`parameter \\B_WIDTH  ${sumW}`);
    this.emit(`parameter \\Y_WIDTH  1`);
    this.emit(`connect \\A ${sumWire}`);
    this.emit(`connect \\B ${constVal(threshold, sumW)}`);
    this.emit(`connect \\Y ${wireName(node)}`);
    this.indent--;
    this.emit('end');
  }

  // ── ONE/TWO: popcount == target ───────────────────────────────────────────
  emitExactlyNCell(node, target) {
    const n    = node.inputs.length;
    const id   = this.cellId();
    const sumW = Math.ceil(Math.log2(n + 1));
    const sumWire = `\\__popcount_${node.id}__`;

    this.emit(`wire width ${sumW} ${sumWire}`);

    // $reduce_add to get popcount
    const sumId = this.cellId();
    this.emit(`cell $reduce_add ${sumId}`);
    this.indent++;
    this.emit(`parameter \\A_SIGNED 0`);
    this.emit(`parameter \\A_WIDTH  ${n}`);
    this.emit(`parameter \\Y_WIDTH  ${sumW}`);
    this.emitConcatInputs(node.inputs, n);
    this.emit(`connect \\Y ${sumWire}`);
    this.indent--;
    this.emit('end');

    // $eq to check == target
    const eqId = this.cellId();
    this.emit(`cell $eq ${eqId}`);
    this.indent++;
    this.emit(`parameter \\A_SIGNED 0`);
    this.emit(`parameter \\B_SIGNED 0`);
    this.emit(`parameter \\A_WIDTH  ${sumW}`);
    this.emit(`parameter \\B_WIDTH  ${sumW}`);
    this.emit(`parameter \\Y_WIDTH  1`);
    this.emit(`connect \\A ${sumWire}`);
    this.emit(`connect \\B ${constVal(target, sumW)}`);
    this.emit(`connect \\Y ${wireName(node)}`);
    this.indent--;
    this.emit('end');
  }

  // ── ODD: XOR tree (parity) ────────────────────────────────────────────────
  emitXORTreeCell(node) {
    if (node.inputs.length === 0) return;
    let prevWire = this.inputSig(node.inputs[0]);

    for (let i = 1; i < node.inputs.length; i++) {
      const isLast  = i === node.inputs.length - 1;
      const outWire = isLast ? wireName(node) : `\\__xor_${node.id}_${i}__`;
      if (!isLast) this.emit(`wire width 1 ${outWire}`);
      const id = this.cellId();
      this.emit(`cell $_XOR_ ${id}`);
      this.indent++;
      this.emit(`connect \\A ${prevWire}`);
      this.emit(`connect \\B ${this.inputSig(node.inputs[i])}`);
      this.emit(`connect \\Y ${outWire}`);
      this.indent--;
      this.emit('end');
      prevWire = outWire;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Get the signal string for an input gate node
  inputSig(node) {
    if (!node) return `1'0`;
    if (node.type === 'CONST') return constVal(node.value, node.width);
    return wireName(node);
  }

  // Emit a concatenated input bus for reduce cells
  emitConcatInputs(inputs, width) {
    const sigs = inputs.map(n => this.inputSig(n)).join(', ');
    this.emit(`connect \\A { ${sigs} }`);
  }
}

// ── Top-level emit function ───────────────────────────────────────────────────

function emitRTLIL(graph, moduleName = 'kh_module') {
  const emitter = new RTLILEmitter(moduleName);
  const rtlil   = emitter.emit_module(graph);
  return {
    rtlil,
    errors:   emitter.errors,
    warnings: emitter.warnings,
  };
}

// ── Yosys synthesis script generator ─────────────────────────────────────────
// Generates the Yosys TCL script to synthesize the emitted RTLIL for Xilinx.

function generateYosysScript(opts = {}) {
  const {
    rtlilFile  = 'out.rtlil',
    edifFile   = 'out.edif',
    xdcFile    = 'constraints.xdc',
    topModule  = 'kh_module',
    part       = 'xc7a35tcpg236-1',  // Artix-7 default; override for UltraScale
  } = opts;

  return [
    `# KH → Xilinx synthesis script (Yosys)`,
    `# Target part: ${part}`,
    ``,
    `read_rtlil ${rtlilFile}`,
    ``,
    `# Optimisation passes`,
    `hierarchy -check -top \\${topModule}`,
    `proc`,
    `opt`,
    `fsm`,
    `opt`,
    `memory`,
    `opt`,
    ``,
    `# Xilinx synthesis`,
    `synth_xilinx -top \\${topModule} -family xc7`,
    ``,
    `# Write output`,
    `write_edif -pvector bra ${edifFile}`,
    ``,
    `# Optional: write JSON netlist for inspection`,
    `write_json ${edifFile.replace('.edif', '.json')}`,
  ].join('\n');
}

// ── Exports ───────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined') {
  module.exports = { RTLILEmitter, emitRTLIL, generateYosysScript };
}
