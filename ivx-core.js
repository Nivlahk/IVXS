// ivx-core.js — IVX Language Core
// Lexer, Parser, Type Checker, Interpreter, Graph Builder, Layout Algorithm
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
// Copyright 2026 IVX


'use strict';
console.log('IVX BUILD v3 - list/dict fixes active');

// ── lexer.js ─────────────────────────────────────────────────────────────────

// ── IVX Lexer ──────────────────────────────────────────────────────────────────
// Turns raw IVX source into a flat stream of typed tokens.
// Design decisions:
//   - Indentation-sensitive: emits INDENT / DEDENT tokens
//   - Newlines are significant: emits NEWLINE tokens
//   - 'so'  normalizes to NEWLINE
//   - 'then' normalizes to NEWLINE + INDENT
//   - ';' is ignored (replaced by 'so' in the language)
//   - Whitespace around operators is enforced by the language; the lexer
//     trusts it and uses surrounding whitespace to distinguish unary minus
//     (part of a number literal) from binary minus (operator token)
//   - Invalid / unknown characters are silently skipped
//   - 'note ' starts a comment that consumes the rest of the line (not emitted)
//   - Strings: single-line only, both " and ' delimiters, Python escape sequences

// ── Token types ───────────────────────────────────────────────────────────────
const T = Object.freeze({
  // Structure
  NEWLINE:    'NEWLINE',
  INDENT:     'INDENT',
  DEDENT:     'DEDENT',
  EOF:        'EOF',

  // Literals
  NUMBER:     'NUMBER',     // integer or float
  STRING:     'STRING',     // "..." or '...'

  // Names
  KEYWORD:    'KEYWORD',    // reserved word
  IDENTIFIER: 'IDENTIFIER', // variable / function name (not a keyword)
  LAZY:       'LAZY',       // identifier? — lazy global declaration

  // Operators (all symbols)
  OP:         'OP',

  // Punctuation
  LPAREN:     'LPAREN',    // (
  RPAREN:     'RPAREN',    // )
  LBRACKET:   'LBRACKET',  // [
  RBRACKET:   'RBRACKET',  // ]
  LBRACE:     'LBRACE',    // {
  RBRACE:     'RBRACE',    // }
  COMMA:      'COMMA',     // ,
  COLON:      'COLON',     // :
  SEMICOLON:  'SEMICOLON', // ;
  BACKSLASH:  'BACKSLASH', // \ (outside strings)
});

// ── Keyword sets ──────────────────────────────────────────────────────────────
const KEYWORDS = new Set([
  // Control flow
  'if', 'else', 'for', 'loop', 'end', 'so', 'then',
  // Functions
  'fun', 'class', 'give',
  // OOP
  'extends', 'super',
  // Data
  'make', 'del', 'take', 'say', 'save', 'local',
  // Navigation / graph
  'dot', 'fork', 'prev', 'next', 'from',
  // Logic / literals
  'not', 'and', 'or', 'xor', 'is', 'yes', 'no', 'none',
  // Iteration
  'in',
  // Other
  'wait', 'note',
  // Network / AI
  'ask', 'post', 'use',
  // Google services
  'sheets', 'email', 'to', 'subject', 'body',
  // Wait block triggers and by keyword
  'http', 'time', 'by',
  // Implicit loop variables
  'i', 'ii', 'iii', 'j', 'jj', 'jjj', 'k', 'kk', 'kkk',
]);

// Two-character operators — must be checked before single-char ones
const TWO_CHAR_OPS = new Set(['//', '!=', '>=', '<=']);
// Single-character operators
const ONE_CHAR_OPS = new Set(['+', '-', '/', '*', '%', '^', '=', '<', '>', '.']);

// Python-style escape sequences resolved inside string literals
const ESCAPE_MAP = {
  'n': '\n', 't': '\t', 'r': '\r', '\\': '\\',
  "'": "'",  '"': '"',  '0': '\0', 'a': '\x07',
  'b': '\b', 'f': '\f', 'v': '\v',
};

// ── Token class ───────────────────────────────────────────────────────────────
class Token {
  constructor(type, value, line, col) {
    this.type  = type;
    this.value = value;
    this.line  = line;  // 1-based
    this.col   = col;   // 1-based
  }
  toString() {
    return `Token(${this.type}, ${JSON.stringify(this.value)}, ${this.line}:${this.col})`;
  }
}

// ── Lexer ─────────────────────────────────────────────────────────────────────
class Lexer {
  constructor(source) {
    this.src    = source;
    this.pos    = 0;
    this.line   = 1;
    this.col    = 1;
    this.tokens = [];

    // Indentation stack — starts at column 0
    this.indentStack = [0];

    // After emitting NEWLINE we process indentation on the next non-empty line
    this.pendingIndent = false;
  }

  // ── Source helpers ──────────────────────────────────────────────────────────
  peek(offset = 0) { return this.src[this.pos + offset] ?? ''; }
  advance() {
    const ch = this.src[this.pos++];
    if (ch === '\n') { this.line++; this.col = 1; }
    else             { this.col++; }
    return ch;
  }

  // ── Emit helpers ────────────────────────────────────────────────────────────
  emit(type, value, line, col) {
    this.tokens.push(new Token(type, value, line ?? this.line, col ?? this.col));
  }

  // ── Indentation handling ────────────────────────────────────────────────────
  // Call at the start of a new logical line, after consuming the newline itself.
  // Counts leading spaces, emits INDENT / DEDENT as needed.
  handleIndent() {
    let spaces = 0;
    while (this.peek() === ' ') { this.advance(); spaces++; }

    // Blank line or comment-only line — skip, don't change indent level
    if (this.peek() === '\n' || this.peek() === '' || this.src.startsWith('note ', this.pos)) {
      return false; // signal: line was empty/comment, caller should skip
    }

    const current = this.indentStack[this.indentStack.length - 1];
    if (spaces > current) {
      this.indentStack.push(spaces);
      this.emit(T.INDENT, spaces, this.line, 1);
    } else if (spaces < current) {
      while (this.indentStack.length > 1 && this.indentStack[this.indentStack.length - 1] > spaces) {
        this.indentStack.pop();
        this.emit(T.DEDENT, spaces, this.line, 1);
      }
    }
    return true;
  }

