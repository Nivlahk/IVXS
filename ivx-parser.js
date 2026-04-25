// ivx-parser.js — IVX Parser & Graph Builder
// Lexes, preprocesses, and parses IVX source into a node/edge graph.
// Depends on: nothing (pure functions, no DOM)
// Globals exposed: parseivx, preprocessControlFlowSyntax,
//                  NODE_KEYWORDS, INCOMING_KEYWORDS, OUTGOING_KEYWORDS,
//                  NODE_KEYS, IN_KEYS, OUT_KEYS
// PROPRIETARY AND CONFIDENTIAL
// Copyright 2026 IVX. All rights reserved.

'use strict';

// ── Parser + Graph ──────────────────────────────────────────────────────────
const NODE_ARITY = {
    Start: { minIn: 0, maxIn: 0, minOut: 1, maxOut: 1 },
    End: { minIn: 1, maxIn: 1, minOut: 0, maxOut: 0 },
    Process: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
    Decision: { minIn: 1, maxIn: 1, minOut: 2, maxOut: Infinity },
    Connector: { minIn: 1, maxIn: Infinity, minOut: 1, maxOut: 1 },
    Input: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
    Output: { minIn: 1, maxIn: 1, minOut: 1, maxOut: 1 },
    Function: { minIn: 0, maxIn: 1, minOut: 0, maxOut: 1 },
};

function validNodeIO(nodes, edges) {
    const errors = [];
    const inDeg = new Map();
    const outDeg = new Map();
    for (const e of edges) {
        outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
        inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    }
    for (const n of nodes) {
        const rules = NODE_ARITY[n.kind];
        const ins = inDeg.get(n.id) ?? 0;
        const outs = outDeg.get(n.id) ?? 0;
        const info = `N${n.id} [${n.kind}] L${n.line + 1}`;
        if (ins < rules.minIn)
            errors.push(`${info}: ${ins} inputs < min ${rules.minIn}`);
        if (rules.maxIn !== Infinity && ins > rules.maxIn)
            errors.push(`${info}: ${ins} inputs > max ${rules.maxIn}`);
        if (outs < rules.minOut)
            errors.push(`${info}: ${outs} outputs < min ${rules.minOut}`);
        if (rules.maxOut !== Infinity && outs > rules.maxOut)
            errors.push(`${info}: ${outs} outputs > max ${rules.maxOut}`);
    }
    return errors;
}

