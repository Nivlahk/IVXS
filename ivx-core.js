// ivx-core.js — IVX Language Core
// Lexer, Parser, Type Checker
// Pure language pipeline — no I/O, no DOM, no external services
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
// Copyright 2026 IVX


'use strict';


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
  'fun', 'class', 'give', 'init',
  // OOP
  'extends', 'super',
  // Data
  'make', 'del', 'take', 'say', 'save', 'local', 'download',
  // Aliasing
  'as',
  // Navigation / graph
  'dot', 'fork', 'prev', 'next', 'from',
  // Logic / literals
  'not', 'and', 'or', 'xor', 'is', 'yes', 'no', 'none',
  // Iteration
  'in',
  // Other
  'wait', 'note', 'try', 'err',
  // Network / AI
  'ask', 'post', 'use', 'key', 'fetch',
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

  // ── Multiline string lexing ─────────────────────────────────────────────────
  // Triple-quoted strings: """...""" or '''...'''
  // Spans multiple lines, preserves newlines, supports {expr} interpolation
  readMultilineString(quote, startLine, startCol) {
    let value = '';
    const triple = quote + quote + quote;
    while (this.pos < this.src.length) {
      // Check for closing triple quote
      if (this.peek() === quote && this.peek(1) === quote && this.peek(2) === quote) {
        this.advance(); this.advance(); this.advance(); // consume closing triple
        break;
      }
      const ch = this.peek();
      this.advance();
      if (ch === '\\') {
        const esc = this.peek();
        const resolved = ESCAPE_MAP[esc];
        if (resolved !== undefined) { this.advance(); value += resolved; }
        else { value += ch; }
      } else if (ch === '\n') {
        this.line++; this.col = 1;
        value += '\n';
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
    while (/[A-Za-z_\d]/.test(this.peek())) word += this.advance();
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
    // URL detection: http:// or https://
    if ((word === 'http' || word === 'https') && this.peek() === ':' && this.peek(1) === '/' && this.peek(2) === '/') {
      this.advance(); this.advance(); this.advance(); // consume ://
      let url = word + '://';
      // Consume URL characters — letters, digits, and URL-valid punctuation
      while (this.pos < this.src.length) {
        const c = this.peek();
        if (c === ' ' || c === '\n' || c === '' || c === '\t') break;
        // Stop at IVX syntax delimiters that can't appear in URLs
        if (c === ',' || c === ')' || c === ']' || c === '}') break;
        url += this.advance();
      }
      this.emit(T.STRING, url, startLine, startCol);
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
        // Check for triple quote
        if (this.peek(1) === ch && this.peek(2) === ch) {
          this.advance(); this.advance(); this.advance(); // consume opening triple
          this.readMultilineString(ch, sLine, sCol);
        } else {
          this.advance();
          this.readString(ch, sLine, sCol);
        }
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

// ── Arithmetic operator set (shared by parseFun and parseMake) ───────────────
const ARITH_OPS = new Set(['+','-','*','/','//','%','^']);

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
      download: () => this.parseDownload(),
      give: () => this.parseGive(),
      wait: () => this.parseWait(),
      ask:  () => this.parseExprStatement(), // ask is an expression
      post: () => this.parsePost(),
      key:  () => this.parseKey(),
      use:  () => this.parseUseImport(),
      email: () => this.parseGmail(),
      sheets:    () => this.parseExprStatement(), // sheets is an expression
      class: () => this.parseClass(),
      if:   () => this.parseIf(),
      for:  () => this.parseFor(),
      loop: () => this.parseLoop(),
      fun:  () => this.parseFun(),
      init: () => this.parseInit(),
      dot:  () => {
        const tok = this.advance();
        this.eatNewline();
        return Node('Dot', { line: tok.line });
      },
      end:  () => this.parseEnd(),
      from: () => this.parseFrom(),
      try:  () => this.parseTry(),
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
  parseKey() {
    const tok = this.advance(); // eat 'key'
    const key = this.parseExpr();
    this.eatNewline();
    return Node('Use', { key, line: tok.line, col: tok.col });
  }

  parseUseImport() {
    // bare 'use' at statement level is now reserved — kept for future use
    const tok = this.advance();
    this.eatNewline();
    return null;
  }

  _parseSavePayload(target, line, col) {
    if (this.check(T.NEWLINE) || this.check(T.EOF) || this.check(T.DEDENT)) {
      this.error("Expected value or filename after 'save'/'download'", this.peek());
      return null;
    }
    const first = this.parseExpr();
    if (!first) { this.error("Expected value or filename", this.peek()); return null; }

    // save x as report.csv  /  download x as report.csv
    if (this.checkKw('as')) {
      this.advance();
      const filenameExpr = this._parseSaveFilenameExpr();
      if (!filenameExpr) { this.error("Expected filename after 'as'", this.peek()); return null; }
      this.eatNewline();
      return Node('Save', { valueExpr: first, filenameExpr, target, line, col });
    }

    // save user.txt — identifier followed immediately by a dot extension (legacy)
    if (first.type === 'Identifier' && this.checkOp('.')) {
      const filenameExpr = this._parseBareFilename(first.name, first.line, first.col);
      if (!filenameExpr) return null;
      this.eatNewline();
      return Node('Save', { valueExpr: null, filenameExpr, target, line, col });
    }

    // save "report.txt" — lone string is the filename
    if (first.type === 'StringLit' &&
        !this.check(T.NEWLINE) && !this.check(T.EOF) && !this.check(T.DEDENT)) {
      const valueExpr = this._parseSaveFilenameExpr();
      this.eatNewline();
      return Node('Save', { valueExpr, filenameExpr: first, target, line, col });
    }
    if (first.type === 'StringLit') {
      this.eatNewline();
      return Node('Save', { valueExpr: null, filenameExpr: first, target, line, col });
    }

    // save x — auto-filename
    if (first.type === 'Identifier' &&
        (this.check(T.NEWLINE) || this.check(T.EOF) || this.check(T.DEDENT))) {
      const autoFilename = Node('StringLit', { value: first.name, line: first.line, col: first.col });
      this.eatNewline();
      return Node('Save', { valueExpr: first, filenameExpr: autoFilename, autoName: true, target, line, col });
    }

    // save x report.txt (legacy positional)
    let valueExpr = first;
    const filenameExpr = this._parseSaveFilenameExpr();
    if (!filenameExpr) { this.error("Expected filename after value in 'save'", this.peek()); return null; }
    this.eatNewline();
    return Node('Save', { valueExpr, filenameExpr, target, line, col });
  }

  // ── save x as report.csv — save to Google Drive ──────────────────────────
  parseSave() {
    const tok = this.advance(); // eat 'save'
    return this._parseSavePayload('drive', tok.line, tok.col);
  }

  // ── download x as report.csv — save to local machine ────────────────────
  parseDownload() {
    const tok = this.advance(); // eat 'download'
    return this._parseSavePayload('local', tok.line, tok.col);
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

  // ── local save — legacy syntax, prefer: download x as filename ───────────
  parseLocal() {
    const tok = this.advance(); // eat 'local'
    if (!this.checkKw('save')) {
      this.error("Expected 'save' after 'local' (prefer: download x as filename)", this.peek());
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
    // Can be a plain identifier OR a call expression like range(5)
    const targetTok = this.peek();
    let target;
    let targetExpr = null;

    if (targetTok.type === T.IDENTIFIER) {
      target = this.advance().value;
      // Check if this is a function call: for range(5) or for sorted(list)
      if (this.check(T.LPAREN)) {
        // Parse as a call expression
        const nameTok = { type: T.IDENTIFIER, value: target, line: targetTok.line, col: targetTok.col };
        targetExpr = this.parsePostfix(Node('Identifier', { name: target, line: targetTok.line, col: targetTok.col }));
        target = null; // signal that targetExpr should be used
      }
    } else {
      this.error("Expected iterable after 'for'", targetTok);
      return null;
    }

    // Optional explicit 'in' — 'for list' and 'for i in list' both valid
    let iterVar = primary, iterVar2 = secondary;
    if (target !== null && this.checkKw('in')) {
      this.advance(); // eat 'in'
      iterVar  = target;
      iterVar2 = secondary;
      const realTarget = this.peek();
      if (realTarget.type === T.IDENTIFIER) {
        target = this.advance().value;
        // Check for call after 'in' too: for i in range(5)
        if (this.check(T.LPAREN)) {
          targetExpr = this.parsePostfix(Node('Identifier', { name: target, line: realTarget.line, col: realTarget.col }));
          target = null;
        }
      } else {
        this.error("Expected iterable after 'in'", realTarget);
        return null;
      }
    }

    this.eatNewline();
    this._forDepth++;
    const body = this.parseBlock();
    this._forDepth--;

    return Node('For', {
      target, targetExpr, iterVar, iterVar2,
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
    // Each param is { name, default: Expr|null, transform: Expr|null }
    // Syntax: name          → plain param
    //         name? 100     → explicit default value
    //         name? + 1     → lazy with transform (inferred default)
    //         name * 3      → transform applied to incoming arg
    //         name? 100 * 3 → explicit default + transform
    const params = [];
    if (this.eat(T.LPAREN)) {
      while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
        const p = this.peek();
        if (p.type !== T.IDENTIFIER && p.type !== T.LAZY) {
          this.error('Expected parameter name', p); break;
        }
        const isLazy = p.type === T.LAZY;
        const paramName = this.advance().value;

        let defaultExpr = null;
        let transformOp = null;
        let transformRight = null;

        if (isLazy) {
          // name? — check for explicit default or transform
          const next = this.peek();
          if (next.type === T.OP && ARITH_OPS.has(next.value)) {
            // name? + 1  → lazy with transform, inferred default
            transformOp = this.advance().value;
            transformRight = this.parseExpr();
          } else if (next.type !== T.COMMA && next.type !== T.RPAREN && next.type !== T.EOF) {
            // name? 100  or  name? 100 * 3  → explicit default
            defaultExpr = this.parseExpr();
            // Check for trailing transform: name? 100 * 3
            const after = this.peek();
            if (after.type === T.OP && ARITH_OPS.has(after.value)) {
              transformOp = this.advance().value;
              transformRight = this.parseExpr();
            }
          }
        } else {
          // Plain name — check for transform: name * 3
          const next = this.peek();
          if (next.type === T.OP && ARITH_OPS.has(next.value)) {
            transformOp = this.advance().value;
            transformRight = this.parseExpr();
          }
        }

        params.push({ name: paramName, lazy: isLazy, defaultExpr, transformOp, transformRight });
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RPAREN, undefined, "Expected ')' after parameters");
    }

    this.eatNewline();
    // Allow empty fun body — implicit init and other bodyless funs are valid
    const body = this.check(T.INDENT) ? this.parseBlock() : [];
    return Node('Fun', { name, params, body, line: tok.line, col: tok.col });
  }

  // ── try / err ─────────────────────────────────────────────────────────────────
  // try
  //   <body>
  // err e
  //   <handler>
  parseTry() {
    const tok = this.advance(); // eat 'try'
    this.eatNewline();
    const body = this.parseBlock();

    let errVar = 'err';
    let errBody = [];

    this.skipNewlines();
    if (this.checkKw('err')) {
      this.advance(); // eat 'err'
      // Optional variable name: err e
      if (this.peek().type === T.IDENTIFIER) {
        errVar = this.advance().value;
      }
      this.eatNewline();
      errBody = this.parseBlock();
    }

    return Node('Try', { body, errVar, errBody, line: tok.line, col: tok.col });
  }

  // ── init(params) — bodyless constructor declaration ─────────────────────────
  parseInit() {
    const tok = this.advance(); // eat 'init'
    const params = [];
    if (this.eat(T.LPAREN)) {
      while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
        const p = this.peek();
        if (p.type !== T.IDENTIFIER && p.type !== T.LAZY) {
          this.error('Expected parameter name', p); break;
        }
        const isLazy = p.type === T.LAZY;
        const paramName = this.advance().value;
        let defaultExpr = null;
        let transformOp = null;
        let transformRight = null;
        if (isLazy) {
          const next = this.peek();
          if (next.type === T.OP && ARITH_OPS.has(next.value)) {
            transformOp = this.advance().value;
            transformRight = this.parseExpr();
          } else if (next.type !== T.COMMA && next.type !== T.RPAREN && next.type !== T.EOF) {
            defaultExpr = this.parseExpr();
            const after = this.peek();
            if (after.type === T.OP && ARITH_OPS.has(after.value)) {
              transformOp = this.advance().value;
              transformRight = this.parseExpr();
            }
          }
        } else {
          const next = this.peek();
          if (next.type === T.OP && ARITH_OPS.has(next.value)) {
            transformOp = this.advance().value;
            transformRight = this.parseExpr();
          }
        }
        params.push({ name: paramName, lazy: isLazy, defaultExpr, transformOp, transformRight });
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RPAREN, undefined, "Expected ')' after init params");
    }
    this.eatNewline();
    // init never has a body — implicit self-assignment handles everything
    return Node('Fun', { name: 'init', params, body: [], line: tok.line, col: tok.col });
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

  // ── from <url> [\n  use name [as alias] ...] ──────────────────────────────
  // Inline:  from https://ivxs.tech/std/math use cosine as c, sine as s
  // Block:   from https://ivxs.tech/std/math
  //            use cosine as c
  //            use sine   as s
  parseFrom() {
    const tok = this.advance(); // eat 'from'

    if (this.check(T.STRING)) {
      const urlTok = this.advance();
      const url = urlTok.value;
      const imports = []; // [{ name, alias }]

      const parseOneUse = () => {
        if (!this.checkKw('use')) return false;
        this.advance();
        if (!this.check(T.IDENTIFIER)) { this.error("Expected name after 'use'", this.peek()); return false; }
        const name = this.advance().value;
        let alias = name;
        if (this.checkKw('as')) {
          this.advance();
          if (this.check(T.IDENTIFIER)) alias = this.advance().value;
        }
        imports.push({ name, alias });
        return true;
      };

      // Inline: from URL use a [as x], b [as y]
      if (this.checkKw('use')) {
        this.advance();
        while (!this.check(T.NEWLINE) && !this.check(T.EOF)) {
          if (!this.check(T.IDENTIFIER)) break;
          const name = this.advance().value;
          let alias = name;
          if (this.checkKw('as')) { this.advance(); if (this.check(T.IDENTIFIER)) alias = this.advance().value; }
          imports.push({ name, alias });
          this.eat(T.COMMA);
        }
        this.eatNewline();
        return Node('Import', { url, imports, line: tok.line, col: tok.col });
      }

      // Block: from URL\n  use a as x\n  use b as y
      this.eatNewline();
      if (this.check(T.INDENT)) {
        this.advance();
        this.skipNewlines();
        while (!this.check(T.DEDENT) && !this.check(T.EOF)) {
          if (!parseOneUse()) { if (!this.check(T.NEWLINE) && !this.check(T.DEDENT) && !this.check(T.EOF)) this.advance(); }
          this.skipNewlines();
        }
        this.eat(T.DEDENT);
      }
      return Node('Import', { url, imports, line: tok.line, col: tok.col });
    }

    // Legacy: from Module by package
    const pathParts = [];
    let via = null;
    while (!this.check(T.NEWLINE) && !this.check(T.EOF)) {
      if (this.checkKw('by')) {
        this.advance();
        const viaParts = [];
        while (!this.check(T.NEWLINE) && !this.check(T.EOF)) viaParts.push(this.advance().value ?? '');
        via = viaParts.join(' ');
        break;
      }
      pathParts.push(this.advance().value ?? '');
    }
    this.eatNewline();
    return Node('Import', { path: pathParts.join(' '), via, imports: [], line: tok.line, col: tok.col });
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
          const arg = this._parseFunctionArg();
          if (arg) args.push(arg);
          if (!this.eat(T.COMMA)) break;
        }
        this.expect(T.RPAREN, undefined, "Expected ')' after arguments");
        // Special-case where() with dot-access predicate: where(table.col op value)
        // Rewrite at parse time into positional form: where(table, "col", "op", value)
        const callName = expr.type === 'Identifier' ? expr.name : null;
        if (callName === 'where' && args.length === 1) {
          const rewritten = this._rewriteWhereArg(args[0], lp.line);
          if (rewritten) {
            expr = Node('Call', { name: 'where', args: rewritten, line: expr.line, col: expr.col });
            continue;
          }
        }
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

    // fetch <url-expr> — explicit HTTP GET
    if (tok.type === T.KEYWORD && tok.value === 'fetch') {
      this.advance();
      const url = this.parseExpr();
      return this.parsePostfix(Node('Fetch', { url, line: tok.line, col: tok.col }));
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
      const arg = this._parseFunctionArg();
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

  // ── Parse a function call argument ────────────────────────────────────────
  // Like parseExpr but also handles unquoted Excel-style cell ranges:
  //   s.read(A1:B50)  →  s.read("A1:B50")
  //   s.read(A1)      →  s.read("A1")
  _parseFunctionArg() {
    // Check for Excel cell reference: IDENTIFIER NUMBER [COLON IDENTIFIER NUMBER]
    const a = this.peek();
    const b = this.peek(1);
    if (a.type === T.IDENTIFIER && b.type === T.NUMBER &&
        Number.isInteger(b.value) && b.value >= 0 &&
        /^[A-Za-z]+$/.test(a.value)) {
      // Peek further to see if it's a range (A1:B50) or single cell (A1)
      const c = this.peek(2);
      const d = this.peek(3);
      const e = this.peek(4);
      if (c.type === T.COLON &&
          d.type === T.IDENTIFIER && /^[A-Za-z]+$/.test(d.value) &&
          e.type === T.NUMBER && Number.isInteger(e.value) && e.value >= 0) {
        // Range: A1:B50
        this.advance(); this.advance(); this.advance(); this.advance(); this.advance();
        return Node('StringLit', {
          value: `${a.value}${b.value}:${d.value}${e.value}`,
          line: a.line, col: a.col,
        });
      }
      // Check it's followed by comma, close-paren, or end — i.e. it's a standalone cell ref
      if (c.type === T.COMMA || c.type === T.RPAREN ||
          c.type === T.NEWLINE || c.type === T.EOF) {
        this.advance(); this.advance();
        return Node('StringLit', {
          value: `${a.value}${b.value}`,
          line: a.line, col: a.col,
        });
      }
    }
    return this.parseExpr();
  }

  // ── Rewrite where(table.col op value) → [table, "col", "op", value] args ──
  // Called when where() receives exactly one argument that looks like
  // a MemberAccess (table.col) or BinOp with MemberAccess on the left.
  _rewriteWhereArg(arg, line) {
    if (!arg) return null;

    // where(table.col = "value")  — BinOp with left=MemberAccess
    if (arg.type === 'BinOp') {
      const { op, left, right } = arg;
      if (left.type === 'MemberAccess') {
        const table = left.object;
        const col   = left.field;
        return [
          table,
          Node('StringLit', { value: col, line }),
          Node('StringLit', { value: op,  line }),
          right,
        ];
      }
    }

    // where(table.col)  — MemberAccess alone (truthy filter)
    if (arg.type === 'MemberAccess') {
      const table = arg.object;
      const col   = arg.field;
      return [
        table,
        Node('StringLit', { value: col,  line }),
        Node('StringLit', { value: '!=', line }),
        Node('BoolLit',   { value: null, line }),  // != none → filter non-null
      ];
    }

    return null; // not rewritable — let it fall through to normal call
  }

  // ── List literal ───────────────────────────────────────────────────────────
  parseList() {
    const tok = this.advance(); // eat '['
    const elements = [];
    let hasRows = false;
    let currentRow = [];

    while (!this.check(T.RBRACKET) && !this.check(T.EOF)) {
      const el = this.parseExpr();
      if (el) currentRow.push(el);
      if (this.eat(T.SEMICOLON)) {
        // Row separator — this is a 2D list
        hasRows = true;
        elements.push(Node('ListLit', { elements: currentRow, line: tok.line, col: tok.col }));
        currentRow = [];
      } else if (!this.eat(T.COMMA)) {
        break;
      }
    }
    this.expect(T.RBRACKET, undefined, "Expected ']'");

    if (hasRows) {
      // Push the final row
      if (currentRow.length > 0) {
        elements.push(Node('ListLit', { elements: currentRow, line: tok.line, col: tok.col }));
      }
      return Node('ListLit', { elements, line: tok.line, col: tok.col });
    }
    return Node('ListLit', { elements: currentRow, line: tok.line, col: tok.col });
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
// All built-in function names — must match BUILTIN_DEFS in ivx-runtime.js
const BUILTIN_NAMES = new Set([
  // Type conversion
  'int','flt','str','bin','list','dict',
  // Math
  'abs','floor','ceil','round','min','max','sqrt',
  // String
  'length','size','upper','lower','trim','split','join','contains','replace',
  'starts','ends','index','slice','pad','padend','chars','repeat',
  // List
  'push','pop','keys','values','has',
  'sort','reverse','unique','flat','first','last','head','drop','zip',
  'map','filter','reduce',
  // 2D list
  'col','row','cols','rows','transpose','colnames',
  // Table
  'where','order','group','agg',
  // Date/time
  'now','time','timestamp','year','month','day','hour','minute','weekday',
  'dateadd','datediff','format',
  // Dict
  'merge','pick','omit','update','entries','fromkeys',
  // Regex
  'match','findall','search','sub','split_re',
  // Extended math
  'log','log2','log10','sin','cos','tan','asin','acos','atan','atan2',
  'pi','e','tau','inf','random','randint','roll','sign','clamp','lerp',
  'degrees','radians','gcd','lcm','isPrime',
  // Type checking
  'type','isString','isInt','isFloat','isBool','isList','isDict','isNone','isNum',
  // Misc
  'range','error',
]);

class TypeChecker {
  constructor() {
    this.errors  = [];
    this.globals = new TCEnv(null, 'global');
    // Built-in: err is always in scope as none (universal sentinel)
    this.globals.define('err', TYPE.NONE);
    // Register all built-in functions so the type checker doesn't flag them
    // Use null params to signal variadic/unknown arg count
    for (const name of BUILTIN_NAMES) {
      this.globals.fns.set(name, { params: null, returnType: TYPE.UNKNOWN });
    }

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
    for (const p of node.params) { const pn = typeof p === "string" ? p : p.name; fnEnv.define(pn, TYPE.UNKNOWN); }
    env.defFn(node.name, node.params.map(p => ({ name: typeof p === "string" ? p : p.name, type: TYPE.UNKNOWN })), TYPE.UNKNOWN);
    this.checkBlock(node.body, fnEnv);
    const retType = fnEnv._returnType ?? TYPE.UNKNOWN;
    env.defFn(node.name, node.params.map(p => { const pn = typeof p === "string" ? p : p.name; return { name: pn, type: fnEnv.lookup(pn)?.type ?? TYPE.UNKNOWN }; }), retType);
  }

  _checkClassStmt(node, env) {
    const initMethod = (node.body ?? []).find(stmt => stmt?.type === 'Fun' && stmt.name === 'init');
    env.defClass(
      node.name,
      (initMethod?.params ?? []).map(param => ({ name: typeof param === "string" ? param : param.name, type: TYPE.UNKNOWN })),
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
        if (callee.params !== null && node.args.length !== callee.params.length) {
          this.err(
            `${isClass ? 'Class' : 'Function'} '${node.name}' expects ${callee.params.length} argument(s), got ${node.args.length}`,
            node
          );
        }
        // Check argument types
        for (let i = 0; callee.params !== null && i < Math.min(node.args.length, callee.params.length); i++) {
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