  // ── String lexing ───────────────────────────────────────────────────────────
  readString(quote, startLine, startCol) {
    let value = '';
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === '\n' || ch === '') {
        // Unterminated string — just close it
        break;
      }
      this.advance();
      if (ch === '\\') {
        const esc = this.peek();
        if (esc === 'u') {
          // \uXXXX unicode escape
          this.advance();
          let hex = '';
          for (let i = 0; i < 4 && /[0-9a-fA-F]/.test(this.peek()); i++) hex += this.advance();
          value += String.fromCharCode(parseInt(hex, 16) || 0);
        } else if (esc === 'x') {
          // \xXX hex escape
          this.advance();
          let hex = '';
          for (let i = 0; i < 2 && /[0-9a-fA-F]/.test(this.peek()); i++) hex += this.advance();
          value += String.fromCharCode(parseInt(hex, 16) || 0);
        } else {
          const resolved = ESCAPE_MAP[esc];
          if (resolved !== undefined) { this.advance(); value += resolved; }
          else { value += ch; } // unknown escape — keep backslash
        }
      } else if (ch === quote) {
        break; // closing quote
      } else {
        value += ch;
      }
    }
    this.emit(T.STRING, value, startLine, startCol);
  }

  // ── Number lexing ───────────────────────────────────────────────────────────
  // Called when we know we're looking at a digit, or a '-' followed by a digit
  // in a position where a unary minus is valid (after whitespace or 'make').
  readNumber(startLine, startCol) {
    let raw = '';
    if (this.peek() === '-') raw += this.advance();
    while (/\d/.test(this.peek())) raw += this.advance();
    if (this.peek() === '.' && /\d/.test(this.peek(1))) {
      raw += this.advance(); // '.'
      while (/\d/.test(this.peek())) raw += this.advance();
    }
    const value = raw.includes('.') ? parseFloat(raw) : parseInt(raw, 10);
    this.emit(T.NUMBER, value, startLine, startCol);
  }

  // ── Word lexing ─────────────────────────────────────────────────────────────
  readWord(startLine, startCol) {
    let word = '';
    while (/[A-Za-z_]/.test(this.peek())) word += this.advance();
    // 'note' starts a comment — consume rest of line, emit nothing
    if (word === 'note') {
      while (this.peek() !== '\n' && this.peek() !== '') this.advance();
      return;
    }
    // 'so' normalizes to NEWLINE
    if (word === 'so') {
      this.emit(T.NEWLINE, 'so', startLine, startCol);
      this.pendingIndent = true;
      return;
    }
    // 'then' normalizes to NEWLINE + INDENT
    if (word === 'then') {
      this.emit(T.NEWLINE, 'then', startLine, startCol);
      // Push a synthetic indent level — parser handles the matching DEDENT
      const current = this.indentStack[this.indentStack.length - 1];
      this.indentStack.push(current + 2);
      this.emit(T.INDENT, current + 2, startLine, startCol);
      return;
    }
    const type = KEYWORDS.has(word) ? T.KEYWORD : T.IDENTIFIER;
    // Check for lazy declaration suffix: identifier? or keyword?
    // Only valid on non-structural identifiers (not keywords like 'if', 'loop' etc.)
    if (this.peek() === '?' && type === T.IDENTIFIER) {
      this.advance(); // consume '?'
      this.emit(T.LAZY, word, startLine, startCol);
      return;
    }
    this.emit(type, word, startLine, startCol);
  }

  // ── Main tokenize loop ──────────────────────────────────────────────────────
  tokenize() {
    // Handle indentation for the very first line
    this.pendingIndent = true;

    while (this.pos < this.src.length) {
      // Process pending indentation at start of a new logical line
      if (this.pendingIndent) {
        this.pendingIndent = false;
        const hadContent = this.handleIndent();
        if (!hadContent) {
          // Skip blank/comment lines — consume through the newline
          while (this.peek() !== '\n' && this.peek() !== '') this.advance();
          if (this.peek() === '\n') { this.advance(); this.pendingIndent = true; }
          continue;
        }
      }

      const ch    = this.peek();
      const sLine = this.line;
      const sCol  = this.col;

      // ── Newline ────────────────────────────────────────────────────────────
      if (ch === '\n') {
        this.advance();
        this.emit(T.NEWLINE, '\n', sLine, sCol);
        this.pendingIndent = true;
        continue;
      }

      // ── Spaces (mid-line) ──────────────────────────────────────────────────
      if (ch === ' ') { this.advance(); continue; }

      // ── String literals ────────────────────────────────────────────────────
      if (ch === '"' || ch === "'") {
        this.advance();
        this.readString(ch, sLine, sCol);
        continue;
      }

      // ── Number: digit, or '-' followed by digit (unary minus) ─────────────
      if (/\d/.test(ch)) {
        this.readNumber(sLine, sCol);
        continue;
      }
      // Unary minus: '-' preceded by space (enforced by language) and followed by digit
      if (ch === '-' && /\d/.test(this.peek(1))) {
        // Check that the previous non-space character was not an identifier/number
        // In practice the language enforces this via whitespace rules, so we trust it
        this.readNumber(sLine, sCol);
        continue;
      }

      // ── Words (keywords + identifiers) ────────────────────────────────────
      if (/[A-Za-z_]/.test(ch)) {
        this.readWord(sLine, sCol);
        continue;
      }

      // ── Two-character operators ────────────────────────────────────────────
      const twoChar = ch + this.peek(1);
      if (TWO_CHAR_OPS.has(twoChar)) {
        this.advance(); this.advance();
        this.emit(T.OP, twoChar, sLine, sCol);
        continue;
      }

      // ── Single-character operators ─────────────────────────────────────────
      if (ONE_CHAR_OPS.has(ch)) {
        this.advance();
        this.emit(T.OP, ch, sLine, sCol);
        continue;
      }

      // ── Punctuation ────────────────────────────────────────────────────────
      switch (ch) {
        case '(': this.advance(); this.emit(T.LPAREN,    ch, sLine, sCol); break;
        case ')': this.advance(); this.emit(T.RPAREN,    ch, sLine, sCol); break;
        case '[': this.advance(); this.emit(T.LBRACKET,  ch, sLine, sCol); break;
        case ']': this.advance(); this.emit(T.RBRACKET,  ch, sLine, sCol); break;
        case '{': this.advance(); this.emit(T.LBRACE,    ch, sLine, sCol); break;
        case '}': this.advance(); this.emit(T.RBRACE,    ch, sLine, sCol); break;
        case ',': this.advance(); this.emit(T.COMMA,     ch, sLine, sCol); break;
        case ':': this.advance(); this.emit(T.COLON,     ch, sLine, sCol); break;
        case ';': this.advance(); this.emit(T.SEMICOLON, ch, sLine, sCol); break;
        case '\\':this.advance(); this.emit(T.BACKSLASH, ch, sLine, sCol); break;
        default:  this.advance(); break; // skip unknown characters silently
      }
    }

    // ── End of file: close any open indent levels ──────────────────────────
    while (this.indentStack.length > 1) {
      this.indentStack.pop();
      this.emit(T.DEDENT, 0, this.line, this.col);
    }
    this.emit(T.EOF, null, this.line, this.col);

    return this.tokens;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function lex(source) {
  return new Lexer(source).tokenize();
}


// ── parser.js ────────────────────────────────────────────────────────────────

// ── AST Node factory ──────────────────────────────────────────────────────────
const Node = (type, props) => ({ type, ...props });

// ── AST Node types ─────────────────────────────────────────────────────────────
// Program         { body: [Statement] }
// Assign          { name: string, expr: Expr }                        make x 5
// Delete          { name: string }                                     del x
// Say             { expr: Expr }                                       say x  (print to terminal)
// Take            { name: string }                                     take x
// Give            { expr: Expr }                                       give x (return from function) + 1
// Wait            { expr: Expr, condition: Expr|null }                 wait 5 / wait x = 5
// If              { condition: Expr, body: [Statement], else_: [Statement]|null }
// For             { target: string, secondary: string|null, body: [Statement] }
// Loop            { condition: Expr, body: [Statement] }
// Fun             { name: string, params: [string], body: [Statement] }
// Call            { name: string, args: [Expr] }                      foo()
// Dot             {}                                                   dot
// End             {}                                                   end
// BinOp           { op: string, left: Expr, right: Expr }
// UnaryOp         { op: string, operand: Expr }
// Identifier      { name: string }
// NumberLit       { value: number }
// StringLit       { value: string }
// BoolLit         { value: true|false|null }                          yes/no/none
// ListLit         { elements: [Expr] }
// DictLit         { pairs: [{key: Expr, value: Expr}] }

// ── Operator precedence ───────────────────────────────────────────────────────
const PREC = {
  'or': 1, 'xor': 1,
  'and': 2,
  'not': 3, // unary, handled separately
  '=': 4, '!=': 4, '<': 4, '>': 4, '<=': 4, '>=': 4, 'is': 4,
  'in': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '//': 6, '%': 6,
  '^': 7, // right-associative
};
const RIGHT_ASSOC = new Set(['^']);
const BINARY_OPS  = new Set(Object.keys(PREC).filter(k => k !== 'not'));

// ── Parser ────────────────────────────────────────────────────────────────────
class Parser {
  constructor(source) {
    this.tokens  = lex(source);
    this.pos     = 0;
    this.errors  = [];

    // Implicit subject/operator carry state for conditions
    this._impliedSubject  = null;
    this._impliedOp       = null;

    // For-loop nesting depth → iterator variable names
    // depth 0 → i/ii, depth 1 → j/jj, depth 2 → k/kk
    this._forDepth = 0;

    this._statementParsers = {
      make: () => this.parseMake(),
      del:  () => this.parseDel(),
      say:  () => this.parseSay(),
      take: () => this.parseTake(),
      save: () => this.parseSave(),
      local: () => this.parseLocal(),
      give: () => this.parseGive(),
      wait: () => this.parseWait(),
      ask:  () => this.parseExprStatement(), // ask is an expression
      post: () => this.parsePost(),
      use:  () => this.parseUse(),
      email: () => this.parseGmail(),
      sheets:    () => this.parseExprStatement(), // sheets is an expression
      class: () => this.parseClass(),
      if:   () => this.parseIf(),
      for:  () => this.parseFor(),
      loop: () => this.parseLoop(),
      fun:  () => this.parseFun(),
      dot:  () => {
        const tok = this.advance();
        this.eatNewline();
        return Node('Dot', { line: tok.line });
      },
      end:  () => this.parseEnd(),
      from: () => this.parseFrom(),
    };
  }

  // ── Token helpers ───────────────────────────────────────────────────────────
  peek(offset = 0) { return this.tokens[this.pos + offset] ?? { type: T.EOF, value: null }; }
  advance()        { return this.tokens[this.pos++] ?? { type: T.EOF, value: null }; }

  check(type, value)  { const t = this.peek(); return t.type === type && (value === undefined || t.value === value); }
  checkKw(value)      { return this.check(T.KEYWORD, value); }
  checkOp(value)      { return this.check(T.OP, value); }

  eat(type, value) {
    if (this.check(type, value)) return this.advance();
    return null;
  }
  eatKw(value) { return this.eat(T.KEYWORD, value); }

  expect(type, value, msg) {
    const t = this.eat(type, value);
    if (!t) {
      const cur = this.peek();
      this.error(msg ?? `Expected ${value ?? type} but got '${cur.value ?? cur.type}'`, cur);
    }
    return t;
  }

  // ── Error handling + panic recovery ────────────────────────────────────────
  error(message, tok) {
    tok = tok ?? this.peek();
    this.errors.push({ line: tok.line, col: tok.col, message });
    this.recover();
  }

  recover() {
    // Skip tokens until a safe restart point
    const SAFE = new Set([T.NEWLINE, T.DEDENT, T.EOF]);
    while (!SAFE.has(this.peek().type)) this.advance();
  }

  skipNewlines() {
    while (this.check(T.NEWLINE)) this.advance();
  }

  // ── Block parsing ───────────────────────────────────────────────────────────
  // A block is INDENT [statements] DEDENT
  parseBlock() {
    if (!this.eat(T.INDENT)) {
      this.error('Expected indented block');
      return [];
    }
    const stmts = [];
    this.skipNewlines();
    while (!this.check(T.DEDENT) && !this.check(T.EOF)) {
      const s = this.parseStatement();
      if (s) stmts.push(s);
      this.skipNewlines();
    }
    this.eat(T.DEDENT);
    return stmts;
  }

  // ── Statement dispatch ──────────────────────────────────────────────────────
  parseStatement() {
    this.skipNewlines();
    const tok = this.peek();

    if (tok.type === T.EOF || tok.type === T.DEDENT) return null;

    if (tok.type === T.KEYWORD) {
      const parseStmt = this._statementParsers[tok.value];
      if (parseStmt) return parseStmt();
      // Could be a bare keyword used as expression (e.g. 'yes', 'none')
      // or an unknown keyword — try parsing as expression statement
      return this.parseExprStatement();
    }

    // Identifier — could be a function call or bare expression
    return this.parseExprStatement();
  }

  eatNewline() {
    this.eat(T.NEWLINE);
  }

  // ── make x <expr>  /  make x <op> <expr>  /  make x? <op> <expr> ──────────
  parseMake() {
    const tok = this.advance(); // eat 'make'
    const nameTok = this.peek();

    // Handle lazy declaration: make name? + expr
    const isLazy = nameTok.type === T.LAZY;
    if (nameTok.type !== T.IDENTIFIER && !isLazy) {
      this.error("Expected variable name after 'make'", nameTok);
      return null;
    }

    let target = Node('Identifier', { name: this.advance().value, line: nameTok.line, col: nameTok.col });
    while (this.checkOp('.')) {
      const dot = this.advance();
      const fieldTok = this.peek();
      if (fieldTok.type !== T.IDENTIFIER) {
        this.error("Expected field name after '.'", fieldTok);
        break;
      }
      this.advance();
      target = Node('MemberAccess', { object: target, field: fieldTok.value, line: dot.line, col: dot.col });
    }

    // Check for shorthand: make x <op> <expr> where op is a binary arithmetic op
    const nextTok = this.peek();
    let expr;
    if (nextTok.type === T.OP && ['+','-','*','/','//','%','^'].includes(nextTok.value)) {
      // make x + 5  →  make x x + 5  (implied LHS is x itself)
      const impliedLeft = target;
      const op = this.advance().value;
      const right = this.parseExpr();
      expr = Node('BinOp', { op, left: impliedLeft, right, line: tok.line });
    } else {
      expr = this.parseExpr();
    }

    this.eatNewline();
    const name = target.type === 'Identifier' ? target.name : null;
    return Node('Assign', { name, target, expr, lazy: isLazy, line: tok.line, col: tok.col });
  }

  // ── del x ──────────────────────────────────────────────────────────────────
  parseDel() {
    const tok = this.advance(); // eat 'del'
    const nameTok = this.peek();
    if (nameTok.type !== T.IDENTIFIER) {
      this.error("Expected variable name after 'del'", nameTok);
      return null;
    }
    const name = this.advance().value;
    this.eatNewline();
    return Node('Delete', { name, line: tok.line, col: tok.col });
  }

  // ── give <expr> ────────────────────────────────────────────────────────────
  parseSay() {
    const tok = this.advance(); // eat 'say'
    const expr = this.parseExpr();
    this.eatNewline();
    return Node('Say', { expr, line: tok.line, col: tok.col });
  }

  // ── take <name> ────────────────────────────────────────────────────────────
  parseTake() {
    const tok = this.advance(); // eat 'take'
    const nameTok = this.peek();

    // Handle take int(user), take flt(user) etc. — converter wraps the variable
    const CONVERTERS = new Set(['int','flt','str','bin','list','dict']);
    if (nameTok.type === T.IDENTIFIER && CONVERTERS.has(nameTok.value) && this.peek(1).type === T.LPAREN) {
      const converter = this.advance().value; // eat converter name e.g. 'int'
      this.advance(); // eat '('
      const innerTok = this.peek();
      if (innerTok.type !== T.IDENTIFIER) {
        this.error("Expected variable name inside converter", innerTok);
        return null;
      }
      const name = this.advance().value;
      this.expect(T.RPAREN, undefined, "Expected ')'");
      this.eatNewline();
      return Node('Take', { name, converter, line: tok.line, col: tok.col });
    }

    // Plain take user — or take file.csv (dot = file)
    if (nameTok.type !== T.IDENTIFIER) {
      this.error("Expected variable name after 'take'", nameTok);
      return null;
    }
    const name = this.advance().value;
    // Check for file extension: take file.csv — dot followed by extension
    if (this.peek().type === T.OP && this.peek().value === '.' ||
        (this.peek().type !== T.NEWLINE && this.peek().type !== T.EOF &&
         /^\.(csv|json|txt|tsv|xml)$/.test('.' + (this.peek().value ?? '')))) {
      // Consume the dot and extension
      let ext = '';
      if (this.peek().value === '.') { this.advance(); ext = this.advance().value ?? ''; }
      else { ext = (this.advance().value ?? '').replace(/^\./, ''); }
      this.eatNewline();
      return Node('TakeFile', { name, ext, line: tok.line, col: tok.col });
    }
    this.eatNewline();
    return Node('Take', { name, converter: null, line: tok.line, col: tok.col });
  }

  // ── give <expr> — return value from function ──────────────────────────────
  parseGive() {
    const tok = this.advance(); // eat 'give'
    const expr = this.parseExpr();
    this.eatNewline();
    return Node('Give', { expr, line: tok.line, col: tok.col });
  }

  // ── wait / wait every ─────────────────────────────────────────────────────
  parseWait() {
    const tok = this.advance(); // eat 'wait'
    let next = this.peek();

    // wait every <trigger> — persistent repeating trigger
    let recurring = false;
    if (next.type === T.IDENTIFIER && next.value === 'every') {
      this.advance(); // eat 'every'
      recurring = true;
      next = this.peek();
    }

    // wait [every] email by <addr>
    if (next.type === T.KEYWORD && next.value === 'email') {
      this.advance();
      let source = null;
      if (this.checkKw('by')) { this.advance(); source = this.parseExpr(); }
      this.eatNewline();
      const body = this.check(T.INDENT) ? this.parseBlock() : [];
      return Node('WaitBlock', { trigger: 'email', source, body, recurring, line: tok.line, col: tok.col });
    }

    // wait [every] sheets <n> by <event>
    if (next.type === T.KEYWORD && next.value === 'sheets') {
      this.advance();
      const name = this.parseExpr();
      let event = 'row added';
      if (this.checkKw('by')) {
        this.advance();
        const parts = [];
        while (!this.check(T.NEWLINE) && !this.check(T.EOF) && !this.check(T.DEDENT)) {
          parts.push(this.advance().value ?? '');
        }
        if (parts.length) event = parts.join(' ');
      }
      this.eatNewline();
      const body = this.check(T.INDENT) ? this.parseBlock() : [];
      return Node('WaitBlock', { trigger: 'sheets', source: name, event, body, recurring, line: tok.line, col: tok.col });
    }

    // wait [every] time <expr>
    if (next.type === T.KEYWORD && next.value === 'time') {
      this.advance();
      const source = this.parseExpr();
      this.eatNewline();
      const body = this.check(T.INDENT) ? this.parseBlock() : [];
      return Node('WaitBlock', { trigger: 'time', source, body, recurring, line: tok.line, col: tok.col });
    }

    // wait [every] http
    if (next.type === T.KEYWORD && next.value === 'http') {
      this.advance();
      this.eatNewline();
      const body = this.check(T.INDENT) ? this.parseBlock() : [];
      return Node('WaitBlock', { trigger: 'http', source: null, body, recurring, line: tok.line, col: tok.col });
    }

    // wait x = 5 — inline condition (no body, not a trigger)
    if (next.type === T.IDENTIFIER && this.peek(1).type === T.OP && this.peek(1).value === '=') {
      const name  = this.advance().value;
      this.advance();
      const value = this.parseExpr();
      this.eatNewline();
      return Node('Wait', {
        expr: null,
        condition: Node('BinOp', { op: '=', left: Node('Identifier', { name }), right: value }),
        line: tok.line, col: tok.col
      });
    }

    // wait 5 — pause N cycles
    const expr = this.parseExpr();
    this.eatNewline();
    return Node('Wait', { expr, condition: null, line: tok.line, col: tok.col });
  }

  // ── post <url> <body> [use <key>] ─────────────────────────────────────────
  parsePost() {
    const tok = this.advance(); // eat 'post'
    const url  = this.parseExpr();
    const body = this.parseExpr();
    let credential = null;
    if (this.checkKw('use')) { this.advance(); credential = this.parseExpr(); }
    this.eatNewline();
    return Node('Post', { url, body, credential, line: tok.line, col: tok.col });
  }

  // ── email <addr> subject <subj> body <body> ──────────────────────────────
  parseGmail() {
    const tok = this.advance(); // eat 'email'
    let to = null, subject = null, body = null;
    // Accept optional 'to' for backwards compat, but not required
    if (this.checkKw('to')) { this.advance(); }
    to = this.parseExpr();
    if (this.checkKw('subject')) { this.advance(); subject = this.parseExpr(); }
    if (this.checkKw('body')) { this.advance(); body = this.parseExpr(); }
    this.eatNewline();
    return Node('Gmail', { to, subject, body, line: tok.line, col: tok.col });
  }

  // ── use <key>  (global form — standalone statement) ───────────────────────
  parseUse() {
    const tok = this.advance(); // eat 'use'
    const key = this.parseExpr();
    this.eatNewline();
    return Node('Use', { key, line: tok.line, col: tok.col });
  }

  _parseSavePayload(target, line, col) {
    if (this.check(T.NEWLINE) || this.check(T.EOF) || this.check(T.DEDENT)) {
      this.error("Expected value or filename after 'save'", this.peek());
      return null;
    }

    const first = this.parseExpr();
    if (!first) {
      this.error("Expected value or filename after 'save'", this.peek());
      return null;
    }

    // save user.txt — identifier followed immediately by a dot extension
    if (first.type === 'Identifier' && this.checkOp('.')) {
      const filenameExpr = this._parseBareFilename(first.name, first.line, first.col);
      if (!filenameExpr) return null;
      this.eatNewline();
      return Node('Save', { valueExpr: null, filenameExpr, target, line, col });
    }

    // save "report.txt" — string literal with no second argument → save response to that file
    if (first.type === 'StringLit' &&
        !this.check(T.NEWLINE) && !this.check(T.EOF) && !this.check(T.DEDENT)) {
      // save "title" value  — string is the filename, next expr is the value
      const valueExpr = this._parseSaveFilenameExpr();
      this.eatNewline();
      return Node('Save', { valueExpr, filenameExpr: first, target, line, col });
    }
    if (first.type === 'StringLit') {
      // lone string → filename, no explicit value (use response)
      this.eatNewline();
      return Node('Save', { valueExpr: null, filenameExpr: first, target, line, col });
    }

    // save x — bare identifier with nothing after it → x is the VALUE,
    // auto-generate filename as the variable name
    if (first.type === 'Identifier' &&
        (this.check(T.NEWLINE) || this.check(T.EOF) || this.check(T.DEDENT))) {
      // Auto-filename: use the variable name; _executeSave will pick extension by type
      const autoFilename = Node('StringLit', { value: first.name, line: first.line, col: first.col });
      this.eatNewline();
      return Node('Save', { valueExpr: first, filenameExpr: autoFilename, autoName: true, target, line, col });
    }

    // save x report.txt  or  save <expr> <filename>
    let valueExpr = first;
    const filenameExpr = this._parseSaveFilenameExpr();
    if (!filenameExpr) {
      this.error("Expected filename after value in 'save'", this.peek());
      return null;
    }

    this.eatNewline();
    return Node('Save', { valueExpr, filenameExpr, target, line, col });
  }

  // ── save <filename> | save <value> <filename> ────────────────────────────
  parseSave() {
    const tok = this.advance(); // eat 'save'
    return this._parseSavePayload('drive', tok.line, tok.col);
  }

  _parseBareFilename(initial, line, col) {
    let name = initial;
    while (this.checkOp('.')) {
      this.advance(); // consume '.'
      const part = this.peek();
      if ([T.IDENTIFIER, T.KEYWORD, T.NUMBER].includes(part.type)) {
        name += '.' + String(this.advance().value ?? '');
      } else {
        this.error("Expected filename segment after '.'", part);
        return null;
      }
    }
    return Node('StringLit', { value: name, line, col });
  }

  _parseSaveFilenameExpr() {
    const tok = this.peek();
    if (tok.type === T.STRING) {
      this.advance();
      return Node('StringLit', { value: tok.value, line: tok.line, col: tok.col });
    }
    if (tok.type === T.IDENTIFIER) {
      const id = this.advance();
      return this._parseBareFilename(id.value, id.line, id.col);
    }
    // Fallback for computed filename expressions.
    return this.parseExpr();
  }

  // ── local save <filename> | local save <value> <filename> ────────────────
  parseLocal() {
    const tok = this.advance(); // eat 'local'
    if (!this.checkKw('save')) {
      this.error("Expected 'save' after 'local'", this.peek());
      this.eatNewline();
      return null;
    }
    this.advance(); // eat 'save'
    return this._parseSavePayload('local', tok.line, tok.col);
  }

  // ── if <condition> NEWLINE INDENT <body> [else <body>] ─────────────────────
  parseIf() {
    const tok = this.advance(); // eat 'if'
    this._impliedSubject = null;
    this._impliedOp      = null;
    const condition = this.parseCondition();
    this.eatNewline();
    const body  = this.parseBlock();
    let else_   = null;

    this.skipNewlines();
    if (this.checkKw('else')) {
      this.advance(); // eat 'else'
      if (this.checkKw('if')) {
        // else if — treat as nested if in the else branch
        else_ = [this.parseIf()];
      } else if (this.checkKw('end')) {
        // else end <message>
        else_ = [this.parseEnd()];
      } else if (this.check(T.NEWLINE)) {
        // else followed by newline then indented block
        this.eatNewline();
        else_ = this.parseBlock();
      } else if (this.check(T.INDENT)) {
        // else followed directly by indented block
        else_ = this.parseBlock();
      } else {
        // inline else — e.g. "else give x" or "else say x"
        // If there's a newline + indent after, the inline expr is the first
        // statement of the else block and the indented body follows
        const s = this.parseStatement();
        if (s) {
          this.skipNewlines();
          if (this.check(T.INDENT)) {
            // Block follows — inline statement + indented block together
            const blockStmts = this.parseBlock();
            else_ = [s, ...blockStmts];
          } else {
            else_ = [s];
          }
        }
      }
    }

    return Node('If', { condition, body, else_, line: tok.line, col: tok.col });
  }

  // ── for <target> NEWLINE INDENT <body> ────────────────────────────────────
  parseFor() {
    const tok = this.advance(); // eat 'for'

    // Determine iterator variable names based on nesting depth
    const varNames = [['i','ii'], ['j','jj'], ['k','kk']];
    const depth    = Math.min(this._forDepth, varNames.length - 1);
    const [primary, secondary] = varNames[depth];

    // Target: the thing being iterated over
    const targetTok = this.peek();
    let target;
    if (targetTok.type === T.IDENTIFIER) {
      target = this.advance().value;
    } else {
      this.error("Expected iterable after 'for'", targetTok);
      return null;
    }

    // Optional explicit 'in' — 'for list' and 'for i in list' both valid
    // If we see a keyword 'in' next, the user wrote the long form
    // and what we read as 'target' was actually the iterator variable name
    let iterVar = primary, iterVar2 = secondary;
    if (this.checkKw('in')) {
      this.advance(); // eat 'in'
      // target was actually the explicit variable name
      iterVar  = target;
      iterVar2 = secondary;
      const realTarget = this.peek();
      if (realTarget.type !== T.IDENTIFIER) {
        this.error("Expected iterable after 'in'", realTarget);
        return null;
      }
      target = this.advance().value;
    }

    this.eatNewline();
    this._forDepth++;
    const body = this.parseBlock();
    this._forDepth--;

    return Node('For', {
      target, iterVar, iterVar2,
      line: tok.line, col: tok.col,
      body
    });
  }

  // ── loop <condition> NEWLINE INDENT <body> ────────────────────────────────
  parseLoop() {
    const tok = this.advance(); // eat 'loop'
    this._impliedSubject = null;
    this._impliedOp      = null;
    const condition = this.parseCondition();
    this.eatNewline();
    const body = this.parseBlock();
    return Node('Loop', { condition, body, line: tok.line, col: tok.col });
  }

  // ── fun name(params) NEWLINE INDENT <body> ────────────────────────────────
  parseFun() {
    const tok  = this.advance(); // eat 'fun'
    const nameTok = this.peek();
    if (nameTok.type !== T.IDENTIFIER) {
      this.error("Expected function name after 'fun'", nameTok);
      return null;
    }
    const name = this.advance().value;

    // Parameter list
    const params = [];
    if (this.eat(T.LPAREN)) {
      while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
        const p = this.peek();
        if (p.type === T.IDENTIFIER) { params.push(this.advance().value); }
        else { this.error('Expected parameter name', p); break; }
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RPAREN, undefined, "Expected ')' after parameters");
    }

    this.eatNewline();
    const body = this.parseBlock();
    return Node('Fun', { name, params, body, line: tok.line, col: tok.col });
  }

  // ── class name(superclass?) ───────────────────────────────────────────────
  // Example: class Dog(Animal)
  parseClass() {
    const tok  = this.advance(); // eat 'class'
    const nameTok = this.peek();
    if (nameTok.type !== T.IDENTIFIER) {
      this.error("Expected class name after 'class'", nameTok);
      return null;
    }
    const name = this.advance().value;

    let superclass = null;
    if (this.eat(T.LPAREN)) {
      if (!this.check(T.RPAREN) && !this.check(T.EOF)) {
        const superTok = this.peek();
        if (superTok.type !== T.IDENTIFIER) {
          this.error("Expected superclass name inside class parentheses", superTok);
        } else {
          superclass = { name: this.advance().value, line: superTok.line, col: superTok.col };
        }
      }
      this.expect(T.RPAREN, undefined, "Expected ')' after class header");
    }

    this.eatNewline();
    const body = this.check(T.INDENT) ? this.parseBlock() : [];
    return Node('Class', { name, superclass, body, line: tok.line, col: tok.col });
  }

  // ── end [message] ──────────────────────────────────────────────────────────
  parseEnd() {
    const tok = this.advance(); // eat 'end'
    // Optional trailing statement — e.g. "end say 'done'" or bare "end"
    let stmt = null;
    if (!this.check(T.NEWLINE) && !this.check(T.EOF) && !this.check(T.DEDENT)) {
      stmt = this.parseStatement();
    } else {
      this.eatNewline();
    }
    return Node('End', { stmt, line: tok.line, col: tok.col });
  }

  // ── from <module> [by <package>] ──────────────────────────────────────────
  // Examples:
  //   from Database by pandas
  //   from "https://api.example.com"
  parseFrom() {
    const tok = this.advance(); // eat 'from'
    const pathParts = [];
    let via = null;
    while (!this.check(T.NEWLINE) && !this.check(T.EOF)) {
      if (this.checkKw('by')) {
        this.advance(); // eat 'by'
        const viaParts = [];
        while (!this.check(T.NEWLINE) && !this.check(T.EOF)) {
          viaParts.push(this.advance().value ?? '');
        }
        via = viaParts.join(' ');
        break;
      }
      pathParts.push(this.advance().value ?? '');
    }
    this.eatNewline();
    return Node('Import', { path: pathParts.join(' '), via, line: tok.line, col: tok.col });
  }

  // ── Expression statement (function call or bare expression) ────────────────
  parseExprStatement() {
    const expr = this.parseExpr();
    this.eatNewline();
    return Node('ExprStatement', { expr, line: expr?.line });
  }

  // ── Condition parsing (with implicit subject/operator carry) ───────────────
  // Handles: "a > 2 and < 4"  "a = 3 or 5"
  parseCondition() {
    return this.parseConditionExpr();
  }

  parseConditionExpr() {
    let left = this.parseConditionClause();

    while (this.checkKw('and') || this.checkKw('or') || this.checkKw('xor')) {
      const op  = this.advance().value;
      const right = this.parseConditionClause();
      left = Node('BinOp', { op, left, right, line: left?.line });
    }
    return left;
  }

  // A single clause, possibly with implicit subject/operator
  parseConditionClause() {
    // 'not' prefix
    if (this.checkKw('not')) {
      const tok = this.advance();
      const operand = this.parseConditionClause();
      return Node('UnaryOp', { op: 'not', operand, line: tok.line, col: tok.col });
    }

    // Peek: do we have a subject (identifier/literal) followed by an operator?
    // Or are we missing the subject (implied), or missing both subject and op?
    const tok  = this.peek();
    const tok1 = this.peek(1);

    const isCompOp = t => t && (
      (t.type === T.OP     && ['=','!=','<','>','<=','>='].includes(t.value)) ||
      (t.type === T.KEYWORD && ['is','in'].includes(t.value))
    );

    const isArithOp = t => t && t.type === T.OP && ['+','-','*','/','//','%','^'].includes(t.value);

    // Parse arithmetic sub-expressions but stop before comparison and logical operators
    const parseClauseExpr = () => this.parseExpr(4);

    let left, op, right;

    if (isCompOp(tok)) {
      // No subject — use implied. e.g. "and < 4"
      op    = this.advance().value;
      right = parseClauseExpr();
      left  = this._impliedSubject ?? Node('Identifier', { name: '?', line: tok.line });
      this._impliedOp = op;
    } else if (isArithOp(tok) && this._impliedSubject) {
      // Arithmetic op with implied subject — e.g. "and % 5 = 0" means "and go % 5 = 0"
      // Build: impliedSubject <arithOp> <arithRight> <compOp> <compRight>
      const arithOp = this.advance().value;
      const arithRight = parseClauseExpr();
      const arithNode = Node('BinOp', { op: arithOp, left: this._impliedSubject, right: arithRight, line: tok.line });
      if (isCompOp(this.peek())) {
        op    = this.advance().value;
        right = parseClauseExpr();
        left  = arithNode;
        this._impliedOp = op;
      } else {
        // No comp op — treat the arithmetic result as a boolean check
        return arithNode;
      }
    } else if (!isCompOp(tok1) && this._impliedSubject) {
      // Only the value is present — subject AND operator are implied
      // e.g. "a = 3 or 5" → second clause is "5" meaning "a = 5"
      right = parseClauseExpr();
      left  = this._impliedSubject;
      op    = this._impliedOp ?? '=';
    } else {
      // Normal: subject op value
      left = parseClauseExpr();
      if (isCompOp(this.peek())) {
        op    = this.advance().value;
        right = parseClauseExpr();
        // _impliedSubject should be the bare subject (leftmost identifier),
        // not the whole arithmetic expression — so dig into BinOp to find it
        let subj = left;
        while (subj && subj.type === 'BinOp') subj = subj.left;
        this._impliedSubject = subj;
        this._impliedOp      = op;
        return Node('BinOp', { op, left, right, line: left?.line });
      }
      // No operator found — just return the expression as-is (e.g. boolean check)
      return left;
    }

    // Keep _impliedSubject pointing to the original subject identifier
    if (!this._impliedSubject) this._impliedSubject = left;
    this._impliedOp = op;
    return Node('BinOp', { op, left, right, line: left?.line });
  }

  // ── Expression parsing (Pratt / precedence climbing) ──────────────────────
  parseExpr(minPrec = 0) {
    let left = this.parseUnary();

    while (true) {
      const tok = this.peek();
      const op  = tok.value;
      const prec = PREC[op];

      if (prec === undefined || prec <= minPrec) break;
      if (!BINARY_OPS.has(op)) break;
      // Make sure it's actually an OP or matching KEYWORD token
      if (tok.type !== T.OP && tok.type !== T.KEYWORD) break;

      this.advance();
      const nextMinPrec = RIGHT_ASSOC.has(op) ? prec - 1 : prec;
      const right = this.parseExpr(nextMinPrec);
      left = Node('BinOp', { op, left, right, line: left?.line });
    }

    return left;
  }

  parseUnary() {
    // 'not' as unary logical operator
    if (this.checkKw('not')) {
      const tok = this.advance();
      const operand = this.parseUnary();
      return Node('UnaryOp', { op: 'not', operand, line: tok.line, col: tok.col });
    }
    return this.parsePrimary();
  }

  parsePostfix(base) {
    let expr = base;
    while (true) {
      if (this.check(T.LBRACKET)) {
        expr = this.parseIndexAccess(expr);
        continue;
      }
      if (this.checkOp('.')) {
        const dot = this.advance();
        const fieldTok = this.peek();
        if (fieldTok.type !== T.IDENTIFIER) {
          this.error("Expected field name after '.'", fieldTok);
          break;
        }
        this.advance();
        expr = Node('MemberAccess', { object: expr, field: fieldTok.value, line: dot.line, col: dot.col });
        continue;
      }
      if (this.check(T.LPAREN)) {
        const lp = this.advance();
        const args = [];
        while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
          const arg = this.parseExpr();
          if (arg) args.push(arg);
          if (!this.eat(T.COMMA)) break;
        }
        this.expect(T.RPAREN, undefined, "Expected ')' after arguments");
        expr = expr.type === 'Identifier'
          ? Node('Call', { name: expr.name, args, line: expr.line, col: expr.col })
          : Node('Invoke', { callee: expr, args, line: lp.line, col: lp.col });
        continue;
      }
      break;
    }
    return expr;
  }

  parseIndexAccess(target) {
    const lbr = this.expect(T.LBRACKET, undefined, "Expected '['");
    if (!lbr) return target;

    const isRowTerminator = () => this.check(T.COMMA) || this.check(T.RBRACKET);
    const isColTerminator = () => this.check(T.RBRACKET);

    const rowSpec = this._parseIndexSpec(isRowTerminator);
    const hasComma = this.eat(T.COMMA) !== null;
    const colSpec = hasComma ? this._parseIndexSpec(isColTerminator) : this._omittedIndexSpec();

    this.expect(T.RBRACKET, undefined, "Expected ']' after index");
    return Node('IndexAccess', {
      target,
      rowSpec,
      colSpec,
      hasComma,
      line: lbr.line,
      colPos: lbr.col,
    });
  }

  _omittedIndexSpec() {
    return { omitted: true, isSlice: false, start: null, end: null, expr: null };
  }

  _parseIndexAtom() {
    // Excel-style cell literal: A0, BC12 (unquoted) inside brackets.
    // Lexer tokenizes this as IDENTIFIER + NUMBER, so stitch it back.
    const a = this.peek();
    const b = this.peek(1);
    if (a.type === T.IDENTIFIER && b.type === T.NUMBER && Number.isInteger(b.value) && b.value >= 0) {
      this.advance();
      this.advance();
      return Node('StringLit', {
        value: `${a.value}${b.value}`,
        line: a.line,
        col: a.col,
      });
    }
    return this.parseExpr();
  }

  _inferClassFieldName(expr) {
    if (!expr) return '';
    if (expr.type === 'Identifier' || expr.type === 'LazyDecl') return expr.name;
    if (expr.type === 'MemberAccess') {
      if (expr.object?.type === 'Identifier' && expr.object.name === 'self') return expr.field;
      return this._inferClassFieldName(expr.object);
    }
    if (expr.type === 'BinOp') return this._inferClassFieldName(expr.left) || this._inferClassFieldName(expr.right);
    if (expr.type === 'UnaryOp') return this._inferClassFieldName(expr.operand);
    if (expr.type === 'IndexAccess') return this._inferClassFieldName(expr.target);
    return '';
  }

  _parseIndexSpec(isTerminator) {
    if (isTerminator()) return this._omittedIndexSpec();

    let start = null;
    let end = null;
    let isSlice = false;

    if (!this.check(T.COLON)) {
      start = this._parseIndexAtom();
    }

    if (this.eat(T.COLON)) {
      isSlice = true;
      if (!isTerminator()) {
        end = this._parseIndexAtom();
      }
    }

    return {
      omitted: false,
      isSlice,
      start,
      end,
      expr: isSlice ? null : start,
    };
  }

  // ── Primary expressions ────────────────────────────────────────────────────
  parsePrimary() {
    const tok = this.peek();

    // Number literal
    if (tok.type === T.NUMBER) {
      this.advance();
      return this.parsePostfix(Node('NumberLit', { value: tok.value, line: tok.line, col: tok.col }));
    }

    // String literal
    if (tok.type === T.STRING) {
      this.advance();
      return this.parsePostfix(Node('StringLit', { value: tok.value, line: tok.line, col: tok.col }));
    }

    // Boolean / none literals
    if (tok.type === T.KEYWORD && ['yes','no','none'].includes(tok.value)) {
      this.advance();
      const value = tok.value === 'yes' ? true : tok.value === 'no' ? false : null;
      return this.parsePostfix(Node('BoolLit', { value, raw: tok.value, line: tok.line, col: tok.col }));
    }

    // List literal [...]
    if (tok.type === T.LBRACKET) {
      return this.parsePostfix(this.parseList());
    }

    // Dict literal {...}
    if (tok.type === T.LBRACE) {
      return this.parsePostfix(this.parseDict());
    }

    // Grouped expression (...)
    if (tok.type === T.LPAREN) {
      this.advance();
      const expr = this.parseExpr();
      this.expect(T.RPAREN, undefined, "Expected ')'");
      return this.parsePostfix(expr);
    }

    // Identifier
    if (tok.type === T.IDENTIFIER) {
      this.advance();
      return this.parsePostfix(Node('Identifier', { name: tok.value, line: tok.line, col: tok.col }));
    }

    // super — subclass method context only
    if (tok.type === T.KEYWORD && tok.value === 'super') {
      this.advance();
      return this.parsePostfix(Node('Super', { line: tok.line, col: tok.col }));
    }

    // Lazy declaration: name? — declare at global scope if not exists, then use
    if (tok.type === T.LAZY) {
      this.advance();
      return this.parsePostfix(Node('LazyDecl', { name: tok.value, line: tok.line, col: tok.col }));
    }

    // Implicit loop variables used as identifiers
    if (tok.type === T.KEYWORD && ['i','ii','iii','j','jj','jjj','k','kk','kkk'].includes(tok.value)) {
      this.advance();
      return this.parsePostfix(Node('Identifier', { name: tok.value, line: tok.line, col: tok.col }));
    }

    // ask <model> <prompt> [use <key>] — AI call expression
    if (tok.type === T.KEYWORD && tok.value === 'ask') {
      this.advance(); // eat 'ask'
      const modelTok = this.peek();
      const model = (modelTok.type === T.IDENTIFIER || modelTok.type === T.KEYWORD)
        ? this.advance().value : 'chatgpt';
      const prompt = this.parseExpr();
      let credential = null;
      if (this.checkKw('use')) { this.advance(); credential = this.parseExpr(); }
      return this.parsePostfix(Node('Ask', { model, prompt, credential, line: tok.line, col: tok.col }));
    }

    // sheets <name> — returns a Sheets handle object
    if (tok.type === T.KEYWORD && tok.value === 'sheets') {
      this.advance(); // eat 'sheets'
      const name = this.parseExpr();
      return this.parsePostfix(Node('SheetsOpen', { name, line: tok.line, col: tok.col }));
    }

    // Nothing matched
    this.error(`Unexpected token '${tok.value ?? tok.type}'`, tok);
    return null;
  }

  // ── Function call: name(arg, arg, ...) ────────────────────────────────────
  parseFunCall(nameTok) {
    this.advance(); // eat '('
    const args = [];
    while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
      const arg = this.parseExpr();
      if (arg) args.push(arg);
      if (!this.eat(T.COMMA)) break;
    }
    this.expect(T.RPAREN, undefined, "Expected ')' after arguments");
    return Node('Call', {
      name: nameTok.value,
      args,
      line: nameTok.line,
      col:  nameTok.col
    });
  }

  // ── List literal ───────────────────────────────────────────────────────────
  parseList() {
    const tok = this.advance(); // eat '['
    const elements = [];
    while (!this.check(T.RBRACKET) && !this.check(T.EOF)) {
      const el = this.parseExpr();
      if (el) elements.push(el);
      if (!this.eat(T.COMMA)) break;
    }
    this.expect(T.RBRACKET, undefined, "Expected ']'");
    return Node('ListLit', { elements, line: tok.line, col: tok.col });
  }

  // ── Dict literal ───────────────────────────────────────────────────────────
  parseDict() {
    const tok = this.advance(); // eat '{'
    const pairs = [];
    while (!this.check(T.RBRACE) && !this.check(T.EOF)) {
      const key = this.parseExpr();
      this.expect(T.COLON, undefined, "Expected ':' after dict key");
      const value = this.parseExpr();
      if (key && value) pairs.push({ key, value });
      if (!this.eat(T.COMMA)) break;
    }
    this.expect(T.RBRACE, undefined, "Expected '}'");
    return Node('DictLit', { pairs, line: tok.line, col: tok.col });
  }

  // ── Entry point ────────────────────────────────────────────────────────────
  parse() {
    const body = [];
    this.skipNewlines();
    while (!this.check(T.EOF)) {
      const s = this.parseStatement();
      if (s) body.push(s);
      this.skipNewlines();
    }
    return {
      ast:    Node('Program', { body }),
      errors: this.errors,
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function parse(source) {
  return new Parser(source).parse();
}


// ── typechecker.js ───────────────────────────────────────────────────────────

// ── IVX Type system ───────────────────────────────────────────────────────────
// Seven types + a special UNKNOWN used during inference before a type is known
const TYPE = Object.freeze({
  STRING:  'string',
  INTEGER: 'integer',
  FLOAT:   'float',
  BOOLEAN: 'boolean',
  LIST:    'list',
  DICT:    'dict',
  NONE:    'none',    // universal "not yet set" sentinel
  UNKNOWN: 'unknown', // internal — type not yet resolved
  URL:     'url',     // HTTP/HTTPS URL — fetched on evaluation
});

// ── Type compatibility ─────────────────────────────────────────────────────────
// Can a value of type 'from' be used where type 'to' is expected?
function compatible(from, to) {
  if (from === TYPE.UNKNOWN || to === TYPE.UNKNOWN) return true; // defer
  if (from === to) return true;
  if (from === TYPE.NONE) return true;   // none is assignable to any type
  if (to   === TYPE.NONE) return true;
  // integer and float can interop in expressions
  if (from === TYPE.INTEGER && to === TYPE.FLOAT) return true;
  if (from === TYPE.FLOAT   && to === TYPE.INTEGER) return true;
  return false;
}

// ── Operator type rules ───────────────────────────────────────────────────────
// Returns the result type of applying op to left and right types,
// or null if the operation is invalid.
function opResultType(op, left, right) {
  // Comparison operators always return boolean
  if (['=','!=','<','>','<=','>=','is'].includes(op)) {
    if (compatible(left, right)) return TYPE.BOOLEAN;
    return null;
  }
  // Logical operators — operands should be boolean, result is boolean
  if (['and','or','xor'].includes(op)) {
    return TYPE.BOOLEAN;
  }
  // 'in' — check membership, returns boolean
  if (op === 'in') return TYPE.BOOLEAN;

  // Arithmetic operators
  if (['+','-','*','%'].includes(op)) {
    if (left === TYPE.STRING && op === '+') {
      // String concatenation
      if (right === TYPE.STRING) return TYPE.STRING;
      return null;
    }
    if ([TYPE.INTEGER, TYPE.FLOAT, TYPE.NONE, TYPE.UNKNOWN].includes(left) &&
        [TYPE.INTEGER, TYPE.FLOAT, TYPE.NONE, TYPE.UNKNOWN].includes(right)) {
      if (left === TYPE.FLOAT || right === TYPE.FLOAT) return TYPE.FLOAT;
      return TYPE.INTEGER;
    }
    return null;
  }
  if (op === '/') {
    // Division always returns float
    if ([TYPE.INTEGER, TYPE.FLOAT, TYPE.NONE, TYPE.UNKNOWN].includes(left) &&
        [TYPE.INTEGER, TYPE.FLOAT, TYPE.NONE, TYPE.UNKNOWN].includes(right)) return TYPE.FLOAT;
    return null;
  }
  if (op === '//') {
    // Floor division always returns integer
    if ([TYPE.INTEGER, TYPE.FLOAT, TYPE.NONE, TYPE.UNKNOWN].includes(left) &&
        [TYPE.INTEGER, TYPE.FLOAT, TYPE.NONE, TYPE.UNKNOWN].includes(right)) return TYPE.INTEGER;
    return null;
  }
  if (op === '^') {
    if ([TYPE.INTEGER, TYPE.FLOAT, TYPE.NONE, TYPE.UNKNOWN].includes(left) &&
        [TYPE.INTEGER, TYPE.FLOAT, TYPE.NONE, TYPE.UNKNOWN].includes(right)) return TYPE.FLOAT;
    return null;
  }

  return TYPE.UNKNOWN;
}

// ── Type error ────────────────────────────────────────────────────────────────
class TypeError_ {
  constructor(message, line, col) {
    this.message = message;
    this.line    = line ?? 0;
    this.col     = col  ?? 0;
  }
  toString() { return `TypeError at ${this.line}:${this.col} — ${this.message}`; }
}

// ── Environment (scope) ───────────────────────────────────────────────────────
// A linked-list of scopes. Variables are resolved by walking up the chain.
class TCEnv {
  constructor(parent = null, name = 'global') {
    this.parent = parent;
    this.name   = name;
    this.vars   = new Map(); // name → { type, defined }
    this.fns    = new Map(); // name → { params: [{name, type}], returnType }
  }

  // Define a variable in this scope
  define(name, type) {
    this.vars.set(name, { type, defined: type !== TYPE.NONE });
  }

  // Look up a variable — walks up the scope chain
  lookup(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent?.lookup(name) ?? null;
  }

  // Update an existing variable's type (for reassignment)
  update(name, type) {
    if (this.vars.has(name)) { this.vars.get(name).type = type; return true; }
    return this.parent?.update(name, type) ?? false;
  }

  // Define a function signature
  defFn(name, params, returnType) {
    this.fns.set(name, { params, returnType });
  }

  // Define a class signature (callable constructor-like value)
  defClass(name, params, returnType) {
    this.fns.set(name, { params, returnType, isClass: true });
  }

  // Look up a function — walks up the scope chain
  lookupFn(name) {
    if (this.fns.has(name)) return this.fns.get(name);
    return this.parent?.lookupFn(name) ?? null;
  }

  lookupClass(name) {
    const fn = this.lookupFn(name);
    return fn?.isClass ? fn : null;
  }

  child(name) { return new TCEnv(this, name); }
}

// ── Type checker ──────────────────────────────────────────────────────────────
class TypeChecker {
  constructor() {
    this.errors  = [];
    this.globals = new TCEnv(null, 'global');
    // Built-in: err is always in scope as none (universal sentinel)
    this.globals.define('err', TYPE.NONE);

    this._stmtCheckers = {
      Assign: (node, env) => this._checkAssignStmt(node, env),
      Delete: (node, env) => this._checkDeleteStmt(node, env),
      Say: (node, env) => this._checkSayStmt(node, env),
      Take: (node, env) => this._checkTakeStmt(node, env),
      Give: (node, env) => this._checkGiveStmt(node, env),
      Wait: (node, env) => this._checkWaitStmt(node, env),
      Use: (node, env) => this._checkUseStmt(node, env),
      Post: (node, env) => this._checkPostStmt(node, env),
      Save: (node, env) => this._checkSaveStmt(node, env),
      TakeFile: (node, env) => this._checkTakeFileStmt(node, env),
      If: (node, env) => this._checkIfStmt(node, env),
      Loop: (node, env) => this._checkLoopStmt(node, env),
      For: (node, env) => this._checkForStmt(node, env),
      Fun: (node, env) => this._checkFunStmt(node, env),
      Class: (node, env) => this._checkClassStmt(node, env),
      ExprStatement: (node, env) => this._checkExprStatementStmt(node, env),
      End: () => {},
      Dot: () => {},
      Import: () => {},
    };
  }

  err(msg, node) {
    this.errors.push(new TypeError_(msg, node?.line, node?.col));
  }

  // ── Check a full program ───────────────────────────────────────────────────
  check(sourceOrParsed) {
    const parsed = (sourceOrParsed && typeof sourceOrParsed === 'object' && sourceOrParsed.ast)
      ? sourceOrParsed
      : parse(sourceOrParsed);
    const { ast, errors: parseErrors } = parsed;
    // Surface parse errors as type errors so caller gets one list
    for (const e of parseErrors) {
      this.errors.push(new TypeError_('Parse error: ' + e.message, e.line, e.col));
    }
    this.checkBlock(ast.body, this.globals);
    return { errors: this.errors, env: this.globals };
  }

  // ── Block ──────────────────────────────────────────────────────────────────
  checkBlock(stmts, env) {
    for (const stmt of stmts) {
      if (stmt) this.checkStmt(stmt, env);
    }
  }

  // ── Statement ──────────────────────────────────────────────────────────────
  checkStmt(node, env) {
    const checker = this._stmtCheckers[node.type];
    if (checker) checker(node, env);
  }

  _checkAssignStmt(node, env) {
    const exprType = this.checkExpr(node.expr, env);
    if (node.target?.type === 'MemberAccess') {
      this.checkExpr(node.target.object, env);
      this.checkExpr(node.target, env);
      return;
    }
    const existing = env.lookup(node.name);
    if (existing && existing.defined && existing.type !== TYPE.NONE) {
      if (!compatible(exprType, existing.type)) {
        this.err(
          `Cannot assign ${exprType} to '${node.name}' which is ${existing.type}`,
          node
        );
      } else {
        env.update(node.name, exprType);
      }
    } else {
      env.define(node.name, exprType);
    }
  }

  _checkDeleteStmt(node, env) {
    const existing = env.lookup(node.name);
    if (!existing) {
      this.err(`Cannot delete '${node.name}': variable not defined`, node);
    } else {
      env.update(node.name, TYPE.NONE);
    }
  }

  _checkSayStmt(node, env) {
    this.checkExpr(node.expr, env);
  }

  _checkTakeStmt(node, env) {
    const takeTypeMap = {
      int: TYPE.INTEGER,
      flt: TYPE.FLOAT,
      str: TYPE.STRING,
      bin: TYPE.BOOLEAN,
      list: TYPE.LIST,
      dict: TYPE.DICT,
    };
    const inferredType = takeTypeMap[node.converter] ?? TYPE.STRING;
    const existing = env.lookup(node.name);
    if (!existing || existing.type === TYPE.NONE) {
      env.define(node.name, inferredType);
    } else {
      env.update(node.name, inferredType);
    }
  }

  _checkGiveStmt(node, env) {
    const exprType = this.checkExpr(node.expr, env);
    if (env._returnType !== undefined) {
      if (env._returnType === TYPE.UNKNOWN) {
        env._returnType = exprType;
      } else if (!compatible(exprType, env._returnType)) {
        this.err(`Inconsistent return types: ${exprType} vs ${env._returnType}`, node);
      }
    }
  }

  _checkWaitStmt(node, env) {
    if (node.condition) {
      const t = this.checkExpr(node.condition, env);
      if (t !== TYPE.BOOLEAN && t !== TYPE.UNKNOWN) {
        this.err(`'wait' condition must be boolean, got ${t}`, node);
      }
    } else if (node.expr) {
      const t = this.checkExpr(node.expr, env);
      if (t !== TYPE.INTEGER && t !== TYPE.UNKNOWN && t !== TYPE.NONE) {
        this.err(`'wait' cycle count must be integer, got ${t}`, node);
      }
    }
  }

  _checkUseStmt(node, env) {
    this.checkExpr(node.key, env);
  }

  _checkPostStmt(node, env) {
    this.checkExpr(node.url, env);
    this.checkExpr(node.body, env);
    if (node.credential) this.checkExpr(node.credential, env);
  }

  _checkSaveStmt(node, env) {
    if (node.valueExpr) this.checkExpr(node.valueExpr, env);
    const filenameType = this.checkExpr(node.filenameExpr, env);
    if (![TYPE.STRING, TYPE.UNKNOWN, TYPE.NONE, TYPE.URL].includes(filenameType)) {
      this.err(`'save' filename should be string-like, got ${filenameType}`, node.filenameExpr ?? node);
    }
  }

  _checkTakeFileStmt(node, env) {
    const fileTypeMap = {
      csv: TYPE.LIST,
      json: TYPE.DICT,
      txt: TYPE.STRING,
      tsv: TYPE.LIST,
      xml: TYPE.STRING,
    };
    const inferredType = fileTypeMap[node.ext] ?? TYPE.STRING;
    env.define(node.name, inferredType);
  }

  _checkIfStmt(node, env) {
    const condType = this.checkExpr(node.condition, env);
    if (condType !== TYPE.BOOLEAN && condType !== TYPE.UNKNOWN) {
      this.err(`'if' condition must be boolean, got ${condType}`, node);
    }
    const bodyEnv = env.child('if-body');
    this.checkBlock(node.body, bodyEnv);
    if (node.else_) {
      const elseEnv = env.child('else-body');
      this.checkBlock(node.else_, elseEnv);
    }
  }

  _checkLoopStmt(node, env) {
    const condType = this.checkExpr(node.condition, env);
    if (condType !== TYPE.BOOLEAN && condType !== TYPE.UNKNOWN) {
      this.err(`'loop' condition must be boolean, got ${condType}`, node);
    }
    const loopEnv = env.child('loop-body');
    this.checkBlock(node.body, loopEnv);
  }

  _checkForStmt(node, env) {
    const iterType = this.resolveIdentifier(node.target, env, node);
    const forEnv = env.child('for-body');
    const elemType = iterType === TYPE.LIST ? TYPE.UNKNOWN
      : iterType === TYPE.STRING ? TYPE.STRING
      : iterType === TYPE.DICT ? TYPE.UNKNOWN
      : TYPE.UNKNOWN;
    forEnv.define(node.iterVar, elemType);
    forEnv.define(node.iterVar2, iterType === TYPE.DICT ? TYPE.UNKNOWN : TYPE.INTEGER);
    this.checkBlock(node.body, forEnv);
  }

  _checkFunStmt(node, env) {
    const fnEnv = env.child('fun-' + node.name);
    fnEnv._returnType = TYPE.UNKNOWN;
    for (const p of node.params) fnEnv.define(p, TYPE.UNKNOWN);
    env.defFn(node.name, node.params.map(p => ({ name: p, type: TYPE.UNKNOWN })), TYPE.UNKNOWN);
    this.checkBlock(node.body, fnEnv);
    const retType = fnEnv._returnType ?? TYPE.UNKNOWN;
    env.defFn(node.name, node.params.map(p => ({ name: p, type: fnEnv.lookup(p)?.type ?? TYPE.UNKNOWN })), retType);
  }

  _checkClassStmt(node, env) {
    const initMethod = (node.body ?? []).find(stmt => stmt?.type === 'Fun' && stmt.name === 'init');
    env.defClass(
      node.name,
      (initMethod?.params ?? []).map(param => ({ name: param, type: TYPE.UNKNOWN })),
      TYPE.DICT
    );
    const classEnv = env.child('class-' + node.name);
    classEnv.define('self', TYPE.DICT);
    if (node.superclass) {
      const superclass = env.lookupClass(node.superclass.name);
      if (!superclass) {
        this.err(`Superclass '${node.superclass.name}' is not defined`, node.superclass);
      }
      classEnv.define('super', TYPE.DICT);
    }
    this.checkBlock(node.body ?? [], classEnv);
  }

  _checkExprStatementStmt(node, env) {
    if (node.expr) this.checkExpr(node.expr, env);
  }

  _isTableListLiteral(node) {
    return Array.isArray(node?.elements)
      && node.elements.length > 0
      && node.elements.every(el => el?.type === 'ListLit');
  }

  _checkTableListLiteral(node, env) {
    const rows = node.elements;

    // Header row (row 0) is schema-exempt, but still type-check each header cell expression.
    if (rows[0]) {
      for (const cell of rows[0].elements ?? []) this.checkExpr(cell, env);
    }

    const dataRows = rows.slice(1);
    if (dataRows.length === 0) return TYPE.LIST;

    const firstDataRow = dataRows.find(r => (r.elements?.length ?? 0) > 0) ?? dataRows[0];
    const width = firstDataRow.elements?.length ?? 0;
    const colTypes = Array.from({ length: width }, () => TYPE.UNKNOWN);

    for (let r = 0; r < dataRows.length; r++) {
      const rowNode = dataRows[r];
      const cells = rowNode.elements ?? [];
      const logicalRow = r + 1; // data row index; row 0 is header

      if (cells.length !== width) {
        this.err(
          `Table rows must have consistent width: expected ${width} column(s), got ${cells.length} at row ${logicalRow}`,
          rowNode
        );
      }

      const limit = Math.min(width, cells.length);
      for (let c = 0; c < limit; c++) {
        const cellNode = cells[c];
        const cellType = this.checkExpr(cellNode, env);
        if (colTypes[c] === TYPE.UNKNOWN) {
          colTypes[c] = cellType;
          continue;
        }
        if (!compatible(cellType, colTypes[c])) {
          this.err(
            `Table column ${c} must be homogeneous: expected ${colTypes[c]}, got ${cellType} at row ${logicalRow}`,
            cellNode
          );
        }
      }
    }

    return TYPE.LIST;
  }

  // ── Expression type inference ──────────────────────────────────────────────
  checkExpr(node, env) {
    if (!node) return TYPE.UNKNOWN;

    switch (node.type) {

      case 'NumberLit':
        return Number.isInteger(node.value) ? TYPE.INTEGER : TYPE.FLOAT;

      case 'StringLit': {
        // Detect URL type from string value
        const sv = node.value;
        if (typeof sv === 'string' && (sv.startsWith('http://') || sv.startsWith('https://'))) {
          return TYPE.URL;
        }
        return TYPE.STRING;
      }

      case 'Ask':
        // ask chatgpt "prompt" — always returns a string
        if (node.credential) this.checkExpr(node.credential, env);
        this.checkExpr(node.prompt, env);
        return TYPE.STRING;

      case 'BoolLit':
        return node.value === null ? TYPE.NONE : TYPE.BOOLEAN;

      case 'ListLit': {
        if (node.elements.length === 0) return TYPE.LIST;

        if (this._isTableListLiteral(node)) {
          return this._checkTableListLiteral(node, env);
        }

        // Infer element type from first element, check homogeneity
        const firstType = this.checkExpr(node.elements[0], env);
        for (let i = 1; i < node.elements.length; i++) {
          const t = this.checkExpr(node.elements[i], env);
          if (!compatible(t, firstType)) {
            this.err(
              `List must be homogeneous: expected ${firstType}, got ${t} at element ${i + 1}`,
              node.elements[i]
            );
          }
        }
        return TYPE.LIST;
      }

      case 'DictLit': {
        for (const { key, value } of node.pairs) {
          this.checkExpr(key, env);
          this.checkExpr(value, env);
        }
        return TYPE.DICT;
      }

      case 'MemberAccess': {
        this.checkExpr(node.object, env);
        return TYPE.UNKNOWN;
      }

      case 'Super': {
        if (!env.lookup('super')) {
          this.err(`'super' is only available inside a subclass method`, node);
        }
        return TYPE.UNKNOWN;
      }

      case 'Identifier':
        return this.resolveIdentifier(node.name, env, node);

      case 'IndexAccess': {
        const targetType = this.checkExpr(node.target, env);
        if (!node.hasComma) {
          if (![TYPE.LIST, TYPE.DICT, TYPE.STRING, TYPE.UNKNOWN, TYPE.NONE].includes(targetType)) {
            this.err(`Indexing requires list/dict/string target, got ${targetType}`, node.target ?? node);
          }
        } else if (![TYPE.LIST, TYPE.UNKNOWN, TYPE.NONE].includes(targetType)) {
          this.err(`2D indexing requires list target, got ${targetType}`, node.target ?? node);
        }
        const row = node.rowSpec;
        const col = node.colSpec;
        if (row && !row.omitted) {
          if (row.isSlice) {
            if (row.start) this.checkExpr(row.start, env);
            if (row.end) this.checkExpr(row.end, env);
          } else if (row.expr) {
            this.checkExpr(row.expr, env);
          }
        }
        if (col && !col.omitted) {
          if (col.isSlice) {
            if (col.start) this.checkExpr(col.start, env);
            if (col.end) this.checkExpr(col.end, env);
          } else if (col.expr) {
            this.checkExpr(col.expr, env);
          }
        }
        if (node.hasComma && row?.omitted && !col?.omitted) return TYPE.LIST;
        if (node.hasComma && !row?.omitted && col?.omitted) return TYPE.LIST;
        if (node.hasComma && (row?.isSlice || col?.isSlice)) return TYPE.LIST;
        if (!node.hasComma && row?.isSlice) return TYPE.LIST;
        return TYPE.UNKNOWN;
      }

      case 'BinOp': {
        const left  = this.checkExpr(node.left,  env);
        const right = this.checkExpr(node.right, env);
        const result = opResultType(node.op, left, right);
        if (result === null) {
          this.err(
            `Operator '${node.op}' cannot be applied to ${left} and ${right}`,
            node
          );
          return TYPE.UNKNOWN;
        }
        return result;
      }

      case 'UnaryOp': {
        const t = this.checkExpr(node.operand, env);
        if (node.op === 'not') {
          if (t !== TYPE.BOOLEAN && t !== TYPE.UNKNOWN && t !== TYPE.NONE) {
            this.err(`'not' requires boolean operand, got ${t}`, node);
          }
          return TYPE.BOOLEAN;
        }
        return t;
      }

      case 'Call': {
        const callee = env.lookupFn(node.name);
        const isClass = callee?.isClass === true;
        if (!callee) {
          this.err(`Undefined function or class '${node.name}'`, node);
          return TYPE.UNKNOWN;
        }
        // Check argument count
        if (node.args.length !== callee.params.length) {
          this.err(
            `${isClass ? 'Class' : 'Function'} '${node.name}' expects ${callee.params.length} argument(s), got ${node.args.length}`,
            node
          );
        }
        // Check argument types
        for (let i = 0; i < Math.min(node.args.length, callee.params.length); i++) {
          const argType    = this.checkExpr(node.args[i], env);
          const paramType  = callee.params[i]?.type ?? TYPE.UNKNOWN;
          if (!compatible(argType, paramType)) {
            this.err(
              `Argument ${i + 1} of '${node.name}': expected ${paramType}, got ${argType}`,
              node.args[i]
            );
          }
        }
        return callee.returnType ?? TYPE.UNKNOWN;
      }

      case 'Invoke': {
        this.checkExpr(node.callee, env);
        for (const arg of node.args) this.checkExpr(arg, env);
        return TYPE.UNKNOWN;
      }

      default:
        return TYPE.UNKNOWN;
    }
  }

  // ── Identifier resolution ──────────────────────────────────────────────────
  resolveIdentifier(name, env, node) {
    const entry = env.lookup(name);
    if (!entry) {
      this.err(`Undefined variable '${name}'`, node);
      return TYPE.UNKNOWN;
    }
    // none is the explicit unset/reset state — not an error to have it,
    // only flag if it was never defined at all (entry missing entirely)
    return entry.type;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function typecheck(sourceOrParsed) {
  const tc = new TypeChecker();
  return tc.check(sourceOrParsed);
}


// ── interpreter.js ───────────────────────────────────────────────────────────

// ── Runtime values ────────────────────────────────────────────────────────────
// IVX values are plain JS values:
//   string  → JS string
//   integer → JS number (integer)
//   float   → JS number (float)
//   boolean → JS true / false
//   none    → JS null
//   list    → JS Array
//   dict    → JS Map

const NONE = null;

// ── Control flow signals ──────────────────────────────────────────────────────
// Used to unwind the call stack for 'out' (return) and loop control
class ReturnSignal  { constructor(value) { this.value = value; } }
class BreakSignal   {}
class ContinueSignal {}
class EndSignal     {}

// ── Runtime error ─────────────────────────────────────────────────────────────
class RuntimeError extends Error {
  constructor(message, line, col) {
    super(message);
    this.ivxLine = line ?? 0;
    this.ivxCol  = col  ?? 0;
  }
}

// ── Environment (scope) ───────────────────────────────────────────────────────
class Env {
  constructor(parent = null) {
    this.parent = parent;
    this.vars   = new Map();
  }

  get(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent)          return this.parent.get(name);
    return undefined;
  }

  set(name, value) {
    // Update in place if variable already exists somewhere in the chain
    if (this.vars.has(name)) { this.vars.set(name, value); return; }
    if (this.parent && this.parent.has(name)) { this.parent.set(name, value); return; }
    // New variable — define in current scope
    this.vars.set(name, value);
  }

  has(name) {
    if (this.vars.has(name)) return true;
    return this.parent?.has(name) ?? false;
  }

  del(name) {
    if (this.vars.has(name)) { this.vars.delete(name); return true; }
    return this.parent?.del(name) ?? false;
  }

  child() { return new Env(this); }
}

// ── IVX function (closure) ────────────────────────────────────────────────────
class IVXFunction {
  constructor(name, params, body, closure) {
    this.name    = name;
    this.params  = params;
    this.body    = body;
    this.closure = closure; // captured environment
  }
}

class IVXClass {
  constructor(name, body, closure, superclass = null) {
    this.name = name;
    this.body = body ?? [];
    this.closure = closure;
    this.superclass = superclass;
    this.methods = new Map();
    this.initStmts = [];
  }

  resolveMethod(name) {
    if (this.methods.has(name)) return this.methods.get(name);
    return this.superclass?.resolveMethod(name) ?? null;
  }

  async instantiate(args, interp) {
    const classEnv = this.closure ? this.closure.child() : interp.globals.child();
    const instance = new Map();
    instance.set('__class__', this.name);
    instance.set('__class_obj__', this);
    classEnv.set('self', instance);

    if (this.superclass) {
      classEnv.set('super', new IVXSuperProxy(instance, this));
    }

    const initMethod = this.resolveMethod('init');
    if (!initMethod && args.length > 0) {
      throw new RuntimeError(`Class '${this.name}' does not define an init() method`, 0, 0);
    }
    if (initMethod) {
      for (let i = 0; i < initMethod.params.length; i++) {
        const value = args[i] ?? NONE;
        const paramName = initMethod.params[i];
        instance.set(paramName, value);
        classEnv.set(paramName, value);
      }
    }

    for (const stmt of this.initStmts) {
      await interp.execStmt(stmt, classEnv);
    }

    if (initMethod) {
      const boundInit = interp._bindMethod(initMethod, instance);
      const fnEnv = boundInit.closure.child();
      fnEnv.set('self', instance);
      if (boundInit.__boundSuper !== undefined) {
        fnEnv.set('super', boundInit.__boundSuper);
      }

      const result = await interp.execBlock(boundInit.body, fnEnv);
      if (result instanceof ReturnSignal) return instance;
    }

    return instance;
  }
}

class IVXSuperProxy {
  constructor(self, ownerClass) {
    this.__kind__ = 'super';
    this.self = self;
    this.ownerClass = ownerClass;
  }
}

const BUILTIN_DEFS = {
  int: {
    params: ['x'],
    call: (args) => Math.trunc(Number(args[0])),
  },
  flt: {
    params: ['x'],
    call: (args) => Number(args[0]),
  },
  str: {
    params: ['x'],
    call: (args) => ivxRepr(args[0]),
  },
  bin: {
    params: ['x'],
    call: (args) => Boolean(args[0]),
  },
  list: {
    params: ['x'],
    call: (args) => Array.isArray(args[0]) ? args[0] : args[0] instanceof Map ? [...args[0].values()] : [args[0]],
  },
  dict: {
    params: ['x'],
    call: (args) => args[0] instanceof Map ? args[0] : new Map(Object.entries(args[0] ?? {})),
  },
  length: {
    params: ['x'],
    call: (args, node) => {
      const v = args[0];
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      if (v instanceof Map) return v.size;
      throw new RuntimeError(`length() requires string, list, or dict`, node?.line);
    },
  },
  keys: {
    params: ['d'],
    call: (args) => args[0] instanceof Map ? [...args[0].keys()] : [],
  },
  values: {
    params: ['d'],
    call: (args) => args[0] instanceof Map ? [...args[0].values()] : [],
  },
  has: {
    params: ['d', 'k'],
    call: (args) => args[0] instanceof Map ? args[0].has(args[1]) : false,
  },
  push: {
    params: ['list', 'val'],
    call: (args) => {
      if (Array.isArray(args[0])) args[0].push(args[1]);
      return args[0];
    },
  },
  pop: {
    params: ['list'],
    call: (args) => {
      if (Array.isArray(args[0])) return args[0].pop() ?? NONE;
      return NONE;
    },
  },
  abs: {
    params: ['x'],
    call: (args) => Math.abs(args[0]),
  },
  floor: {
    params: ['x'],
    call: (args) => Math.floor(args[0]),
  },
  ceil: {
    params: ['x'],
    call: (args) => Math.ceil(args[0]),
  },
  round: {
    params: ['x'],
    call: (args) => Math.round(args[0]),
  },
  min: {
    params: ['a', 'b'],
    call: (args) => Math.min(args[0], args[1]),
  },
  max: {
    params: ['a', 'b'],
    call: (args) => Math.max(args[0], args[1]),
  },
  sqrt: {
    params: ['x'],
    call: (args) => Math.sqrt(args[0]),
  },
  upper: {
    params: ['s'],
    call: (args) => String(args[0]).toUpperCase(),
  },
  lower: {
    params: ['s'],
    call: (args) => String(args[0]).toLowerCase(),
  },
  trim: {
    params: ['s'],
    call: (args) => String(args[0]).trim(),
  },
  split: {
    params: ['s', 'sep'],
    call: (args) => String(args[0]).split(args[1] ?? ''),
  },
  join: {
    params: ['list', 'sep'],
    call: (args, node) => {
      // Relational join overload: join(left, right, leftCol, rightCol[, kind])
      if (args.length >= 4) {
        return tableJoin(args[0], args[1], args[2], args[3], args[4] ?? 'inner', node);
      }
      // Original string/list join behavior
      return (args[0] ?? []).join(args[1] ?? '');
    },
  },
  where: {
    params: ['table', 'col', 'op', 'value'],
    call: (args, node) => tableWhere(args, node),
  },
  order: {
    params: ['table', 'col', 'dir'],
    call: (args) => tableOrder(args[0], args[1], args[2] ?? 'asc'),
  },
  group: {
    params: ['table', 'cols'],
    call: (args) => tableGroup(args[0], args[1]),
  },
  agg: {
    params: ['grouped', 'col', 'fn', 'as'],
    call: (args, node) => tableAgg(args[0], args[1], args[2], args[3], node),
  },
  contains: {
    params: ['s', 'sub'],
    call: (args) => String(args[0]).includes(String(args[1])),
  },
  replace: {
    params: ['s', 'from', 'to'],
    call: (args) => String(args[0]).replaceAll(String(args[1]), String(args[2])),
  },
};

function ivxToPlain(value) {
  if (value === NONE || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(v => ivxToPlain(v));
  if (value instanceof Map) {
    const obj = {};
    for (const [k, v] of value.entries()) obj[String(k)] = ivxToPlain(v);
    return obj;
  }
  if (typeof value === 'object') {
    const obj = {};
    for (const [k, v] of Object.entries(value)) obj[k] = ivxToPlain(v);
    return obj;
  }
  return value;
}

function tableToObjectRows(table) {
  if (!Array.isArray(table)) return [];
  if (table.length === 0) return [];

  // Row objects (plain objects / maps)
  if (table.every(r => r instanceof Map || (r && typeof r === 'object' && !Array.isArray(r)))) {
    return table.map(r => (r instanceof Map ? ivxToPlain(r) : ivxToPlain(r)));
  }

  // 2D list rows -> object rows (header-aware)
  if (table.every(r => Array.isArray(r))) {
    const first = table[0] ?? [];
    const hasHeader = first.every(c => typeof c === 'string');
    const rows = hasHeader ? table.slice(1) : table;
    const headers = hasHeader
      ? first
      : Array.from({ length: Math.max(...rows.map(r => r.length), 0) }, (_, i) => `c${i}`);

    return rows.map(r => {
      const obj = {};
      for (let i = 0; i < headers.length; i++) obj[headers[i]] = ivxToPlain(r[i]);
      return obj;
    });
  }

  return table.map(v => ({ value: ivxToPlain(v) }));
}

function tableCompare(left, op, right) {
  switch (op) {
    case '=': return left === right;
    case '!=': return left !== right;
    case '<': return left < right;
    case '>': return left > right;
    case '<=': return left <= right;
    case '>=': return left >= right;
    case 'contains': return String(left ?? '').includes(String(right ?? ''));
    default: return left === right;
  }
}

function tableWhere(args, node) {
  const rows = tableToObjectRows(args[0]);
  const col = String(args[1] ?? '');
  if (!col) throw new RuntimeError("where() requires a column name", node?.line);

  let op = '=';
  let val = NONE;
  if (args.length >= 4) {
    op = String(args[2] ?? '=');
    val = ivxToPlain(args[3]);
  } else {
    val = ivxToPlain(args[2]);
  }

  return rows.filter(r => tableCompare(r[col], op, val));
}

function tableOrder(table, col, dir = 'asc') {
  const rows = tableToObjectRows(table);
  const key = String(col ?? '');
  const sign = String(dir).toLowerCase() === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const av = a?.[key];
    const bv = b?.[key];
    if (av === bv) return 0;
    return av > bv ? sign : -sign;
  });
}

function tableGroup(table, cols) {
  const rows = tableToObjectRows(table);
  const keys = Array.isArray(cols) ? cols.map(String) : [String(cols ?? '')];
  const buckets = new Map();

  for (const row of rows) {
    const keyObj = {};
    for (const k of keys) keyObj[k] = row?.[k];
    const key = JSON.stringify(keyObj);
    if (!buckets.has(key)) buckets.set(key, { key: keyObj, rows: [] });
    buckets.get(key).rows.push(row);
  }

  return [...buckets.values()];
}

function tableAgg(grouped, col, fn, asName, node) {
  if (!Array.isArray(grouped)) throw new RuntimeError('agg() expects grouped rows list', node?.line);
  const key = String(col ?? '');
  const op = String(fn ?? 'count').toLowerCase();
  const outKey = String(asName ?? `${op}_${key}`);

  return grouped.map(g => {
    const rows = Array.isArray(g?.rows) ? g.rows : [];
    const values = rows.map(r => r?.[key]).filter(v => v !== null && v !== undefined);
    let value;

    if (op === 'count') value = rows.length;
    else if (op === 'sum') value = values.reduce((a, v) => a + Number(v || 0), 0);
    else if (op === 'avg') value = values.length ? values.reduce((a, v) => a + Number(v || 0), 0) / values.length : 0;
    else if (op === 'min') value = values.length ? values.reduce((a, v) => (a < v ? a : v)) : NONE;
    else if (op === 'max') value = values.length ? values.reduce((a, v) => (a > v ? a : v)) : NONE;
    else throw new RuntimeError(`agg(): unknown function '${op}'`, node?.line);

    return { ...(g?.key ?? {}), [outKey]: value };
  });
}

function tableJoin(leftTable, rightTable, leftCol, rightCol, kind = 'inner', node) {
  const left = tableToObjectRows(leftTable);
  const right = tableToObjectRows(rightTable);
  const lCol = String(leftCol ?? '');
  const rCol = String(rightCol ?? '');
  const mode = String(kind ?? 'inner').toLowerCase();

  if (!lCol || !rCol) throw new RuntimeError('join() requires left and right key columns', node?.line);

  const rIndex = new Map();
  for (const r of right) {
    const key = r?.[rCol];
    if (!rIndex.has(key)) rIndex.set(key, []);
    rIndex.get(key).push(r);
  }

  const out = [];
  const rightSeen = new Set();
  for (const l of left) {
    const key = l?.[lCol];
    const matches = rIndex.get(key) ?? [];
    if (matches.length === 0) {
      if (mode === 'left' || mode === 'full') out.push({ ...l });
      continue;
    }
    for (const r of matches) {
      rightSeen.add(r);
      const merged = { ...l };
      for (const [k, v] of Object.entries(r ?? {})) {
        if (k in merged) merged[`r_${k}`] = v;
        else merged[k] = v;
      }
      out.push(merged);
    }
  }

  if (mode === 'right' || mode === 'full') {
    for (const r of right) {
      if (rightSeen.has(r)) continue;
      out.push({ ...r });
    }
  }

  return out;
}

// ── Interpreter ───────────────────────────────────────────────────────────────
class Interpreter {
  constructor(options = {}) {
    // I/O hooks — override these to wire up the browser UI
    this.onOutput  = options.onOutput  ?? (v => console.log(ivxRepr(v)));
    this.onInput   = options.onInput   ?? (() => { throw new RuntimeError("'take' requires an input handler"); });
    this.onError   = options.onError   ?? (e => console.error(e));
    this.onWait    = options.onWait    ?? (n => new Promise(r => setTimeout(r, n * 100)));
    // onStep(srcLine) — called before each statement executes with the 1-based source line
    this.onStep    = options.onStep    ?? null;

    // Max loop iterations — safety valve against infinite loops
    this.maxIterations = options.maxIterations ?? 100_000;

    this.globals = new Env();
    // Built-in: err starts as none
    this.globals.set('err', NONE);

    // Register built-in functions
    this._registerBuiltins();

    this._exprEvaluators = {
      NumberLit: (node, env) => this._evalNumberLit(node, env),
      StringLit: (node, env) => this._evalStringLit(node, env),
      BoolLit: (node, env) => this._evalBoolLit(node, env),
      Ask: (node, env) => this._evalAskExpr(node, env),
      SheetsOpen: (node, env) => this._evalSheetsOpenExpr(node, env),
      Super: (node, env) => this._evalSuperExpr(node, env),
      ListLit: (node, env) => this._evalListLit(node, env),
      DictLit: (node, env) => this._evalDictLit(node, env),
      MemberAccess: (node, env) => this._evalMemberAccessExpr(node, env),
      Identifier: (node, env) => this._evalIdentifierExpr(node, env),
      IndexAccess: (node, env) => this._evalIndexAccessExpr(node, env),
      LazyDecl: (node, env) => this._evalLazyDeclExpr(node, env),
      BinOp: (node, env) => this.evalBinOp(node, env),
      Post: (node, env) => this._evalPostExpr(node, env),
      UnaryOp: (node, env) => this._evalUnaryOpExpr(node, env),
      Call: (node, env) => this.evalCall(node, env),
      Invoke: (node, env) => this._evalInvokeExpr(node, env),
    };
  }

  _resolveClassObject(name, env = this.globals) {
    const value = env?.get?.(name);
    return value instanceof IVXClass ? value : null;
  }

  _bindMethod(methodFn, selfValue) {
    const bound = new IVXFunction(methodFn.name, methodFn.params, methodFn.body, methodFn.closure);
    bound.__ownerClass = methodFn.__ownerClass ?? null;
    bound.__boundSelf = selfValue;

    const ownerClass = methodFn.__ownerClass ?? null;
    if (ownerClass?.superclass) {
      bound.__boundSuper = new IVXSuperProxy(selfValue, ownerClass);
    }

    return bound;
  }

  _resolveInstanceMember(instance, field, selfValue = instance) {
    if (!(instance instanceof Map)) return NONE;
    if (instance.has(field)) return instance.get(field);

    const classObj = instance.get('__class_obj__');
    const method = classObj?.resolveMethod?.(field) ?? null;
    if (method) {
      return this._bindMethod(method, selfValue);
    }

    return NONE;
  }

  _resolveSuperMember(proxy, field) {
    if (!(proxy instanceof IVXSuperProxy)) return NONE;
    const superClass = proxy.ownerClass?.superclass ?? null;
    const method = superClass?.resolveMethod?.(field) ?? null;
    if (method) return this._bindMethod(method, proxy.self);
    return NONE;
  }

  // ── Built-in functions ────────────────────────────────────────────────────
  _registerBuiltins() {
    const G = this.globals;
    for (const [name, spec] of Object.entries(BUILTIN_DEFS)) {
      G.set(name, new IVXFunction(name, spec.params, null, null));
    }
  }

  // ── Call a built-in function by name ──────────────────────────────────────
  _callBuiltin(name, args, node) {
    const spec = BUILTIN_DEFS[name];
    if (!spec) throw new RuntimeError(`Unknown built-in '${name}'`, node?.line);
    return spec.call(args, node);
  }

  async _executePost(node, env, { storeResponse = false } = {}) {
    const url  = await this.evalExpr(node.url,  env);
    const body = await this.evalExpr(node.body, env);
    const cred = node.credential
      ? await this.evalExpr(node.credential, env)
      : this.globals.get('__credential__') ?? null;
    const headers = { 'Content-Type': 'application/json' };
    if (cred) headers['Authorization'] = `Bearer ${cred}`;

    try {
      const res = await fetch(String(url), {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      const ct = res.headers.get('content-type') || '';
      const result = ct.includes('application/json') ? await res.json() : await res.text();
      if (storeResponse) {
        // Convenience variable for statement-form post.
        this.globals.set('response', result);
      }
      return result;
    } catch (e) {
      throw new RuntimeError(`post failed: ${e.message}`, node.line);
    }
  }

  _ivxToPlain(value) {
    if (value === NONE || value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(v => this._ivxToPlain(v));
    if (value instanceof Map) {
      const obj = {};
      for (const [k, v] of value.entries()) obj[String(k)] = this._ivxToPlain(v);
      return obj;
    }
    if (typeof value === 'object') {
      const obj = {};
      for (const [k, v] of Object.entries(value)) obj[k] = this._ivxToPlain(v);
      return obj;
    }
    return value;
  }

  _escapeDelimitedCell(val, delimiter) {
    const s = String(val ?? '');
    const needsQuote = s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delimiter);
    const escaped = s.replace(/"/g, '""');
    return needsQuote ? `"${escaped}"` : escaped;
  }

  _toDelimitedText(value, delimiter) {
    const plain = this._ivxToPlain(value);

    if (Array.isArray(plain)) {
      if (plain.length === 0) return '';

      if (plain.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
        const headers = [];
        for (const row of plain) {
          for (const k of Object.keys(row)) {
            if (!headers.includes(k)) headers.push(k);
          }
        }
        const lines = [];
        lines.push(headers.map(h => this._escapeDelimitedCell(h, delimiter)).join(delimiter));
        for (const row of plain) {
          const line = headers
            .map(h => this._escapeDelimitedCell(row[h] ?? '', delimiter))
            .join(delimiter);
          lines.push(line);
        }
        return lines.join('\n');
      }

      if (plain.every(row => Array.isArray(row))) {
        return plain
          .map(row => row.map(cell => this._escapeDelimitedCell(cell, delimiter)).join(delimiter))
          .join('\n');
      }

      const header = this._escapeDelimitedCell('value', delimiter);
      const body = plain.map(v => this._escapeDelimitedCell(v, delimiter)).join('\n');
      return body ? `${header}\n${body}` : header;
    }

    if (plain && typeof plain === 'object') {
      const keys = Object.keys(plain);
      const header = keys.map(k => this._escapeDelimitedCell(k, delimiter)).join(delimiter);
      const row = keys.map(k => this._escapeDelimitedCell(plain[k], delimiter)).join(delimiter);
      return `${header}\n${row}`;
    }

    return String(plain ?? '');
  }

  _serializeForSave(value, filename) {
    const match = /\.([A-Za-z0-9]+)$/.exec(filename);
    const ext = (match?.[1] ?? 'txt').toLowerCase();

    if (ext === 'json') {
      return {
        filename,
        mimeType: 'application/json',
        content: JSON.stringify(this._ivxToPlain(value), null, 2),
      };
    }
    if (ext === 'csv') {
      return {
        filename,
        mimeType: 'text/csv',
        content: this._toDelimitedText(value, ','),
      };
    }
    if (ext === 'tsv') {
      return {
        filename,
        mimeType: 'text/tab-separated-values',
        content: this._toDelimitedText(value, '\t'),
      };
    }
    if (ext === 'xlsx') {
      this.globals.set('err', "save: '.xlsx' uses CSV content in zero-dependency mode");
      return {
        filename,
        mimeType: 'text/csv',
        content: this._toDelimitedText(value, ','),
      };
    }

    return {
      filename,
      mimeType: 'text/plain',
      content: typeof value === 'string' ? value : ivxRepr(value),
    };
  }

  async _saveLocalFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async _saveDriveFile(filename, content, mimeType) {
    if (!driveToken) {
      throw new RuntimeError("save: not signed in to Google Drive", 0);
    }

    await driveEnsureFolder();
    const escapedName = String(filename).replace(/'/g, "\\'");
    const q = `'${driveFolderId}' in parents and name='${escapedName}' and trashed=false`;
    const found = await driveAPI(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
    let fileId = found.files?.[0]?.id ?? null;

    if (!fileId) {
      const meta = await driveAPI('/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: filename,
          parents: [driveFolderId],
          mimeType: mimeType || 'text/plain',
        }),
      });
      fileId = meta.id;
    }

    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + driveToken,
        'Content-Type': mimeType || 'text/plain',
      },
      body: content,
    });
    if (!res.ok) {
      throw new RuntimeError(`save: Drive upload failed (${res.status})`, 0);
    }

    if (typeof driveListFiles === 'function') {
      try { await driveListFiles(); } catch (_) {}
    }
  }

  async _executeSave(node, env) {
    let value;
    if (node.valueExpr) {
      value = await this.evalExpr(node.valueExpr, env);
    } else if (this.globals.has('response')) {
      value = this.globals.get('response');
    } else if (this.globals.has('err')) {
      value = this.globals.get('err');
    } else {
      value = NONE;
    }

    let rawName = await this.evalExpr(node.filenameExpr, env);
    let filename = String(rawName ?? '').trim();
    if (!filename) {
      throw new RuntimeError("save: filename cannot be empty", node.line);
    }

    // Auto-name: no extension was given — pick one based on value type
    if (node.autoName && !filename.includes('.')) {
      if (Array.isArray(value) || value instanceof Map) {
        filename += '.json';
      } else {
        filename += '.txt';
      }
    }

    const payload = this._serializeForSave(value, filename);
    if (node.target === 'local') {
      await this._saveLocalFile(payload.filename, payload.content, payload.mimeType);
      return;
    }
    await this._saveDriveFile(payload.filename, payload.content, payload.mimeType);
  }

  // ── Execute a program from source ─────────────────────────────────────────
  async run(source, options = {}) {
    // Parse once and reuse for type checking and execution.
    const parsed = parse(source);

    // Type-check first — surface errors without running
    const { errors: typeErrors } = typecheck(parsed);
    const hasParseErrors = parsed.errors.length > 0;
    if (typeErrors.length > 0 && (hasParseErrors || !options.ignoreTypeErrors)) {
      for (const e of typeErrors) this.onError(e);
      return;
    }

    try {
      const result = await this.execBlock(parsed.ast.body, this.globals);
      // EndSignal is a clean stop — no error, stmt already executed inside End case
    } catch (e) {
      if (e instanceof RuntimeError) this.onError(e);
      else throw e;
    }
  }

  // ── Execute a block of statements ─────────────────────────────────────────
  async execBlock(stmts, env) {
    for (const stmt of stmts) {
      if (!stmt) continue;
      const result = await this.execStmt(stmt, env);
      // Propagate control flow signals up
      if (result instanceof ReturnSignal)   return result;
      if (result instanceof BreakSignal)    return result;
      if (result instanceof ContinueSignal) return result;
      if (result instanceof EndSignal)      return result;
    }
  }

  // ── Execute a single statement ────────────────────────────────────────────
  async execStmt(node, env) {
    // Fire onStep so the renderer can highlight the active node
    if (this.onStep && node.line != null) this.onStep(node.line);
    switch (node.type) {

      case 'Assign': {
        // Lazy declaration: make name? + expr — hoist to global if not exists
        // Default is 0 for arithmetic context (most common), none otherwise
        if (node.lazy && node.name && !this.globals.has(node.name)) {
          // Peek at the expr to infer a better default
          // BinOp with arithmetic op on an Identifier named same as node.name
          // means the implied left is already set; infer from the right side
          let defaultVal = 0; // arithmetic shorthand implies integer
          if (node.expr?.type === 'BinOp') {
            const right = node.expr.right;
            if (right?.type === 'NumberLit') {
              defaultVal = Number.isInteger(right.value) ? 0 : 0.0;
            } else if (right?.type === 'StringLit') {
              defaultVal = '';
            } else if (right?.type === 'BoolLit') {
              defaultVal = false;
            }
          }
          this.globals.set(node.name, defaultVal);
        }
        const value = await this.evalExpr(node.expr, env);
        if (node.target?.type === 'MemberAccess') {
          const obj = await this.evalExpr(node.target.object, env);
          if (obj instanceof Map) {
            obj.set(node.target.field, value);
          } else if (obj && typeof obj === 'object') {
            obj[node.target.field] = value;
          } else {
            throw new RuntimeError(`Cannot assign field '${node.target.field}' on non-object value`, node.line);
          }
        } else {
          env.set(node.name, value);
        }
        break;
      }

      case 'Delete': {
        if (!env.del(node.name)) {
          throw new RuntimeError(`Cannot delete undefined variable '${node.name}'`, node.line);
        }
        break;
      }

      case 'Say': {
        const value = await this.evalExpr(node.expr, env);
        await this.onOutput(value);
        break;
      }

      case 'Take': {
        const raw = await this.onInput(node.name);
        let value = raw ?? NONE;
        // Apply converter if specified
        if (node.converter && value !== NONE) {
          try { value = this._callBuiltin(node.converter, [value], node); }
          catch(e) { this.globals.set('err', e.message ?? String(e)); }
        }
        env.set(node.name, value);
        break;
      }

      case 'Give': {
        const value = await this.evalExpr(node.expr, env);
        return new ReturnSignal(value);
      }

      case 'Use': {
        // use <key> — set global credential
        const keyVal = await this.evalExpr(node.key, env);
        this.globals.set('__credential__', String(keyVal));
        break;
      }

      case 'Post': {
        // post <url> <body> [use <key>]
        // Result stored in 'response' by default, or assign via make response post ...
        return await this._executePost(node, env, { storeResponse: true });
      }

      case 'Gmail': {
        await this._executeGmail(node, env);
        break;
      }

      case 'Save': {
        await this._executeSave(node, env);
        break;
      }

      case 'TakeFile': {
        // take file.csv — browser file picker
        const result = await new Promise((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          const extMap = { csv: '.csv', json: '.json', txt: '.txt', tsv: '.tsv', xml: '.xml' };
          input.accept = extMap[node.ext] || '*';
          input.onchange = async () => {
            const file = input.files[0];
            if (!file) { resolve(NONE); return; }
            const text = await file.text();
            try {
              if (node.ext === 'json') {
                resolve(JSON.parse(text));
              } else if (node.ext === 'csv' || node.ext === 'tsv') {
                const sep = node.ext === 'tsv' ? '\t' : ',';
                const lines = text.trim().split('\n');
                const headers = lines[0].split(sep).map(h => h.trim());
                const rows = lines.slice(1).map(line => {
                  const vals = line.split(sep);
                  const row = new Map();
                  headers.forEach((h, i) => row.set(h, vals[i]?.trim() ?? ''));
                  return row;
                });
                resolve(rows);
              } else {
                resolve(text);
              }
            } catch(e) {
              reject(new RuntimeError(`Failed to parse ${node.ext}: ${e.message}`, node.line));
            }
          };
          input.click();
        });
        env.set(node.name, result);
        break;
      }

      case 'Wait': {
        if (node.condition) {
          // wait x = 5 — poll until condition is true
          let iters = 0;
          while (true) {
            const cond = await this.evalExpr(node.condition, env);
            if (cond) break;
            if (++iters > this.maxIterations) {
              throw new RuntimeError("'wait' condition never became true", node.line);
            }
            await this.onWait(1);
          }
        } else {
          const cycles = await this.evalExpr(node.expr, env);
          await this.onWait(Number(cycles) || 1);
        }
        break;
      }

      case 'WaitBlock': {
        // WaitBlock is a declaration — deployed to Apps Script automatically.
        // The browser never executes it directly, just like 'fun' doesn't run its body.
        break;
      }

      case 'If': {
        const cond = await this.evalExpr(node.condition, env);
        const bodyEnv = env.child();
        if (isTruthy(cond)) {
          const r = await this.execBlock(node.body, bodyEnv);
          if (r) return r;
        } else if (node.else_) {
          const elseEnv = env.child();
          const r = await this.execBlock(node.else_, elseEnv);
          if (r) return r;
        }
        break;
      }

      case 'Loop': {
        let iters = 0;
        while (true) {
          // Re-fire onStep so the Decision node highlights on every iteration
          if (this.onStep && node.line != null) this.onStep(node.line);
          const cond = await this.evalExpr(node.condition, env);
          if (!isTruthy(cond)) break;
          if (++iters > this.maxIterations) {
            throw new RuntimeError('Loop exceeded maximum iterations', node.line);
          }
          const loopEnv = env.child();
          const r = await this.execBlock(node.body, loopEnv);
          if (r instanceof ReturnSignal)  return r;
          if (r instanceof BreakSignal)   break;
        }
        break;
      }

      case 'For': {
        const iterable = env.get(node.target);
        if (iterable === undefined) {
          throw new RuntimeError(`Undefined variable '${node.target}'`, node.line);
        }
        const entries = toIterable(iterable, node);
        let iters = 0;
        for (const [primary, secondary] of entries) {
          // Re-fire onStep so the Decision node highlights on every iteration
          if (this.onStep && node.line != null) this.onStep(node.line);
          if (++iters > this.maxIterations) {
            throw new RuntimeError('For loop exceeded maximum iterations', node.line);
          }
          const forEnv = env.child();
          forEnv.set(node.iterVar,  primary);
          forEnv.set(node.iterVar2, secondary);
          const r = await this.execBlock(node.body, forEnv);
          if (r instanceof ReturnSignal)  return r;
          if (r instanceof BreakSignal)   break;
        }
        break;
      }

      case 'Fun': {
        const fn = new IVXFunction(node.name, node.params, node.body, env);
        env.set(node.name, fn);
        break;
      }

      case 'Class': {
        const superClass = node.superclass
          ? this._resolveClassObject(node.superclass.name, env)
          : null;
        if (node.superclass && !superClass) {
          throw new RuntimeError(`Superclass '${node.superclass.name}' is not defined`, node.superclass.line, node.superclass.col);
        }
        const cls = new IVXClass(node.name, node.body, env, superClass);
        const classEnv = env.child();
        classEnv.set('self', NONE);
        if (superClass) {
          classEnv.set('super', new IVXSuperProxy(NONE, cls));
        }
        for (const stmt of node.body ?? []) {
          if (stmt?.type === 'Fun') {
            const methodFn = new IVXFunction(stmt.name, stmt.params, stmt.body, classEnv);
            methodFn.__ownerClass = cls;
            cls.methods.set(stmt.name, methodFn);
          } else if (stmt) {
            cls.initStmts.push(stmt);
          }
        }
        env.set(node.name, cls);
        break;
      }

      case 'End': {
        if (node.stmt) await this.execStmt(node.stmt, env);
        return new EndSignal();
      }

      case 'Dot':
        // Connector — no-op at runtime
        break;

      case 'Import':
        // Module imports deferred to future runtime
        break;

      case 'ExprStatement':
        if (node.expr) await this.evalExpr(node.expr, env);
        break;

      default:
        break;
    }
  }

  // ── Evaluate an expression to a value ─────────────────────────────────────
  async evalExpr(node, env) {
    if (!node) return NONE;
    const evaluator = this._exprEvaluators[node.type];
    if (!evaluator) return NONE;
    return await evaluator(node, env);
  }

  async _evalNumberLit(node) {
    return node.value;
  }

  async _evalStringLit(node, env) {
    let sv = node.value;
    if (typeof sv === 'string' && sv.includes('{')) {
      sv = sv.replace(/\{([A-Za-z_]\w*)\}/g, (match, name) => {
        const val = env.get(name);
        if (val === undefined) return match;
        return ivxRepr(val);
      });
    }
    if (typeof sv === 'string' && (sv.startsWith('http://') || sv.startsWith('https://'))) {
      try {
        const res = await fetch(sv);
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) return await res.json();
        return await res.text();
      } catch (e) {
        throw new RuntimeError(`fetch failed for ${sv}: ${e.message}`, node.line);
      }
    }
    return sv;
  }

  async _evalBoolLit(node) {
    return node.value;
  }

  async _evalAskExpr(node, env) {
    const prompt = await this.evalExpr(node.prompt, env);
    const credential = node.credential
      ? await this.evalExpr(node.credential, env)
      : this.globals.get('__credential__') ?? null;
    const model = (node.model ?? 'gemini').toLowerCase();

    if (!credential) {
      throw new RuntimeError(
        `ask ${model}: no API key. Add: make key "your-key" use key`,
        node.line
      );
    }

    try {
      if (model === 'gemini' || model === 'google') {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${credential}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: String(prompt) }] }]
            }),
          }
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new RuntimeError(
            `Gemini error ${res.status}: ${err?.error?.message ?? res.statusText}`,
            node.line
          );
        }
        const data = await res.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      }

      if (model === 'chatgpt' || model === 'gpt') {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${credential}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: String(prompt) }],
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new RuntimeError(
            `OpenAI error ${res.status}: ${err?.error?.message ?? res.statusText}`,
            node.line
          );
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content ?? '';
      }

      if (model === 'claude' || model === 'anthropic') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': credential,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            messages: [{ role: 'user', content: String(prompt) }],
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new RuntimeError(
            `Claude error ${res.status}: ${err?.error?.message ?? res.statusText}`,
            node.line
          );
        }
        const data = await res.json();
        return data?.content?.[0]?.text ?? '';
      }

      throw new RuntimeError(
        `Unknown model '${model}'. Use: gemini, chatgpt, or claude`,
        node.line
      );

    } catch (e) {
      if (e instanceof RuntimeError) throw e;
      throw new RuntimeError(`ask ${model} failed: ${e.message}`, node.line);
    }
  }

  // ── Google service helpers ────────────────────────────────────────────────

  _googleToken() {
    // driveToken is the shared OAuth token for all Google services
    if (typeof driveToken !== 'undefined' && driveToken) return driveToken;
    return null;
  }

  async _googleAPI(url, opts = {}) {
    const token = this._googleToken();
    if (!token) throw new RuntimeError('Not signed in to Google. Click "Sign in to Google" first.', null);
    const res = await fetch(url, {
      ...opts,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message ?? err?.error?.status ?? res.statusText;
      throw new RuntimeError(`Google API error ${res.status}: ${msg}`, null);
    }
    return res.json();
  }

  // ── sheets <name> — returns a handle with .read and .write ───────────────
  async _evalSheetsOpenExpr(node, env) {
    const name = String(await this.evalExpr(node.name, env));
    const token = this._googleToken();
    if (!token) throw new RuntimeError('Not signed in to Google. Click "Sign in to Google" first.', node.line);

    // Find the spreadsheet by name in Drive
    const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
    const listRes = await this._googleAPI(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`
    );
    const file = listRes?.files?.[0];
    if (!file) throw new RuntimeError(`Spreadsheet "${name}" not found in Drive.`, node.line);
    const spreadsheetId = file.id;
    const interp = this;

    // Return a Map-like handle with read/write methods
    const handle = new Map();
    handle.set('__type__', 'sheets');
    handle.set('__id__', spreadsheetId);
    handle.set('__name__', name);

    // handle.read("A1:C10") → 2D list
    handle.set('read', async (range) => {
      const r = encodeURIComponent(String(range));
      const data = await interp._googleAPI(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${r}`
      );
      return data?.values ?? [];
    });

    // handle.write("A1", value) or handle.write("A1:B2", [[...],[...]])
    handle.set('write', async (range, value) => {
      const r = encodeURIComponent(String(range));
      const body = Array.isArray(value) ? value : [[value]];
      await interp._googleAPI(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${r}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', body: JSON.stringify({ values: body }) }
      );
      return value;
    });

    // handle.append(row) — appends a row to the first sheet
    handle.set('append', async (row) => {
      const body = Array.isArray(row[0]) ? row : [row];
      await interp._googleAPI(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: body }) }
      );
      return row;
    });

    return handle;
  }

  // ── gmail to <addr> subject <subj> body <body> ────────────────────────────
  async _executeGmail(node, env) {
    const to      = node.to      ? String(await this.evalExpr(node.to, env))      : '';
    const subject = node.subject ? String(await this.evalExpr(node.subject, env)) : '';
    const body    = node.body    ? String(await this.evalExpr(node.body, env))     : '';

    if (!to) throw new RuntimeError("email: missing recipient address", node.line);

    // Build RFC 2822 message and base64url-encode it
    const raw = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `MIME-Version: 1.0`,
      '',
      body,
    ].join('\r\n');

    const encoded = btoa(unescape(encodeURIComponent(raw)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await this._googleAPI(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      { method: 'POST', body: JSON.stringify({ raw: encoded }) }
    );

    this.onOutput?.(`Email sent to ${to}`);
  }

  // ── wait block: Level 1 polling execution ────────────────────────────────
  async _executeWaitBlock(node, env) {
    const POLL_MS    = 5000;  // poll every 5 seconds
    const MAX_POLLS  = 720;   // give up after 1 hour (720 × 5s)
    const trigger    = node.trigger;
    const interp     = this;

    const poll = async () => {
      if (trigger === 'email') {
        // Poll Gmail for unread messages from the source address
        const from = node.source ? String(await this.evalExpr(node.source, env)) : '';
        const q    = encodeURIComponent(`is:unread${from ? ` from:${from}` : ''}`);
        const data = await this._googleAPI(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=1`
        );
        if (data?.messages?.length > 0) {
          // Fetch the message and expose it as 'request'
          const msg = await this._googleAPI(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${data.messages[0].id}`
          );
          const headers = msg?.payload?.headers ?? [];
          const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
          const fromAddr = headers.find(h => h.name === 'From')?.value ?? '';
          const bodyPart = msg?.payload?.parts?.[0]?.body?.data ?? msg?.payload?.body?.data ?? '';
          const bodyText = bodyPart ? atob(bodyPart.replace(/-/g,'+').replace(/_/g,'/')) : '';
          const triggerEnv = env.child();
          triggerEnv.set('request', new Map([
            ['subject', subject], ['from', fromAddr], ['body', bodyText], ['id', data.messages[0].id]
          ]));
          return triggerEnv;
        }
        return null;
      }

      if (trigger === 'sheets') {
        // Poll a sheet for new rows since last check
        const name = node.source ? String(await this.evalExpr(node.source, env)) : '';
        const handle = await this._evalSheetsOpenExpr({ ...node, name: node.source }, env);
        const rows = await handle.get('read')('A1:Z1000');
        const lastSeen = this.globals.get('__waitSheetRows__') ?? 0;
        const current  = (rows?.length ?? 1) - 1; // subtract header
        if (current > lastSeen) {
          this.globals.set('__waitSheetRows__', current);
          const newRows = rows.slice(lastSeen + 1);
          const triggerEnv = env.child();
          triggerEnv.set('request', newRows);
          return triggerEnv;
        }
        // Initialise baseline on first poll
        if (lastSeen === 0) this.globals.set('__waitSheetRows__', current);
        return null;
      }

      if (trigger === 'time') {
        // Check if current time matches (simple HH:MM match)
        const timeStr = node.source ? String(await this.evalExpr(node.source, env)) : '';
        const now = new Date();
        const nowStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        if (nowStr === timeStr) return env.child();
        return null;
      }

      return null;
    };

    this.onOutput?.(`⏳ Waiting for ${trigger} trigger…`);

    let polls = 0;
    while (polls < MAX_POLLS) {
      const triggerEnv = await poll();
      if (triggerEnv) {
        this.onOutput?.(`✓ ${trigger} trigger fired`);
        const r = await this.execBlock(node.body, triggerEnv);
        if (r instanceof EndSignal || r instanceof ReturnSignal) return r;
        return;
      }
      polls++;
      await new Promise(res => setTimeout(res, POLL_MS));
    }

    this.onOutput?.(`⚠ wait ${trigger}: timed out after ${MAX_POLLS * POLL_MS / 1000}s`);
  }

  async _evalListLit(node, env) {
    const elements = [];
    for (const el of node.elements) elements.push(await this.evalExpr(el, env));
    return elements;
  }

  async _evalDictLit(node, env) {
    const map = new Map();
    for (const { key, value } of node.pairs) {
      const k = await this.evalExpr(key, env);
      const v = await this.evalExpr(value, env);
      map.set(k, v);
    }
    return map;
  }

  async _evalMemberAccessExpr(node, env) {
    const target = await this.evalExpr(node.object, env);
    if (target instanceof IVXSuperProxy) {
      return this._resolveSuperMember(target, node.field);
    }
    if (target instanceof Map) {
      return this._resolveInstanceMember(target, node.field, target);
    }
    if (target && typeof target === 'object') {
      return node.field in target ? target[node.field] : NONE;
    }
    return NONE;
  }

  async _evalSuperExpr(node, env) {
    const target = env.get('super');
    if (target instanceof IVXSuperProxy) return target;
    throw new RuntimeError(`'super' is only available inside a subclass method`, node.line, node.col);
  }

  async _evalIdentifierExpr(node, env) {
    const val = env.get(node.name);
    if (val === undefined) {
      throw new RuntimeError(`Undefined variable '${node.name}'`, node.line, node.col);
    }
    return val;
  }

  async _evalInvokeExpr(node, env) {
    const callee = await this.evalExpr(node.callee, env);
    const args = [];
    for (const arg of node.args) args.push(await this.evalExpr(arg, env));

    if (callee instanceof IVXFunction) {
      if (callee.body === null) {
        try {
          return this._callBuiltin(callee.name, args, node) ?? NONE;
        } catch (e) {
          this.globals.set('err', e.message ?? String(e));
          return NONE;
        }
      }
      const fnEnv = callee.closure.child();
      if (callee.__boundSelf !== undefined) {
        fnEnv.set('self', callee.__boundSelf);
      }
      if (callee.__boundSuper !== undefined) {
        fnEnv.set('super', callee.__boundSuper);
      }
      for (let i = 0; i < callee.params.length; i++) {
        fnEnv.set(callee.params[i], args[i] ?? NONE);
      }
      try {
        const result = await this.execBlock(callee.body, fnEnv);
        if (result instanceof ReturnSignal) return result.value;
        return NONE;
      } catch (e) {
        this.globals.set('err', e.message ?? String(e));
        return NONE;
      }
    }

    if (callee instanceof IVXClass) {
      try {
        return await callee.instantiate(args, this, node);
      } catch (e) {
        this.globals.set('err', e.message ?? String(e));
        return NONE;
      }
    }

    // Native async functions stored in Maps (e.g. sheets handle methods)
    if (typeof callee === 'function') {
      try {
        return await callee(...args) ?? NONE;
      } catch (e) {
        if (e instanceof RuntimeError) throw e;
        throw new RuntimeError(e.message ?? String(e), node.line);
      }
    }

    throw new RuntimeError('Attempted to call a non-callable value', node.line);
  }

  _toArrayIndex(value, node, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new RuntimeError(`${label} index must be an integer`, node?.line);
    }
    return n;
  }

  _toSliceBound(value, node, label) {
    if (value === null || value === undefined) return null;
    return this._toArrayIndex(value, node, label);
  }

  _toExcelColumnIndex(value) {
    if (typeof value !== 'string') return null;
    const col = value.trim().toUpperCase();
    if (!/^[A-Z]+$/.test(col)) return null;
    let out = 0;
    for (let i = 0; i < col.length; i++) {
      out = out * 26 + (col.charCodeAt(i) - 64);
    }
    return out - 1;
  }

  _parseExcelCellRef(value) {
    if (typeof value !== 'string') return null;
    const m = value.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!m) return null;
    const col = this._toExcelColumnIndex(m[1]);
    const row = Number(m[2]);
    if (col == null || !Number.isInteger(row) || row < 0) return null;
    return { row, col };
  }

  _normalizeTableColumnSelector(value, node) {
    if (typeof value !== 'string') return value;
    const colIdx = this._toExcelColumnIndex(value);
    if (colIdx == null) {
      throw new RuntimeError(`Invalid table column '${value}'. Use Excel letters like A, B, AA`, node?.line);
    }
    return colIdx;
  }

  _sliceExcelRange(table, startRef, endRef) {
    const rowStart = Math.min(startRef.row, endRef.row);
    const rowEnd = Math.max(startRef.row, endRef.row);
    const colStart = Math.min(startRef.col, endRef.col);
    const colEnd = Math.max(startRef.col, endRef.col);
    const out = [];

    for (let r = rowStart; r <= rowEnd; r++) {
      const rowVal = table[r] ?? NONE;
      if (Array.isArray(rowVal)) {
        out.push(rowVal.slice(colStart, colEnd + 1));
      } else if (rowVal instanceof Map) {
        const rowOut = [];
        for (let c = colStart; c <= colEnd; c++) rowOut.push(rowVal.get(c) ?? NONE);
        out.push(rowOut);
      } else if (rowVal && typeof rowVal === 'object') {
        const rowOut = [];
        for (let c = colStart; c <= colEnd; c++) rowOut.push(rowVal[c] ?? NONE);
        out.push(rowOut);
      } else {
        out.push([]);
      }
    }

    return out;
  }

  _pickColumnFromRow(row, colIdxOrKey) {
    if (row == null) return NONE;
    if (row instanceof Map) {
      return row.has(colIdxOrKey) ? row.get(colIdxOrKey) : NONE;
    }
    if (Array.isArray(row)) {
      if (typeof colIdxOrKey === 'string') return NONE;
      return row[colIdxOrKey] ?? NONE;
    }
    if (typeof row === 'object') {
      return row[colIdxOrKey] ?? NONE;
    }
    return NONE;
  }

  _sliceColumnsFromRow(row, start, end) {
    if (Array.isArray(row)) return row.slice(start ?? undefined, end ?? undefined);
    return NONE;
  }

  async _resolveIndexSpec(spec, env, node, label, { allowString = false } = {}) {
    if (!spec || spec.omitted) return { omitted: true, isSlice: false, value: null, start: null, end: null };
    if (spec.isSlice) {
      const startRaw = spec.start ? await this.evalExpr(spec.start, env) : null;
      const endRaw = spec.end ? await this.evalExpr(spec.end, env) : null;

      const start = allowString && typeof startRaw === 'string'
        ? startRaw
        : this._toSliceBound(startRaw, node, `${label} start`);
      const end = allowString && typeof endRaw === 'string'
        ? endRaw
        : this._toSliceBound(endRaw, node, `${label} end`);

      return {
        omitted: false,
        isSlice: true,
        start,
        end,
      };
    }

    const raw = spec.expr ? await this.evalExpr(spec.expr, env) : null;
    if (allowString && typeof raw === 'string') {
      return { omitted: false, isSlice: false, value: raw, start: null, end: null };
    }
    return { omitted: false, isSlice: false, value: this._toArrayIndex(raw, node, label), start: null, end: null };
  }

  async _evalIndexAccessExpr(node, env) {
    const target = await this.evalExpr(node.target, env);
    const isArrayTarget = Array.isArray(target);

    const row = await this._resolveIndexSpec(node.rowSpec, env, node, 'Row', { allowString: isArrayTarget });
    const col = await this._resolveIndexSpec(node.colSpec, env, node, 'Column', { allowString: true });

    if (!isArrayTarget) {
      if (node.hasComma) {
        throw new RuntimeError(`2D indexing requires a list target`, node.line);
      }
      if (row.omitted) return target;
      if (row.isSlice) {
        if (typeof target === 'string') {
          return target.slice(row.start ?? undefined, row.end ?? undefined);
        }
        throw new RuntimeError(`Slice indexing requires list or string target`, node.line);
      }

      if (target instanceof Map) {
        return target.has(row.value) ? target.get(row.value) : NONE;
      }
      if (typeof target === 'object' && target !== null) {
        return target[row.value] ?? NONE;
      }
      if (typeof target === 'string') {
        const idx = this._toArrayIndex(row.value, node, 'Index');
        return target[idx] ?? NONE;
      }
      throw new RuntimeError(`Indexing requires a list/dict/string target`, node.line);
    }

    if (!node.hasComma) {
      if (row.omitted) return target;
      if (row.isSlice) {
        const startRef = this._parseExcelCellRef(row.start);
        const endRef = this._parseExcelCellRef(row.end);
        if (startRef && endRef) {
          return this._sliceExcelRange(target, startRef, endRef);
        }
        return target.slice(row.start ?? undefined, row.end ?? undefined);
      }
      if (typeof row.value === 'string') {
        const cell = this._parseExcelCellRef(row.value);
        if (cell) {
          const tableRow = target[cell.row];
          return this._pickColumnFromRow(tableRow, cell.col);
        }
      }
      return target[row.value] ?? NONE;
    }

    // t[,] -> whole table
    if (row.omitted && col.omitted) return target;

    // Build selected row set first.
    let selectedRows;
    if (row.omitted) {
      selectedRows = target.slice();
    } else if (row.isSlice) {
      selectedRows = target.slice(row.start ?? undefined, row.end ?? undefined);
    } else {
      selectedRows = [target[row.value] ?? NONE];
    }

    // Row-only access in 2D form: t[r,] or t[r1:r2,]
    if (col.omitted) {
      if (!row.omitted && !row.isSlice) return selectedRows[0] ?? NONE;
      return selectedRows;
    }

    // Column slices: t[,c1:c2], t[r,c1:c2], t[r1:r2,c1:c2]
    if (col.isSlice) {
      const cStart = this._normalizeTableColumnSelector(col.start, node);
      const cEnd = this._normalizeTableColumnSelector(col.end, node);
      const projected = selectedRows.map(r => this._sliceColumnsFromRow(r, cStart, cEnd));
      if (!row.omitted && !row.isSlice) return projected[0] ?? NONE;
      return projected;
    }

    // Single column projection: t[,c], t[r,c], t[r1:r2,c]
    const colSelector = this._normalizeTableColumnSelector(col.value, node);
    const projected = selectedRows.map(r => this._pickColumnFromRow(r, colSelector));
    if (!row.omitted && !row.isSlice) return projected[0] ?? NONE;
    return projected;
  }

  async _evalLazyDeclExpr(node) {
    if (!this.globals.has(node.name)) {
      this.globals.set(node.name, NONE);
    }
    return this.globals.get(node.name);
  }

  async _evalPostExpr(node, env) {
    return await this._executePost(node, env);
  }

  async _evalUnaryOpExpr(node, env) {
    const operand = await this.evalExpr(node.operand, env);
    if (node.op === 'not') return !isTruthy(operand);
    return operand;
  }

  // ── Binary operations ──────────────────────────────────────────────────────
  async evalBinOp(node, env) {
    // Lazy inference: if either side is a LazyDecl, infer default from the other side
    if (node.left?.type === 'LazyDecl' || node.right?.type === 'LazyDecl') {
      const lazyNode  = node.left?.type  === 'LazyDecl' ? node.left  : node.right;
      const otherNode = node.left?.type  === 'LazyDecl' ? node.right : node.left;
      if (!this.globals.has(lazyNode.name)) {
        const otherVal   = await this.evalExpr(otherNode, env);
        const defaultVal =
          typeof otherVal === 'number' && Number.isInteger(otherVal) ? 0
          : typeof otherVal === 'number'  ? 0.0
          : typeof otherVal === 'string'  ? ''
          : typeof otherVal === 'boolean' ? false
          : NONE;
        this.globals.set(lazyNode.name, defaultVal);
      }
    }

    // Short-circuit for logical operators
    if (node.op === 'and') {
      const l = await this.evalExpr(node.left, env);
      if (!isTruthy(l)) return false;
      return isTruthy(await this.evalExpr(node.right, env));
    }
    if (node.op === 'or') {
      const l = await this.evalExpr(node.left, env);
      if (isTruthy(l)) return true;
      return isTruthy(await this.evalExpr(node.right, env));
    }

    const left  = await this.evalExpr(node.left,  env);
    const right = await this.evalExpr(node.right, env);

    switch (node.op) {
      case '+':   return typeof left === 'string' ? String(left) + String(right) : left + right;
      case '-':   return left - right;
      case '*':   return left * right;
      case '/':   if (right === 0) throw new RuntimeError('Division by zero', node.line);
                  return left / right;
      case '//':  if (right === 0) throw new RuntimeError('Division by zero', node.line);
                  return Math.trunc(left / right);
      case '%':   return left % right;
      case '^':   return Math.pow(left, right);
      case '=':   return ivxEqual(left, right);
      case '!=':  return !ivxEqual(left, right);
      case '<':   return left < right;
      case '>':   return left > right;
      case '<=':  return left <= right;
      case '>=':  return left >= right;
      case 'is':  return ivxEqual(left, right);
      case 'in':  return ivxIn(left, right, node);
      case 'xor': return isTruthy(left) !== isTruthy(right);
      default:    throw new RuntimeError(`Unknown operator '${node.op}'`, node.line);
    }
  }

  // ── Function calls ─────────────────────────────────────────────────────────
  async evalCall(node, env) {
    const callee = env.get(node.name);

    // Evaluate arguments
    const args = [];
    for (const arg of node.args) args.push(await this.evalExpr(arg, env));

    if (!(callee instanceof IVXFunction) && !(callee instanceof IVXClass)) {
      throw new RuntimeError(`'${node.name}' is not callable`, node.line);
    }

    if (callee instanceof IVXClass) {
      try {
        return await callee.instantiate(args, this, node);
      } catch (e) {
        this.globals.set('err', e.message ?? String(e));
        return NONE;
      }
    }

    // Built-in: body is null, delegate to _callBuiltin
    if (callee.body === null) {
      try {
        return this._callBuiltin(node.name, args, node) ?? NONE;
      } catch (e) {
        this.globals.set('err', e.message ?? String(e));
        return NONE;
      }
    }

    // User-defined function
    const fnEnv = callee.closure.child();
    for (let i = 0; i < callee.params.length; i++) {
      fnEnv.set(callee.params[i], args[i] ?? NONE);
    }

    try {
      const result = await this.execBlock(callee.body, fnEnv);
      if (result instanceof ReturnSignal) return result.value;
      return NONE;
    } catch (e) {
      // Propagate runtime errors but set err variable
      this.globals.set('err', e.message ?? String(e));
      return NONE;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isTruthy(v) {
  if (v === NONE)  return false;
  if (v === false) return false;
  return true;
}

function ivxEqual(a, b) {
  if (a === NONE && b === NONE) return true;
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) { if (!ivxEqual(b.get(k), v)) return false; }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => ivxEqual(v, b[i]));
  }
  return a === b;
}

