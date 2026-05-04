/**
 * kh-partitioner.js — KH Compiler: FPGA/CPU Partitioning Pass
 * 
 * Takes a KH AST and annotates every node with a partition tag:
 *   node.__partition = 'fpga' | 'cpu'
 * 
 * Also returns a PartitionReport with warnings and cost estimates.
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const PARTITION = { FPGA: 'fpga', CPU: 'cpu' };

const FPGA_LOGIC_OPS = new Set([
  'and', 'or', 'not', 'same', 'xor', 'nand', 'nor',  // existing five
  'maj', 'one', 'two', 'odd',                          // new four
]);

// Bounded loop keywords that are safe for FPGA
const FPGA_LOOP_TYPES = new Set(['repeat', 'fold', 'cycle']);

// Memory declarations that map to FPGA primitives
const FPGA_MEMORY_TYPES = new Set(['wire', 'register', 'buffer']);

// ── Partition Context ─────────────────────────────────────────────────────────

class PartitionContext {
  constructor() {
    this.warnings  = [];
    this.errors    = [];
    this.nodeCount = { fpga: 0, cpu: 0 };
    // Compile-time known values — populated by constant folding pass
    this.constants = new Map();
    // Branch cost accumulator — warn when if/else mux count gets expensive
    this.branchCost = 0;
    this.BRANCH_WARN_THRESHOLD = 32;
  }

  warn(message, node) {
    this.warnings.push({ message, line: node?.line ?? null });
  }

  error(message, node) {
    this.errors.push({ message, line: node?.line ?? null });
  }

  isConstant(name) {
    return this.constants.has(name);
  }

  getConstant(name) {
    return this.constants.get(name);
  }

  setConstant(name, value) {
    this.constants.set(name, value);
  }

  tag(node, partition) {
    node.__partition = partition;
    this.nodeCount[partition]++;
    return partition;
  }
}

// ── Constant Folding Pre-Pass ─────────────────────────────────────────────────
// Walks the AST before partitioning to identify compile-time constants.
// These are used to resolve if/else conditions and loop bounds statically.

function foldConstants(ast, ctx) {
  if (!ast || typeof ast !== 'object') return;

  for (const node of (ast.body ?? [])) {
    foldNode(node, ctx);
  }
}

function foldNode(node, ctx) {
  if (!node) return;

  switch (node.type) {
    case 'Make': {
      // make x 42 — if RHS is a literal, record as compile-time constant
      const val = evalConstExpr(node.expr, ctx);
      if (val !== null) {
        ctx.setConstant(node.name, val);
      }
      break;
    }
    case 'Fun':
    case 'If':
    case 'Loop':
    case 'For':
      // Recurse into bodies
      foldNode(node.body, ctx);
      foldNode(node.else_, ctx);
      break;
    default:
      break;
  }
}

// Attempts to evaluate an expression node to a compile-time constant.
// Returns the value if successful, null otherwise.
function evalConstExpr(node, ctx) {
  if (!node) return null;

  switch (node.type) {
    case 'NumberLit': return node.value;
    case 'BoolLit':   return node.value;
    case 'StringLit': return typeof node.value === 'string' ? node.value : null;

    case 'Identifier': {
      return ctx.isConstant(node.name) ? ctx.getConstant(node.name) : null;
    }

    case 'BinOp': {
      const l = evalConstExpr(node.left, ctx);
      const r = evalConstExpr(node.right, ctx);
      if (l === null || r === null) return null;
      switch (node.op) {
        case '+':  return l + r;
        case '-':  return l - r;
        case '*':  return l * r;
        case '/':  return l / r;
        case '%':  return l % r;
        case '^':  return Math.pow(l, r);
        case '<':  return l < r;
        case '>':  return l > r;
        case '<=': return l <= r;
        case '>=': return l >= r;
        case '=':  return l === r;
        case '!=': return l !== r;
        case 'and': return l && r;
        case 'or':  return l || r;
        default:   return null;
      }
    }

    case 'UnaryOp': {
      const val = evalConstExpr(node.operand, ctx);
      if (val === null) return null;
      if (node.op === 'not') return !val;
      if (node.op === '-')   return -val;
      return null;
    }

    default:
      return null;
  }
}

// ── Main Partitioner ──────────────────────────────────────────────────────────

function partitionAST(ast) {
  const ctx = new PartitionContext();

  // Pre-pass: fold constants so we can make static decisions
  foldConstants(ast, ctx);

  // Main pass: annotate every node
  for (const node of (ast.body ?? [])) {
    partitionNode(node, ctx);
  }

  return {
    ast,
    warnings:   ctx.warnings,
    errors:     ctx.errors,
    nodeCount:  ctx.nodeCount,
    summary: {
      fpgaNodes: ctx.nodeCount.fpga,
      cpuNodes:  ctx.nodeCount.cpu,
      total:     ctx.nodeCount.fpga + ctx.nodeCount.cpu,
      fpgaRatio: ctx.nodeCount.fpga / (ctx.nodeCount.fpga + ctx.nodeCount.cpu || 1),
    }
  };
}

// ── Node Partitioner ──────────────────────────────────────────────────────────

function partitionNode(node, ctx) {
  if (!node) return PARTITION.CPU;

  switch (node.type) {

    // ── Memory declarations ───────────────────────────────────────────────────
    case 'Make': {
      const memType = node.memType; // 'wire' | 'register' | 'buffer' | undefined
      if (memType && FPGA_MEMORY_TYPES.has(memType)) {
        // Size must be known at compile time
        const size = evalConstExpr(node.sizeExpr, ctx);
        if (size === null && memType !== 'wire') {
          ctx.error(
            `'${memType}' size must be a compile-time constant for FPGA partition — ` +
            `move to CPU partition or use a fixed size literal`,
            node
          );
          return ctx.tag(node, PARTITION.CPU);
        }
        return ctx.tag(node, PARTITION.FPGA);
      }
      // Regular make — FPGA if RHS is a constant or pure logic expression
      const exprPartition = partitionExpr(node.expr, ctx);
      return ctx.tag(node, exprPartition);
    }

    // ── Control flow ──────────────────────────────────────────────────────────
    case 'If': {
      const condIsConstant = evalConstExpr(node.condition, ctx) !== null;

      if (condIsConstant) {
        // Compile-time condition — dead branch eliminated, pure FPGA
        ctx.warn(
          `Compile-time constant condition on line ${node.line} — dead branch will be eliminated`,
          node
        );
        partitionBlock(node.body, ctx);
        partitionBlock(node.else_, ctx);
        return ctx.tag(node, PARTITION.FPGA);
      }

      // Runtime condition — both branches compiled, mux selects result
      const thenPartition = partitionBlock(node.body, ctx);
      const elsePartition = partitionBlock(node.else_, ctx);

      // Accumulate branch cost — each mux adds to the gate budget
      ctx.branchCost++;
      if (ctx.branchCost >= ctx.BRANCH_WARN_THRESHOLD) {
        ctx.warn(
          `High branch count (${ctx.branchCost} muxes) — consider restructuring to reduce ` +
          `gate network complexity or moving logic to CPU partition`,
          node
        );
      }

      // If either branch forces CPU, the whole if goes to CPU
      if (thenPartition === PARTITION.CPU || elsePartition === PARTITION.CPU) {
        return ctx.tag(node, PARTITION.CPU);
      }
      return ctx.tag(node, PARTITION.FPGA);
    }

    // ── Loop forms ────────────────────────────────────────────────────────────
    case 'Loop': {
      // 'while condition' — not allowed in FPGA partition
      if (node.loopType === 'while') {
        ctx.warn(
          `'while' loop on line ${node.line} cannot be mapped to FPGA — moved to CPU partition`,
          node
        );
        partitionBlock(node.body, ctx);
        return ctx.tag(node, PARTITION.CPU);
      }

      // 'cycle' — infinite loop, fine for persistent FPGA workloads
      if (node.loopType === 'cycle') {
        partitionBlock(node.body, ctx);
        return ctx.tag(node, PARTITION.FPGA);
      }

      // 'repeat n' — must be compile-time constant
      if (node.loopType === 'repeat') {
        const n = evalConstExpr(node.count, ctx);
        if (n === null) {
          ctx.warn(
            `'repeat' with non-constant count on line ${node.line} — moved to CPU partition`,
            node
          );
          partitionBlock(node.body, ctx);
          return ctx.tag(node, PARTITION.CPU);
        }
        partitionBlock(node.body, ctx);
        return ctx.tag(node, PARTITION.FPGA);
      }

      // 'fold n' — maps to counter + single gate network
      if (node.loopType === 'fold') {
        partitionBlock(node.body, ctx);
        return ctx.tag(node, PARTITION.FPGA);
      }

      // 'loop x < n' — fine, worst-case allocation with runtime counter
      // Check if bound is statically known (better allocation)
      const bound = evalConstExpr(node.condition, ctx);
      if (bound !== null) {
        ctx.setConstant(node.variable, 0); // variable becomes known-range
      }
      partitionBlock(node.body, ctx);
      return ctx.tag(node, PARTITION.FPGA);
    }

    // ── Dynamic allocation — always CPU ───────────────────────────────────────
    case 'DynAlloc':
    case 'Push':
    case 'Pop': {
      partitionBlock(node.body, ctx);
      return ctx.tag(node, PARTITION.CPU);
    }

    // ── Functions ─────────────────────────────────────────────────────────────
    case 'Fun': {
      // Analyse body to determine partition
      const bodyPartition = partitionBlock(node.body, ctx);
      return ctx.tag(node, bodyPartition);
    }

    // ── Expressions as statements ─────────────────────────────────────────────
    case 'ExprStatement': {
      const p = partitionExpr(node.expr, ctx);
      return ctx.tag(node, p);
    }

    // ── Network/IO — always CPU ───────────────────────────────────────────────
    case 'Ask':
    case 'Gmail':
    case 'Post':
    case 'Wait':
    case 'WaitBlock':
    case 'Import':
    case 'Print':
    case 'Say': {
      return ctx.tag(node, PARTITION.CPU);
    }

    // ── Default — conservative: CPU ───────────────────────────────────────────
    default: {
      return ctx.tag(node, PARTITION.CPU);
    }
  }
}

// Partitions a block (array of nodes), returns the dominant partition.
// If any node requires CPU, the block is CPU.
function partitionBlock(block, ctx) {
  if (!block || block.length === 0) return PARTITION.FPGA;
  let dominant = PARTITION.FPGA;
  for (const node of block) {
    const p = partitionNode(node, ctx);
    if (p === PARTITION.CPU) dominant = PARTITION.CPU;
  }
  return dominant;
}

// Partitions an expression node — returns 'fpga' or 'cpu'.
function partitionExpr(node, ctx) {
  if (!node) return PARTITION.FPGA;

  switch (node.type) {
    case 'NumberLit':
    case 'BoolLit':
    case 'StringLit':
      return PARTITION.FPGA;

    case 'Identifier':
      return PARTITION.FPGA;

    case 'BinOp': {
      const l = partitionExpr(node.left, ctx);
      const r = partitionExpr(node.right, ctx);
      // Logic ops are FPGA-native
      if (FPGA_LOGIC_OPS.has(node.op)) {
        return (l === PARTITION.CPU || r === PARTITION.CPU)
          ? PARTITION.CPU : PARTITION.FPGA;
      }
      return (l === PARTITION.CPU || r === PARTITION.CPU)
        ? PARTITION.CPU : PARTITION.FPGA;
    }

    case 'UnaryOp': {
      const operand = partitionExpr(node.operand, ctx);
      return operand;
    }

    case 'MultiInputOp': {
      // maj/one/two/odd — pure logic, FPGA-native
      const itemPartitions = node.items.map(i => partitionExpr(i, ctx));
      return itemPartitions.some(p => p === PARTITION.CPU)
        ? PARTITION.CPU : PARTITION.FPGA;
    }

    case 'Call': {
      // Function calls — conservative CPU unless proven pure
      // Could be refined with purity analysis in a later pass
      return PARTITION.CPU;
    }

    // Dynamic structures — CPU
    case 'ListLit':
    case 'DictLit':
      return PARTITION.CPU;

    default:
      return PARTITION.CPU;
  }
}

// ── Report Formatter ──────────────────────────────────────────────────────────

function formatReport(result) {
  const lines = [];
  lines.push('── Partition Report ─────────────────────────────────────');
  lines.push(`  FPGA nodes : ${result.summary.fpgaNodes}`);
  lines.push(`  CPU nodes  : ${result.summary.cpuNodes}`);
  lines.push(`  FPGA ratio : ${(result.summary.fpgaRatio * 100).toFixed(1)}%`);
  lines.push('');

  if (result.warnings.length > 0) {
    lines.push('  Warnings:');
    for (const w of result.warnings) {
      lines.push(`    [line ${w.line ?? '?'}] ${w.message}`);
    }
    lines.push('');
  }

  if (result.errors.length > 0) {
    lines.push('  Errors:');
    for (const e of result.errors) {
      lines.push(`    [line ${e.line ?? '?'}] ${e.message}`);
    }
    lines.push('');
  }

  lines.push('─────────────────────────────────────────────────────────');
  return lines.join('\n');
}

// ── Exports ───────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined') {
  module.exports = { partitionAST, formatReport, PARTITION };
}
