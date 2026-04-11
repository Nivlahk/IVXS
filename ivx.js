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
  'fun', 'give',
  // Data
  'make', 'del', 'take', 'say',
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
  // Implicit loop variables
  'i', 'ii', 'iii', 'j', 'jj', 'jjj', 'k', 'kk', 'kkk',
]);

// Two-character operators — must be checked before single-char ones
const TWO_CHAR_OPS = new Set(['//', '!=', '>=', '<=']);
// Single-character operators
const ONE_CHAR_OPS = new Set(['+', '-', '/', '*', '%', '^', '=', '<', '>']);

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

    // Track whether we are at the start of a logical line
    // (used to handle indentation)
    this.atLineStart = true;

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
  match(str) {
    if (this.src.startsWith(str, this.pos)) { this.pos += str.length; this.col += str.length; return true; }
    return false;
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
      switch (tok.value) {
        case 'make':  return this.parseMake();
        case 'del':   return this.parseDel();
        case 'say':   return this.parseSay();
        case 'take':  return this.parseTake();
        case 'give':  return this.parseGive();
        case 'wait':  return this.parseWait();
        case 'ask':   return this.parseExprStatement(); // ask is an expression
        case 'post':  return this.parsePost();
        case 'use':   return this.parseUse();
        case 'if':    return this.parseIf();
        case 'for':   return this.parseFor();
        case 'loop':  return this.parseLoop();
        case 'fun':   return this.parseFun();
        case 'dot':   this.advance(); this.eatNewline(); return Node('Dot', { line: tok.line });
        case 'end':   return this.parseEnd();
        case 'from':  return this.parseFrom();
        default:
          // Could be a bare keyword used as expression (e.g. 'yes', 'none')
          // or an unknown keyword — try parsing as expression statement
          return this.parseExprStatement();
      }
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
    const name = this.advance().value;

    // Check for shorthand: make x <op> <expr> where op is a binary arithmetic op
    const nextTok = this.peek();
    let expr;
    if (nextTok.type === T.OP && ['+','-','*','/','//','%','^'].includes(nextTok.value)) {
      // make x + 5  →  make x x + 5  (implied LHS is x itself)
      const impliedLeft = Node('Identifier', { name, line: tok.line, col: tok.col });
      const op = this.advance().value;
      const right = this.parseExpr();
      expr = Node('BinOp', { op, left: impliedLeft, right, line: tok.line });
    } else {
      expr = this.parseExpr();
    }

    this.eatNewline();
    return Node('Assign', { name, expr, lazy: isLazy, line: tok.line, col: tok.col });
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

  // ── wait 5  /  wait x = 5 ─────────────────────────────────────────────────
  parseWait() {
    const tok = this.advance(); // eat 'wait'
    const next = this.peek();

    // wait x = 5 — wait for a variable to equal a value
    if (next.type === T.IDENTIFIER && this.peek(1).type === T.OP && this.peek(1).value === '=') {
      const name  = this.advance().value;
      this.advance(); // eat '='
      const value = this.parseExpr();
      this.eatNewline();
      return Node('Wait', {
        expr: null,
        condition: Node('BinOp', { op: '=', left: Node('Identifier', { name }), right: value }),
        line: tok.line, col: tok.col
      });
    }

    // wait 5 — wait N cycles
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

  // ── use <key>  (global form — standalone statement) ───────────────────────
  parseUse() {
    const tok = this.advance(); // eat 'use'
    const key = this.parseExpr();
    this.eatNewline();
    return Node('Use', { key, line: tok.line, col: tok.col });
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
        // inline else — e.g. "else give x" — wrap in synthetic block
        const s = this.parseStatement();
        if (s) else_ = [s];
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

  // ── end [message] ──────────────────────────────────────────────────────────
  parseEnd() {
    const tok = this.advance(); // eat 'end'
    let message = null;
    // Consume optional message (anything until newline)
    const parts = [];
    while (!this.check(T.NEWLINE) && !this.check(T.EOF) && !this.check(T.DEDENT)) {
      parts.push(this.advance().value ?? '');
    }
    if (parts.length) message = parts.join(' ');
    this.eatNewline();
    return Node('End', { message, line: tok.line, col: tok.col });
  }

  // ── from <module> ──────────────────────────────────────────────────────────
  parseFrom() {
    const tok = this.advance(); // eat 'from'
    const parts = [];
    while (!this.check(T.NEWLINE) && !this.check(T.EOF)) {
      parts.push(this.advance().value ?? '');
    }
    this.eatNewline();
    return Node('Import', { path: parts.join(' '), line: tok.line, col: tok.col });
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

  // ── Primary expressions ────────────────────────────────────────────────────
  parsePrimary() {
    const tok = this.peek();

    // Number literal
    if (tok.type === T.NUMBER) {
      this.advance();
      return Node('NumberLit', { value: tok.value, line: tok.line, col: tok.col });
    }

    // String literal
    if (tok.type === T.STRING) {
      this.advance();
      return Node('StringLit', { value: tok.value, line: tok.line, col: tok.col });
    }

    // Boolean / none literals
    if (tok.type === T.KEYWORD && ['yes','no','none'].includes(tok.value)) {
      this.advance();
      const value = tok.value === 'yes' ? true : tok.value === 'no' ? false : null;
      return Node('BoolLit', { value, raw: tok.value, line: tok.line, col: tok.col });
    }

    // List literal [...]
    if (tok.type === T.LBRACKET) {
      return this.parseList();
    }

    // Dict literal {...}
    if (tok.type === T.LBRACE) {
      return this.parseDict();
    }

    // Grouped expression (...)
    if (tok.type === T.LPAREN) {
      this.advance();
      const expr = this.parseExpr();
      this.expect(T.RPAREN, undefined, "Expected ')'");
      return expr;
    }

    // Identifier or function call
    if (tok.type === T.IDENTIFIER) {
      this.advance();
      if (this.check(T.LPAREN)) {
        return this.parseFunCall(tok);
      }
      return Node('Identifier', { name: tok.value, line: tok.line, col: tok.col });
    }

    // Lazy declaration: name? — declare at global scope if not exists, then use
    if (tok.type === T.LAZY) {
      this.advance();
      return Node('LazyDecl', { name: tok.value, line: tok.line, col: tok.col });
    }

    // Implicit loop variables used as identifiers
    if (tok.type === T.KEYWORD && ['i','ii','iii','j','jj','jjj','k','kk','kkk'].includes(tok.value)) {
      this.advance();
      return Node('Identifier', { name: tok.value, line: tok.line, col: tok.col });
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
      return Node('Ask', { model, prompt, credential, line: tok.line, col: tok.col });
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

  // Look up a function — walks up the scope chain
  lookupFn(name) {
    if (this.fns.has(name)) return this.fns.get(name);
    return this.parent?.lookupFn(name) ?? null;
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
  }

  err(msg, node) {
    this.errors.push(new TypeError_(msg, node?.line, node?.col));
  }

  // ── Check a full program ───────────────────────────────────────────────────
  check(source) {
    const { ast, errors: parseErrors } = parse(source);
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
    switch (node.type) {

      case 'Assign': {
        const exprType = this.checkExpr(node.expr, env);
        const existing = env.lookup(node.name);
        if (existing && existing.defined && existing.type !== TYPE.NONE) {
          // Reassignment — type must be compatible
          if (!compatible(exprType, existing.type)) {
            this.err(
              `Cannot assign ${exprType} to '${node.name}' which is ${existing.type}`,
              node
            );
          } else {
            env.update(node.name, exprType);
          }
        } else {
          // New variable — infer type
          env.define(node.name, exprType);
        }
        break;
      }

      case 'Delete': {
        const existing = env.lookup(node.name);
        if (!existing) {
          this.err(`Cannot delete '${node.name}': variable not defined`, node);
        } else {
          // Mark as deleted by setting to none
          env.update(node.name, TYPE.NONE);
        }
        break;
      }

      case 'Say': {
        this.checkExpr(node.expr, env);
        break;
      }

      case 'Take': {
        // 'take' always produces a real value — mark variable as properly defined
        // The type depends on the converter: int→INTEGER, flt→FLOAT, str→STRING,
        // bin→BOOLEAN, list→LIST, dict→DICT, none→STRING (default)
        const takeTypeMap = { int: TYPE.INTEGER, flt: TYPE.FLOAT, str: TYPE.STRING,
                              bin: TYPE.BOOLEAN, list: TYPE.LIST, dict: TYPE.DICT };
        const inferredType = takeTypeMap[node.converter] ?? TYPE.STRING;
        const existing = env.lookup(node.name);
        // If variable exists and is none, it's being reset — allow any type
        // If variable doesn't exist, define it fresh
        if (!existing || existing.type === TYPE.NONE) {
          env.define(node.name, inferredType);
        } else {
          env.update(node.name, inferredType);
        }
        break;
      }

      case 'Give': {
        // 'give' inside a function — record return type on the function's env
        const exprType = this.checkExpr(node.expr, env);
        if (env._returnType !== undefined) {
          if (env._returnType === TYPE.UNKNOWN) {
            env._returnType = exprType;
          } else if (!compatible(exprType, env._returnType)) {
            this.err(
              `Inconsistent return types: ${exprType} vs ${env._returnType}`,
              node
            );
          }
        }
        break;
      }

      case 'Wait': {
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
        break;
      }

      case 'Use': {
        // use <key> — sets global credential, key must resolve to string
        this.checkExpr(node.key, env);
        break;
      }

      case 'Post': {
        // post <url> <body> [use <key>]
        this.checkExpr(node.url, env);
        this.checkExpr(node.body, env);
        if (node.credential) this.checkExpr(node.credential, env);
        break;
      }

      case 'TakeFile': {
        // take file.csv — result type depends on extension
        const fileTypeMap = { csv: TYPE.LIST, json: TYPE.DICT, txt: TYPE.STRING,
                              tsv: TYPE.LIST, xml: TYPE.STRING };
        const inferredType = fileTypeMap[node.ext] ?? TYPE.STRING;
        env.define(node.name, inferredType);
        break;
      }

      case 'If': {
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
        break;
      }

      case 'Loop': {
        const condType = this.checkExpr(node.condition, env);
        if (condType !== TYPE.BOOLEAN && condType !== TYPE.UNKNOWN) {
          this.err(`'loop' condition must be boolean, got ${condType}`, node);
        }
        const loopEnv = env.child('loop-body');
        this.checkBlock(node.body, loopEnv);
        break;
      }

      case 'For': {
        // Resolve the iterable
        const iterType = this.resolveIdentifier(node.target, env, node);
        // Define iterator variables in the loop body scope
        const forEnv = env.child('for-body');
        // i gets the element type, ii gets index (integer) for lists/strings,
        // or value for dicts. For now, both are typed loosely until runtime knows.
        const elemType = iterType === TYPE.LIST   ? TYPE.UNKNOWN
                       : iterType === TYPE.STRING ? TYPE.STRING
                       : iterType === TYPE.DICT   ? TYPE.UNKNOWN
                       : TYPE.UNKNOWN;
        forEnv.define(node.iterVar,  elemType);
        forEnv.define(node.iterVar2, iterType === TYPE.DICT ? TYPE.UNKNOWN : TYPE.INTEGER);
        this.checkBlock(node.body, forEnv);
        break;
      }

      case 'Fun': {
        // First pass: register the function signature so recursive calls work
        const fnEnv = env.child('fun-' + node.name);
        fnEnv._returnType = TYPE.UNKNOWN;
        // Params are untyped until inference — mark as UNKNOWN
        for (const p of node.params) fnEnv.define(p, TYPE.UNKNOWN);
        env.defFn(node.name, node.params.map(p => ({ name: p, type: TYPE.UNKNOWN })), TYPE.UNKNOWN);
        // Check body
        this.checkBlock(node.body, fnEnv);
        // Update function return type from what 'out' inferred
        const retType = fnEnv._returnType ?? TYPE.UNKNOWN;
        env.defFn(node.name, node.params.map(p => ({ name: p, type: fnEnv.lookup(p)?.type ?? TYPE.UNKNOWN })), retType);
        break;
      }

      case 'End':
      case 'Dot':
      case 'Import':
        break; // nothing to type-check structurally

      case 'ExprStatement':
        if (node.expr) this.checkExpr(node.expr, env);
        break;

      default:
        // Unknown statement type — skip
        break;
    }
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

      case 'Identifier':
        return this.resolveIdentifier(node.name, env, node);

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
        const fn = env.lookupFn(node.name);
        if (!fn) {
          this.err(`Undefined function '${node.name}'`, node);
          return TYPE.UNKNOWN;
        }
        // Check argument count
        if (node.args.length !== fn.params.length) {
          this.err(
            `Function '${node.name}' expects ${fn.params.length} argument(s), got ${node.args.length}`,
            node
          );
        }
        // Check argument types
        for (let i = 0; i < Math.min(node.args.length, fn.params.length); i++) {
          const argType    = this.checkExpr(node.args[i], env);
          const paramType  = fn.params[i]?.type ?? TYPE.UNKNOWN;
          if (!compatible(argType, paramType)) {
            this.err(
              `Argument ${i + 1} of '${node.name}': expected ${paramType}, got ${argType}`,
              node.args[i]
            );
          }
        }
        return fn.returnType ?? TYPE.UNKNOWN;
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
function typecheck(source) {
  const tc = new TypeChecker();
  return tc.check(source);
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
  }

  // ── Built-in functions ────────────────────────────────────────────────────
  _registerBuiltins() {
    const G = this.globals;

    // Type conversion
    G.set('int',  new IVXFunction('int',  ['x'], null, null));
    G.set('flt',  new IVXFunction('flt',  ['x'], null, null));
    G.set('str',  new IVXFunction('str',  ['x'], null, null));
    G.set('bin',  new IVXFunction('bin',  ['x'], null, null));
    G.set('list', new IVXFunction('list', ['x'], null, null));
    G.set('dict', new IVXFunction('dict', ['x'], null, null));

    // Collections
    G.set('length',  new IVXFunction('length',  ['x'], null, null));
    G.set('keys',    new IVXFunction('keys',    ['d'], null, null));
    G.set('values',  new IVXFunction('values',  ['d'], null, null));
    G.set('has',     new IVXFunction('has',     ['d', 'k'], null, null));
    G.set('push',    new IVXFunction('push',    ['list', 'val'], null, null));
    G.set('pop',     new IVXFunction('pop',     ['list'], null, null));

    // Math
    G.set('abs',     new IVXFunction('abs',     ['x'], null, null));
    G.set('floor',   new IVXFunction('floor',   ['x'], null, null));
    G.set('ceil',    new IVXFunction('ceil',    ['x'], null, null));
    G.set('round',   new IVXFunction('round',   ['x'], null, null));
    G.set('min',     new IVXFunction('min',     ['a', 'b'], null, null));
    G.set('max',     new IVXFunction('max',     ['a', 'b'], null, null));
    G.set('sqrt',    new IVXFunction('sqrt',    ['x'], null, null));

    // String
    G.set('upper',   new IVXFunction('upper',   ['s'], null, null));
    G.set('lower',   new IVXFunction('lower',   ['s'], null, null));
    G.set('trim',    new IVXFunction('trim',    ['s'], null, null));
    G.set('split',   new IVXFunction('split',   ['s', 'sep'], null, null));
    G.set('join',    new IVXFunction('join',    ['list', 'sep'], null, null));
    G.set('contains',new IVXFunction('contains',['s', 'sub'], null, null));
    G.set('replace', new IVXFunction('replace', ['s', 'from', 'to'], null, null));
  }

  // ── Call a built-in function by name ──────────────────────────────────────
  _callBuiltin(name, args, node) {
    switch (name) {
      case 'int':  return Math.trunc(Number(args[0]));
      case 'flt':  return Number(args[0]);
      case 'str':  return ivxRepr(args[0]);
      case 'bin':  return Boolean(args[0]);
      case 'list': return Array.isArray(args[0]) ? args[0] : args[0] instanceof Map ? [...args[0].values()] : [args[0]];
      case 'dict': return args[0] instanceof Map ? args[0] : new Map(Object.entries(args[0] ?? {}));
      case 'length':  {
        const v = args[0];
        if (typeof v === 'string') return v.length;
        if (Array.isArray(v))     return v.length;
        if (v instanceof Map)     return v.size;
        throw new RuntimeError(`length() requires string, list, or dict`, node?.line);
      }
      case 'keys':    return args[0] instanceof Map ? [...args[0].keys()]   : [];
      case 'values':  return args[0] instanceof Map ? [...args[0].values()] : [];
      case 'has':     return args[0] instanceof Map ? args[0].has(args[1]) : false;
      case 'push':    { if (Array.isArray(args[0])) { args[0].push(args[1]); } return args[0]; }
      case 'pop':     { if (Array.isArray(args[0])) return args[0].pop() ?? NONE; return NONE; }
      case 'abs':     return Math.abs(args[0]);
      case 'floor':   return Math.floor(args[0]);
      case 'ceil':    return Math.ceil(args[0]);
      case 'round':   return Math.round(args[0]);
      case 'min':     return Math.min(args[0], args[1]);
      case 'max':     return Math.max(args[0], args[1]);
      case 'sqrt':    return Math.sqrt(args[0]);
      case 'upper':   return String(args[0]).toUpperCase();
      case 'lower':   return String(args[0]).toLowerCase();
      case 'trim':    return String(args[0]).trim();
      case 'split':   return String(args[0]).split(args[1] ?? '');
      case 'join':    return (args[0] ?? []).join(args[1] ?? '');
      case 'contains':return String(args[0]).includes(String(args[1]));
      case 'replace': return String(args[0]).replaceAll(String(args[1]), String(args[2]));
      default: throw new RuntimeError(`Unknown built-in '${name}'`, node?.line);
    }
  }

  // ── Execute a program from source ─────────────────────────────────────────
  async run(source, options = {}) {
    // Type-check first — surface errors without running
    const { errors: typeErrors } = typecheck(source);
    if (typeErrors.length > 0 && !options.ignoreTypeErrors) {
      for (const e of typeErrors) this.onError(e);
      return;
    }

    const { ast, errors: parseErrors } = parse(source);
    if (parseErrors.length > 0) {
      for (const e of parseErrors) this.onError(e);
      return;
    }

    try {
      await this.execBlock(ast.body, this.globals);
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
        if (node.lazy && !this.globals.has(node.name)) {
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
        env.set(node.name, value);
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
          // Always store in 'response' as convenience variable
          this.globals.set('response', result);
          return result;
        } catch(e) {
          throw new RuntimeError(`post failed: ${e.message}`, node.line);
        }
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

      case 'End': {
        const msg = node.message ?? 'Program ended';
        throw new RuntimeError(msg, node.line);
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

    switch (node.type) {

      case 'NumberLit': return node.value;
      case 'StringLit': {
        let sv = node.value;
        // String interpolation: replace {varname} with value from env
        if (typeof sv === 'string' && sv.includes('{')) {
          sv = sv.replace(/\{([A-Za-z_]\w*)\}/g, (match, name) => {
            const val = env.get(name);
            if (val === undefined) return match; // leave unreplaced if not found
            return ivxRepr(val);
          });
        }
        // URL type — automatically fetch on evaluation
        if (typeof sv === 'string' && (sv.startsWith('http://') || sv.startsWith('https://'))) {
          try {
            const res = await fetch(sv);
            const ct  = res.headers.get('content-type') || '';
            if (ct.includes('application/json')) return await res.json();
            return await res.text();
          } catch(e) {
            throw new RuntimeError(`fetch failed for ${sv}: ${e.message}`, node.line);
          }
        }
        return sv;
      }
      case 'BoolLit':   return node.value; // true, false, or null (none)

      case 'Ask': {
        // ask <model> "prompt" [use key]
        // Supported models: chatgpt → OpenAI, gemini → Google, claude → Anthropic
        const prompt     = await this.evalExpr(node.prompt, env);
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
          // ── Google Gemini ──────────────────────────────────────────────────
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

          // ── OpenAI ChatGPT ─────────────────────────────────────────────────
          if (model === 'chatgpt' || model === 'gpt') {
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${credential}`,
              },
              body: JSON.stringify({
                model:    'gpt-4o-mini',
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

          // ── Anthropic Claude ───────────────────────────────────────────────
          if (model === 'claude' || model === 'anthropic') {
            const res = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type':      'application/json',
                'x-api-key':         credential,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
              },
              body: JSON.stringify({
                model:      'claude-haiku-4-5-20251001',
                max_tokens: 1024,
                messages:   [{ role: 'user', content: String(prompt) }],
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

        } catch(e) {
          if (e instanceof RuntimeError) throw e;
          throw new RuntimeError(`ask ${model} failed: ${e.message}`, node.line);
        }
      }

      case 'ListLit': {
        const elements = [];
        for (const el of node.elements) elements.push(await this.evalExpr(el, env));
        return elements;
      }

      case 'DictLit': {
        const map = new Map();
        for (const { key, value } of node.pairs) {
          const k = await this.evalExpr(key,   env);
          const v = await this.evalExpr(value, env);
          map.set(k, v);
        }
        return map;
      }

      case 'Identifier': {
        const val = env.get(node.name);
        if (val === undefined) {
          throw new RuntimeError(`Undefined variable '${node.name}'`, node.line, node.col);
        }
        return val;
      }

      case 'LazyDecl': {
        // name? — ensure variable exists at global scope, then return its value
        // Default is none unless we can infer from context (handled at BinOp level)
        if (!this.globals.has(node.name)) {
          this.globals.set(node.name, NONE);
        }
        return this.globals.get(node.name);
      }

      case 'BinOp': return await this.evalBinOp(node, env);
      case 'Post': {
        // post as expression — make response post "url" body
        const url  = await this.evalExpr(node.url,  env);
        const body = await this.evalExpr(node.body, env);
        const cred = node.credential
          ? await this.evalExpr(node.credential, env)
          : this.globals.get('__credential__') ?? null;
        const headers = { 'Content-Type': 'application/json' };
        if (cred) headers['Authorization'] = `Bearer ${cred}`;
        const res = await fetch(String(url), {
          method: 'POST', headers,
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? await res.json() : await res.text();
      }
      case 'UnaryOp': {
        const operand = await this.evalExpr(node.operand, env);
        if (node.op === 'not') return !isTruthy(operand);
        return operand;
      }

      case 'Call': return await this.evalCall(node, env);

      default: return NONE;
    }
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

    if (!(callee instanceof IVXFunction)) {
      throw new RuntimeError(`'${node.name}' is not a function`, node.line);
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
  if (value instanceof Map)     return '{' + [...value.entries()].map(([k,v]) => `${ivxRepr(k)}: ${ivxRepr(v)}`).join(', ') + '}';
  if (Array.isArray(value))     return '[' + value.map(ivxRepr).join(', ') + ']';
  return String(value);
}

// ── Public API ────────────────────────────────────────────────────────────────
function interpret(source, options = {}) {
  const interp = new Interpreter(options);
  return interp.run(source, options);
}


// ── script.js ────────────────────────────────────────────────────────────────


const NS = 'http://www.w3.org/2000/svg';
const BASEY = 40, YSTEP = 80, MAX_NODE_W = 260, PAD_X = 20, PAD_Y = 10;
const LINE_H = 14, CELL_PAD_X = 6, CELL_H = 22;
const BLOCK_GAP_Y = 28, BLOCK_PAD = 12, BLANK_LINE_THRESH = 2;

const NODE_FILL = { Decision:'#004b8d', Predictive:'#6a00a3', Function:'#92700a',
                    Start:'#007f00', End:'#7f0000', Input:'#007f00', Output:'#ED8936' };
const TYPE_FILL = { string:'#b45309', integer:'#60a5fa', float:'#14b8a6',
                    boolean:'#1e3a8a', range:'#ec4899', none:'#ef4444', list:'#6b7280', dict:'#7a4d2e' };

// State
let currentGraph, currentXSTEP = 140;
let nodePositions = new Map();
let dragOffsets   = new Map();
let blockOffsets  = new Map();
let blockState    = new Map();
let watchMap      = new Map();
let breakpoints   = new Set();
let varColorCache = new Map();

let viewBox = { x:0, y:0, width:1000, height:800 };
let graphBounds   = { x:0, y:0, width:1000, height:800 };
let isFirstRender = true;

// Interaction state
let isPanning = false, panStart = {x:0,y:0}, panMoved = false, cancelNextClick = false;
let draggedId = null, dragStartMouse = {x:0,y:0}, isDragging = false;
let draggedBlockKey = null, blockDragStart = {x:0,y:0}, isBlockDragging = false;
let loopBowSign = 1;

// Edit overlay state
let activeEdit = null, activeEditInput = null, activeEditCancel = null;
const pendingEditCtx = new Map();

// Highlight/trace state
let traceEvents = [], traceIndex = 0, traceTimer;
let edgeOverlays = [], persistentOverlays = [];
let lastHighlightedId, stepIntoBtn, stepIntoCtx, persistentEdgeMode, persistentEdge;
let isVideoPlaying = false;

let showComments = false;

const svg      = /** @type {SVGSVGElement} */ (document.getElementById('canvas'));
const miniSvg  = /** @type {SVGSVGElement} */ (document.getElementById('minimap-canvas'));

// Hidden measure node for text measurement
const _measureSvg = document.createElementNS(NS, 'svg');
_measureSvg.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:2000px;height:200px;overflow:visible;visibility:hidden;pointer-events:none;';
document.body.appendChild(_measureSvg);
const measureNode = document.createElementNS(NS, 'text');
_measureSvg.appendChild(measureNode);

// Helpers
// ── Bidirectional source sync ─────────────────────────────────────────────────
// Map from graph node kind → IVX keyword (for reconstructing source lines)
const KIND_TO_KEY = {
  Decision: 'if', Input: 'take', Output: 'say', End: 'end',
  Connector: 'dot', Function: 'fun', Start: 'from'
};

// Rewrite a single source line in-place, preserving indentation and keyword prefix.
function commitNodeEditToSource(line, newText) {
  const originalSrc = srcEl.value;
  const originalLines = originalSrc.split('\n');

  // Map preprocessed line index back to original source line index
  const prepToOrig = [];
  originalLines.forEach((origLine, origIdx) => {
    const expanded = origLine
      .replace(/then\s+/g, '\n  ')
      .replace(/\bso\s+/g, '\n')
      .replace(/;/g, '\n');
    const count = expanded.split('\n').length;
    for (let k = 0; k < count; k++) prepToOrig.push(origIdx);
  });

  const origLine = line >= 0 && line < prepToOrig.length ? prepToOrig[line] : line;
  const rawLines = originalLines;
  if (origLine < 0 || origLine >= rawLines.length) return;
  const raw = rawLines[origLine];
  line = origLine; // remap for the rest of the function
  const indent = raw.length - raw.trimStart().length;
  const prefix = raw.slice(0, indent);
  const trimmed = raw.trimStart();

  // Bug 1 fix: extract and preserve any trailing 'note ...' comment before tokenizing,
  // so it is re-appended after the new content and not silently dropped.
  let trailingNote = '';
  const noteIdx = trimmed.indexOf('note ');
  const workingTrimmed = noteIdx >= 0 ? trimmed.slice(0, noteIdx).trimEnd() : trimmed;
  if (noteIdx >= 0) trailingNote = ' ' + trimmed.slice(noteIdx);

  // Preserve any leading keyword tokens (incoming + nodeKey) and trailing outgoing token
  const tokens = workingTrimmed.split(/\s+/).filter(Boolean);
  const leadTokens = [];
  let ti = 0;
  if (ti < tokens.length && IN_KEYS.has(tokens[ti]))  { leadTokens.push(tokens[ti]); ti++; }
  if (ti < tokens.length && NODE_KEYS.has(tokens[ti])){ leadTokens.push(tokens[ti]); ti++; }
  const trailTokens = [];
  // Check last token for outgoing keyword
  const allTail = tokens.slice(ti);
  if (allTail.length > 0 && OUT_KEYS.has(allTail[allTail.length - 1])) {
    trailTokens.push(allTail.pop());
  }

  const parts = [...leadTokens, newText.trim(), ...trailTokens].filter(Boolean);
  rawLines[line] = prefix + parts.join(' ') + trailingNote;
  srcEl.value = rawLines.join('\n');
  if (typeof updateHighlight === 'function') updateHighlight();
  scheduleRender();
}

function insertNodeOnEdgeInSource(fromNodeId, toNodeId, nodeKind) {
  if (!currentGraph) return;
  const fromNode = currentGraph.nodes.find(n => n.id === fromNodeId);
  const toNode   = currentGraph.nodes.find(n => n.id === toNodeId);
  if (!fromNode || !toNode) return;

  const isImplicit = (n) => n.meta && (n.meta.includes('implicit start') || n.meta.includes('implicit end'));

  const originalSrc = srcEl.value;
  let originalLines = originalSrc.split('\n');

  const prepToOrig = [];
  const prepToSubLine = [];
  originalLines.forEach((origLine, origIdx) => {
    const expanded = origLine
      .replace(/then\s+/g, '\n  ')
      .replace(/\bso\s+/g, '\n')
      .replace(/;/g, '\n');
    const subLines = expanded.split('\n');
    subLines.forEach((_, k) => {
      prepToOrig.push(origIdx);
      prepToSubLine.push(k);
    });
  });

  const toOrigIdx = (prepLine) => {
    if (prepLine < 0) return -1;
    if (prepLine >= prepToOrig.length) return originalLines.length - 1;
    return prepToOrig[prepLine];
  };

  const parseLine = (raw) => {
    const indentSpaces = raw.length - raw.trimStart().length;
    const noteIdx = raw.indexOf('note ');
    const trimmed = (noteIdx >= 0 ? raw.slice(0, noteIdx) : raw).trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    let i = 0;
    let incoming = '';
    let nodeKey = '';
    if (i < tokens.length && IN_KEYS.has(tokens[i])) { incoming = tokens[i]; i++; }
    if (i < tokens.length && NODE_KEYS.has(tokens[i])) { nodeKey = tokens[i]; i++; }
    const rest = tokens.slice(i);
    let outgoing = '';
    if (rest.length > 0 && OUTGOING_KEYWORDS.includes(rest[rest.length - 1])) {
      outgoing = rest[rest.length - 1];
    }
    return { indentSpaces, incoming, nodeKey, outgoing };
  };

  const expandOrigLine = (raw) => {
    return raw
      .replace(/then\s+/g, '\n  ')
      .replace(/\bso\s+/g, '\n')
      .replace(/;/g, '\n')
      .split('\n');
  };

  const fromOrigIdx = isImplicit(fromNode) ? -1 : toOrigIdx(fromNode.line);
  const toOrigIndex = isImplicit(toNode)   ? originalLines.length : toOrigIdx(toNode.line);
  const fromSubLine = isImplicit(fromNode) ? 0 : prepToSubLine[fromNode.line];

  let insertAfterOrig;
  let indentSpaces = 0;
  let inheritedOutgoing = '';
  let spliceAt;

  if (isImplicit(fromNode)) {
    spliceAt = 0;
  } else if (isImplicit(toNode)) {
    const fromRaw = originalLines[fromOrigIdx];
    const fp = parseLine(fromRaw);
    indentSpaces = fp.indentSpaces;
    if (fp.outgoing === 'prev' || fp.outgoing === 'next') {
      inheritedOutgoing = fp.outgoing;
      originalLines[fromOrigIdx] = fromRaw.replace(/\s+(prev|next)\s*$/, '');
    }
    spliceAt = originalLines.length;
  } else if (fromOrigIdx === toOrigIndex) {
    // fromNode and toNode on the same original line — expand it first
    const origRaw = originalLines[fromOrigIdx];
    const subLines = expandOrigLine(origRaw);
    originalLines.splice(fromOrigIdx, 1, ...subLines);
    spliceAt = fromOrigIdx + fromSubLine + 1;
    const fromSubRaw = subLines[fromSubLine];
    const fp = parseLine(fromSubRaw);
    indentSpaces = fp.indentSpaces;
    if (fp.outgoing === 'prev' || fp.outgoing === 'next') {
      inheritedOutgoing = fp.outgoing;
      originalLines[fromOrigIdx + fromSubLine] = fromSubRaw.replace(/\s+(prev|next)\s*$/, '');
    }
  } else {
    insertAfterOrig = fromOrigIdx;
    const fromRaw = originalLines[fromOrigIdx];
    const fp = parseLine(fromRaw);
    indentSpaces = fp.indentSpaces;
    if (fp.outgoing === 'prev' || fp.outgoing === 'next') {
      inheritedOutgoing = fp.outgoing;
      originalLines[fromOrigIdx] = fromRaw.replace(/\s+(prev|next)\s*$/, '');
    }
    if (toOrigIndex >= 0 && toOrigIndex < originalLines.length) {
      const toParsed = parseLine(originalLines[toOrigIndex]);
      if (toParsed.incoming === 'else') {
        indentSpaces = toParsed.indentSpaces;
        insertAfterOrig = toOrigIndex - 1;
        inheritedOutgoing = '';
      }
    }
    spliceAt = insertAfterOrig + 1;
  }

  const prefix = ' '.repeat(indentSpaces);
  const keyword = KIND_TO_KEY[nodeKind] || '';
  const placeholder = nodeKind === 'End' ? '' : 'new node';
  const outgoingSuffix = inheritedOutgoing ? ' ' + inheritedOutgoing : '';
  const newLine = keyword
    ? `${prefix}${keyword}${placeholder ? ' ' + placeholder : ''}${outgoingSuffix}`
    : `${prefix}${placeholder}${outgoingSuffix}`;

  originalLines.splice(spliceAt, 0, newLine);
  srcEl.value = originalLines.join('\n');
  _pendingInsertEditLine = spliceAt;
  if (typeof updateHighlight === 'function') updateHighlight();
  scheduleRender();
}

const sendMsg = (msg) => {
  if (msg.type === 'commitNodeEdit') {
    commitNodeEditToSource(msg.line, msg.newText);
  } else if (msg.type === 'insertNodeOnEdge') {
    insertNodeOnEdgeInSource(msg.fromNodeId, msg.toNodeId, msg.nodeKind);
  }
};

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
};
const title = (e, t) => { if (t) { const n = el('title'); n.textContent = t; e.appendChild(n); } };
const snap  = (v, s) => Math.round(v / s) * s;
const fwd   = (a, b) => b.line !== a.line ? b.line > a.line : b.segmentIndex >= a.segmentIndex;

const measureText = (s, size = 12) => {
  measureNode.setAttribute('font-size', String(size));
  measureNode.textContent = s || '';
  const _l=measureNode.getComputedTextLength();
  return _l>0?_l:(s||'').length*size*0.6;
};

function wrapText(text, maxW, fontSize = 12) {
  const lines = [];
  for (const rawLine of String(text).split(/\n/)) {
    let line = '';
    for (const w of rawLine.split(/\s+/).filter(Boolean)) {
      const test = line ? line + ' ' + w : w;
      if (measureText(test, fontSize) > maxW && line) { lines.push(line); line = w; }
      else line = test;
    }
    lines.push(line);
  }
  return lines;
}

const classifyValue = raw => {
  const t = String(raw).trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return 'string';
  if (/^-?\d+$/.test(t))             return 'integer';
  if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(t)) return 'float';
  if (/^(true|false)$/i.test(t))     return 'boolean';
  if (/^none$/i.test(t))             return 'none';
  if (/^range\s*\(/.test(t))         return 'range';
  if (/^\[/.test(t))                 return 'list';
  if (/^\{/.test(t))                 return 'dict';
  return 'other';
};

const normType = raw => {
  const b = String(raw).trim().toLowerCase().replace(/[^a-z]/g,'');
  return ({int:'integer',str:'string',bool:'boolean'})[b]
    || (['integer','string','boolean','float','list','dict','range','none'].includes(b) ? b : '');
};

const normVar = raw => (String(raw ?? '').match(/^([A-Za-z_]\w*)/) || [])[1] || '';

const numericType = expr => {
  const s = String(expr);
  if (/\bfloat\s*\(/.test(s) || /\d+\.\d+/.test(s) || /\//.test(s)) return 'float';
  if (/\bint\s*\(/.test(s)   || /\d+/.test(s)       || /[+\-*%]/.test(s)) return 'integer';
  return '';
};

const extractComment = meta => {
  if (!meta) return '';
  // Only extract comments that start with 'note '
  const m = String(meta).match(/note (.*)/);
  return m ? m[1].trim() : '';
};

const fmtDecision = text => {
  const parts = String(text).split(/\s+(and|or)\s+/i).filter(Boolean);
  if (parts.length <= 1) return text;
  const lines = [parts[0]];
  for (let i = 1; i < parts.length; i += 2) lines.push(`${parts[i]||''} ${parts[i+1]||''}`.trim());
  return lines.join('\n');
};

// CSV split that respects brackets and quotes
function smartSplit(str, delim) {
  const parts = []; let cur = '', depth = 0, inS = false, inD = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i], esc = i > 0 && str[i-1] === '\\';
    if      (c === '"' && !esc && !inS) inD = !inD;
    else if (c === "'" && !esc && !inD) inS = !inS;
    else if (!inS && !inD) {
      if (c === '[') depth++;
      else if (c === ']') depth--;
    }
    if (c === delim && !depth && !inS && !inD) { parts.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur) parts.push(cur);
  return parts.map(s => s.trim()).filter(Boolean);
}

// ─── Label rendering ──────────────────────────────────────────────────────────
function createLabel(text, cx, cy, maxW, tooltip, parent = svg, colorMap = null, fontSize = 12, lineH = LINE_H, fill = '#eee') {
  const textEl = el('text', { 'text-anchor':'middle', 'dominant-baseline':'middle', 'font-size':fontSize }, parent);
  if (fill !== '#eee') textEl.style.fill = fill;
  title(textEl, tooltip);
  const lines  = wrapText(text, maxW, fontSize);
  const startY = cy - (lineH * lines.length) / 2 + lineH / 2;

  lines.forEach((line, i) => {
    const y = startY + i * lineH;
    if (!colorMap) {
      const ts = el('tspan', { x: cx, y }, textEl);
      ts.dataset.lineY = String(y);
      ts.textContent = line;
    } else {
      const re = /\w+/g; let last = 0, m, isFirst = true;
      const parts = [];
      while ((m = re.exec(line))) {
        if (m.index > last) parts.push({ t: line.slice(last, m.index), c: '' });
        parts.push({ t: m[0], c: colorMap.get(m[0]) || '' });
        last = m.index + m[0].length;
      }
      if (last < line.length) parts.push({ t: line.slice(last), c: '' });
      parts.forEach(p => {
        const ts = el('tspan', isFirst ? { x: cx, y } : {}, textEl);
        if (isFirst) { ts.dataset.lineY = String(y); isFirst = false; }
        ts.textContent = p.t;
        if (p.c) ts.style.fill = p.c;
      });
    }
  });
  return { textEl, bbox: textEl.getBBox() };
}

const shiftTextY = (textEl, delta) => {
  if (!delta) return;
  for (const ts of textEl.childNodes) {
    const b = ts.dataset?.lineY;
    if (b != null) ts.setAttribute('y', String(Number(b) + delta));
  }
};

// ─── Block bookkeeping ────────────────────────────────────────────────────────
// Stable key = sorted node IDs joined – survives re-renders
const blockKey = group => [...group].sort((a,b)=>a-b).join(',');

function getOrCreateBlockState(key) {
  if (!blockState.has(key)) blockState.set(key, { collapsed: false });
  return blockState.get(key);
}

// ─── Layout ───────────────────────────────────────────────────────────────────
function buildAdj(graph) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const childOf = new Map(), parentOf = new Map();
  for (const e of graph.edges) {
    (childOf.get(e.from) ?? (childOf.set(e.from,[]), childOf.get(e.from))).push(e);
    (parentOf.get(e.to)  ?? (parentOf.set(e.to,[]),  parentOf.get(e.to))).push(e);
  }
  return { byId, childOf, parentOf };
}

function propagate(map, parentOf, cond) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, parents] of parentOf) {
      if (map.has(id) || parents.length !== 1) continue;
      const v = cond(id, parents[0].from, map.get(parents[0].from));
      if (v !== undefined) { map.set(id, v); changed = true; }
    }
  }
}

function computeBranchInfo(graph, byId, childOf, parentOf) {
  const branchIdx = new Map(), decOf = new Map();
  for (const node of graph.nodes) {
    if (node.kind !== 'Decision') continue;
    (childOf.get(node.id) || [])
      .slice().sort((a,b) => {
        const na = byId.get(a.to), nb = byId.get(b.to);
        if (!na || !nb) return a.to - b.to;
        return na.line !== nb.line ? na.line - nb.line
             : na.segmentIndex !== nb.segmentIndex ? na.segmentIndex - nb.segmentIndex
             : na.id - nb.id;
      })
      .forEach((e, i) => { branchIdx.set(e.to, i); decOf.set(e.to, node.id); });
  }
  propagate(branchIdx, parentOf, (id, pid, pv) => pv);
  propagate(decOf,     parentOf, (id, pid, pv) => pv);
  return { branchIdx, decOf };
}

function computeLayering(graph, byId) {
  const depth = new Map(graph.nodes.map(n => [n.id, (n.kind==='Start'||n.kind==='Function') ? 0 : Infinity]));
  const fwdEdges = graph.edges.filter(e => { const a=byId.get(e.from),b=byId.get(e.to); return a&&b&&fwd(a,b); });
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (const e of fwdEdges) {
      const fd = depth.get(e.from), td = depth.get(e.to);
      if (fd!=null&&td!=null&&fd+1<td&&byId.get(e.to)?.kind!=='Function') { depth.set(e.to,fd+1); changed=true; }
    }
    if (!changed) break;
  }
  let fallback = Math.max(...[...depth.values()].filter(isFinite)) + 1;
  graph.nodes.slice()
    .sort((a,b) => a.line!==b.line ? a.line-b.line : a.segmentIndex!==b.segmentIndex ? a.segmentIndex-b.segmentIndex : a.id-b.id)
    .forEach(n => {
      if (n.kind==='Function') depth.set(n.id, 0);
      else if (!isFinite(depth.get(n.id))) depth.set(n.id, fallback++);
    });
  return depth;
}

function computeLayout(graph) {
  const { byId, childOf, parentOf } = buildAdj(graph);
  const { branchIdx, decOf } = computeBranchInfo(graph, byId, childOf, parentOf);
  const depthMap = computeLayering(graph, byId);
  const XSTEP = Math.max(100, Math.min(180,
    Math.max(80, ...graph.nodes.map(n => Math.min(measureText(n.text||n.kind)+PAD_X*2, MAX_NODE_W))) + 40));
  currentXSTEP = XSTEP;

  const centerX0 = snap(500, XSTEP);
  const positions = new Map();
  let fnOffset = XSTEP * 4;

  for (const node of graph.nodes) {
    const depth = isFinite(depthMap.get(node.id)) ? depthMap.get(node.id) : 0;
    const isFn = node.kind === 'Function';
    const cx = isFn ? centerX0 + fnOffset : centerX0;
    if (isFn) fnOffset += XSTEP * 3;
    positions.set(node.id, { id:node.id, kind:node.kind, centerX:cx, centerY:BASEY+depth*YSTEP, x:cx, y:BASEY+depth*YSTEP, width:0, height:0 });
  }

  // Function body column alignment
  const fnXMap = new Map();
  for (const n of graph.nodes) if (n.kind==='Function') fnXMap.set(n.id, positions.get(n.id).centerX);
  for (const n of graph.nodes) {
    const m = n.meta?.match(/fun-body-of=(\d+)/);
    if (m && !n.meta?.includes('fun-call-inline')) {
      const p = positions.get(n.id), fnX = fnXMap.get(parseInt(m[1],10));
      if (fnX!=null && p) p.centerX = fnX;
    }
  }

  // 'from' Start nodes: place one XSTEP to the left of their merge connector,
  // at the same Y so the incoming edge reads left-to-right.
  for (const n of graph.nodes) {
    const m = n.meta?.match(/from-offset-of=(\d+)/);
    if (!m) continue;
    const connPos = positions.get(parseInt(m[1], 10));
    const fromPos = positions.get(n.id);
    if (connPos && fromPos) {
      fromPos.centerX = fromPos.x = connPos.centerX - XSTEP;
      fromPos.centerY = fromPos.y = connPos.centerY;
    }
  }

  // Branch X offsets
  const branchesPerDec = new Map();
  for (const n of graph.nodes) if (n.kind==='Decision') branchesPerDec.set(n.id, new Set());
  branchIdx.forEach((idx, nid) => { const d=decOf.get(nid); if (d!=null) branchesPerDec.get(d)?.add(idx); });
  branchIdx.forEach((idx, nid) => {
    const dId = decOf.get(nid), pos = positions.get(nid);
    if (!dId || !pos) return;
    const n = Math.max(...branchesPerDec.get(dId)) + 1;
    const slot = n%2===1 ? idx-(n-1)/2 : idx-n/2+0.5;
    pos.centerX = pos.x = snap((positions.get(dId)?.centerX ?? centerX0) + slot*XSTEP, XSTEP);
  });

  // Connector centering
  for (const node of graph.nodes) {
    if (node.kind!=='Connector' && node.kind!=='NextConnector') continue;
    const pos = positions.get(node.id), parents = parentOf.get(node.id)||[];
    if (!pos || !parents.length) continue;
    const decs = new Set(parents.map(e => decOf.get(e.from)).filter(v=>v!=null));
    if (decs.size!==1) continue;
    const xs = parents.map(e=>positions.get(e.from)?.centerX).filter(v=>v!=null);
    if (xs.length) pos.centerX = pos.x = snap((Math.min(...xs)+Math.max(...xs))/2, XSTEP);
  }

  // Collision resolution
  const byY = new Map();
  for (const pos of positions.values())
    (byY.get(pos.centerY) ?? (byY.set(pos.centerY,[]), byY.get(pos.centerY))).push(pos);
  for (const group of byY.values()) {
    if (group.length < 2) continue;
    const seen = new Map();
    for (const p of group) (seen.get(p.centerX) ?? (seen.set(p.centerX,[]), seen.get(p.centerX))).push(p);
    for (const dupes of seen.values()) {
      if (dupes.length < 2) continue;
      dupes.sort((a,b)=>a.id-b.id);
      const mid = (dupes.length-1)/2;
      dupes.forEach((p,i) => {
        const slot = i-mid;
        p.centerX = p.x = snap(p.centerX + (slot!==0 ? slot*XSTEP : (p.centerX>=centerX0?1:-1)*XSTEP), XSTEP);
      });
    }
  }

  // ── Block grouping ────────────────────────────────────────────────────────
  // Determine ownerKey per node
  const ownerOf = new Map();
  for (const n of graph.nodes) {
    const m = n.meta?.match(/fun-body-of=(\d+)/);
    ownerOf.set(n.id, m ? parseInt(m[1],10) : null);
  }

  // Bucket all nodes by owner.
  // Group function header node and its body into a single block keyed by function id.
  const buckets = new Map();
  for (const n of graph.nodes) {
    let key = null;
    if (n.kind === 'Function') {
      key = n.id;
    } else {
      const own = ownerOf.get(n.id) ?? null;
      if (own !== null) key = own;
    }
    (buckets.get(key) ?? (buckets.set(key,[]), buckets.get(key))).push(n);
  }

  // Split into groups; compute stable keys
  const segmentLines = new Set((graph.segments || []).map(s => s.physicalLine));
  const hasSegments = segmentLines.size > 0;
  const blankCountBetween = (a, b) => {
    if (!hasSegments) return Math.max(0, b - a - 1);
    let blanks = 0;
    for (let l = a + 1; l < b; l++) if (!segmentLines.has(l)) blanks++;
    return blanks;
  };
  const layoutBlocks = [];
  for (const [ownerKey, nodes] of buckets) {
    nodes.sort((a,b) => a.line!==b.line ? a.line-b.line : a.segmentIndex!==b.segmentIndex ? a.segmentIndex-b.segmentIndex : a.id-b.id);
    const splitAfter = new Set();
    for (let i=0; i<nodes.length-1; i++)
      if (blankCountBetween(nodes[i].line, nodes[i+1].line) >= BLANK_LINE_THRESH) splitAfter.add(nodes[i].id);
   
    let cur = new Set();
    for (const node of nodes) {
      cur.add(node.id);
      if (splitAfter.has(node.id)) { layoutBlocks.push({ ownerKey, group:cur }); cur=new Set(); }
    }
    if (cur.size) layoutBlocks.push({ ownerKey, group:cur });
  }

  // Apply vertical gaps per owner; build block boxes; FIX: shift applied AFTER box is measured
  const shiftByOwner = new Map();
  const blockBoxes = [];
  for (const blk of layoutBlocks) {
    const { ownerKey, group } = blk;
    const key = blockKey(group);
    const state = getOrCreateBlockState(key);
    const shift = shiftByOwner.get(ownerKey) ?? 0;

    // Apply cumulative shift from PREVIOUS blocks
    if (shift) {
      for (const id of group) {
        const p = positions.get(id);
        if (p) { p.centerY += shift; p.y = p.centerY - (p.height||0)/2; }
      }
    }

    // Measure bounding box AFTER shift
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for (const id of group) {
      const p = positions.get(id); if (!p) continue;
      const hw=(p.width||80)/2, hh=(p.height||30)/2;
      minX=Math.min(minX,p.centerX-hw); maxX=Math.max(maxX,p.centerX+hw);
      minY=Math.min(minY,p.centerY-hh); maxY=Math.max(maxY,p.centerY+hh);
    }
    if (!isFinite(minX)) continue;

    blockBoxes.push({ key, collapsed:state.collapsed, ownerKey, minX,maxX,minY,maxY, group });
    shiftByOwner.set(ownerKey, shift + BLOCK_GAP_Y);
  }

  nodePositions = positions;
  return { positions, blockBoxes, parentOf, branchIdx, decOf };
}

// ─── Hidden node computation ──────────────────────────────────────────────────
function computeHidden(graph, blockBoxes) {
  const hidden = new Set();
  // Layout-block collapse only
  for (const box of blockBoxes)
    if (box.collapsed) for (const id of box.group) hidden.add(id);
  return { hidden };
}

// ─── Block collapse: vertical compaction ─────────────────────────────────────
function applyCollapseShift(blockBoxes, positions) {
  const byOwner = new Map();
  for (const box of blockBoxes)
    (byOwner.get(box.ownerKey) ?? (byOwner.set(box.ownerKey,[]), byOwner.get(box.ownerKey))).push(box);
  for (const blocks of byOwner.values()) {
    blocks.sort((a,b)=>a.minY-b.minY);
    let removed = 0;
    for (const box of blocks) {
      if (removed) {
        for (const id of box.group) {
          const p = positions.get(id);
          if (p) { p.centerY -= removed; p.y = p.centerY - (p.height||0)/2; }
        }
      }
      if (box.collapsed) removed += (box.maxY - box.minY) + BLOCK_PAD*2;
    }
  }
}

// ─── Node shape factory ───────────────────────────────────────────────────────
function makeShape(node, cx, cy, w, h, x, y) {
  const isRet = node.kind==='Process' && node.meta?.includes('return-node');
  if (['Start','End','Function'].includes(node.kind) || isRet)
    return el('ellipse', {cx,cy,rx:w/2,ry:h/2});
  if (node.kind==='Decision')
    return el('polygon', { points:[[cx,cy-h/2],[cx+w/2,cy],[cx,cy+h/2],[cx-w/2,cy]].map(p=>p.join(',')).join(' ') });
  if (node.kind==='Input' || node.kind==='Output') {
    const s = w*0.125;
    return el('polygon', { points:[[x,y],[x+w-s,y],[x+w,y+h],[x+s,y+h]].map(p=>p.join(',')).join(' ') });
  }
  return el('rect', {x,y,width:w,height:h,rx:4,ry:4});
}

// ─── Variable color map ───────────────────────────────────────────────────────
function buildVarColorMap(graph) {
  const map = new Map();
  for (const node of graph.nodes) {
    // Param colors from function headers
    if (node.kind==='Function' || node.meta?.includes('fun-header')) {
      for (const [k,v] of buildParamColors(node.text||'', node.id, graph.nodes)) map.set(k,v);
    }
    if (!node.title) continue;
    const varName = normVar(node.title);
    if (!varName) continue;
    const meta = node.meta||'';
    let typeKey = node.meta?.match(/\btype=(\w+)\b/)?.[1] || '';
    if (!typeKey) typeKey = /\blist\b/.test(meta) ? 'list' : /\bdict\b/.test(meta) ? 'dict' : classifyValue(node.text||'');
    if (typeKey==='other') typeKey = numericType(node.text||'');
    const color = TYPE_FILL[typeKey];
    if (color) map.set(varName, color);
  }
  return map;
}

function buildParamColors(funText, headerId, nodes) {
  const map = new Map();
  const m = String(funText).match(/^[^(]*\(([^)]*)\)/);
  if (!m) return map;
  for (const raw of m[1].split(',').map(p=>p.trim()).filter(Boolean)) {
    const base = raw.replace(/^\*+/,'').trim();
    const [namePart, typePart] = base.split(':');
    if (!namePart) continue;
    const name = namePart.split('=')[0].trim();
    let typeName = typePart ? normType(typePart.split('=')[0]) : '';
    if (!typeName && headerId!=null) {
      for (const node of nodes) {
        if (!node?.meta?.includes(`fun-body-of=${headerId}`) || node.title!==name) continue;
        const tm = node.meta?.match(/\btype=(\w+)\b/);
        typeName = normType(tm?.[1]??'') || numericType(node.text||'');
        if (typeName) break;
      }
    }
    const color = TYPE_FILL[typeName];
    if (name && color) map.set(name, color);
  }
  return map;
}

// ─── Render table nodes (list/dict) ──────────────────────────────────────────
function renderTableNode(node, pos, cx, cy, kind) {
  const raw = node.text.trim().replace(/^[\[{]/,'').replace(/[\]}]$/,'');
  const parts = smartSplit(raw,',');
  const rows = kind==='list'
    ? [parts]
    : [parts.map(p=>smartSplit(p,':')[0]?.trim()??''), parts.map(p=>smartSplit(p,':').slice(1).join(':').trim())];
  const cols = Math.max(...rows.map(r=>r.length));
  let colWs = Array.from({length:cols}, (_,c) => Math.max(...rows.map(r=>measureText(String(r[c]??''))+2*CELL_PAD_X), 40));
  let totalW = colWs.reduce((a,b)=>a+b,0);
  const BASE_W = MAX_NODE_W/3;
  if (totalW <= BASE_W) { colWs = colWs.map(w=>w*(BASE_W/totalW)); totalW = BASE_W; }
  const totalH = rows.length*CELL_H, x0=cx-totalW/2, y0=cy-totalH/2;
  const g = el('g',{},svg);
  const bg = el('rect',{x:x0,y:y0,width:totalW,height:totalH,rx:4,ry:4,fill:TYPE_FILL[kind]||'#5C563F',stroke:'#ccc','stroke-width':1.5},g);
  title(bg, extractComment(node.meta)); bg.dataset.nodeId = node.id;
  let curY=y0;
  for (const row of rows) {
    let curX=x0;
    for (let c=0;c<row.length;c++) {
      el('rect',{x:curX,y:curY,width:colWs[c],height:CELL_H,fill:'none',stroke:'#ddd','stroke-width':0.5},g);
      if (row[c]) {
        const t = el('text',{x:curX+colWs[c]/2,y:curY+CELL_H/2+3,'text-anchor':'middle','dominant-baseline':'middle','font-size':12,fill:'#e6e6e6'},g);
        t.textContent=row[c]; t.dataset.nodeId=node.id;
      }
      curX+=colWs[c];
    }
    curY+=CELL_H;
  }
  Object.assign(pos, {x:x0,y:y0,width:totalW,height:totalH,edgeTop:y0,edgeBottom:y0+totalH});
}

// ─── Render nodes ─────────────────────────────────────────────────────────────
function renderNodes(graph, positions, hidden) {
  const vcMap = buildVarColorMap(graph);
  varColorCache = vcMap;
  const funFooterOf = new Map();
  for (const n of graph.nodes) {
    const m = n.meta?.match(/fun-footer-of=(\d+)/);
    if (m) funFooterOf.set(parseInt(m[1],10), n.id);
  }

  for (const node of graph.nodes) {
    if (hidden.has(node.id)) continue;
    const pos = positions.get(node.id);
    if (!pos) continue;
    const { centerX:cx, centerY:cy } = pos;

    // Connector dots
    if (node.kind==='Connector' || node.kind==='NextConnector') {
      const r=6, fill=node.kind==='Connector'?'#bbb':'#00bfff';
      const c = el('circle',{cx,cy,r,fill,stroke:'#ccc','stroke-width':1.5},svg);
      title(c, extractComment(node.meta)); c.dataset.nodeId=node.id; c.style.cursor='text';
      Object.assign(pos,{x:cx-r,y:cy-r,width:r*2,height:r*2,edgeTop:cy-r,edgeBottom:cy+r});
      continue;
    }

    const raw = node.text.trim();
    const meta = node.meta||'';
    if (/\blist\b/.test(meta)) { renderTableNode(node,pos,cx,cy,'list'); continue; }
    if (/\bdict\b/.test(meta)) { renderTableNode(node,pos,cx,cy,'dict'); continue; }

    // Strictly match 'fun' as the first token only
    const isFun = (node.kind==='Process'||node.kind==='Function') && /^fun(\s|$)/.test(raw);
    const isFunCall = node.kind==='Process' && /^[A-Za-z_]\w*\s*\(/.test(raw);
    const isElse = node.kind==='Process' && raw.startsWith('else');
    let bodyLabel = isElse ? raw.slice(5).trim() : isFun ? raw.replace(/^fun(\s|$)/,'').trim() : raw||node.kind;
    if (node.kind==='Decision') bodyLabel = fmtDecision(bodyLabel);

    const isFunHeader = node.kind==='Function' || meta.includes('fun-header');
    let labelText = bodyLabel;
    if (isFunHeader) {
      const m2 = bodyLabel.match(/^([^(]+)\(([^)]*)\)\s*$/);
      if (m2) labelText = `${m2[1].trim()}\n(${m2[2].trim()})`;
    }
    const labelMap = isFunHeader ? new Map([...vcMap, ...buildParamColors(raw,node.id,graph.nodes)]) : vcMap;

    const g = el('g',{},svg);
    const tooltip = extractComment(meta);
    const { textEl:bodyTxt, bbox:bodyBB } = createLabel(labelText,cx,cy,MAX_NODE_W-PAD_X*2,tooltip,g,labelMap);
    let bw = Math.max(bodyBB.width+PAD_X*2, 60);
    let bh = Math.max(bodyBB.height+PAD_Y*2, 30);

    if (showComments) {
      const cmtText = extractComment(meta);
      if (cmtText) {
        const { textEl:cmtEl, bbox:cmtBB } = createLabel(cmtText,cx,cy,MAX_NODE_W-PAD_X*2,tooltip,g,null,11,12,'#4ade80');
        const gap=6, totalH=bodyBB.height+gap+cmtBB.height;
        shiftTextY(bodyTxt, cy - totalH/2 + bodyBB.height/2 - cy);
        shiftTextY(cmtEl,   cy - totalH/2 + bodyBB.height + gap + cmtBB.height/2 - cy);
        bw = Math.max(Math.max(bodyBB.width,cmtBB.width)+PAD_X*2, 60);
        bh = Math.max(totalH+PAD_Y*2, 30);
        cmtEl.dataset.nodeId = node.id; cmtEl.style.cursor='text';
      }
    }

    let edgeTop = cy-bh/2;
    if (node.title) {
      const { textEl:hTxt, bbox:hBB } = createLabel(node.title,cx,cy-bh/2-10,MAX_NODE_W-PAD_X*2,tooltip,g);
      const hw=Math.max(hBB.width+PAD_X/2,40), hh2=Math.max(hBB.height+4,18);
      const hy = cy-bh/2+6-hh2;
      for (const ts of hTxt.childNodes) ts.setAttribute('y', String(Number(ts.getAttribute('y')||0)+(hy+hh2/2)-(cy-bh/2-10)));
      const titleColor = (normVar(node.title)&&vcMap.get(normVar(node.title)))||TYPE_FILL[classifyValue(bodyLabel)]||'#222831';
      const hRect = el('rect',{x:cx-hw/2,y:hy,width:hw,height:hh2,rx:4,ry:4,fill:titleColor,stroke:'#ccc','stroke-width':1});
      g.insertBefore(hRect, hTxt); hTxt.dataset.nodeId=node.id; hTxt.style.cursor='text';
      edgeTop = Math.min(edgeTop, hy);
    }

    const shape = makeShape(node,cx,cy,bw,bh,cx-bw/2,cy-bh/2);
    const isImport = node.kind==='Process' && /^(import|from)\b/.test(raw);
    shape.setAttribute('fill', isImport?'#007f00':(NODE_FILL[node.kind]||(isFun||isFunCall?'#92700a':'#333')));
    if (breakpoints.has(node.id)) {
      shape.setAttribute('stroke','#ff4444');
      shape.setAttribute('stroke-width','3');
    } else {
      shape.setAttribute('stroke','#ccc');
      shape.setAttribute('stroke-width','1.5');
    }
    title(shape,tooltip);
    shape.dataset.nodeId = node.id; shape.style.cursor='text';
    bodyTxt.dataset.nodeId = node.id; bodyTxt.style.cursor='text';
    g.insertBefore(shape, bodyTxt);
    Object.assign(pos,{x:cx-bw/2,y:cy-bh/2,width:bw,height:bh,edgeTop,edgeBottom:cy+bh/2});

    if (watchMap.has(node.id)) {
      const wt = el('text',{x:cx+bw/2+12,y:cy,'text-anchor':'start','dominant-baseline':'middle','font-size':12},g);
      wt.style.fill='#888'; wt.style.fontStyle='italic'; wt.textContent=watchMap.get(node.id);
    }
  }
  return funFooterOf;
}

// ─── Block backgrounds ────────────────────────────────────────────────────────
function renderBlockBg(blockBoxes, positions) {
  const HEADER_H = 18, BTN = 10, CLEARANCE = 4;
  for (const box of blockBoxes) {
    const { key, minX, maxX, minY, maxY } = box;
    const x = minX - BLOCK_PAD, w = (maxX-minX)+BLOCK_PAD*2;
    const headerY = minY - HEADER_H - CLEARANCE;
    const contentH = (maxY - minY) + BLOCK_PAD;

    // All block chrome goes in one group tagged for back-insertion
    const g = el('g', {'data-block-bg':'1'}, svg);

    el('rect',{x,y:headerY,width:w,height:HEADER_H+CLEARANCE+contentH,rx:8,ry:8,
      fill:'rgba(255,255,255,0.025)',stroke:'rgba(255,255,255,0.07)','stroke-width':1,
      style:'pointer-events:none;'},g);

    el('rect',{x,y:headerY,width:w,height:HEADER_H,rx:5,ry:5,
      fill:'rgba(40,40,70,0.9)',stroke:'rgba(255,255,255,0.07)','stroke-width':1,'data-block-key':key,style:'cursor:grab'},g);

    const lbl = el('text',{x:x+8,y:headerY+HEADER_H-5,'text-anchor':'start','font-size':10,fill:'#9ca3af'},g);
    lbl.textContent=`Block ${key.split(',')[0]}…`;
  }
}

// ─── Edges ────────────────────────────────────────────────────────────────────
function edgeClearance(x1,y1,x2,y2,positions,fromId,toId,hidden) {
  const MARGIN=16, dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy);
  if (!len) return 0;
  const ux=dx/len, uy=dy/len, midX=(x1+x2)/2;
  let sum=0, cnt=0;
  for (const [id,pos] of positions) {
    if (id===fromId||id===toId||hidden.has(id)||!pos.width||!pos.height) continue;
    const t=Math.max(0,Math.min(1,((pos.centerX-x1)*ux+(pos.centerY-y1)*uy)/len));
    const px=x1+t*ux*len, py=y1+t*uy*len;
    if (Math.abs(pos.centerX-px)<pos.width/2+MARGIN && Math.abs(pos.centerY-py)<pos.height/2+MARGIN)
      { sum+=pos.centerX-midX; cnt++; }
  }
  return cnt ? sum/cnt : 0;
}

function drawEdge(x1,y1,x2,y2,label,bow=0,fromId,toId) {
  const midX=(x1+x2)/2, midY=(y1+y2)/2;
  const nat = 0.3*(x2-x1);
  const avoid = bow ? -Math.sign(bow)*Math.abs(currentXSTEP*1.5) : 0;
  let loop = 0;
  if (y2<y1 && Math.abs(nat+avoid)<currentXSTEP*0.5) { loop=loopBowSign*currentXSTEP*1.5; loopBowSign*=-1; }
  const cpX = midX+nat+avoid+loop;
  const color = label==='true'?'#4ade80':label==='false'?'#f87171':'#aaa';
  const eA = fromId!=null ? {'data-edge-from':fromId,'data-edge-to':toId} : {};
  const d = `M ${x1} ${y1} Q ${cpX} ${midY} ${x2} ${y2}`;
  if (fromId!=null) el('path',{d,fill:'none',stroke:'transparent','stroke-width':12,style:'cursor:pointer;',...eA},svg);
  el('path',{d,fill:'none',stroke:color,'stroke-width':1.5,style:'pointer-events:none;',...eA},svg);
  const ang=Math.atan2(y2-midY,x2-cpX), AS=6;
  el('polygon',{points:[[x2,y2],[x2-AS*Math.cos(ang-Math.PI/6),y2-AS*Math.sin(ang-Math.PI/6)],[x2-AS*Math.cos(ang+Math.PI/6),y2-AS*Math.sin(ang+Math.PI/6)]].map(p=>p.join(',')).join(' '),fill:color,style:'pointer-events:none;',...eA},svg);
  if (label && label!=='break' && label!=='continue') {
    const t = el('text',{x:midX+avoid*0.5,y:midY-5,'text-anchor':'middle',fill:color,style:'pointer-events:none;'},svg);
    t.textContent=label;
  }
}

function renderEdges(graph, positions, hidden, extra=[], blockBoxes=[]) {
  const nodeBlock = new Map();
  for (const box of blockBoxes) for (const id of box.group) nodeBlock.set(id,box);
  loopBowSign = 1;
  for (const e of [...graph.edges,...extra]) {
    if (hidden.has(e.from)||hidden.has(e.to)) continue;
    const bF=nodeBlock.get(e.from), bT=nodeBlock.get(e.to);
    if (bF && bF===bT && bF.collapsed) continue;
    const fp=positions.get(e.from), tp=positions.get(e.to);
    if (!fp||!tp) continue;
    const x1=fp.centerX, y1=fp.edgeBottom??(fp.centerY+fp.height/2);
    const x2=tp.centerX, y2=tp.edgeTop??(tp.centerY-tp.height/2);
    drawEdge(x1,y1,x2,y2,e.label,edgeClearance(x1,y1,x2,y2,positions,e.from,e.to,hidden),e.from,e.to);
  }
}

// FIX: try-error brackets computed before edges, not after
function renderTryBrackets(graph, positions, hidden) {
  for (const tryNode of graph.nodes.filter(n=>n.meta?.includes('try-block'))) {
    const m = tryNode.meta?.match(/try-body=\[([^\]]*)\]/);
    if (!m) continue;
    const ids = m[1].split(',').map(id=>parseInt(id.trim(),10)).filter(id=>!isNaN(id)&&!hidden.has(id));
    if (!ids.length) continue;
    const fp=positions.get(ids[0]), lp=positions.get(ids[ids.length-1]);
    if (!fp||!lp) continue;

    // Reposition error handler BEFORE edges are drawn
    const errHandler = graph.nodes.find(n=>n.meta?.includes(`error-handler-of=${tryNode.id}`));
    if (errHandler) {
      const ep = positions.get(errHandler.id);
      if (ep) {
        ep.centerX=ep.x=fp.centerX-currentXSTEP*0.7-currentXSTEP*0.8;
        ep.centerY=ep.y=(fp.centerY+lp.centerY)/2;
      }
    }

    const bx=fp.centerX-currentXSTEP*0.7, top=fp.centerY, bot=lp.centerY;
    el('path',{d:`M ${bx+15} ${top} L ${bx} ${top} L ${bx} ${bot} L ${bx+15} ${bot}`,fill:'none',stroke:'#f59e0b','stroke-width':2,style:'pointer-events:none;'},svg);
    createLabel('try',bx-20,top,60,null,svg,null,11,12,'#f59e0b');
  }
}

// ─── Main render ──────────────────────────────────────────────────────────────
function renderGraph(graph) {
  currentGraph = graph;
  svg.textContent = '';

  const { positions, blockBoxes } = computeLayout(graph);

  // FIX: compute hidden BEFORE renderNodes so collapsed nodes are skipped
  const { hidden } = computeHidden(graph, blockBoxes);

  // Apply drag offsets to nodes
  for (const [id, off] of dragOffsets) {
    const p = positions.get(id);
    if (p) { p.centerX+=off.x; p.centerY+=off.y; p.x=p.centerX-p.width/2; p.y=p.centerY-p.height/2; }
  }

  // Apply block offsets to nodes within those blocks
  for (const box of blockBoxes) {
    const blockOff = blockOffsets.get(box.key);
    if (blockOff) {
      for (const nodeId of box.group) {
        const p = positions.get(nodeId);
        if (p) { p.centerX+=blockOff.x; p.centerY+=blockOff.y; p.x=p.centerX-p.width/2; p.y=p.centerY-p.height/2; }
      }
    }
  }

  // Collapse vertical compaction (shift visible nodes up past hidden blocks)
  applyCollapseShift(blockBoxes, positions);
  nodePositions = positions;

  // FIX: render try brackets BEFORE edges so error handler positions are correct
  renderTryBrackets(graph, positions, hidden);

  const funFooterOf = renderNodes(graph, positions, hidden);

  // Block backgrounds drawn AFTER renderNodes so real node sizes (width/height) are known.
  // Recompute minX/maxX/minY/maxY from actual rendered positions before drawing.
  for (const box of blockBoxes) {
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for (const id of box.group) {
      const p = positions.get(id); if (!p || !p.width) continue;
      // use edgeTop if set (accounts for title badges above the shape)
      const top = p.edgeTop ?? p.y;
      minX=Math.min(minX,p.x);      maxX=Math.max(maxX,p.x+p.width);
      minY=Math.min(minY,top);      maxY=Math.max(maxY,p.y+p.height);
    }
    if (isFinite(minX)) { box.minX=minX; box.maxX=maxX; box.minY=minY; box.maxY=maxY; }
  }
  renderBlockBg(blockBoxes, positions);
  // Push the full-bg rects AND header rects to back so they sit behind nodes.
  // We mark them with a data attribute in renderBlockBg to make selection reliable.
  const bgEls = Array.from(svg.querySelectorAll('[data-block-bg]'));
  for (const r of bgEls) svg.insertBefore(r, svg.firstChild);

  renderEdges(graph, positions, hidden, [], blockBoxes);

  let bbox;try{bbox=svg.getBBox();}catch(e){bbox={x:0,y:0,width:800,height:600};}if(!bbox||(!bbox.width&&!bbox.height))bbox={x:0,y:0,width:800,height:600};const pad=80;
  graphBounds={x:bbox.x-pad,y:bbox.y-pad,width:bbox.width+pad*2,height:bbox.height+pad*2};
  if (isFirstRender) { viewBox={...graphBounds}; isFirstRender=false; }
  applyVB(); renderMinimap();

  if (lastHighlightedId!=null) {
    for (const e of svg.querySelectorAll(`[data-node-id="${lastHighlightedId}"]`))
      { e.dataset.highlight='true'; styleHL(e,true); }
    updateStepIntoBtn(lastHighlightedId);
  }
  redrawPersistentEdge();
}

const applyVB = () => svg.setAttribute('viewBox',`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);

// ─── Zoom / Pan ───────────────────────────────────────────────────────────────
function zoom(factor, cx, cy) {
  const ow=viewBox.width, oh=viewBox.height;
  viewBox.width*=factor; viewBox.height*=factor;
  const mn=Math.min(graphBounds.width,graphBounds.height)*0.05, mx=Math.max(graphBounds.width,graphBounds.height)*2;
  viewBox.width=Math.min(Math.max(viewBox.width,mn),mx);
  viewBox.height=viewBox.width*(svg.clientHeight/svg.clientWidth);
  if (cx!=null) {
    viewBox.x-=(viewBox.width-ow)*((cx-viewBox.x)/ow-0.5);
    viewBox.y-=(viewBox.height-oh)*((cy-viewBox.y)/oh-0.5);
  } else { viewBox.x+=(ow-viewBox.width)/2; viewBox.y+=(oh-viewBox.height)/2; }
  applyVB(); renderMinimap();
}
const pan = (dx,dy) => { viewBox.x-=dx; viewBox.y-=dy; applyVB(); renderMinimap(); };
const fitScreen = () => { viewBox={...graphBounds}; applyVB(); renderMinimap(); };

svg.addEventListener('wheel', e => {
  e.preventDefault();
  const r=svg.getBoundingClientRect();
  zoom(e.deltaY>0?1.1:0.9, viewBox.x+(e.clientX-r.left)/r.width*viewBox.width, viewBox.y+(e.clientY-r.top)/r.height*viewBox.height);
}, {passive:false});

svg.addEventListener('mousedown', e => {
  if (e.button!==0) return;
  const shape = e.target?.closest?.('ellipse,polygon,rect,circle');
  const edgePath = e.target?.closest?.('path[data-edge-from]');

  if (edgePath) {
    const from=parseInt(edgePath.getAttribute('data-edge-from')||'-1',10);
    const to  =parseInt(edgePath.getAttribute('data-edge-to')  ||'-1',10);
    if (from>-1&&to>-1) { showEdgeMenu(e,from,to); e.preventDefault(); return; }
  }

  // Check for block header drag
  const blockHeader = e.target?.getAttribute?.('data-block-key');
  if (blockHeader) {
    draggedBlockKey = blockHeader;
    blockDragStart = {x:e.clientX, y:e.clientY};
    isBlockDragging = false;
    e.preventDefault();
    return;
  }

  if (shape?.dataset.nodeId) {
    if (e.target?.tagName?.toLowerCase()==='text') return;
    draggedId=parseInt(shape.dataset.nodeId,10);
    const pos=nodePositions.get(draggedId);
    if (!pos) { draggedId=null; return; }
    dragStartMouse={x:e.clientX,y:e.clientY};
    isDragging=false; e.preventDefault(); return;
  }

  if (!e.target?.getAttribute?.('data-node-id') && !e.target?.closest?.('[data-node-id]')) {
    isPanning=true; svg.classList.add('panning');
    panStart={x:e.clientX,y:e.clientY}; panMoved=false; e.preventDefault();
  }
});

svg.addEventListener('contextmenu', e => {
  const shape = e.target?.closest?.('ellipse,polygon,rect,circle');
  if (shape?.dataset.nodeId) {
    const nodeId = parseInt(shape.dataset.nodeId, 10);
    if (breakpoints.has(nodeId)) {
      breakpoints.delete(nodeId);
    } else {
      breakpoints.add(nodeId);
    }
    renderGraph(currentGraph);
    e.preventDefault();
  }
});

window.addEventListener('mousemove', e => {
  const r=svg.getBoundingClientRect();
  if (draggedBlockKey!==null) {
    const dx=e.clientX-blockDragStart.x, dy=e.clientY-blockDragStart.y;
    if (!isBlockDragging && Math.hypot(dx,dy)<3) return;
    isBlockDragging=true; cancelNextClick=true;
    blockOffsets.set(draggedBlockKey,{x:dx*viewBox.width/r.width, y:dy*viewBox.height/r.height});
    renderGraph(currentGraph); return;
  }
  if (draggedId!==null) {
    const dx=e.clientX-dragStartMouse.x, dy=e.clientY-dragStartMouse.y;
    if (!isDragging && Math.hypot(dx,dy)<3) return;
    isDragging=true; cancelNextClick=true;
    dragOffsets.set(draggedId,{x:dx*viewBox.width/r.width, y:dy*viewBox.height/r.height});
    renderGraph(currentGraph); return;
  }
  if (!isPanning) return;
  if (!panMoved && Math.hypot(e.clientX-panStart.x,e.clientY-panStart.y)>3) { panMoved=true; activeEditCancel?.(); }
  pan((e.clientX-panStart.x)*viewBox.width/r.width, (e.clientY-panStart.y)*viewBox.height/r.height);
  panStart={x:e.clientX,y:e.clientY};
});

window.addEventListener('mouseup', () => {
  if (isPanning && panMoved) cancelNextClick=true;
  isPanning=false; svg.classList.remove('panning');
  // FIX: only set cancelNextClick if we actually dragged, then clear drag state
  if (isDragging) cancelNextClick=true;
  if (isBlockDragging) cancelNextClick=true;
  draggedId=null; isDragging=false;
  draggedBlockKey=null; isBlockDragging=false;
});

// ─── Minimap ──────────────────────────────────────────────────────────────────
function renderMinimap() {
  miniSvg.textContent='';
  if (!currentGraph) return;
  miniSvg.setAttribute('viewBox',`${graphBounds.x} ${graphBounds.y} ${graphBounds.width} ${graphBounds.height}`);
  for (const pos of nodePositions.values())
    if (pos.width) el('rect',{x:pos.x,y:pos.y,width:pos.width,height:pos.height,fill:'#555',stroke:'none'},miniSvg);
  el('rect',{class:'vp',x:viewBox.x,y:viewBox.y,width:viewBox.width,height:viewBox.height},miniSvg);
}
miniSvg.addEventListener('click', e => {
  const r=miniSvg.getBoundingClientRect();
  viewBox.x=graphBounds.x+(e.clientX-r.left)/r.width*graphBounds.width-viewBox.width/2;
  viewBox.y=graphBounds.y+(e.clientY-r.top)/r.height*graphBounds.height-viewBox.height/2;
  applyVB(); renderMinimap();
});

// ─── Edge insert menu ─────────────────────────────────────────────────────────
function showEdgeMenu(e, fromId, toId) {
  const menu = Object.assign(document.createElement('div'), {
    style:`position:fixed;left:${e.clientX}px;top:${e.clientY}px;background:#1e1e2e;border:1px solid #3a3a5c;border-radius:8px;padding:0;box-shadow:0 4px 16px rgba(0,0,0,.7);z-index:10000;font:12px system-ui;min-width:140px;overflow:hidden`
  });
  const header = Object.assign(document.createElement('div'), {
    textContent: 'Insert node',
    style: 'padding:6px 12px;color:#6b7280;font-size:10px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #2a2a3e;background:#16161f'
  });
  menu.appendChild(header);
  const insertOptions = [
    { kind:'Process',   label:'Process',   key:'' },
    { kind:'Decision',  label:'if — Decision', key:'if' },
    { kind:'Input',     label:'take — Input',  key:'take' },
    { kind:'Output',    label:'say — Output', key:'say' },
    { kind:'Connector', label:'dot — Connector', key:'dot' },
    { kind:'End',       label:'end — End',   key:'end' },
  ];
  for (const opt of insertOptions) {
    const item = Object.assign(document.createElement('div'), {
      style:'padding:7px 14px;color:#cdd6f4;cursor:pointer;white-space:nowrap;user-select:none;display:flex;align-items:center;gap:8px'
    });
    if (opt.key) {
      const badge = Object.assign(document.createElement('span'), {
        textContent: opt.key,
        style:'font-family:monospace;font-size:10px;background:#2a2a3e;color:#89b4fa;padding:1px 5px;border-radius:3px;flex-shrink:0'
      });
      item.appendChild(badge);
    }
    item.appendChild(document.createTextNode(opt.key ? opt.label.split('—')[1].trim() : 'Process'));
    item.onmouseenter=()=>item.style.background='#313145';
    item.onmouseleave=()=>item.style.background='';
    item.onclick=()=>{ sendMsg({type:'insertNodeOnEdge',fromNodeId:fromId,toNodeId:toId,nodeKind:opt.kind}); menu.remove(); };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  // Ensure menu stays on screen
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth)  menu.style.left = (e.clientX - r.width) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = (e.clientY - r.height) + 'px';
  setTimeout(()=>document.addEventListener('mousedown',function h(ev){ if(!menu.contains(ev.target)){menu.remove();document.removeEventListener('mousedown',h);} }),0);
}

// ─── Node click / edit ────────────────────────────────────────────────────────
svg.addEventListener('click', e => {
  // FIX: reset cancelNextClick atomically so one stale flag can't eat two events
  if (cancelNextClick) { cancelNextClick=false; return; }
  let el2=e.target;
  while (el2 && el2!==svg) {
    const id=el2.dataset?.nodeId;
    if (id!=null) {
      const nodeId=parseInt(id,10), node=currentGraph?.nodes.find(n=>n.id===nodeId);
      const pos=nodePositions.get(nodeId);
      if (!node||!pos) return;
      if (el2.tagName.toLowerCase()==='text' && el2.getBBox) {
        const bb=el2.getBBox(), s=window.getComputedStyle(el2);
        pendingEditCtx.set(nodeId,{textBox:{x:bb.x,y:bb.y,width:bb.width,height:bb.height},
          fontSize:s.fontSize||'12px',lineHeight:s.lineHeight||'14px',
          fontFamily:s.fontFamily||'system-ui, sans-serif',textAnchor:el2.getAttribute('text-anchor')||'middle'});
      } else pendingEditCtx.delete(nodeId);
      highlightNode(nodeId, null);
      return;
    }
    el2=el2.parentElement;
  }
});

// Double-click a node to edit its label inline and sync back to source
svg.addEventListener('dblclick', e => {
  if (cancelNextClick) return;
  let el2 = e.target;
  while (el2 && el2 !== svg) {
    const id = el2.dataset?.nodeId;
    if (id != null) {
      e.preventDefault();
      const nodeId = parseInt(id, 10);
      const node = currentGraph?.nodes.find(n => n.id === nodeId);
      const pos = nodePositions.get(nodeId);
      if (!node || !pos) return;
      // Capture text box from the text element if available
      const textEl = svg.querySelector(`[data-node-id="${nodeId}"]`);
      if (textEl?.tagName?.toLowerCase() === 'text' && textEl.getBBox) {
        const bb = textEl.getBBox(), s = window.getComputedStyle(textEl);
        pendingEditCtx.set(nodeId, {
          textBox: {x:bb.x, y:bb.y, width:bb.width, height:bb.height},
          fontSize: s.fontSize||'12px', lineHeight: s.lineHeight||'14px',
          fontFamily: s.fontFamily||'system-ui, sans-serif',
          textAnchor: textEl.getAttribute('text-anchor')||'middle'
        });
      }
      startNodeEdit({nodeId, text: node.text||'', x: pos.x, y: pos.y,
        width: pos.width, height: pos.height,
        line: node.line, segmentIndex: node.segmentIndex||0});
      return;
    }
    el2 = el2.parentElement;
  }
});

function startNodeEdit({ nodeId, text, x, y, width, height, line, segmentIndex }) {
  const ctx = nodeId!=null ? pendingEditCtx.get(Number(nodeId)) : null;
  if (nodeId!=null) pendingEditCtx.delete(Number(nodeId));
  const hideText = h => svg.querySelectorAll(`[data-node-id="${nodeId}"]`).forEach(el3=>{ if(el3.tagName.toLowerCase()==='text') el3.style.opacity=h?'0':''; });
  const cleanup = commit => {
    if (!activeEdit) return;
    if (commit) sendMsg({type:'commitNodeEdit',nodeId,newText:activeEditInput.value,line,segmentIndex});
    activeEdit.remove(); activeEdit=activeEditInput=activeEditCancel=null; hideText(false);
  };
  if (activeEdit) cleanup(false);
  hideText(true);
  const box = ctx?.textBox?.width>8&&ctx?.textBox?.height>8 ? ctx.textBox : {x,y,width,height};
  const fo = el('foreignObject',{x:box.x,y:box.y,width:box.width,height:box.height},svg);
  const div = document.createElement('div');
  Object.assign(div.style,{width:'100%',height:'100%',display:'flex',alignItems:'center',justifyContent:'center',background:'transparent'});
  const inp = document.createElement('input');
  inp.type='text'; inp.value=text;
  Object.assign(inp.style,{width:'100%',background:'transparent',color:'#eee',border:'none',outline:'none',padding:'0',margin:'0',
    textAlign:ctx?.textAnchor==='start'?'left':ctx?.textAnchor==='end'?'right':'center',
    fontFamily:ctx?.fontFamily||'system-ui, sans-serif',fontSize:ctx?.fontSize||'12px',
    lineHeight:ctx?.lineHeight||'14px',height:'100%',boxSizing:'border-box'});
  inp.addEventListener('keydown', e=>{ if(e.key==='Enter') cleanup(true); else if(e.key==='Escape') cleanup(false); });
  inp.addEventListener('blur', ()=>cleanup(false));
  div.appendChild(inp); fo.appendChild(div);
  activeEdit=fo; activeEditInput=inp; activeEditCancel=()=>cleanup(false);
  inp.focus(); inp.select();
}

function startNodeEditByLine({ line, text }) {
  if (!currentGraph) return;
  const node=currentGraph.nodes.find(n=>n.line===line); if (!node) return;
  const pos=nodePositions.get(node.id); if (!pos) return;
  const textEl=svg.querySelector(`text[data-node-id="${node.id}"]`);
  if (textEl?.getBBox) {
    const bb=textEl.getBBox(), s=window.getComputedStyle(textEl);
    pendingEditCtx.set(node.id,{textBox:{x:bb.x,y:bb.y,width:bb.width,height:bb.height},
      fontSize:s.fontSize||'12px',lineHeight:s.lineHeight||'14px',
      fontFamily:s.fontFamily||'system-ui',textAnchor:textEl.getAttribute('text-anchor')||'middle'});
  }
  startNodeEdit({nodeId:node.id,text:text||node.text||'',x:pos.x,y:pos.y,width:pos.width,height:pos.height,line,segmentIndex:node.segmentIndex||0});
}

// ─── Highlight / trace ────────────────────────────────────────────────────────
const styleHL = (el4, on) => {
  if (el4.tagName.toLowerCase()==='text') el4.style.fill=on?'#fffb66':'';
  else { el4.setAttribute('stroke',on?'#ffd54f':'#ccc'); el4.setAttribute('stroke-width',on?'3':'1.5'); el4.style.filter=on?'drop-shadow(0 0 8px #ffd54f)':''; }
};
function clearHL() {
  for (const e of svg.querySelectorAll('[data-highlight="true"]')) { e.removeAttribute('data-highlight'); styleHL(e,false); }
  for (const e of edgeOverlays) e.remove();
  edgeOverlays=[]; lastHighlightedId=null;
  if (stepIntoBtn) stepIntoBtn.style.display='none';
}
const clearPersistent = () => { for (const e of persistentOverlays) e.remove(); persistentOverlays=[]; persistentEdgeMode=persistentEdge=null; };

function flowEdge(x1,y1,x2,y2,target,color) {
  const mid=(x1+x2)/2, midY=(y1+y2)/2, cpX=mid+0.4*(x2-x1)+currentXSTEP*0.8;
  const d=`M ${x1} ${y1} Q ${cpX} ${midY} ${x2} ${y2}`;
  target.push(el('path',{d,fill:'none',stroke:color,'stroke-width':6,'stroke-opacity':.25,'stroke-linecap':'round'},svg));
  const f1=el('path',{d,fill:'none',stroke:color,'stroke-width':2.5,'stroke-dasharray':'10 8','stroke-linecap':'butt'},svg);
  f1.classList.add('flow-a'); target.push(f1);
  const f2=el('path',{d,fill:'none',stroke:color,'stroke-width':2.5,'stroke-dasharray':'2 16','stroke-linecap':'round','stroke-opacity':.85},svg);
  f2.classList.add('flow-b'); target.push(f2);
}

function highlightEdge(fromId, toId) {
  const path=svg.querySelector(`path[data-edge-from="${fromId}"][data-edge-to="${toId}"]`);
  if (!path) return;
  const d=path.getAttribute('d');
  edgeOverlays.push(el('path',{d,fill:'none',stroke:'#ffd54f','stroke-width':7,'stroke-opacity':.2,'stroke-linecap':'round'},svg));
  const f1=el('path',{d,fill:'none',stroke:'#ffd54f','stroke-width':2.5,'stroke-dasharray':'10 8','stroke-linecap':'butt'},svg);
  f1.classList.add('flow-a'); edgeOverlays.push(f1);
  const f2=el('path',{d,fill:'none',stroke:'#ffd54f','stroke-width':2.5,'stroke-dasharray':'2 16','stroke-linecap':'round','stroke-opacity':.85},svg);
  f2.classList.add('flow-b'); edgeOverlays.push(f2);
}

function drawVirtualEdge(fromId, toId, target=edgeOverlays, color='#c084fc') {
  const fp=nodePositions.get(fromId), tp=nodePositions.get(toId);
  if (fp&&tp) flowEdge(fp.centerX,fp.centerY+fp.height/2,tp.centerX,tp.centerY-tp.height/2,target,color);
}
const drawPersistentEdge = (f,t,c='#c084fc') => { clearPersistent(); drawVirtualEdge(f,t,persistentOverlays,c); persistentEdge={fromId:f,toId:t,color:c}; };
const redrawPersistentEdge = () => { if (!persistentEdge) return; for(const e of persistentOverlays) e.remove(); persistentOverlays=[]; drawVirtualEdge(persistentEdge.fromId,persistentEdge.toId,persistentOverlays,persistentEdge.color); };

const getFunCallTarget = id => { const m=currentGraph?.nodes.find(n=>n.id===id)?.meta?.match(/fun-call:(\d+)/); return m?parseInt(m[1],10):null; };
const getFunBodyHeader = n => { const m=n?.meta?.match(/fun-body-of=(\d+)/); return m?parseInt(m[1],10):null; };
const isFunExit = (node, hId) => {
  if (!node || getFunBodyHeader(node)!==hId) return false;
  if (node.meta?.includes('return-node')||node.text.trim().startsWith('return')) return true;
  return !currentGraph.edges.some(e=>e.from===node.id && getFunBodyHeader(currentGraph.nodes.find(n=>n.id===e.to))===hId);
};

function highlightNode(nodeId, nextId) {
  if (nodeId==null||nodeId===-1) {
    svg.style.transition='opacity .25s ease-out'; svg.style.opacity='.45';
    setTimeout(()=>{ clearHL(); svg.style.opacity='1'; svg.style.transition='opacity .2s ease-in'; },260);
    return;
  }
  clearHL(); lastHighlightedId=nodeId;
  for (const e of svg.querySelectorAll(`[data-node-id="${nodeId}"]`)) { e.dataset.highlight='true'; styleHL(e,true); }
  if (nextId!=null&&nextId!==-1) highlightEdge(nodeId,nextId);
  updateStepIntoBtn(nodeId);
  if (stepIntoCtx) {
    const node=currentGraph?.nodes.find(n=>n.id===nodeId);
    if (isFunExit(node,stepIntoCtx.headerNodeId)) { drawPersistentEdge(nodeId,stepIntoCtx.fromNodeId); persistentEdgeMode='return'; }
  }
  const pos=nodePositions.get(nodeId);
  if (pos) { viewBox.x=(pos.centerX??pos.x+pos.width/2)-viewBox.width/2; viewBox.y=(pos.centerY??pos.y+pos.height/2)-viewBox.height/2; applyVB(); renderMinimap(); }
}
const updateStepIntoBtn = id => { if(stepIntoBtn) stepIntoBtn.style.display=getFunCallTarget(id)!=null?'':'none'; };

// ─── Trace ────────────────────────────────────────────────────────────────────
const stopTrace = () => { clearTimeout(traceTimer); traceTimer=null; traceEvents=[]; traceIndex=0; };
function playNext() {
  if (traceIndex>=traceEvents.length) {
    if (isVideoPlaying) {
      isVideoPlaying = false;
      updateVideoButton();
    }
    return;
  }
  const speed=Number(speedSel.value)||1, ev=traceEvents[traceIndex++], nxt=traceIndex<traceEvents.length?traceEvents[traceIndex]:null;
  highlightNode(ev.nodeId, nxt?.nodeId??null);
  
  // Check if we hit a breakpoint
  if (breakpoints.has(ev.nodeId)) {
    if (isVideoPlaying) {
      isVideoPlaying = false;
      updateVideoButton();
      sendMsg({type:'seedExecFromVideo',nodeId:ev.nodeId});
    }
    return;
  }
  
  if (traceIndex<traceEvents.length) traceTimer=setTimeout(playNext, Math.max(10,(((nxt?.ts||0)-(ev.ts||0))||100)/speed));
  else if (isVideoPlaying) {
    isVideoPlaying = false;
    updateVideoButton();
  }
}
const startTrace = events => { stopTrace(); traceEvents=events.slice(); traceIndex=0; playNext(); };

// ─── Message handler ──────────────────────────────────────────────────────────
window.addEventListener('message', ({data:msg}) => {
  if (!msg) return;
  switch (msg.type) {
    case 'graph':             
      // FIX: clear drag offsets when a new graph arrives to avoid phantom offsets
      dragOffsets.clear(); blockOffsets.clear(); renderGraph(msg.graph); break;
    case 'startNodeEdit':     startNodeEdit(msg); break;
    case 'startNodeEditByLine': startNodeEditByLine(msg); break;
    case 'highlight':         highlightNode(msg.nodeId); break;
    case 'clearHighlights':   clearHL(); break;
    case 'stepAdvance':       { const pm=persistentEdgeMode; clearPersistent(); if(pm==='return') stepIntoCtx=null; break; }
    case 'trace':             if (msg.events && msg.events.length > 0) { isVideoPlaying=true; updateVideoButton(); } startTrace(msg.events||[]); break;
    case 'traceClear':        stopTrace(); isVideoPlaying=false; updateVideoButton(); break;
    case 'watchUpdate':       watchMap.clear(); (msg.items||[]).forEach(i=>watchMap.set(i.nodeId,i.text)); if(currentGraph) renderGraph(currentGraph); break;
    case 'watchClear':        watchMap.clear(); if(currentGraph) renderGraph(currentGraph); break;
    case 'stepIntoResult':    stepIntoCtx={fromNodeId:msg.fromNodeId,headerNodeId:msg.headerNodeId}; drawPersistentEdge(msg.fromNodeId,msg.headerNodeId); persistentEdgeMode='call'; setTimeout(()=>highlightNode(msg.headerNodeId),120); break;
  }
});

// ─── Controls ─────────────────────────────────────────────────────────────────
const ctrlRoot = document.getElementById('controls');
const mkBtn = (label, fn, style='') => {
  const b=Object.assign(document.createElement('button'),{textContent:label});
  if (style) b.style.cssText=style;
  if (typeof fn === 'function') b.addEventListener('click',fn);
  return b;
};

const speedSel = document.createElement('select');
for (const s of [0.25,0.5,1,1.5,2]) {
  const o=Object.assign(document.createElement('option'),{value:String(s),textContent:`${s}x`});
  if (s===1) o.selected=true; speedSel.appendChild(o);
}

const postStepNext = () => {
  if (persistentEdgeMode==='return'&&stepIntoCtx?.fromNodeId!=null)
    sendMsg({type:'stepNext',stepOutFrom:stepIntoCtx.fromNodeId});
  else sendMsg({type:'stepNext'});
};

let autoTimer;
const stopAuto = () => { clearTimeout(autoTimer); autoTimer=null; };
const startAuto = () => {
  stopAuto();
  const tick=()=>{ postStepNext(); autoTimer=setTimeout(tick, 300/(Number(speedSel.value)||1)); };
  tick();
};

let playVideoBtn;
const updateVideoButton = () => {
  if (isVideoPlaying) {
    playVideoBtn.textContent = '⏹';
    playVideoBtn.style.cssText = 'background:#6b2b2b;border-color:#f87171;color:#f87171';
  } else {
    playVideoBtn.textContent = '▶';
    playVideoBtn.style.cssText = 'background:#1f4d6e;border-color:#60a5fa;color:#60a5fa';
  }
};

const toggleVideoDebug = () => {
  if (isVideoPlaying) {
    isVideoPlaying = false;
    updateVideoButton();
    stopAuto();
    stopTrace();
    sendMsg({type:'traceClear'});
  } else {
    sendMsg({type:'playVideoDebug'});
  }
};

const sep = () => Object.assign(document.createElement('span'),{textContent:'|',style:'color:#555;margin:0 4px'});
ctrlRoot.append(
  mkBtn('<',()=>sendMsg({type:'stepPrev'})), mkBtn('Play',startAuto), mkBtn('Pause',()=>{ stopAuto(); stopTrace(); sendMsg({type:'traceClear'}); }), mkBtn('>',postStepNext)
);

stepIntoBtn = mkBtn('⤵', ()=>{ const t=getFunCallTarget(lastHighlightedId); if(t!=null) sendMsg({type:'stepInto',fromNodeId:lastHighlightedId,headerNodeId:t}); }, 'display:none;background:#3b1f6e;border-color:#c084fc;color:#c084fc');
const watchBtn = mkBtn('Watch',()=>sendMsg({type:'toggleWatchVariables'}));
playVideoBtn = mkBtn('▶',toggleVideoDebug, 'background:#1f4d6e;border-color:#60a5fa;color:#60a5fa');
ctrlRoot.append(stepIntoBtn, watchBtn, playVideoBtn, speedSel);


window.addEventListener('load', () => { if(typeof _ivxInit==='function') _ivxInit(); });

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
const NODE_KEYWORDS = ['if', 'fork', 'loop', 'dot', 'take', 'say', 'give', 'fun', 'end', 'from'];
const OUTGOING_KEYWORDS = ['prev', 'next', 'use'];
const NODE_KEYS = new Set(NODE_KEYWORDS);
const IN_KEYS = new Set(INCOMING_KEYWORDS);
const OUT_KEYS = new Set(OUTGOING_KEYWORDS);
const makeCtx = (baseIndent, firstLast, savedLast = null) => ({
  scopeStack: [{ indent: baseIndent, lastExec: firstLast }],
  decStack: [], pendingElse: null, baseIndent, savedLastExec: savedLast,
});
function parseivx(source) {
  // Treat ';' as a line break and 'then ' as a newline with indent
  const preprocessed = source
    .replace(/then\s+/g, '\n  ')
    .replace(/\bso\s+/g, '\n')
    .replace(/;/g, '\n');
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

  // Pass 2: assign fun-body-of meta based on indentation after Function node
  let funStack = [];
  let lastFun = null;
  let lastFunIndent = -1;
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
      // Exiting function scope
      funStack.pop();
      if (funStack.length > 0) {
        lastFun = funStack[funStack.length - 1].funLine;
        lastFunIndent = funStack[funStack.length - 1].indent;
      } else {
        lastFun = null;
        lastFunIndent = -1;
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
            pushEdge(dc.decNode.id, node.id, (dc.kind === 'if' || dc.kind === 'loop') ? 'true' : undefined);
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

            if (!edges.some(e => e.from === dc.decNode.id && e.label === 'true')) {
                const trueDest = dc.trueBranchHead ?? dc.autoConnector ?? trigger ?? dc.decNode;
                pushEdge(dc.decNode.id, trueDest.id, 'true');
            }

            if (!edges.some(e => e.from === dc.decNode.id && e.label === 'false')) {
                const falseDest = dc.autoConnector ?? trigger ?? dc.decNode;
                pushEdge(dc.decNode.id, falseDest.id, 'false');
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
            if (!edges.some(e => e.from === dc.decNode.id && e.label === 'false')) {
                if (trigger) {
                    pushEdge(dc.decNode.id, trigger.id, 'false');
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
        const { lineNum, incoming, nodeKey, content, outgoing, _funHeader, _funBodyOf } = pl;
        const indent = pl.indent;
        if (processedLine.has(lineNum)) continue;
        // Set fun-body-of meta if in function scope
        let meta = '';
        if (_funHeader) meta = 'fun-header';
        if (_funBodyOf !== undefined) meta = `fun-body-of=${_funBodyOf}`;
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

                const edgeLabel = dc.kind === 'fork' ? undefined : 'false';
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
                // A function definition is not part of the sequential flow — it is a
                // named declaration that sits outside the execution path.  We must NOT
                // wire any predecessor (sequential or branch tail) into the Function
                // node itself.  flushUntil is called with null so pending decision tails
                // are left intact to wire forward to the first node after the function.
                // savedLastExec preserves the pre-fun lastExec so sequential flow
                // resumes correctly once closeFunCtx fires.
                const savedBeforeFun = getLastExec();
                flushUntil(indent, null);
                ctxStack.push(ctx);
                // firstLast = node (the Function header) so that the first body node
                // receives a wireSeq(Function → firstBodyNode) edge, giving the
                // function block a visible connecting edge from its header.
                // savedBeforeFun is passed as savedLastExec so closeFunCtx restores
                // the pre-fun sequential position when the body scope closes.
                ctx = makeCtx(indent, node, savedBeforeFun);
                continue;
            }
            else {
                node = addNode('Process', lineNum, content, meta);
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
        if (content || hasNonIncomingKeyword) {
            const n = addNode('Process', lineNum, content, meta);
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

    return { nodes, edges, startNodeId: startNode.id, segments: [], validationErrors };
}

// ── DOM refs for editor UI ────────────────────────────────────────────────────
const srcEl  = /** @type {HTMLTextAreaElement} */ (document.getElementById('src'));
const errEl  = document.getElementById('err');

const STARTER = `take user input
if input > 0
then give positive result
else give non-positive result
end`;

srcEl.value = STARTER;

// Bug 4 fix: line number of a newly-inserted node waiting for its edit overlay,
let _pendingInsertEditLine = -1;

let _dt;
function scheduleRender() {
  clearTimeout(_dt);
  _dt = setTimeout(doRender, 150);
}

function doRender() {
  const src = srcEl.value;
  try {
    const graph = parseivx(src);
    const errs = graph.validationErrors || [];
    if (errs.length) {
      errEl.innerHTML = errs.map((e, i) => `<div>${e}</div>`).join('') + (errs.length > 1 ? `<div style=\"color:#888;font-size:10px;\">(${errs.length} errors)</div>` : '');
      errEl.className = '';
    } else {
      errEl.textContent = `✓ ${graph.nodes.length} nodes, ${graph.edges.length} edges`;
      errEl.className = 'ok';
    }
    _walkOrder = getWalkOrder(graph);
    _walkIdx = 0;
    // Feed directly into renderer (same script scope, so renderGraph is available)
    dragOffsets.clear();
    blockOffsets.clear();
    isFirstRender = !currentGraph;
    renderGraph(graph);

    // Bug 4 fix: open the inline editor for a newly inserted node now that the
    // graph is guaranteed to be up to date, instead of relying on a fixed timeout.
    if (_pendingInsertEditLine >= 0) {
      const targetLine = _pendingInsertEditLine;
      _pendingInsertEditLine = -1;
      const inserted = graph.nodes.find(n => n.line === targetLine);
      if (inserted) startNodeEditByLine({ line: targetLine, text: inserted.text || '' });
    }
  } catch(e) {
    errEl.textContent = 'Parse error: ' + e.message;
    errEl.className = '';
  }
}

srcEl.addEventListener('input', scheduleRender);

srcEl.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = srcEl.selectionStart, end = srcEl.selectionEnd;
    srcEl.value = srcEl.value.slice(0, s) + '  ' + srcEl.value.slice(end);
    srcEl.selectionStart = srcEl.selectionEnd = s + 2;
    updateHighlight();
    scheduleRender();
  }
});

document.querySelectorAll('[data-ins]').forEach(function(btn) {
  btn.addEventListener('click', function handleInsertClick() {
    const ins = btn.dataset.ins;
    const s = srcEl.selectionStart, e2 = srcEl.selectionEnd;
    srcEl.value = srcEl.value.slice(0, s) + ins + srcEl.value.slice(e2);
    srcEl.selectionStart = srcEl.selectionEnd = s + ins.length;
    srcEl.focus();
    updateHighlight();
    scheduleRender();
  });
});
document.getElementById('clr').addEventListener('click', function handleClearClick() {
  srcEl.value = '';
  srcEl.focus();
  updateHighlight();
  scheduleRender();
});


// ── Step controls ─────────────────────────────────────────────────────────────
let _walkOrder = [], _walkIdx = 0, _stepTimer = null, _stepRunning = false;

function getWalkOrder(graph) {
  const visited = new Set(), order = [], adj = new Map();
  for (const e of graph.edges)
    (adj.get(e.from) ?? (adj.set(e.from, []), adj.get(e.from))).push(e.to);
  const q = [graph.startNodeId];
  while (q.length) {
    const id = q.shift();
    if (id == null || visited.has(id)) continue;
    visited.add(id);
    const n = graph.nodes.find(n => n.id === id);
    if (n && n.kind !== 'Function') order.push(id);
    for (const nxt of (adj.get(id) || [])) if (!visited.has(nxt)) q.push(nxt);
  }
  return order;
}

function stepTo(idx) {
  if (!_walkOrder.length) return;
  _walkIdx = Math.max(0, Math.min(idx, _walkOrder.length - 1));
  highlightNode(_walkOrder[_walkIdx], _walkOrder[_walkIdx + 1] ?? null);
}
function stepNext() { if (_walkIdx < _walkOrder.length - 1) stepTo(_walkIdx + 1); }
function stepPrev() { if (_walkIdx > 0) stepTo(_walkIdx - 1); }

function stepStartAuto() {
  if (_stepRunning) return; _stepRunning = true;
  const tick = () => {
    if (!_stepRunning || _walkIdx >= _walkOrder.length - 1) { stepStopAuto(); return; }
    stepNext();
    _stepTimer = setTimeout(tick, 300 / (Number(document.getElementById('spd').value) || 1));
  };
  tick();
}
function stepStopAuto() { _stepRunning = false; clearTimeout(_stepTimer); }

document.getElementById('sprev').addEventListener('click', () => { stepStopAuto(); stepPrev(); });
document.getElementById('snext').addEventListener('click', () => { stepStopAuto(); stepNext(); });
document.getElementById('splay').addEventListener('click', stepStartAuto);
document.getElementById('spause').addEventListener('click', stepStopAuto);
// ── Comments toggle ──────────────────────────────────────────────────────────
document.getElementById('cmtbtn').addEventListener('click', function toggleComments() {
  showComments = !showComments;
  const cmtBtnEl = document.getElementById('cmtbtn');
  if (cmtBtnEl) cmtBtnEl.classList.toggle('on', showComments);
  if (currentGraph) renderGraph(currentGraph);
});

// ── Called by renderer after load ─────────────────────────────────────────────
function _ivxInit() { doRender(); }

// ── Export ────────────────────────────────────────────────────────────────────
function exportSVG() {
  const bbox = graphBounds;
  const pad = 20;
  // Clone the canvas SVG and set a clean viewBox covering the full graph
  const clone = svg.cloneNode(true);
  clone.setAttribute('viewBox', `${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad*2} ${bbox.height + pad*2}`);
  clone.setAttribute('width',  String(bbox.width  + pad*2));
  clone.setAttribute('height', String(bbox.height + pad*2));
  clone.style.background = '#0f0f14';
  // Inline the CSS animation keyframes so the exported SVG is self-contained
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `
    text { font-family: system-ui, sans-serif; font-size: 12px; fill: #eee; }
    @keyframes flow-a { to { stroke-dashoffset: -18 } }
    @keyframes flow-b { from { stroke-dashoffset: -9 } to { stroke-dashoffset: -27 } }
    .flow-a { animation: flow-a .45s linear infinite; }
    .flow-b { animation: flow-b .45s linear infinite; }
  `;
  clone.insertBefore(style, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

function downloadFile(filename, content, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportJSON() {
  if (!currentGraph) return;
  const nodeInfo = new Map(currentGraph.nodes.map(n => [n.id, n]));
  const map = {};
  for (const node of currentGraph.nodes) {
    map[node.id] = { type: node.kind, to: [] };
  }
  for (const edge of currentGraph.edges) {
    if (map[edge.from]) {
      const target = nodeInfo.get(edge.to);
      map[edge.from].to.push({
        id: edge.to,
        type: target ? target.kind : 'Unknown',
        label: edge.label ?? null
      });
    }
  }
  downloadFile('graph.json', JSON.stringify(map, null, 2), 'application/json');
}

function exportAsSVG() {
  downloadFile('graph.svg', exportSVG(), 'image/svg+xml');
}

function exportAsPNG() {
  const svgStr = exportSVG();
  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const url  = URL.createObjectURL(blob);
  const img  = new Image();
  const pad  = 20;
  img.onload = () => {
    const w = graphBounds.width  + pad*2;
    const h = graphBounds.height + pad*2;
    const canvas = document.createElement('canvas');
    // Render at 2x for crisp export on high-DPI screens
    canvas.width  = w * 2;
    canvas.height = h * 2;
    const ctx2d = canvas.getContext('2d');
    ctx2d.scale(2, 2);
    ctx2d.fillStyle = '#0f0f14';
    ctx2d.fillRect(0, 0, w, h);
    ctx2d.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    canvas.toBlob(b => downloadFile('graph.png', b, 'image/png'), 'image/png');
  };
  img.src = url;
}

document.getElementById('export-btn').addEventListener('click', () => {
  const fmt = document.getElementById('export-fmt').value;
  if      (fmt === 'json') exportJSON();
  else if (fmt === 'svg')  exportAsSVG();
  else if (fmt === 'png')  exportAsPNG();
});
// ── Syntax highlighting ───────────────────────────────────────────────────────
const hlEl     = document.getElementById('src-hl');
const gutterEl = document.getElementById('src-gutter-inner');
const scrollEl = document.getElementById('src-scroll');

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Keyword sets for the tokenizing highlighter
const _KW_NODE     = new Set(['if','fork','loop','dot','con','take','say','give','fun','end','from','make','note','for','in','wait','del','ask','post','use']);
const _KW_FLOW     = new Set(['so','then','else']);
const _KW_OUTGOING = new Set(['prev','next','use']);
const _KW_LOGIC    = new Set(['not','and','or','xor','is','yes','no','none']);

// Tokenize a raw source line into typed spans, then emit HTML.
// Handles strings, numbers, lists, dicts, keywords — all before HTML escaping
// so bracket/quote characters are never corrupted by &amp; etc.
function highlightLine(line, allVars = new Set()) {
  // Split off trailing 'note ...' comment first
  const noteMatch = line.match(/^(.*?)\b(note\s.*)$/);
  const code = noteMatch ? noteMatch[1] : line;
  const note = noteMatch ? noteMatch[2] : '';

  // Tokenizer: walk the code string producing {text, cls} segments
  const segs = [];
  let i = 0;
  let prevWasMake = false;
  const push = (text, cls) => { if (text) segs.push({ text, cls }); };

  while (i < code.length) {
    // String literal — detect URL type and highlight {interpolations}
    if (code[i] === '"') {
      let j = i + 1;
      while (j < code.length && !(code[j] === '"' && code[j-1] !== '\\')) j++;
      if (j < code.length) j++;
      const raw     = code.slice(i, j);
      const strVal  = raw.slice(1, -1);
      const isUrl   = strVal.startsWith('http://') || strVal.startsWith('https://');
      const baseCls = isUrl ? 'kw-url' : 'kw-string';
      // Split on {varname} patterns and highlight interpolations
      const parts = strVal.split(/(\{[A-Za-z_]\w*\})/);
      if (parts.length > 1) {
        push('"', baseCls);
        for (const part of parts) {
          if (/^\{[A-Za-z_]\w*\}$/.test(part)) push(part, 'kw-var');
          else if (part) push(part, baseCls);
        }
        push('"', baseCls);
      } else {
        push(raw, baseCls);
      }
      i = j; continue;
    }
    // List literal  [...]
    if (code[i] === '[') {
      let depth = 0, j = i;
      while (j < code.length) {
        if (code[j] === '[') depth++;
        else if (code[j] === ']') { depth--; if (depth === 0) { j++; break; } }
        j++;
      }
      push(code.slice(i, j), 'kw-list'); i = j; continue;
    }
    // Dict literal  {...}
    if (code[i] === '{') {
      let depth = 0, j = i;
      while (j < code.length) {
        if (code[j] === '{') depth++;
        else if (code[j] === '}') { depth--; if (depth === 0) { j++; break; } }
        j++;
      }
      push(code.slice(i, j), 'kw-dict'); i = j; continue;
    }
    // Number literal (integer or float)
    if (/[\d]/.test(code[i]) || (code[i] === '-' && /\d/.test(code[i+1]||''))) {
      let j = i;
      if (code[j] === '-') j++;
      while (j < code.length && /[\d.]/.test(code[j])) j++;
      push(code.slice(i, j), 'kw-number'); i = j; continue;
    }
    // Word token — check against keyword sets, or function call if followed by (
    if (/[A-Za-z_]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[\w]/.test(code[j])) j++;
      const word = code.slice(i, j);
      const isFunCall = code[j] === '(';
      const isLazy    = code[j] === '?' && !isFunCall;
      let cls = '';
      if (isFunCall)                       cls = 'kw-funcall';
      else if (_KW_NODE.has(word))         cls = 'kw-node';
      else if (_KW_FLOW.has(word))         cls = 'kw-flow';
      else if (_KW_OUTGOING.has(word))     cls = 'kw-outgoing';
      else if (_KW_LOGIC.has(word))        cls = 'kw-logic';
      else if (allVars.has(word))          cls = 'kw-var';
      prevWasMake = (word === 'make') && !isFunCall;
      push(word, cls); i = j;
      // ? suffix — same color as the variable, just marks lazy declaration
      if (isLazy) { push('?', cls || 'kw-var'); i++; }
      continue;
    }
    // Everything else — pass through as plain text (accumulate runs)
    let j = i + 1;
    while (j < code.length && !/[A-Za-z_\d\-"\[{]/.test(code[j])) j++;
    push(code.slice(i, j), ''); i = j;
  }

  let html = segs.map(({ text, cls }) => {
    const e = escHtml(text);
    return cls ? `<span class="${cls}">${e}</span>` : e;
  }).join('');

  if (note) html += `<span class="kw-note">${escHtml(note)}</span>`;
  return html;
}

function highlightSource(src) {
  // Pre-scan entire source for all make-declared variable names
  // so every occurrence gets colored, not just the token after 'make'
  const allVars = new Set();
  const makeMatches = src.match(/\bmake\s+([A-Za-z_]\w*)/g);
  if (makeMatches) makeMatches.forEach(m => { const v = m.match(/make\s+(\w+)/); if (v) allVars.add(v[1]); });
  const takeMatches = src.match(/\btake\s+(?:int|flt|str|bin|list|dict\s*\(\s*)?([A-Za-z_]\w*)/g);
  if (takeMatches) takeMatches.forEach(m => { const v = m.match(/([A-Za-z_]\w*)$/); if (v) allVars.add(v[1]); });
  // Also collect lazy-declared variables (name?) so they color as vars
  const lazyMatches = src.match(/\b([A-Za-z_]\w*)\?/g);
  if (lazyMatches) lazyMatches.forEach(m => { allVars.add(m.slice(0, -1)); });
  return src.split('\n').map(line => highlightLine(line, allVars)).join('\n');
}

function updateHighlight() {
  const src   = srcEl.value;
  const lines = src.split('\n');
  const count = lines.length;

  // Update highlight layer
  hlEl.innerHTML = highlightSource(src) + '\n';

  // Update line number gutter
  let gutter = '';
  for (let i = 1; i <= count; i++) gutter += i + '\n';
  gutterEl.textContent = gutter;

  // Size the highlight and textarea to content so scroll container works
  const lineH   = 13 * 1.7; // font-size * line-height
  const padV    = 10 * 2;   // top + bottom padding
  const minH    = scrollEl.clientHeight || 300;
  const contentH = Math.max(minH, count * lineH + padV);
  hlEl.style.height    = contentH + 'px';
  srcEl.style.height   = contentH + 'px';

  // Sync gutter scroll position with scroll container
  gutterEl.style.top = -scrollEl.scrollTop + 'px';
}

// Sync scroll: when src-scroll scrolls, move gutter too
scrollEl.addEventListener('scroll', () => {
  gutterEl.style.top = -scrollEl.scrollTop + 'px';
});

// Textarea scroll should be ignored — scrollEl handles it
srcEl.addEventListener('scroll', () => { srcEl.scrollTop = 0; srcEl.scrollLeft = 0; });

srcEl.addEventListener('input', updateHighlight);
updateHighlight();

// ── Terminal ──────────────────────────────────────────────────────────────────
const termMsgs   = document.getElementById('term-msgs');
const termRun    = document.getElementById('term-run');
const termClear  = document.getElementById('term-clear');
const termRes    = document.getElementById('term-resizer');

// ── Terminal message helpers ──────────────────────────────────────────────────
function termAppend(text, cls) {
  const el = document.createElement('div');
  el.className = 'term-msg ' + cls;
  el.textContent = text;
  termMsgs.appendChild(el);
  termMsgs.scrollTop = termMsgs.scrollHeight;
  return el;
}

function termInfo(text)   { termAppend(text, 'info');   }
function termOutput(text) { termAppend(text, 'output'); }
function termError(text)  { termAppend(text, 'error');  }

// ── Inline input — returns a Promise that resolves when user hits Enter ───────
function termInput(varName) {
  return new Promise(resolve => {
    const row = document.createElement('div');
    row.className = 'term-input-row';

    const label = document.createElement('span');
    label.className = 'term-input-label';
    label.textContent = varName + ' ›';

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'term-input-field';
    field.placeholder = 'type and press Enter…';

    row.appendChild(label);
    row.appendChild(field);
    termMsgs.appendChild(row);
    termMsgs.scrollTop = termMsgs.scrollHeight;
    field.focus();

    field.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const val = field.value;
      // Lock the input row and show sent bubble
      field.disabled = true;
      field.style.display = 'none';
      const sent = document.createElement('div');
      sent.className = 'term-input-sent';
      sent.textContent = val;
      row.appendChild(sent);
      termMsgs.scrollTop = termMsgs.scrollHeight;
      resolve(val);
    });
  });
}

// ── Run button ────────────────────────────────────────────────────────────────
let _running = false;

termRun.addEventListener('click', async () => {
  if (_running) return;
  _running = true;
  termRun.textContent = '⏹ Running';
  termRun.classList.add('running');
  termInfo('─── run started ───');

  // Build map: 0-based graph line → node ID
  // Decision nodes take priority so conditions highlight the diamond
  const lineToNodeId = new Map();
  if (currentGraph) {
    for (const n of currentGraph.nodes) {
      if (n.kind === 'Start' || n.kind === 'End' || n.kind === 'Function') continue;
      const existing = lineToNodeId.get(n.line);
      if (!existing || n.kind === 'Decision' || n.kind === 'Input' || n.kind === 'Output') {
        lineToNodeId.set(n.line, n.id);
      }
    }
  }

  // Record trace events during execution — play back after at human speed
  const recorded = [];
  const t0 = performance.now();

  const interp = new Interpreter({
    onOutput: async (value) => {
      termOutput(ivxRepr(value));
    },
    onInput: async (varName) => {
      const raw = await termInput(varName);
      const num = Number(raw);
      return raw.trim() === '' ? null : isNaN(num) ? raw : num;
    },
    onError: (e) => {
      termError('Error: ' + (e.message ?? String(e)));
    },
    onWait: (n) => new Promise(r => setTimeout(r, n * 100)),
    onStep: (srcLine) => {
      // srcLine is 1-based from AST; graph nodes are 0-based
      const nodeId = lineToNodeId.get(srcLine - 1);
      if (nodeId != null) {
        const last = recorded[recorded.length - 1];
        // Deduplicate consecutive same-node steps (e.g. tight loops)
        // but keep repeats for decision nodes so the flash is visible
        const n = currentGraph?.nodes.find(n => n.id === nodeId);
        const isDecision = n?.kind === 'Decision';
        if (!last || last.nodeId !== nodeId || isDecision) {
          recorded.push({ nodeId, ts: performance.now() - t0 });
        }
      }
    },
  });

  try {
    await interp.run(srcEl.value, { ignoreTypeErrors: true });
  } catch(e) {
    termError('Fatal: ' + (e.message ?? String(e)));
  }

  termInfo('─── run finished ───');
  termRun.textContent = '▶ Run';
  termRun.classList.remove('running');
  _running = false;

  // Hand recorded trace to the playback system
  // Normalize timestamps to 300ms per step so playback is human-readable
  if (recorded.length > 0) {
    const STEP_MS = 300;
    const normalized = recorded.map((ev, i) => ({ nodeId: ev.nodeId, ts: i * STEP_MS }));
    isVideoPlaying = true;
    updateVideoButton();
    startTrace(normalized);
  }
});

// ── Clear button ──────────────────────────────────────────────────────────────
termClear.addEventListener('click', () => {
  termMsgs.innerHTML = '';
});

// ── Resizer drag ──────────────────────────────────────────────────────────────
(function() {
  let startY, startTermH, dragging = false;

  termRes.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startTermH = document.getElementById('term').getBoundingClientRect().height;
    termRes.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH = Math.max(80, Math.min(startTermH + delta, window.innerHeight * 0.6));
    document.getElementById('ep').style.gridTemplateRows = `1fr 6px ${newH}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    termRes.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });
})();

// ── Google Drive Integration ──────────────────────────────────────────────────
const DRIVE_CLIENT_ID = '857056430546-3o2o9mhula9lkm1vcpidu61919h3umev.apps.googleusercontent.com';
const DRIVE_SCOPE     = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER    = 'IVX';

let driveToken     = null;   // current access token
let driveFolderId  = null;   // ID of IVX/ folder in Drive
let driveCurrentId = null;   // ID of currently open file
let driveCurrentName = null; // name of currently open file
let driveUnsaved   = false;  // unsaved changes flag
let driveTokenClient = null; // GIS token client

const drivePanel       = document.getElementById('drive-panel');
const driveConnectBtn  = document.getElementById('drive-connect-btn');
const driveFileList    = document.getElementById('drive-file-list');
const drivePanelFooter = document.getElementById('drive-panel-footer');
const driveNewBtn      = document.getElementById('drive-new-btn');
const driveSaveBtn     = document.getElementById('drive-save-btn');
const driveSignoutBtn  = document.getElementById('drive-signout-btn');
const driveFilename    = document.getElementById('drive-filename');

// ── Auth ──────────────────────────────────────────────────────────────────────
function driveInit() {
  // Wait for GSI to load
  if (typeof google === 'undefined') {
    setTimeout(driveInit, 200);
    return;
  }
  driveTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_CLIENT_ID,
    scope:     DRIVE_SCOPE,
    callback:  (resp) => {
      if (resp.error) { console.error('Drive auth error:', resp); return; }
      driveToken = resp.access_token;
      driveConnectBtn.textContent = 'Connected ✓';
      driveConnectBtn.disabled = true;
      drivePanelFooter.style.display = 'flex';
      driveEnsureFolder().then(driveListFiles);
    },
  });
}

driveConnectBtn.addEventListener('click', () => {
  if (!driveTokenClient) { driveInit(); setTimeout(() => driveTokenClient?.requestAccessToken(), 300); return; }
  driveTokenClient.requestAccessToken();
});

driveSignoutBtn.addEventListener('click', () => {
  if (driveToken) google.accounts.oauth2.revoke(driveToken);
  driveToken = null; driveFolderId = null;
  driveCurrentId = null; driveCurrentName = null;
  driveConnectBtn.textContent = 'Sign in to Google';
  driveConnectBtn.disabled = false;
  drivePanelFooter.style.display = 'none';
  driveFileList.innerHTML = '<div class="drive-empty">Sign in to access your IVX files in Google Drive</div>';
  driveFilename.textContent = '';
  driveFilename.className = 'drive-filename';
});

// ── API helpers ───────────────────────────────────────────────────────────────
async function driveAPI(path, opts = {}) {
  const res = await fetch('https://www.googleapis.com' + path, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + driveToken, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error('Drive API ' + res.status + ': ' + await res.text());
  return res.json();
}

async function driveEnsureFolder() {
  // Find or create the IVX/ folder
  const q = `name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await driveAPI(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
  if (res.files && res.files.length > 0) {
    driveFolderId = res.files[0].id;
    return;
  }
  // Create it
  const created = await driveAPI('/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' }),
  });
  driveFolderId = created.id;
}

// ── List files ────────────────────────────────────────────────────────────────
async function driveListFiles() {
  driveFileList.innerHTML = '<div class="drive-loading">Loading...</div>';
  try {
    const q = `'${driveFolderId}' in parents and name contains '.ivx' and trashed=false`;
    const res = await driveAPI(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`);
    driveFileList.innerHTML = '';
    if (!res.files || res.files.length === 0) {
      driveFileList.innerHTML = '<div class="drive-empty">No .ivx files yet. Click ＋ New to create one.</div>';
      return;
    }
    for (const f of res.files) {
      const item = document.createElement('div');
      item.className = 'drive-file-item' + (f.id === driveCurrentId ? ' active' : '');
      item.dataset.id   = f.id;
      item.dataset.name = f.name;
      item.innerHTML = `<span class="drive-file-icon">◆</span><span class="drive-file-name">${escHtml(f.name.replace(/\.ivx$/, ''))}</span>`;
      item.addEventListener('click', () => driveOpenFile(f.id, f.name));
      driveFileList.appendChild(item);
    }
  } catch(e) {
    driveFileList.innerHTML = `<div class="drive-empty">Error: ${e.message}</div>`;
  }
}

// ── Open file ─────────────────────────────────────────────────────────────────
async function driveOpenFile(id, name) {
  if (driveUnsaved) {
    if (!confirm('You have unsaved changes. Open this file anyway?')) return;
  }
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
      headers: { 'Authorization': 'Bearer ' + driveToken },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    srcEl.value = text;
    updateHighlight();
    scheduleRender();
    driveCurrentId   = id;
    driveCurrentName = name;
    driveUnsaved     = false;
    driveUpdateHeader();
    // Update active state in list
    driveFileList.querySelectorAll('.drive-file-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
    });
  } catch(e) {
    alert('Could not open file: ' + e.message);
  }
}

// ── Save file ─────────────────────────────────────────────────────────────────
async function driveSaveFile() {
  if (!driveToken) return;
  if (!driveCurrentId) { driveNewFile(); return; }
  try {
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${driveCurrentId}?uploadType=media`, {
      method:  'PATCH',
      headers: { 'Authorization': 'Bearer ' + driveToken, 'Content-Type': 'text/plain' },
      body:    srcEl.value,
    });
    driveUnsaved = false;
    driveUpdateHeader();
  } catch(e) {
    alert('Save failed: ' + e.message);
  }
}

// ── New file ──────────────────────────────────────────────────────────────────
async function driveNewFile() {
  if (!driveToken || !driveFolderId) return;
  const rawName = prompt('File name:', 'untitled');
  if (!rawName) return;
  const name = rawName.endsWith('.ivx') ? rawName : rawName + '.ivx';
  try {
    // Create metadata
    const meta = await driveAPI('/drive/v3/files', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, parents: [driveFolderId], mimeType: 'text/plain' }),
    });
    // Upload empty content
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${meta.id}?uploadType=media`, {
      method:  'PATCH',
      headers: { 'Authorization': 'Bearer ' + driveToken, 'Content-Type': 'text/plain' },
      body:    '',
    });
    driveCurrentId   = meta.id;
    driveCurrentName = name;
    driveUnsaved     = false;
    srcEl.value      = '';
    updateHighlight();
    scheduleRender();
    driveUpdateHeader();
    await driveListFiles();
  } catch(e) {
    alert('Could not create file: ' + e.message);
  }
}

// ── Header filename display ───────────────────────────────────────────────────
function driveUpdateHeader() {
  if (!driveCurrentName) { driveFilename.textContent = ''; return; }
  driveFilename.textContent = driveCurrentName.replace(/\.ivx$/, '');
  driveFilename.className   = 'drive-filename' + (driveUnsaved ? ' unsaved' : '');
}

// ── Track unsaved changes ─────────────────────────────────────────────────────
srcEl.addEventListener('input', () => {
  if (driveCurrentId && !driveUnsaved) {
    driveUnsaved = true;
    driveUpdateHeader();
  }
});

// ── Keyboard shortcut: Ctrl/Cmd+S to save ────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (driveToken) driveSaveFile();
  }
});

driveNewBtn .addEventListener('click', driveNewFile);
driveSaveBtn.addEventListener('click', driveSaveFile);

// Init on load
window.addEventListener('load', driveInit);
