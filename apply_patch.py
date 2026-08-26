#!/usr/bin/env python3
"""
apply_patch.py -- produces Soak_tester.patched.html from Soak_tester.html.

Two features, both purely additive: every new parameter is optional and
every new return field is extra, so existing callers behave identically.
That is asserted, not assumed -- verify_patch.js checks byte-identical
compiler output on the unpatched paths.

  A. LIVE-OUT (makes `print` possible at all)
     stage2Allocate gains an optional third argument. Without it,
     s2LiveList(mainStmts, new Set(), ctx) hardcodes an empty live-out
     set, so any name written and never read is dead at once and its
     register is reused. Combined with ecall having no architectural
     effect, a compiled program has NO defined output channel.

  B. SOURCE MAP (makes the FLAT abstraction altitude possible)
     stage2Allocate returns raw2Map (raw2 line -> raw line).
     compileCFSource returns srcMap  (output line -> input line).
     parseProgram tags each item with srcLine.
     Composed, these give: assembled instruction -> PC/bytes -> flat line
     -> compiled line -> raw2 line -> raw line -> UAST node. Nothing
     downstream of codegen recorded origin before this, which is why
     "highering" could not be built as an extension of materializeToggle.

Every anchor below must match EXACTLY ONCE. A miss is a hard failure --
silently patching nothing, or patching twice, is the failure mode this
whole exercise exists to avoid.
"""
import sys, os

