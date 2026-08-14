"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsekh = exports.preprocessControlFlowSyntax = void 0;

function preprocessControlFlowSyntax(raw) {
  const s = String(raw)
    .replace(/then\s+/g, '\n  ')
    .replace(/\bso\s+/g, '\n');

  let result = '', depth = 0, inD = false, inS = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], prev = i > 0 ? s[i-1] : '';
    if (c === '"' && !inS && prev !== '\\') inD = !inD;
    else if (c === "'" && !inD && prev !== '\\') inS = !inS;
    else if (!inD && !inS) {
      if (c === '[' || c === '{' || c === '(') depth++;
      else if (c === ']' || c === '}' || c === ')') depth--;
    }
    if (c === ';' && depth === 0 && !inD && !inS) result += '\n';
    else result += c;
  }
  return result;
}
exports.preprocessControlFlowSyntax = preprocessControlFlowSyntax;

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

const INCOMING_KEYWORDS = ['then', 'else']; 
const NODE_KEYWORDS = ['if', 'fork', 'loop', 'dot', 'take', 'say', 'print', 'make', 'give', 'fun', 'end', 'from', 'wait', 'every', 'try'];
const OUTGOING_KEYWORDS = ['prev', 'next'];
const NODE_KEYS = new Set(NODE_KEYWORDS);
const IN_KEYS = new Set(INCOMING_KEYWORDS);
const OUT_KEYS = new Set(OUTGOING_KEYWORDS);
const makeCtx = (baseIndent, firstLast, savedLast = null) => ({
  scopeStack: [{ indent: baseIndent, lastExec: firstLast }],
  decStack: [], pendingElse: null, baseIndent, savedLastExec: savedLast,
});

