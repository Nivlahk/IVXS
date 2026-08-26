function Node(type, fields) { return { type, ...fields }; }

function wordLex(src) {
  // 'fun' and 'give' added so KH programs can reach the calling convention
  // -- the subset previously had no function syntax at all, which meant the
  // ABI was tested only at the CF-dialect level and nothing in the lowering
  // path could emit a `def`. Keyword names follow the editor's own tutorial
  // buttons in index.html ("fun", "give").
  const KEYWORDS = new Set(['make','print','say','if','else','end','for','in','loop','and','or','not','is','yes','no','none','fun','give']);
  const toks = [];
  const lines = src.split('\n');
  const indentStack = [0];
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    if (line.trim() === '') continue;
    let sp = 0; while (line[sp] === ' ') sp++;
    const cur = indentStack[indentStack.length-1];
    if (sp > cur) { indentStack.push(sp); toks.push({t:'INDENT'}); }
    else if (sp < cur) { while (indentStack.length>1 && indentStack[indentStack.length-1] > sp) { indentStack.pop(); toks.push({t:'DEDENT'}); } }
    const rest = line.slice(sp);
    // Line tagging (added for the abstraction-lensing gutter): every
    // token emitted for this physical line gets stamped after the fact,
    // so no individual toks.push site has to change.
    const tokStart = toks.length;
    let i = 0;
    while (i < rest.length) {
      const ch = rest[i];
      if (ch === ' ') { i++; continue; }
      if (/[0-9]/.test(ch)) { let j=i; while (j<rest.length && /[0-9.]/.test(rest[j])) j++; toks.push({t:'NUM', v: Number(rest.slice(i,j))}); i=j; continue; }
      if (ch === '"' || ch === "'") { let j=i+1; while (j<rest.length && rest[j]!==ch) j++; toks.push({t:'STR', v: rest.slice(i+1,j)}); i=j+1; continue; }
      if (/[a-zA-Z_]/.test(ch)) { let j=i; while (j<rest.length && /[a-zA-Z0-9_]/.test(rest[j])) j++; const w=rest.slice(i,j);
        toks.push({t: KEYWORDS.has(w) ? 'KW' : 'ID', v: w}); i=j; continue; }
      if ('!<>='.includes(ch) && rest[i+1]==='=') { toks.push({t:'OP', v: rest.slice(i,i+2)}); i+=2; continue; }
      if (ch === '=') { toks.push({t:'OP', v: '='}); i++; continue; }
      if ('+-*/%()'.includes(ch)) { toks.push({t: '()'.includes(ch) ? (ch==='('?'LP':'RP') : 'OP', v: ch}); i++; continue; }
      if ('<>'.includes(ch)) { toks.push({t:'OP', v: ch}); i++; continue; }
      if (ch === ',') { toks.push({t:'COMMA'}); i++; continue; }
      i++;
    }
    toks.push({t:'NEWLINE'});
    for (let k = tokStart; k < toks.length; k++) toks[k].line = li + 1;
  }
  while (indentStack.length>1) { indentStack.pop(); toks.push({t:'DEDENT'}); }
  toks.push({t:'EOF'});
  return toks;
}

class WordParser {
  constructor(toks) { this.toks = toks; this.pos = 0; this._forDepth = 0; }
  peek(o=0) { return this.toks[this.pos+o] ?? {t:'EOF'}; }
  at(t,v) { const p=this.peek(); return p.t===t && (v===undefined || p.v===v); }
  atKw(v) { return this.at('KW', v); }
  adv() {
    if (this.pos >= this.toks.length - 1 && this.at('EOF')) throw new Error('unexpected EOF (parser stuck)');
    return this.toks[this.pos++];
  }
  skipNL() { let n=0; while (this.at('NEWLINE')) { this.adv(); if (++n > 100000) throw new Error('stuck in skipNL'); } }
  eatNL() { if (this.at('NEWLINE')) this.adv(); }