function ivxIn(left, right, node) {
  if (Array.isArray(right))     return right.some(v => ivxEqual(v, left));
  if (right instanceof Map)     return right.has(left);
  if (typeof right === 'string') return String(right).includes(String(left));
  throw new RuntimeError(`'in' requires list, dict, or string`, node?.line);
}

// Convert an IVX value to an iterable of [primary, secondary] pairs
function toIterable(value, node) {
  if (Array.isArray(value)) {
    return value.map((v, i) => [v, i]);
  }
  if (value instanceof Map) {
    return [...value.entries()].map(([k, v]) => [k, v]);
  }
  if (typeof value === 'string') {
    return [...value].map((c, i) => [c, i]);
  }
  throw new RuntimeError(`Cannot iterate over ${typeof value}`, node?.line);
}

// Human-readable representation of an IVX value
function ivxRepr(value) {
  if (value === NONE)           return 'none';
  if (value === true)           return 'yes';
  if (value === false)          return 'no';
  if (value instanceof Map)     return '{' + [...value.entries()].filter(([k]) => !String(k).startsWith('__')).map(([k,v]) => `${ivxRepr(k)}: ${ivxRepr(v)}`).join(', ') + '}';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return '{' + Object.entries(value).filter(([k]) => !String(k).startsWith('__')).map(([k, v]) => `${k}: ${ivxRepr(v)}`).join(', ') + '}';
  }
  if (Array.isArray(value))     return '[' + value.map(ivxRepr).join(', ') + ']';
  return String(value);
}