exports.parsekh = parsekh;
function parsekh(source) {
  const preprocessed = preprocessControlFlowSyntax(source);
  const rawLines = preprocessed.split('\n');

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

  let funStack = [];
  let lastFun = null;
  let lastFunIndent = -1;
  let waitStack = [];
  let lastWait = null;
  let lastWaitIndent = -1;
  for (let i = 0; i < parsedLines.length; i++) {
    const pl = parsedLines[i];
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
    if (pl.nodeKey === 'try') {
      pl._tryHeader = true;
      pl._tryId = i;
    } else if (pl.raw === 'err' || pl.raw?.startsWith('err ')) {
      pl._errHandler = true;
      for (let k = i - 1; k >= 0; k--) {
        if (parsedLines[k]._tryHeader && parsedLines[k].indent <= pl.indent) {
          pl._errHandlerOf = k;
          parsedLines[k]._errHandlerLine = i;
          break;
        }
      }
    } else {
      for (let k = i - 1; k >= 0; k--) {
        if (parsedLines[k]._tryHeader && parsedLines[k].indent < pl.indent) {
          pl._tryBodyOf = k;
          break;
        }
        if (parsedLines[k].indent <= pl.indent) break;
      }
    }

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

    const nodes = [];
    const edges = [];
    const validationErrors = [];

    // --- NEW: Structural & Syntax Diagnostics (Sync from Web) ---
    const BLOCK_INITIATORS = new Set(['if', 'loop', 'fun', 'fork', 'try', 'err', 'every']);
    const ifStackForDiag = new Map();

    parsedLines.forEach((current, i) => {
      if (current.raw === '') return;
      const next = parsedLines[i + 1];

      // 1. Keyword Syntax Rules
      if (current.nodeKey === 'make') {
        const tokens = current.raw.split(/\s+/).filter(Boolean);
        const mIdx = tokens.indexOf('make');
        if (tokens.length <= mIdx + 1) validationErrors.push(`Line ${current.lineNum + 1}: Missing variable name after 'make'`);
        else if (tokens.length <= mIdx + 2) validationErrors.push(`Line ${current.lineNum + 1}: Missing value or expression after 'make ${tokens[mIdx+1]}'`);
      }
      if (current.nodeKey === 'take' && !current.content) validationErrors.push(`Line ${current.lineNum + 1}: Missing variable name after 'take'`);
      if ((current.nodeKey === 'if' || current.nodeKey === 'loop') && !current.content) validationErrors.push(`Line ${current.lineNum + 1}: Missing condition after '${current.nodeKey}'`);
      if ((current.nodeKey === 'say' || current.nodeKey === 'print') && !current.content) validationErrors.push(`Line ${current.lineNum + 1}: Missing expression after '${current.nodeKey}'`);
      if (current.nodeKey === 'fun') {
        if (!current.content) validationErrors.push(`Line ${current.lineNum + 1}: Missing function name after 'fun'`);
        else if (!current.content.includes('(') || !current.content.includes(')')) validationErrors.push(`Line ${current.lineNum + 1}: Malformed function signature. Expected 'fun name(params)'`);
      }

      // 2. Orphan Check
      if (current.incoming === 'else') {
        const matchingIf = ifStackForDiag.get(current.indent);
        if (!matchingIf) validationErrors.push(`Line ${current.lineNum + 1}: Orphaned 'else' - no matching 'if' found at this indentation level`);
      }
      if (current.nodeKey === 'if') {
        ifStackForDiag.set(current.indent, current);
      } else if (current.incoming !== 'else' && current.indent <= (ifStackForDiag.get(current.indent)?.indent ?? -1)) {
        ifStackForDiag.delete(current.indent);
      }

      // 3. Empty Block Check
      if (BLOCK_INITIATORS.has(current.nodeKey)) {
        const nextActive = parsedLines.slice(i + 1).find(l => l.raw !== '');
        if (!nextActive || nextActive.indent <= current.indent) {
          validationErrors.push(`Line ${current.lineNum + 1}: Expected an indented block after '${current.nodeKey}'`);
        }
      }
    });
    // ------------------------------------------------------------
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
        let updated = false;
        for (let i = ctx.scopeStack.length - 1; i >= 0; i--) {
            if (ctx.scopeStack[i].indent <= indent) {
                ctx.scopeStack[i].lastExec = n;
                updated = true;
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
                  exitNode = trigger;
                } else {
                  exitNode = dc.autoConnector;
                }
            } else if (trigger) {
                replaceBranchTail(dc.decNode, trigger);
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
    let processedLine = new Set();
    for (const pl of parsedLines) {
        const { lineNum, incoming, nodeKey, content, outgoing, _funHeader, _funBodyOf, _waitHeader, _waitBodyOf, _tryHeader, _tryBodyOf, _errHandler, _errHandlerOf } = pl;
        const indent = pl.indent;
        if (processedLine.has(lineNum)) continue;
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
        if (incoming === 'else') {
            let dcIdx = ctx.decStack.length - 1;
            if (nodeKey !== 'if') {
                for (let i = ctx.decStack.length - 1; i >= 0; i--) {
                    if (ctx.decStack[i].indent === indent) { dcIdx = i; break; }
                }
            }
            const dc = ctx.decStack[dcIdx];
            if (dc && dc.kind === 'loop' && dc.indent === indent) {
                validationErrors.push(`Line ${lineNum + 1}: 'else' is not valid after 'loop'. Loops have no branches — the false path exits sequentially.`);
                processedLine.add(lineNum);
                continue;
            }
            if (dc) {
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
            else if (nodeKey === 'text' || nodeKey === 'print' || nodeKey === 'say') {
                node = addNode('Output', lineNum, content);
                flushUntil(indent, node);
                if (!tryWireAsBranch(node)) {
                    wireSeqAndUpdateTails(getLastExec(), node);
                }
                setLastExec(node);
            }
            else if (nodeKey === 'from') {
                const fromStart = addNode('Start', lineNum, content, 'from-node');
                const mergeConn = addNode('Connector', lineNum, 'from-join', 'from-join');
                connectors.push(mergeConn);
                flushUntil(indent, mergeConn);
                const prev = getLastExec();
                if (prev) wireSeq(prev, mergeConn);
                pushEdge(fromStart.id, mergeConn.id);
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
            else if (nodeKey === 'wait' && /^(email|sheets|time|http)\b/.test(content)) {
                node = addNode('WaitBlock', lineNum, `wait ${content}`, 'wait-header');
                const savedBeforeWait = getLastExec();
                flushUntil(indent, null);
                ctxStack.push(ctx);
                ctx = makeCtx(indent, node, savedBeforeWait);
                continue;
            }
            else {
                let nodeMeta = meta;
                const makeRhs = content.replace(/^make\s+[A-Za-z_]\w*\s*/, '').trimStart();
                if (makeRhs.startsWith('[')) nodeMeta = (nodeMeta ? nodeMeta + ' ' : '') + 'list';
                else if (makeRhs.startsWith('{')) nodeMeta = (nodeMeta ? nodeMeta + ' ' : '') + 'dict';
                node = addNode('Process', lineNum, content, nodeMeta);
                const _makeM1 = content.match(/^make\s+([A-Za-z_]\w*)/);
                if (_makeM1 && !nodeMeta.includes('list') && !nodeMeta.includes('dict')) node.title = _makeM1[1];
                flushUntil(indent, node);
                if (!tryWireAsBranch(node)) {
                    wireSeq(getLastExec(), node);
                }
                setLastExec(node);
            }
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
        if (content || hasNonIncomingKeyword) {
            let fallMeta = meta;
            const fallRhs = content.replace(/^make\s+[A-Za-z_]\w*\s*/, '').trimStart();
            if (fallRhs.startsWith('[')) fallMeta = (fallMeta ? fallMeta + ' ' : '') + 'list';
            else if (fallRhs.startsWith('{')) fallMeta = (fallMeta ? fallMeta + ' ' : '') + 'dict';
            const n = addNode('Process', lineNum, content, fallMeta);
            const _makeM2 = content.match(/^make\s+([A-Za-z_]\w*)/);
            if (_makeM2 && !fallMeta.includes('list') && !fallMeta.includes('dict')) n.title = _makeM2[1];
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
    
    const implEnd = addNode('End', rawLines.length - 1, '', 'implicit end');
    flushUntil(-Infinity, implEnd);
    pendingNext.clear();
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

    let didMerge;
    do {
      didMerge = false;
      const connectorNodes = nodes.filter(n => n.kind === 'Connector');
      for (const c1 of connectorNodes) {
        const outEdges1 = edges.filter(e => e.from === c1.id);
        const edgesToConnectors = outEdges1.filter(e => nodes.some(n => n.id === e.to && n.kind === 'Connector'));
        if (edgesToConnectors.length === 1) {
          const c2 = nodes.find(n => n.id === edgesToConnectors[0].to && n.kind === 'Connector');
          const c1IsIfJoin   = c1.meta?.includes('if-join');
          const c2IsLoopHead = c2?.meta?.includes('loop-head');
          if (c2 && !c2.meta?.includes('explicit-con') && !(c1IsIfJoin && c2IsLoopHead)) {
            for (let i = edges.length - 1; i >= 0; i--) {
              if (edges[i].to === c1.id) {
                edges[i].to = c2.id;
              }
            }
            for (let i = edges.length - 1; i >= 0; i--) {
              if (edges[i].from === c1.id && edges[i].to === c2.id) {
                edges.splice(i, 1);
              }
            }
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

    if (!edges.some(e => e.from === startNode.id)) {
      const first = nodes.find(n => n.id !== startNode.id && n.kind !== 'End' && n.kind !== 'Function' && !n.meta?.includes('from-node') && !n.meta?.includes('fun-body-of') && !n.meta?.includes('fun-header') && !n.meta?.includes('fun-footer'));
      if (first) {
        pushEdge(startNode.id, first.id);
      } else {
        pushEdge(startNode.id, implEnd.id);
      }
    }
    const finalLast = ctx.scopeStack[0].lastExec;
    if (finalLast && !edges.some(e => e.from === finalLast.id) && finalLast.kind !== 'End') {
      const imp = nodes.find(n => n.meta === 'implicit end');
      if (imp) pushEdge(finalLast.id, imp.id);
    }

    for (const n of nodes) {
      if (n.meta === 'try-block') {
        const bodyIds = nodes
          .filter(b => b.meta === `try-body-of=${n.id}` || b.meta?.startsWith(`try-body-of=${n.id}`))
          .map(b => b.id);
        if (bodyIds.length) n.meta = `try-block try-body=[${bodyIds.join(',')}]`;
      }
    }

    return { nodes, edges, startNodeId: startNode.id, segments: [], validationErrors };
}
exports.parsekh = parsekh;