PATCHES = [

# ── A1: stage2Allocate takes an optional live-out set ────────────────────────
("stage2Allocate signature",
 "function stage2Allocate(raw, enableMetaCF) {",
 "function stage2Allocate(raw, enableMetaCF, liveOut) {"),

# ── A2: seed backward liveness with it ───────────────────────────────────────
("live-out seed",
 "  const liveInMain = s2LiveList(mainStmts, new Set(), ctx);",
 "  // liveOut: names that must still hold their value when the program\n"
 "  // halts. Omitted => empty set => byte-identical to the old behaviour.\n"
 "  // Without this there is no way to observe a result: the register file\n"
 "  // at halt is the only channel (ecall has no architectural effect), and\n"
 "  // a name nothing reads is dead the instant it is written.\n"
 "  const liveInMain = s2LiveList(mainStmts, new Set(liveOut || []), ctx);"),

# ── B1: raw2Map -- identity unless the spill rewriter runs ───────────────────
("raw2Map init",
 "  let raw2 = raw;\n  if (spilled.length) {",
 "  let raw2 = raw;\n"
 "  // raw2Map[i] = index of the `raw` line that produced raw2 line i, or\n"
 "  // null for a line the spill rewriter / prologue synthesized. Identity\n"
 "  // when nothing spills.\n"
 "  let raw2Map = raw.split(\"\\n\").map((_, i) => i);\n"
 "  if (spilled.length) {"),

# ── B2: track origins through the spill rewrite ─────────────────────────────
# The loop body uses `continue`, so it is wrapped in an IIFE (continue ->
# return) and the emitted lines are stamped afterwards. Body text is
# otherwise untouched.
("spill rewrite loop",
 "    for (const line of lines) {\n"
 "      const clean = line.split(\";\")[0].split(\"#\")[0].trim();",
 "    const raw2MapSpill = [];\n"
 "    for (let rawIdx = 0; rawIdx < lines.length; rawIdx++) {\n"
 "      const line = lines[rawIdx];\n"
 "      const clean = line.split(\";\")[0].split(\"#\")[0].trim();"),

# The untouched-line fast path `continue`s, so it stamps on its way out.
# (An earlier attempt wrapped the body in an IIFE so a single stamp could
# sit at the bottom; `continue` is illegal inside a function, and the
# verifier caught it as a SyntaxError at load. Two small anchors that leave
# the original control flow alone are the better trade.)
("spill rewrite passthrough",
 "      if (!roles || (!touchedU.length && !touchedD.length)) { outLines.push(line); continue; }",
 "      if (!roles || (!touchedU.length && !touchedD.length)) {\n"
 "        outLines.push(line); raw2MapSpill.push(rawIdx); continue;\n"
 "      }"),

("spill rewrite loop close",
 "      [...new Set(touchedD)].forEach(n => {\n"
 "        outLines.push(`${indent}li r${reserved.ptr}, ${slot[n]}`);\n"
 "        outLines.push(`${indent}sts64 ${tmpFor[n]}, r${reserved.cap}, r${reserved.ptr}`);\n"
 "      });\n"
 "    }\n"
 "    raw2 = outLines.join(\"\\n\");",
 "      [...new Set(touchedD)].forEach(n => {\n"
 "        outLines.push(`${indent}li r${reserved.ptr}, ${slot[n]}`);\n"
 "        outLines.push(`${indent}sts64 ${tmpFor[n]}, r${reserved.cap}, r${reserved.ptr}`);\n"
 "      });\n"
 "      // Everything emitted for this input line -- the rewritten\n"
 "      // instruction plus the spill loads/stores it forced -- belongs to\n"
 "      // raw line rawIdx.\n"
 "      while (raw2MapSpill.length < outLines.length) raw2MapSpill.push(rawIdx);\n"
 "    }\n"
 "    raw2 = outLines.join(\"\\n\");\n"
 "    raw2Map = raw2MapSpill;"),

("spill prologue origin",
 "    raw2 = pro.join(\"\\n\") + \"\\n\" + raw2;\n  }",
 "    raw2 = pro.join(\"\\n\") + \"\\n\" + raw2;\n"
 "    raw2Map = pro.map(() => null).concat(raw2Map);\n  }"),

("reg-init prologue origin",
 "  if (regInits.length) raw2 = regInits.map(n => `li ${n}, 0`).join(\"\\n\") + \"\\n\" + raw2;",
 "  if (regInits.length) {\n"
 "    raw2 = regInits.map(n => `li ${n}, 0`).join(\"\\n\") + \"\\n\" + raw2;\n"
 "    raw2Map = regInits.map(() => null).concat(raw2Map);\n"
 "  }"),

("stage2Allocate return",
 "  return {mapping, spilled, initNames, raw2, reserved};",
 "  return {mapping, spilled, initNames, raw2, raw2Map, reserved};"),

# ── B4: stamp codegen output with the statement that produced it ────────────
# Done in cfCodegenBlock rather than cfCodegenStmt so ONE change covers
# every emitted node type. The `=== undefined` guard means a nested block's
# inner statement wins over its enclosing one, which is the attribution the
# editor gutter wants.
("cfCodegenBlock stamping",
 "function cfCodegenBlock(stmts, loopStack, retryStack, out) "
 "{ stmts.forEach(s => cfCodegenStmt(s, loopStack, retryStack, out)); }",
 "function cfCodegenBlock(stmts, loopStack, retryStack, out) {\n"
 "  stmts.forEach(s => {\n"
 "    const before = out.length;\n"
 "    cfCodegenStmt(s, loopStack, retryStack, out);\n"
 "    // Stamp origin on everything this statement emitted. Innermost wins:\n"
 "    // a nested block's own statements stamp first and are not overwritten.\n"
 "    for (let i = before; i < out.length; i++) {\n"
 "      if (out[i].srcLine === undefined) out[i].srcLine = (s.lineNo !== undefined ? s.lineNo : null);\n"
 "    }\n"
 "  });\n"
 "}"),

# ── B5: cfScopeToText optionally reports origins ────────────────────────────
("cfScopeToText origins",
 "function cfScopeToText(flatLines) {\n  const out = [];\n  flatLines.forEach(l => {",
 "function cfScopeToText(flatLines, originsOut) {\n  const out = [];\n"
 "  const mark = l => { if (originsOut) originsOut.push(l.srcLine !== undefined ? l.srcLine : null); };\n"
 "  flatLines.forEach(l => {\n    mark(l);"),

# ── B6: compileCFSource assembles srcMap ────────────────────────────────────
("compileCFSource body origins",
 "  const bodyText = scopes.map(sc => cfScopeToText(sc.flatLines).join(\"\\n\")).join(\"\\n\");",
 "  const bodyOrigins = [];\n"
 "  const bodyText = scopes.map(sc => cfScopeToText(sc.flatLines, bodyOrigins).join(\"\\n\")).join(\"\\n\");"),

("compileCFSource return",
 "  return {text: fullText, labelCount: registeredNodes.length,\n"
 "          functionCount: functions.length, mutability};",
 "  // srcMap[i] = 0-based index of the line of THIS FUNCTION'S `src`\n"
 "  // argument that produced output line i, or null for a synthesized line\n"
 "  // (CN-table setup, the stack-capability boot prefix, the appended hlt).\n"
 "  // lineNo values are 1-based and counted against the boot-prefixed\n"
 "  // source, so both offsets come back out here -- otherwise every mapped\n"
 "  // line would be off by the prefix length, silently.\n"
 "  const bootPrefixLines = generateStackCapBootPrefix().split(\"\\n\").length;\n"
 "  const setupLineCount = setupText.split(\"\\n\").length;\n"
 "  const srcMap = new Array(setupLineCount).fill(null).concat(\n"
 "    bodyOrigins.map(n => {\n"
 "      if (n === null || n === undefined) return null;\n"
 "      const idx = n - 1 - bootPrefixLines;\n"
 "      return idx >= 0 ? idx : null;\n"
 "    }));\n"
 "  return {text: fullText, labelCount: registeredNodes.length,\n"
 "          functionCount: functions.length, mutability,\n"
 "          srcMap, bootPrefixLines, setupLineCount};"),

# ── B6b: every statement carries its source line, not just `instr` ──────────
# parseCFSource stamped lineNo only on plain instruction statements (used
# for error messages). if/while/loop/def carried none, so every BRANCH and
# connector nop came out untraced -- control flow, i.e. exactly the part a
# reader most wants to trace. Wrapping parseStatement stamps all of them
# without touching any of the individual statement constructors.
("parseStatement lineNo",
 "  function parseStatement() {\n"
 "    const line = lines[pos], indent = line.indent, text = line.text;",
 "  function parseStatement() {\n"
 "    const stmtLineNo = lines[pos] ? lines[pos].lineNo : null;\n"
 "    const stmt = parseStatementInner();\n"
 "    if (stmt && typeof stmt === 'object' && stmt.lineNo === undefined) stmt.lineNo = stmtLineNo;\n"
 "    return stmt;\n"
 "  }\n"
 "  function parseStatementInner() {\n"
 "    const line = lines[pos], indent = line.indent, text = line.text;"),

# ── C: exact capability-relative address arithmetic ─────────────────────────
# BUG (found while testing the ABI, independent of it):
#   sts64/ld64/ld.s32/sts32 compute the effective address as
#     Number(RD(cap)) + Number(RD(ptr))
#   The interpreter's own comment at li.64 says it models `cap.base +
#   offset` with a flat address space -- i.e. RD(cap) is meant to be a BASE.
#   But generateStackCapTokenLines puts a full AUTHENTICATED TOKEN there
#   (idx | gen<<16 | mac<<32), which for the stack capability is
#   8230353620671987712. Converting that to a JS Number lands in a range
#   where float64 spacing is 2048, so every address within 2048 bytes of
#   another collapses onto it.
#
#   Consequence: SPILLING SILENTLY PRODUCES WRONG ANSWERS. Spill slots are
#   8 bytes apart (SPILL_BASE_ADDR 512, 520, 528...), so they all alias.
#   Reproducer: sum v0..v69 where v_k = k+1 -- expected 2485, actual 2695.
#   Every value that stays in a register is correct; only spilled ones are
#   wrong, which is why it survived this long.
#
# FIX: do the arithmetic in BigInt (exact), then mask to 32 bits so the
# result is an exact, Number-safe Map key. The token's low 32 bits are
# idx | gen<<16, so each installed capability keeps its own distinct
# region and offsets within it stay distinct. Store/load round-trips are
# preserved, which is all the soak scenarios depend on -- they assert on
# REGISTER values after a load, not on absolute addresses.
#
# NOT a full capability model: this does not decode base/bounds or check
# permissions, so the simulator still cannot catch a capability violation
# on a memory op. That is a separate and larger decision.
("ld64 address",
 "      WR(b1, mem.get(Number(RD(b2))+Number(RD(b3))) ?? 0n);",
 "      WR(b1, mem.get(simMemAddr(RD(b2), RD(b3))) ?? 0n);"),

("ld.s32 address",
 "      const v = Number((mem.get(Number(RD(b2))+Number(RD(b3))) ?? 0n) & 0xFFFFFFFFn);",
 "      const v = Number((mem.get(simMemAddr(RD(b2), RD(b3))) ?? 0n) & 0xFFFFFFFFn);"),

("sts32 address",
 "      mem.set(Number(RD(b2))+Number(RD(b3)), RD(b1) & 0xFFFFFFFFn);",
 "      mem.set(simMemAddr(RD(b2), RD(b3)), RD(b1) & 0xFFFFFFFFn);"),

("sts64 address",
 "      mem.set(Number(RD(b2))+Number(RD(b3)), RD(b1));",
 "      mem.set(simMemAddr(RD(b2), RD(b3)), RD(b1));"),

("simMemAddr definition",
 "const SPILL_BASE_ADDR = 512; // dmem byte address of spill slot 0 (8 bytes each)",
 "const SPILL_BASE_ADDR = 512; // dmem byte address of spill slot 0 (8 bytes each)\n"
 "\n"
 "// Effective address for a capability-relative memory op. Exact by\n"
 "// construction: RD(cap) can be a full capability token (idx | gen<<16 |\n"
 "// mac<<32), and Number() on a value of that magnitude has a spacing of\n"
 "// 2048 -- which silently aliased every 8-byte spill slot onto the same\n"
 "// address and made spilled values read back as each other.\n"
 "function simMemAddr(capVal, ptrVal) {\n"
 "  return Number(BigInt.asUintN(32, BigInt(capVal) + BigInt(ptrVal)));\n"
 "}"),

# ── B7: parseProgram tags each item with its source line ────────────────────
("parseProgram srcLine",
 "    if (res && !res.label) items.push(res);",
 "    // srcLine (0-based) lets a caller line assembled bytes/PCs back up\n"
 "    // with the text they came from; items skip blanks and labels, so\n"
 "    // index-in-items is NOT index-in-lines.\n"
 "    if (res && !res.label) items.push(Object.assign({srcLine: i}, res));"),
]


