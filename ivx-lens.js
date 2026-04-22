// ivx-lens.js — IVX Lens Transpiler & Panel UI
// Bidirectional transpilation between IVX and Python/JS/TS/Pseudocode.
// Depends on: ivx-render.js (srcEl, updateHighlight, scheduleRender),
//             ivx-core.js (parse), ivx-parser.js (inferImmutables)
// PROPRIETARY AND CONFIDENTIAL
// Copyright 2026 IVX. All rights reserved.

'use strict';

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

  const LANGS = { python: PYTHON, javascript: JAVASCRIPT, typescript: TYPESCRIPT, pseudocode: PSEUDOCODE };

  // ── Public API ───────────────────────────────────────────────────────────────

  function transpile(source, langId) {
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
    </select>
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

  // ── State ───────────────────────────────────────────────────────────────────
  let lensOpen    = false;
  let lensLang    = 'python';
  let lensEdited  = false;  // user has manually edited the lens content
  let lensMode    = 'forward';  // 'forward' = IVX→lang, 'import' = user pasted foreign code

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const LANG_LABELS = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', pseudocode: 'Pseudocode' };
  const IMPORT_SUPPORTED = new Set(['python', 'javascript', 'typescript']);

  function escHtmlLens(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function updateGutter(lineCount) {
    let g = '';
    for (let i = 1; i <= lineCount; i++) g += i + '\n';
    lensGutter.textContent = g;
  }

  function syncGutter() {
    lensGutter.style.top = -lensScroll.scrollTop + 'px';
  }
  lensScroll.addEventListener('scroll', syncGutter);

  // ── Forward render: IVX → language ──────────────────────────────────────────
  function renderLens() {
    if (!lensOpen) return;
    const code  = LensTranspiler.transpile(srcEl.value, lensLang);
    // Plain text — no stubs in forward direction
    lensCode.innerHTML = escHtmlLens(code);
    updateGutter(code.split('\n').length);
    lensTitleEl.textContent = LANG_LABELS[lensLang] + ' Lens';
    // Show import button only for supported languages
    lensImportWrap.style.display = IMPORT_SUPPORTED.has(lensLang) ? 'flex' : 'none';
    lensStubCount.textContent = '';
    lensConfirm.style.display = 'none';
    lensMode   = 'forward';
    lensEdited = false;
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
    srcEl.value = ivxSource;
    updateHighlight();
    scheduleRender();
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
    // Hide ep-body entirely, show lens panel in its place
    document.getElementById('ep-body').style.display = 'none';
    lensPanel.style.display   = 'flex';
    lensPanel.style.flex      = '1';
    lensPanel.style.minHeight = '0';
    lensCode.contentEditable  = 'true';
    lensEdited = false;
    renderLens();
  }

  function closeLens() {
    lensOpen   = false;
    lensEdited = false;
    lensBtn.classList.remove('on');
    lensPanel.style.display  = 'none';
    lensPanel.style.flex     = '';
    lensCode.contentEditable = 'false';
    document.getElementById('ep-body').style.display = '';
    lensConfirm.style.display = 'none';
    srcEl.focus();
  }

  lensBtn.addEventListener('click', () => { if (lensOpen) closeLens(); else openLens(); });
  lensClose.addEventListener('click', closeLens);

  langSel.addEventListener('change', () => {
    lensLang = langSel.value;
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
      lensStubCount.textContent = '';
    }
  });

  // Re-render on IVX source change, but only if user hasn't manually edited the lens
  srcEl.addEventListener('input', () => {
    if (lensOpen && !lensEdited) renderLens();
  });

  window._lensRender = renderLens;
  window._lensOpen   = () => lensOpen;
})();