// ── Public API ────────────────────────────────────────────────────────────────
function interpret(source, options = {}) {
  const interp = new Interpreter(options);
  return interp.run(source, options);
}

async function runIVXSelfTests() {
  const results = [];
  const pass = (name, details = {}) => results.push({ name, ok: true, ...details });
  const fail = (name, details = {}) => results.push({ name, ok: false, ...details });

  try {
    const p = parse('make x 1\nsay x');
    if (p.errors.length === 0 && p.ast?.type === 'Program') {
      pass('parse-basic');
    } else {
      fail('parse-basic', { errors: p.errors });
    }
  } catch (e) {
    fail('parse-basic', { error: e.message ?? String(e) });
  }

  try {
    const tc = typecheck('say not_defined_var');
    if (tc.errors.length > 0) {
      pass('typecheck-undefined-var', { count: tc.errors.length });
    } else {
      fail('typecheck-undefined-var', { count: 0 });
    }
  } catch (e) {
    fail('typecheck-undefined-var', { error: e.message ?? String(e) });
  }

  try {
    const tc = typecheck('make t [["name","score"],["Ana",10],["Bo",11]]');
    if (tc.errors.length === 0) {
      pass('typecheck-table-header-exempt');
    } else {
      fail('typecheck-table-header-exempt', { errors: tc.errors.map(e => e.toString()) });
    }
  } catch (e) {
    fail('typecheck-table-header-exempt', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('class Dog\n  fun init(size, name)\n    make self.size size\n    make self.name name\nmake d Dog(3, "Rex")\nsay d.size\nsay d.name', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 2 && out[0] === 3 && out[1] === 'Rex') {
      pass('runtime-class-constructor');
    } else {
      fail('runtime-class-constructor', { output: out });
    }
  } catch (e) {
    fail('runtime-class-constructor', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('class Counter\n  fun init(value)\n    make self.value value\n  fun inc()\n    make self.value self.value + 1\n    give self.value\nmake c Counter(1)\nsay c.inc()\nsay c.inc()', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 2 && out[0] === 2 && out[1] === 3) {
      pass('runtime-class-methods');
    } else {
      fail('runtime-class-methods', { output: out });
    }
  } catch (e) {
    fail('runtime-class-methods', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('class Animal\n  fun init(name)\n    make self.name name\n  fun speak()\n    give self.name\nclass Dog(Animal)\n  fun init(name)\n    make self.name name\n  fun speak()\n    give super.speak() + "!"\nmake d Dog("Rex")\nsay d.speak()\nsay d.name', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 2 && out[0] === 'Rex!' && out[1] === 'Rex') {
      pass('runtime-class-inheritance');
    } else {
      fail('runtime-class-inheritance', { output: out });
    }
  } catch (e) {
    fail('runtime-class-inheritance', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('make x 2\nmake x + 3\nsay x', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 1 && out[0] === 5) {
      pass('runtime-arithmetic-output', { output: out[0] });
    } else {
      fail('runtime-arithmetic-output', { output: out });
    }
  } catch (e) {
    fail('runtime-arithmetic-output', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('make xs [1,2,3]\nsay length(xs)', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 1 && out[0] === 3) {
      pass('runtime-builtin-length', { output: out[0] });
    } else {
      fail('runtime-builtin-length', { output: out });
    }
  } catch (e) {
    fail('runtime-builtin-length', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('make t [["name","score"],["Ana",11],["Bo",22]]\nsay t[A0]\nsay t[B1]', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    if (out.length === 2 && out[0] === 'name' && out[1] === 11) {
      pass('runtime-excel-cell-index', { output: out });
    } else {
      fail('runtime-excel-cell-index', { output: out });
    }
  } catch (e) {
    fail('runtime-excel-cell-index', { error: e.message ?? String(e) });
  }

  try {
    const out = [];
    await interpret('make t [["c1","c2","c3"],[11,12,13],[21,22,23],[31,32,33]]\nsay t[A1:B2]\nsay t[2, "B"]', {
      onOutput: (v) => { out.push(v); },
      onError: (e) => { throw e; },
    });
    const okRange = out.length >= 1 && ivxEqual(out[0], [[11,12],[21,22]]);
    const okCell = out.length >= 2 && out[1] === 22;
    if (okRange && okCell) {
      pass('runtime-excel-range-index', { output: out });
    } else {
      fail('runtime-excel-range-index', { output: out });
    }
  } catch (e) {
    fail('runtime-excel-range-index', { error: e.message ?? String(e) });
  }

  const total = results.length;
  const passed = results.filter(r => r.ok).length;
  const failed = total - passed;
  const summary = { total, passed, failed, results };
  if (typeof console !== 'undefined') {
    console.log('IVX self-test summary:', summary);
  }
  return summary;
}

if (typeof window !== 'undefined') {
  window.runIVXSelfTests = runIVXSelfTests;
}