def main():
    src_path = sys.argv[1] if len(sys.argv) > 1 else 'Soak_tester.html'
    out_path = sys.argv[2] if len(sys.argv) > 2 else 'Soak_tester.patched.html'
    text = open(src_path, encoding='utf-8').read()
    original_len = len(text)

    for name, old, new in PATCHES:
        n = text.count(old)
        if n != 1:
            print(f"FAIL [{name}]: anchor matched {n} times, expected exactly 1")
            print(f"      anchor: {old[:90]!r}")
            return 1
        text = text.replace(old, new, 1)
        print(f"  ok  {name}")

    # No anchor may survive -- EXCEPT where the replacement deliberately
    # re-emits it (an additive patch that keeps the original line and adds
    # around it). Those are identified structurally by old being a substring
    # of new, not waved through by name, so a genuinely duplicated match is
    # still caught.
    for name, old, new in PATCHES:
        if old in new:
            if text.count(old) != 1:
                print(f"FAIL [{name}]: additive anchor appears {text.count(old)} times, expected 1")
                return 1
            continue
        if old in text:
            print(f"FAIL [{name}]: anchor still present after patching")
            return 1

    open(out_path, 'w', encoding='utf-8').write(text)
    print(f"\nwrote {out_path}  ({original_len} -> {len(text)} bytes, "
          f"+{len(text) - original_len})")
    return 0


if __name__ == '__main__':
    sys.exit(main())