  parseProgram() {
    const body = [];
    this.skipNL();
    let guard = 0;
    while (!this.at('EOF')) {
      if (++guard > 100000) throw new Error('stuck in parseProgram');
      const before = this.pos;
      const s = this.parseStatement();
      if (s) body.push(s);
      this.skipNL();
      if (this.pos === before) { throw new Error(`parseProgram stuck at token ${JSON.stringify(this.peek())}`); }
    }
    return Node('Program', { body });
  }

  parseBlock() {
    if (this.at('INDENT')) this.adv();
    const body = [];
    this.skipNL();
    let guard = 0;
    while (!this.at('DEDENT') && !this.at('EOF')) {
      if (++guard > 100000) throw new Error('stuck in parseBlock');
      const before = this.pos;
      const s = this.parseStatement();
      if (s) body.push(s);
      this.skipNL();
      if (this.pos === before) { throw new Error(`parseBlock stuck at token ${JSON.stringify(this.peek())}`); }
    }
    if (this.at('DEDENT')) this.adv();
    return body;
  }

  parseStatement() {
    this.skipNL();
    const stmtLine = this.peek().line;
    const stmt = this.parseStatementInner();
    if (stmt && typeof stmt === 'object' && stmt.line === undefined) stmt.line = stmtLine;
    return stmt;
  }

  parseStatementInner() {
    if (this.atKw('make')) return this.parseMake();
    if (this.atKw('print')) return this.parsePrint();
    if (this.atKw('say')) return this.parseSay();
    if (this.atKw('if')) return this.parseIf();
    if (this.atKw('for')) return this.parseFor();
    if (this.atKw('loop')) return this.parseLoop();
    if (this.atKw('fun')) return this.parseFun();
    if (this.atKw('give')) return this.parseGive();
    if (this.atKw('end')) { this.adv(); this.eatNL(); return Node('End', { stmt: null }); }
    if (this.at('EOF') || this.at('DEDENT')) return null;
    // Unknown/unsupported construct for this subset -- fail loudly rather
    // than silently drop or spin.
    throw new Error(`word-parser subset does not cover token ${JSON.stringify(this.peek())}`);
  }

  parseMake() {
    this.adv();
    const name = this.adv().v;
    const target = Node('Identifier', { name });
    let expr;
    if (this.at('OP') && ['+','-','*','/'].includes(this.peek().v)) {
      const op = this.adv().v;
      const right = this.parseExpr();
      expr = Node('BinOp', { op, left: target, right });
    } else {
      expr = this.parseExpr();
    }
    this.eatNL();
    return Node('Assign', { name, target, expr, lazy: false });
  }

  parsePrint() { this.adv(); const expr = this.parseExpr(); this.eatNL(); return Node('Print', { expr }); }
  parseSay()   { this.adv(); const expr = this.parseExpr(); this.eatNL(); return Node('Speak', { expr }); }

  parseIf() {
    this.adv();
    const condition = this.parseExpr();
    this.eatNL();
    const body = this.parseBlock();
    let else_ = null;
    this.skipNL();
    if (this.atKw('else')) {
      this.adv();
      if (this.at('NEWLINE')) { this.eatNL(); else_ = this.parseBlock(); }
      else if (this.at('INDENT')) { else_ = this.parseBlock(); }
    }
    return Node('If', { condition, body, else_ });
  }

  parseFor() {
    this.adv();
    const varNames = [['i','ii'],['j','jj'],['k','kk']];
    const depth = Math.min(this._forDepth, varNames.length-1);
    let [iterVar, iterVar2] = varNames[depth];
    let target = null, targetExpr = null;
    if (!this.at('ID')) throw new Error('expected identifier after for');
    let nameTok = this.adv().v;
    if (this.at('LP')) { targetExpr = this.parseCallFrom(nameTok); target = null; }
    else target = nameTok;
    if (target !== null && this.atKw('in')) {
      this.adv();
      iterVar = target;
      const real = this.adv().v;
      if (this.at('LP')) { targetExpr = this.parseCallFrom(real); target = null; }
      else target = real;
    }
    this.eatNL();
    this._forDepth++;
    const body = this.parseBlock();
    this._forDepth--;
    return Node('For', { target, targetExpr, iterVar, iterVar2, body });
  }