// --- Keyword groups ---
const INCOMING_KEYWORDS = ['then', 'else']; // 'then' is accepted but has no effect
// Bug 5 fix: 'note' is a comment marker, not a node keyword.  It must NOT be
// in NODE_KEYWORDS, otherwise parseLine sets nodeKey='note' and the main loop's
// else-branch silently creates a spurious Process node for every standalone
// 'note ...' line, and KIND_TO_KEY has no entry for it so round-trips break.
const NODE_KEYWORDS = ['if', 'fork', 'loop', 'dot', 'take', 'say', 'give', 'fun', 'end', 'from', 'wait', 'try'];
const OUTGOING_KEYWORDS = ['prev', 'next'];
const NODE_KEYS = new Set(NODE_KEYWORDS);
const IN_KEYS = new Set(INCOMING_KEYWORDS);
const OUT_KEYS = new Set(OUTGOING_KEYWORDS);
const makeCtx = (baseIndent, firstLast, savedLast = null) => ({
  scopeStack: [{ indent: baseIndent, lastExec: firstLast }],
  decStack: [], pendingElse: null, baseIndent, savedLastExec: savedLast,
});
function parseivx(source) {
  // Treat ';' as a line break and 'then ' as a newline with indent
  const preprocessed = preprocessControlFlowSyntax(source);
  const rawLines = preprocessed.split('\n');

  // Pass 1: parse lines and collect indent info
  const parsedLines = rawLines.map((raw, i) => {
    const commentIdx = raw.indexOf('note ');
    const trimmed = (commentIdx >= 0 ? raw.slice(0, commentIdx) : raw).trim();
    if (!trimmed) return { lineNum: i, indent: 0, raw: '', incoming: '', nodeKey: '', content: '', outgoing: '' };
    const indent = Math.floor((raw.length - raw.trimStart().length) / 2);
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    let j = 0;
    let incoming = '';
    let nodeKey = '';
    if (j < tokens.length && IN_KEYS.has(tokens[j])) { incoming = tokens[j]; j++; }
    if (!nodeKey && j < tokens.length && NODE_KEYS.has(tokens[j])) { nodeKey = tokens[j]; j++; }
    const remaining = tokens.slice(j);
    let outgoing = '';
    if (remaining.length > 0 && OUT_KEYS.has(remaining[remaining.length - 1])) outgoing = remaining.pop();
    return { lineNum: i, indent, raw: trimmed, incoming, nodeKey, content: remaining.join(' '), outgoing };
  });

  // Pass 2: assign fun-body-of and wait-body-of meta based on indentation
  let funStack = [];
  let lastFun = null;
  let lastFunIndent = -1;
  let waitStack = [];
  let lastWait = null;
  let lastWaitIndent = -1;
  for (let i = 0; i < parsedLines.length; i++) {
    const pl = parsedLines[i];
    // Fun tracking
    if (pl.nodeKey === 'fun' || pl.nodeKey === 'Function') {
      lastFun = i;
      lastFunIndent = pl.indent;
      funStack.push({ funLine: i, indent: pl.indent });
      pl._funHeader = true;
    } else if (lastFun !== null && pl.indent > lastFunIndent) {
      pl._funBodyOf = lastFun;
    } else if (lastFun !== null && pl.indent <= lastFunIndent) {
      funStack.pop();
      if (funStack.length > 0) {
        lastFun = funStack[funStack.length - 1].funLine;
        lastFunIndent = funStack[funStack.length - 1].indent;
      } else {
        lastFun = null;
        lastFunIndent = -1;
      }
    }
    // Try block tracking
    if (pl.nodeKey === 'try') {
      pl._tryHeader = true;
      pl._tryId = i;
    } else if (pl.raw === 'err' || pl.raw?.startsWith('err ')) {
      pl._errHandler = true;
      // Find most recent try header at same or lower indent
      for (let k = i - 1; k >= 0; k--) {
        if (parsedLines[k]._tryHeader && parsedLines[k].indent <= pl.indent) {
          pl._errHandlerOf = k;
          parsedLines[k]._errHandlerLine = i;
          break;
        }
      }
    } else {
      // Check if inside a try block
      for (let k = i - 1; k >= 0; k--) {
        if (parsedLines[k]._tryHeader && parsedLines[k].indent < pl.indent) {
          pl._tryBodyOf = k;
          break;
        }
        if (parsedLines[k].indent < pl.indent) break; // strictly less: stop only at lower indent
      }
    }

    // Wait block tracking — detect wait with a trigger keyword after it
    const isWaitBlock = pl.nodeKey === 'wait' &&
      /^(email|sheets|time|http)\b/.test(pl.content);
    if (isWaitBlock) {
      lastWait = i;
      lastWaitIndent = pl.indent;
      waitStack.push({ waitLine: i, indent: pl.indent });
      pl._waitHeader = true;
    } else if (lastWait !== null && pl.indent > lastWaitIndent) {
      pl._waitBodyOf = lastWait;
    } else if (lastWait !== null && pl.indent <= lastWaitIndent) {
      waitStack.pop();
      if (waitStack.length > 0) {
        lastWait = waitStack[waitStack.length - 1].waitLine;
        lastWaitIndent = waitStack[waitStack.length - 1].indent;
      } else {
        lastWait = null;
        lastWaitIndent = -1;
      }
    }
  }

  // The rest of the parser should use parsedLines instead of re-parsing rawLines
  // (You may need to adapt the rest of the function to use parsedLines)
    const nodes = [];
    const edges = [];
    const validationErrors = [];
    let nextId = 1;
    const startNode = { id: 0, kind: 'Start', line: 0, segmentIndex: 0, indent: 0, text: '', meta: 'implicit start' };
    nodes.push(startNode);
    const connectors = [];
    const pendingNext = new Map();
    let ctx = makeCtx(-1, null);
    const ctxStack = [];
    const curScope = () => ctx.scopeStack[ctx.scopeStack.length - 1];
    const getLastExec = () => curScope().lastExec;
    const setLastExec = (n) => { curScope().lastExec = n; };
    const setLastExecAtIndent = (indent, n) => {
        // Update all scope entries whose indent is <= the target indent.
        // This matters for if-joins inside loop bodies: the loop body scope
        // sits on the stack with a lower indent than the if, but as a higher
        // stack index. We must update it so getLastExec() returns the if-join,
        // not the stale loop-body lastExec.
        let updated = false;
        for (let i = ctx.scopeStack.length - 1; i >= 0; i--) {
            if (ctx.scopeStack[i].indent <= indent) {
                ctx.scopeStack[i].lastExec = n;
                updated = true;
                // Continue updating enclosing scopes that are still active
                // and whose lastExec is stale (i.e. predates the if-join)
            }
        }
        if (!updated) ctx.scopeStack[0].lastExec = n;
    };
    const addNode = (kind, line, text, meta = '') => {
        const n = { id: nextId++, kind, line, segmentIndex: 0, indent: 0, text, meta: meta || undefined };
        nodes.push(n);
        return n;
    };
    const pushEdge = (from, to, label) => {
        if (from === to) {
            return;
        }
        if (edges.some(e => e.from === from && e.to === to && (e.label ?? '') === (label ?? ''))) {
            return;
        }
        edges.push({ from, to, label });
    };
    const wireSeq = (from, to) => { if (from) {
        pushEdge(from.id, to.id);
    } };
    // Wire sequentially and replace 'from' with 'to' in all decStack branchTails,
    // so the tail always points to the last node in a branch.
    const wireSeqAndUpdateTails = (from, to) => {
        wireSeq(from, to);
        if (from) {
            for (const d of ctx.decStack) {
                const idx = d.branchTails.indexOf(from);
                if (idx !== -1) d.branchTails[idx] = to;
            }
        }
    };
    const prevConn = (beforeLine) => {
        for (let i = connectors.length - 1; i >= 0; i--) {
            if (connectors[i].line < beforeLine) {
                return connectors[i];
            }
        }
        return null;
    };
    const consumePendingNext = (targetNode) => {
      if (!targetNode || targetNode.kind !== 'Connector') return;
      for (const id of pendingNext.keys()) {
        pushEdge(id, targetNode.id);
      }
      pendingNext.clear();
    };
    const hasEdgesFrom = (id) => edges.some(e => e.from === id);
    const isEnd = (n) => n.kind === 'End';
    const replaceBranchTail = (orig, rep) => {
        for (const d of ctx.decStack) {
            const idx = d.branchTails.indexOf(orig);
            if (idx !== -1) {
                d.branchTails[idx] = rep;
            }
        }
    };
    const makeDecisionCtx = (decNode, kind, indent, parentBranchDc = null, autoConnector = null) => ({
      decNode,
      autoConnector,
      branchTails: [],
      trueBranchHead: null,
      kind,
      indent,
      parentBranchDc
    });
    const promoteExitToParentBranch = (dc, exitNode) => {
        const parent = dc.parentBranchDc;
        if (!parent || !exitNode || isEnd(exitNode)) return;
        const oldIdx = parent.branchTails.indexOf(dc.decNode);
        if (oldIdx !== -1) parent.branchTails.splice(oldIdx, 1);
        if (!parent.branchTails.includes(exitNode)) {
            parent.branchTails.push(exitNode);
        }
    };
    const applyOutgoingDirective = (node, outgoing, lineNum, handlers = {}) => {
      if (!node) return '';
      if (outgoing === 'next') {
        pendingNext.set(node.id, node);
        handlers.onNext?.(node);
        return 'next';
      }
      if (outgoing === 'prev') {
        const t = prevConn(lineNum);
        if (t) pushEdge(node.id, t.id);
        handlers.onPrev?.(node);
        return 'prev';
      }
      return '';
    };
    const tryWireAsBranch = (node) => {
        if (ctx.pendingElse) {
            const { ctx: dc, edgeLabel } = ctx.pendingElse;
            ctx.pendingElse = null;
            pushEdge(dc.decNode.id, node.id, edgeLabel);
            if (!isEnd(node)) {
                dc.branchTails.push(node);
            }
            return true;
        }
        const dc = ctx.decStack[ctx.decStack.length - 1];
        if (dc && !hasEdgesFrom(dc.decNode.id)) {
            pushEdge(dc.decNode.id, node.id, (dc.kind === 'if' || dc.kind === 'loop') ? 'yes' : undefined);
            if (!isEnd(node)) {
                dc.branchTails.push(node);
                if (dc.kind === 'if' && dc.trueBranchHead === null) dc.trueBranchHead = node;
            }
            return true;
        }
        return false;
    };
    const flushOne = (dc, trigger) => {
        while (ctx.scopeStack.length > 1 &&
               ctx.scopeStack[ctx.scopeStack.length - 1].indent > dc.indent) {
            ctx.scopeStack.pop();
        }

        if (dc.kind === 'if') {
            // Deduplicate branchTails: remove any node that already has a
            // sequential outgoing edge to another node in branchTails, since
            // only the final node of each branch should wire to the connector.
            // Also ensure the current lastExec (true tail of the active branch)
            // is included — nodes added deep in an else scope may not have been
            // added to branchTails via tryWireAsBranch.
            const curTail = getLastExec();
            if (curTail && !isEnd(curTail) && !dc.branchTails.includes(curTail)) {
                dc.branchTails.push(curTail);
            }
            const branchTailSet = new Set(dc.branchTails.map(t => t.id));
            const dedupedTails = dc.branchTails.filter(t =>
              !edges.some(e => e.from === t.id && branchTailSet.has(e.to))
            );
            dc.branchTails = dedupedTails;
            const live = dc.branchTails.filter(t => !isEnd(t));
          let exitNode = dc.decNode;

            // Always create an autoConnector when there's a trigger (next sequential node),
            // even if all branch tails are End nodes. This prevents the trigger from being
            // mistakenly added to an enclosing loop's branchTails as a loop-back candidate.
            if ((live.length || trigger) && !dc.autoConnector) {
                dc.autoConnector = addNode('Connector', dc.decNode.line, 'if-join', 'if-join');
                connectors.push(dc.autoConnector);
            }

            if (!edges.some(e => e.from === dc.decNode.id && e.label === 'yes')) {
                const trueDest = dc.trueBranchHead ?? dc.autoConnector ?? trigger ?? dc.decNode;
                pushEdge(dc.decNode.id, trueDest.id, 'yes');
            }

            if (!edges.some(e => e.from === dc.decNode.id && e.label === 'no')) {
                const falseDest = dc.autoConnector ?? trigger ?? dc.decNode;
                pushEdge(dc.decNode.id, falseDest.id, 'no');
            }

            if (dc.autoConnector) {
                for (const t of live) {
                    pushEdge(t.id, dc.autoConnector.id);
                }

                replaceBranchTail(dc.decNode, dc.autoConnector);
                setLastExecAtIndent(dc.indent, dc.autoConnector);

                if (trigger) {
                    pushEdge(dc.autoConnector.id, trigger.id);
                    // Don't setLastExecAtIndent(trigger) here — caller sets lastExec after flushUntil
                  exitNode = trigger;
                } else {
                  exitNode = dc.autoConnector;
                }
            } else if (trigger) {
                replaceBranchTail(dc.decNode, trigger);
                // Don't setLastExecAtIndent(trigger) here — caller sets lastExec after flushUntil
                exitNode = trigger;
            } else {
                setLastExecAtIndent(dc.indent, dc.decNode);
                exitNode = dc.decNode;
            }

              promoteExitToParentBranch(dc, exitNode);

            return;
        }

        if (dc.kind === 'loop') {
            dc.branchTails.forEach(t => pushEdge(t.id, dc.autoConnector.id));
          let exitNode = dc.decNode;
            if (!edges.some(e => e.from === dc.decNode.id && e.label === 'no')) {
                if (trigger) {
                    pushEdge(dc.decNode.id, trigger.id, 'no');
                    replaceBranchTail(dc.decNode, trigger);
                    setLastExecAtIndent(dc.indent, trigger);
              exitNode = trigger;
                } else {
                    // No following node: loop false-edge will be wired to End later in final pass
                    setLastExecAtIndent(dc.indent, dc.decNode);
              exitNode = dc.decNode;
                }
            }
          promoteExitToParentBranch(dc, exitNode);
        }
    };
    const flushUntil = (minIndent, trigger) => {
        while (ctx.decStack.length > 0 && ctx.decStack[ctx.decStack.length - 1].indent >= minIndent) {
            flushOne(ctx.decStack[ctx.decStack.length - 1], trigger);
            ctx.decStack.pop();
        }
    };
    const closeFunCtx = () => {
        flushUntil(-Infinity, null);
        const saved = ctx.savedLastExec;
        ctx = ctxStack.pop();
        ctx.scopeStack[0].lastExec = saved;
    };
    // ── Main loop (using parsedLines) ─────────────────────────────────────────────
    let processedLine = new Set();
    for (const pl of parsedLines) {
        const { lineNum, incoming, nodeKey, content, outgoing, _funHeader, _funBodyOf, _waitHeader, _waitBodyOf, _tryHeader, _tryBodyOf, _errHandler, _errHandlerOf } = pl;
        const indent = pl.indent;
        if (processedLine.has(lineNum)) continue;
        // Set fun-body-of / wait-body-of / try meta if in scope
        let meta = '';
        if (_funHeader) meta = 'fun-header';
        if (_funBodyOf !== undefined) meta = `fun-body-of=${_funBodyOf}`;
        if (_waitHeader) meta = 'wait-header';
        if (_waitBodyOf !== undefined) meta = `wait-body-of=${_waitBodyOf}`;
        if (_tryHeader) meta = `try-block`;
        if (_tryBodyOf !== undefined) meta = `try-body-of=${_tryBodyOf}`;
        if (_errHandler) meta = `error-handler-of=${_errHandlerOf ?? ''}`;
        while (ctxStack.length > 0 && indent <= ctx.baseIndent) {
            closeFunCtx();
        }
        // Restore lastExec when dedenting out of an err block
        if (ctx._errRestoreStack) {
            while (ctx._errRestoreStack.length > 0 &&
                   indent <= ctx._errRestoreStack[ctx._errRestoreStack.length - 1].indent) {
                const { savedExec } = ctx._errRestoreStack.pop();
                setLastExec(savedExec);
            }
        }
        if (incoming === 'else') {
            let dcIdx = ctx.decStack.length - 1;
            if (nodeKey !== 'if') {
                for (let i = ctx.decStack.length - 1; i >= 0; i--) {
                    if (ctx.decStack[i].indent === indent) { dcIdx = i; break; }
                }
            }
            const dc = ctx.decStack[dcIdx];
            // Only reject 'else' if the decision context at the MATCHING indent is a loop.
            // An 'else' inside an 'if' that is nested inside a 'loop' is perfectly valid —
            // it belongs to the 'if', not the 'loop'.
            if (dc && dc.kind === 'loop' && dc.indent === indent) {
                validationErrors.push(`Line ${lineNum + 1}: 'else' is not valid after 'loop'. Loops have no branches — the false path exits sequentially.`);
                processedLine.add(lineNum);
                continue;
            }
            if (dc) {
              // Graph-collapse behavior: treat `else if <cond>` as a labeled
              // middle branch on the parent `if` (Python `elif` style), rather
              // than creating a nested Decision node.
              if (nodeKey === 'if' && dc.kind === 'if') {
                const edgeLabel = (content || '').trim() || 'else-if';
                ctx.pendingElse = { ctx: dc, edgeLabel };
                processedLine.add(lineNum);
                continue;
              }

                const edgeLabel = dc.kind === 'fork' ? undefined : 'no';
                let bn;
                if (nodeKey === 'if') {
                    bn = addNode('Decision', lineNum, content, 'if-cond');
                } else if (nodeKey === 'dot') {
                    bn = addNode('Connector', lineNum, content || 'dot', 'explicit-con');
                    connectors.push(bn);
                } else if (nodeKey === 'end') {
                    bn = addNode('End', lineNum, content);
                } else if (nodeKey === 'take') {
                    bn = addNode('Input', lineNum, content);
                } else if (nodeKey === 'say') {
                    bn = addNode('Output', lineNum, content);
                } else {
                    bn = addNode('Process', lineNum, content, meta);
                }
                pushEdge(dc.decNode.id, bn.id, edgeLabel);
                // Before recording the new else-branch tail, consolidate the
                // previous branch's tails down to just the actual last node
                // (getLastExec). Intermediate nodes accumulate in branchTails
                // via tryWireAsBranch but only the final sequential node matters.
                const prevTail = getLastExec();
                dc.branchTails.length = 0;
                if (prevTail && !isEnd(prevTail)) dc.branchTails.push(prevTail);
                if (!isEnd(bn)) {
                    dc.branchTails.push(bn);
                }
                if (bn.kind === 'Decision') {
                  const nestedDc = makeDecisionCtx(bn, 'if', indent, dc);
                    ctx.decStack.push(nestedDc);
                    ctx.scopeStack.push({ indent: indent + 1, lastExec: bn });
                    setLastExec(null);
                    processedLine.add(lineNum);
                    continue;
                }
                consumePendingNext(bn);
                applyOutgoingDirective(bn, outgoing, bn.line, {
                  onNext: () => {
                    const idx = dc.branchTails.indexOf(bn);
                    if (idx !== -1) dc.branchTails.splice(idx, 1);
                  },
                  onPrev: () => {
                    const idx = dc.branchTails.indexOf(bn);
                    if (idx !== -1) dc.branchTails.splice(idx, 1);
                  }
                });
                setLastExec(bn);
            }
            processedLine.add(lineNum);
            continue;
        }
        const hasAnyKeyword = incoming || nodeKey || outgoing;
        if (nodeKey) {
            let node;
            if (nodeKey === 'if') {
                node = addNode('Decision', lineNum, content, 'if-cond');
                flushUntil(indent, node);
              const parentBranchDc = ctx.decStack[ctx.decStack.length - 1] ?? null;
              const wiredAsBranch = tryWireAsBranch(node);
              if (!wiredAsBranch) {
                    wireSeqAndUpdateTails(getLastExec(), node);
                }
              ctx.decStack.push(makeDecisionCtx(node, 'if', indent, wiredAsBranch ? parentBranchDc : null));
                setLastExec(null);
                ctx.scopeStack.push({ indent: indent + 1, lastExec: node });
                continue;
            }
            else if (nodeKey === 'fork') {
                node = addNode('Decision', lineNum, content || 'fork', 'fork');
                flushUntil(indent, node);
              const parentBranchDc = ctx.decStack[ctx.decStack.length - 1] ?? null;
              const wiredAsBranch = tryWireAsBranch(node);
              if (!wiredAsBranch) {
                    wireSeqAndUpdateTails(getLastExec(), node);
                }
              ctx.decStack.push(makeDecisionCtx(node, 'fork', indent, wiredAsBranch ? parentBranchDc : null));
                setLastExec(null);
                ctx.scopeStack.push({ indent: indent + 1, lastExec: node });
                continue;
            }
            else if (nodeKey === 'loop') {
                const head = addNode('Connector', lineNum, 'loop-head', 'loop-head');
                connectors.push(head);
                flushUntil(indent, head);
              const parentBranchDc = ctx.decStack[ctx.decStack.length - 1] ?? null;
              const wiredAsBranch = tryWireAsBranch(head);
              if (!wiredAsBranch) {
                    wireSeqAndUpdateTails(getLastExec(), head);
                }
                node = addNode('Decision', lineNum, content, 'loop-cond');
                pushEdge(head.id, node.id);
              ctx.decStack.push(makeDecisionCtx(node, 'loop', indent, wiredAsBranch ? parentBranchDc : null, head));
                setLastExec(null);
                ctx.scopeStack.push({ indent: indent + 1, lastExec: node });
                continue;
            }
            else if (nodeKey === 'dot') {
                node = addNode('Connector', lineNum, content || 'dot', 'explicit-con');
                connectors.push(node);
                flushUntil(indent, node);
                flushUntil(-Infinity, node);
                if (!tryWireAsBranch(node)) {
                    wireSeq(getLastExec(), node);
                }
              consumePendingNext(node);
                setLastExec(node);
            }
            else if (nodeKey === 'end') {
                node = addNode('End', lineNum, content);
                flushUntil(indent, node);
                // Remove the current branch tail before wiring — end terminates
                // the branch so nothing should flow from it into the auto-connector.
                const deadTail = getLastExec();
                if (deadTail) {
                    for (const d of ctx.decStack) {
                        const idx = d.branchTails.indexOf(deadTail);
                        if (idx !== -1) d.branchTails.splice(idx, 1);
                    }
                }
                if (!tryWireAsBranch(node)) {
                    wireSeq(deadTail, node);
                }
                setLastExec(null);
            }
            else if (nodeKey === 'take') {
                node = addNode('Input', lineNum, content);
                flushUntil(indent, node);
                if (!tryWireAsBranch(node)) {
                    wireSeqAndUpdateTails(getLastExec(), node);
                }
                setLastExec(node);
            }
            else if (nodeKey === 'say') {
                node = addNode('Output', lineNum, content);
                flushUntil(indent, node);
                if (!tryWireAsBranch(node)) {
                    wireSeqAndUpdateTails(getLastExec(), node);
                }
                setLastExec(node);
            }
            else if (nodeKey === 'from') {
                // 'from' creates an external Start node offset to the left of the main
                // column, then merges it with the current sequential flow into a new
                // Connector placed where this line sits in the flow.
                const fromStart = addNode('Start', lineNum, content, 'from-node');
                const mergeConn = addNode('Connector', lineNum, 'from-join', 'from-join');
                connectors.push(mergeConn);
                flushUntil(indent, mergeConn);
                // Wire previous sequential node → merge connector
                const prev = getLastExec();
                if (prev) wireSeq(prev, mergeConn);
                // Wire the external Start → merge connector
                pushEdge(fromStart.id, mergeConn.id);
                // Mark the Start as offset-left so layout can place it correctly
                fromStart.meta = (fromStart.meta ? fromStart.meta + ' ' : '') + `from-offset-of=${mergeConn.id}`;
                consumePendingNext(mergeConn);
                setLastExec(mergeConn);
                node = mergeConn;
            }
            else if (nodeKey === 'fun') {
                node = addNode('Function', lineNum, content, 'fun-header');
                const savedBeforeFun = getLastExec();
                flushUntil(indent, null);
                ctxStack.push(ctx);
                ctx = makeCtx(indent, node, savedBeforeFun);
                continue;
            }
            else if (nodeKey === 'try') {
                // 'try' is a block opener — the try node itself is just a marker.
                // Any content on the same line (e.g. "try fetchData()") becomes
                // the FIRST node of the try body, exactly as if it were written
                // on the next indented line.
                node = addNode('Process', lineNum, 'try', meta || 'try-block');
                flushUntil(indent, node);
                if (!tryWireAsBranch(node)) {
                    wireSeq(getLastExec(), node);
                }
                setLastExec(node);
                node._tryIndent = indent;
                // If there's inline content, create it as the first try-body node
                if (content) {
                    const bodyNode = addNode('Process', lineNum, content, `try-body-of=${node.id}`);
                    wireSeq(node, bodyNode);
                    setLastExec(bodyNode);
                }
            }
            else if (nodeKey === 'wait' && /^(email|sheets|time|http)\b/.test(content)) {
                // Wait block — like fun, sits outside sequential flow
                // Build a display label: "wait email by addr" etc.
                node = addNode('WaitBlock', lineNum, `wait ${content}`, 'wait-header');
                const savedBeforeWait = getLastExec();
                flushUntil(indent, null);
                ctxStack.push(ctx);
                ctx = makeCtx(indent, node, savedBeforeWait);
                continue;
            }
            else {
                // Detect list/dict literals in make assignments so renderTableNode
                // can render them as mini-sheets in the flowchart.
                let nodeMeta = meta;
                const makeRhs = content.replace(/^make\s+[A-Za-z_]\w*\s*/, '').trimStart();
                if (makeRhs.startsWith('[')) nodeMeta = (nodeMeta ? nodeMeta + ' ' : '') + 'list';
                else if (makeRhs.startsWith('{')) nodeMeta = (nodeMeta ? nodeMeta + ' ' : '') + 'dict';
                node = addNode('Process', lineNum, content, nodeMeta);
                // Title badge: variable name for any make assignment
                const _makeM1 = content.match(/^make\s+([A-Za-z_]\w*)/);
                if (_makeM1 && !nodeMeta.includes('list') && !nodeMeta.includes('dict')) node.title = _makeM1[1];
                flushUntil(indent, node);
                if (!tryWireAsBranch(node)) {
                    wireSeq(getLastExec(), node);
                }
                setLastExec(node);
            }
            // A prior 'next' should connect to whichever node starts next, including
            // decision/IO/process nodes used as fork branch starters.
            if (node) {
              consumePendingNext(node);
            }
            if (node) {
                const outKind = applyOutgoingDirective(node, outgoing, lineNum, {
                    onNext: () => {
                        for (const d of ctx.decStack) {
                            const idx = d.branchTails.indexOf(node);
                            if (idx !== -1) d.branchTails.splice(idx, 1);
                        }
                    }
                });
                if (outKind) {
                    setLastExec(null);
                }
            }
            continue;
        }
        const hasNonIncomingKeyword = nodeKey || outgoing;
        if (_errHandler) {
            // err line — create the node but wire it OUTSIDE the main sequential flow.
            // The err handler is a side island: it has no incoming/outgoing sequential edges.
            // We save lastExec (= last try-body node), create the err node as a detached
            // Process, then restore lastExec so what follows continues from the right place.
            const savedExec = getLastExec();
            const errNode = addNode('Process', lineNum, content, meta);
            // No wireSeq — no sequential edges to/from the err handler
            // The err body nodes (_tryBodyOf check doesn't apply to them, they follow
            // this line at deeper indent and will be wired sequentially FROM errNode
            // inside the err branch, but that's fine — they're purely visual)
            setLastExec(errNode);
            // After this line's body is processed, restore lastExec to savedExec
            // so the node after the entire err block continues from the try-body tail.
            // We do this by pushing a sentinel: track the err indent, and when we
            // dedent back out, restore savedExec.
            // Simple approach: store savedExec on a stack keyed by the err indent.
            if (!ctx._errRestoreStack) ctx._errRestoreStack = [];
            ctx._errRestoreStack.push({ indent, savedExec });
            continue;
        }
        if (content || hasNonIncomingKeyword) {
            // Detect list/dict literals on make lines (make is not a nodeKey)
            let fallMeta = meta;
            const fallRhs = content.replace(/^make\s+[A-Za-z_]\w*\s*/, '').trimStart();
            if (fallRhs.startsWith('[')) fallMeta = (fallMeta ? fallMeta + ' ' : '') + 'list';
            else if (fallRhs.startsWith('{')) fallMeta = (fallMeta ? fallMeta + ' ' : '') + 'dict';
            const n = addNode('Process', lineNum, content, fallMeta);
            // Title badge: variable name for any make assignment
            const _makeM2 = content.match(/^make\s+([A-Za-z_]\w*)/);
            if (_makeM2 && !fallMeta.includes('list') && !fallMeta.includes('dict')) n.title = _makeM2[1];
          // Respect branch scope by indent: dedenting out of a branch must flush
          // enclosing decisions before wiring this node.
          flushUntil(indent, n);
            if (!tryWireAsBranch(n)) {
                wireSeqAndUpdateTails(getLastExec(), n);
            }
          consumePendingNext(n);
          setLastExec(n);
          const outKind = applyOutgoingDirective(n, outgoing, lineNum, {
            onNext: () => {
              for (const d of ctx.decStack) {
                const idx = d.branchTails.indexOf(n);
                if (idx !== -1) d.branchTails.splice(idx, 1);
              }
            }
          });
          if (outKind) {
                setLastExec(null);
          }
        }
        continue;
    }
    while (ctxStack.length > 0) {
        closeFunCtx();
    }
    
    // Create implicit End node before final flush so loops can wire to it
    const implEnd = addNode('End', rawLines.length - 1, '', 'implicit end');
    flushUntil(-Infinity, implEnd);
    pendingNext.clear();
    // Pass 2 stamps _funBodyOf as a source-line index (e.g. 3) because it runs
    // before the main loop and doesn't know each Function node's assigned id yet.
    // computeLayout builds ownerOf by parsing "fun-body-of=N" and buckets the
    // Function header node by its node.id.  When N is a line index and node.id
    // is a different number the two buckets never merge → two separate blocks per
    // function instead of one.  Now that Function nodes exist with real ids we
    // patch every body-node meta so both sides of the comparison use the same id.
    const funLineToId = new Map();
    for (const n of nodes) {
        if (n.kind === 'Function') funLineToId.set(n.line, n.id);
    }
    for (const n of nodes) {
        if (!n.meta) continue;
        const m = n.meta.match(/^fun-body-of=(\d+)$/);
        if (!m) continue;
        const lineIdx = parseInt(m[1], 10);
        const nodeId  = funLineToId.get(lineIdx);
        if (nodeId != null && nodeId !== lineIdx) {
            n.meta = `fun-body-of=${nodeId}`;
        }
    }

    // ── Connector merging for graph simplicity ──
    let didMerge;
    do {
      didMerge = false;
      // Find a connector whose only outgoing edge is to another connector
      const connectorNodes = nodes.filter(n => n.kind === 'Connector');
      for (const c1 of connectorNodes) {
        const outEdges1 = edges.filter(e => e.from === c1.id);
        // Count only edges to other connectors
        const edgesToConnectors = outEdges1.filter(e => nodes.some(n => n.id === e.to && n.kind === 'Connector'));
        if (edgesToConnectors.length === 1) {
          const c2 = nodes.find(n => n.id === edgesToConnectors[0].to && n.kind === 'Connector');
          // Don't merge if-join connectors into loop-head connectors — the if-join
          // is a meaningful visual node (branch merge point) and merging it would
          // make the false branch appear to jump directly to the loop-back.
          const c1IsIfJoin   = c1.meta?.includes('if-join');
          const c2IsLoopHead = c2?.meta?.includes('loop-head');
          if (c2 && !c2.meta?.includes('explicit-con') && !(c1IsIfJoin && c2IsLoopHead)) {
            // Redirect all incoming edges to c1 → go to c2 instead
            for (let i = edges.length - 1; i >= 0; i--) {
              if (edges[i].to === c1.id) {
                edges[i].to = c2.id;
              }
            }
            // Remove the c1→c2 edge
            for (let i = edges.length - 1; i >= 0; i--) {
              if (edges[i].from === c1.id && edges[i].to === c2.id) {
                edges.splice(i, 1);
              }
            }
            // Remove c1 from nodes
            for (let i = nodes.length - 1; i >= 0; i--) {
              if (nodes[i].id === c1.id) {
                nodes.splice(i, 1);
              }
            }
            didMerge = true;
          }
        }
      }
    } while (didMerge);

    // implEnd was already created before flushUntil above
    if (!edges.some(e => e.from === startNode.id)) {
      const first = nodes.find(n => n.id !== startNode.id && n.kind !== 'End' && n.kind !== 'Function' && !n.meta?.includes('from-node') && !n.meta?.includes('fun-body-of') && !n.meta?.includes('fun-header') && !n.meta?.includes('fun-footer'));
      if (first) {
        pushEdge(startNode.id, first.id);
      } else {
        // Empty file (or only function definitions): wire Start directly to implicit End
        pushEdge(startNode.id, implEnd.id);
      }
    }
    const finalLast = ctx.scopeStack[0].lastExec;
    if (finalLast && !edges.some(e => e.from === finalLast.id) && finalLast.kind !== 'End') {
      const imp = nodes.find(n => n.meta === 'implicit end');
      if (imp) pushEdge(finalLast.id, imp.id);
    }

    // Post-process: rewrite try-body-of and error-handler-of from line indices to node ids,
    // then build try-body=[ids] on each try-block node.
    // The line index stored in meta is the parsedLines index of the try/err header line.
    // We need the node id of the try-block node on that line instead.
    const lineToTryNodeId = new Map();
    for (const n of nodes) {
      if (n.meta === 'try-block' || n.meta?.startsWith('try-block ')) {
        lineToTryNodeId.set(n.line, n.id);
      }
    }

    for (const n of nodes) {
      if (n.meta?.startsWith('try-body-of=')) {
        const lineIdx = parseInt(n.meta.replace('try-body-of=', ''), 10);
        // lineIdx is the parsedLine index; n.line is the preprocessed line number
        // Find the try-block node by matching parsedLines[lineIdx].lineNum → node.line
        const tryLineNum = parsedLines[lineIdx]?.lineNum;
        if (tryLineNum != null) {
          const tryNodeId = nodes.find(nd =>
            nd.line === tryLineNum && (nd.meta === 'try-block' || nd.meta?.startsWith('try-block '))
          )?.id;
          if (tryNodeId != null) n.meta = `try-body-of=${tryNodeId}`;
        }
      }
      if (n.meta?.startsWith('error-handler-of=')) {
        const lineIdx = parseInt(n.meta.replace('error-handler-of=', ''), 10);
        const tryLineNum = parsedLines[lineIdx]?.lineNum;
        if (tryLineNum != null) {
          const tryNodeId = nodes.find(nd =>
            nd.line === tryLineNum && (nd.meta === 'try-block' || nd.meta?.startsWith('try-block '))
          )?.id;
          if (tryNodeId != null) n.meta = `error-handler-of=${tryNodeId}`;
        }
      }
    }

    for (const n of nodes) {
      if (n.meta === 'try-block' || n.meta?.startsWith('try-block ')) {
        const bodyIds = nodes
          .filter(b => b.meta === `try-body-of=${n.id}`)
          .map(b => b.id);
        if (bodyIds.length) n.meta = `try-block try-body=[${bodyIds.join(',')}]`;
      }
    }

    return { nodes, edges, startNodeId: startNode.id, segments: [], validationErrors };
}