  // fun name(a, b)
  //     <body>
  // Parameters are optional: `fun name` parses as a zero-arg function,
  // matching the tutorial button which inserts a bare "fun ".
  parseFun() {
    this.adv();
    if (!this.at('ID')) throw new Error('expected a name after fun');
    const name = this.adv().v;
    const params = [];
    if (this.at('LP')) {
      this.adv();
      while (!this.at('RP')) {
        if (this.at('ID')) params.push(this.adv().v);
        else if (this.at('COMMA')) this.adv();
        else throw new Error(`unexpected token in parameter list: ${JSON.stringify(this.peek())}`);
      }
      this.adv();
    }
    this.eatNL();
    const body = this.parseBlock();
    return Node('FunctionDef', { name, params, body });
  }

  parseGive() {
    this.adv();
    // `give` with no expression returns nothing.
    if (this.at('NEWLINE') || this.at('EOF') || this.at('DEDENT')) {
      this.eatNL();
      return Node('Give', { expr: null });
    }
    const expr = this.parseExpr();
    this.eatNL();
    return Node('Give', { expr });
  }

  parseLoop() {
    this.adv();
    const condition = this.parseExpr();
    this.eatNL();
    const body = this.parseBlock();
    return Node('Loop', { condition, body });
  }

  parseExpr(minPrec = 0) {
    let left = this.parseUnary();
    const PREC = { or:1, and:1, '=':2,'!=':2,'<':2,'>':2,'<=':2,'>=':2, is:2, in:2, '+':3,'-':3, '*':4,'/':4 };
    let guard = 0;
    while (true) {
      if (++guard > 100000) throw new Error('stuck in parseExpr');
      const p = this.peek();
      const opv = p.v;
      const isOp = (p.t==='OP' && PREC[opv]!==undefined) || (p.t==='KW' && PREC[opv]!==undefined);
      if (!isOp || PREC[opv] < minPrec) break;
      this.adv();
      const right = this.parseExpr(PREC[opv]+1);
      left = Node('BinOp', { op: opv, left, right });
    }
    return left;
  }

  parseUnary() {
    if (this.atKw('not')) { this.adv(); const operand = this.parseUnary(); return Node('UnaryOp', { op:'not', operand }); }
    return this.parsePostfix(this.parsePrimary());
  }

  parsePostfix(node) {
    if (node && node.type === 'Identifier' && this.at('LP')) {
      return this.parseCallFrom(node.name);
    }
    return node;
  }

  parseCallFrom(name) {
    this.adv();
    const args = [];
    if (!this.at('RP')) {
      args.push(this.parseExpr());
      let guard = 0;
      while (this.at('COMMA')) { if (++guard>10000) throw new Error('stuck in call args'); this.adv(); args.push(this.parseExpr()); }
    }
    if (!this.at('RP')) throw new Error(`expected ) got ${JSON.stringify(this.peek())}`);
    this.adv();
    return Node('Call', { name, args });
  }

  parsePrimary() {
    const tok = this.peek();
    if (tok.t === 'NUM') { this.adv(); return Node('NumberLit', { value: tok.v }); }
    if (tok.t === 'STR') { this.adv(); return Node('StringLit', { value: tok.v }); }
    if (tok.t === 'KW' && tok.v === 'yes') { this.adv(); return Node('BoolLit', { value: true }); }
    if (tok.t === 'KW' && tok.v === 'no') { this.adv(); return Node('BoolLit', { value: false }); }
    if (tok.t === 'KW' && tok.v === 'none') { this.adv(); return Node('BoolLit', { value: null }); }
    if (tok.t === 'ID') { this.adv(); return Node('Identifier', { name: tok.v }); }
    if (tok.t === 'LP') { this.adv(); const e = this.parseExpr(); if(!this.at('RP')) throw new Error('expected )'); this.adv(); return e; }
    throw new Error(`parsePrimary: unexpected token ${JSON.stringify(tok)}`);
  }
}

function wordParse(src) {
  const toks = wordLex(src);
  return new WordParser(toks).parseProgram();
}

module.exports = { wordParse };
