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


// ── script.js ────────────────────────────────────────────────────────────────


const NS = 'http://www.w3.org/2000/svg';
const BASEY = 40, YSTEP = 80, MAX_NODE_W = 260, PAD_X = 20, PAD_Y = 10;
const LINE_H = 14, CELL_PAD_X = 6, CELL_H = 22;
const BLOCK_GAP_Y = 28, BLOCK_PAD = 12, BLANK_LINE_THRESH = 2;

const NODE_FILL = { Decision:'#004b8d', Predictive:'#6a00a3', Function:'#92700a',
                    Start:'#007f00', End:'#7f0000', Input:'#007f00', Output:'#ED8936',
                    WaitBlock:'#7c4d00' };
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
let lastRenderedBlocks = [];

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

function preprocessControlFlowSyntax(raw) {
  // Expand 'then' and 'so' as before, but only expand ';' as a statement
  // separator when it is outside of brackets/strings — so that 2D list
  // syntax like [1,2; 3,4] is preserved intact.
  const s = String(raw)
    .replace(/then\s+/g, '\n  ')
    .replace(/\bso\s+/g, '\n');

  // Expand ';' only outside brackets and quotes
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

// Rewrite a single source line in-place, preserving indentation and keyword prefix.
function commitNodeEditToSource(line, newText) {
  const originalSrc = srcEl.value;
  const originalLines = originalSrc.split('\n');

  // Map preprocessed line index back to original source line index
  const prepToOrig = [];
  originalLines.forEach((origLine, origIdx) => {
    const expanded = preprocessControlFlowSyntax(origLine);
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
    const expanded = preprocessControlFlowSyntax(origLine);
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
    return preprocessControlFlowSyntax(raw).split('\n');
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
  if (!blockState.has(key)) blockState.set(key, { collapsed: false, label: '', color: '' });
  return blockState.get(key);
}

function isBlankLine(s) {
  return String(s ?? '').trim() === '';
}

function isValidCssColorToken(token) {
  const v = String(token ?? '').trim();
  if (!v) return false;
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return true;
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('span');
  probe.style.color = '';
  probe.style.color = v;
  return probe.style.color !== '';
}

function parseBlockDirectiveFromNoteLine(line) {
  const m = String(line ?? '').trim().match(/^note\s+(.+)$/i);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;

  const parts = body.split(/\s+/).filter(Boolean);
  let color = '';
  const labelParts = [];
  let consumedColor = false;

  for (const part of parts) {
    if (!consumedColor && isValidCssColorToken(part)) {
      color = part;
      consumedColor = true;
    } else {
      labelParts.push(part);
    }
  }

  return { color, label: labelParts.join(' ') };
}

function buildPreprocessedToOriginalMap(source) {
  const originalLines = String(source ?? '').split('\n');
  const prepToOrig = [];
  originalLines.forEach((line, idx) => {
    const expanded = preprocessControlFlowSyntax(line);
    const count = expanded.split('\n').length;
    for (let i = 0; i < count; i++) prepToOrig.push(idx);
  });
  return { originalLines, prepToOrig };
}

function readBlockDirectiveForPreprocessedLine(preLine, sourceInfo) {
  if (!sourceInfo) return null;
  const { originalLines, prepToOrig } = sourceInfo;
  if (!Array.isArray(originalLines) || !Array.isArray(prepToOrig)) return null;

  const origLine = (preLine >= 0 && preLine < prepToOrig.length) ? prepToOrig[preLine] : preLine;
  if (origLine == null || origLine < 0 || origLine >= originalLines.length) return null;

  let i = origLine - 1;
  while (i >= 0 && isBlankLine(originalLines[i])) i--;
  if (i < 0) return null;

  // If multiple note lines are stacked, use the FIRST one after the separator.
  let noteStart = i;
  while (noteStart - 1 >= 0 && /^note\b/i.test(String(originalLines[noteStart - 1]).trim())) {
    noteStart--;
  }

  const directive = parseBlockDirectiveFromNoteLine(originalLines[noteStart]);
  if (!directive) return null;

  let blanksAbove = 0;
  let j = noteStart - 1;
  while (j >= 0 && isBlankLine(originalLines[j])) { blanksAbove++; j--; }
  if (blanksAbove < 2) return null;

  return directive;
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
  const depth = new Map(graph.nodes.map(n => [n.id, (n.kind==='Start'||n.kind==='Function'||n.kind==='WaitBlock') ? 0 : Infinity]));
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
      if (n.kind==='Function' || n.kind==='WaitBlock') depth.set(n.id, 0);
      else if (!isFinite(depth.get(n.id))) depth.set(n.id, fallback++);
    });
  return depth;
}

function computeLayout(graph) {
  const { byId, childOf, parentOf } = buildAdj(graph);
  const { branchIdx, decOf } = computeBranchInfo(graph, byId, childOf, parentOf);
  const depthMap = computeLayering(graph, byId);
  const sourceInfo = (typeof srcEl !== 'undefined' && srcEl && typeof srcEl.value === 'string')
    ? buildPreprocessedToOriginalMap(srcEl.value)
    : null;
  const XSTEP = Math.max(100, Math.min(180,
    Math.max(80, ...graph.nodes.map(n => Math.min(measureText(n.text||n.kind)+PAD_X*2, MAX_NODE_W))) + 40));
  currentXSTEP = XSTEP;

  const centerX0 = snap(500, XSTEP);
  const positions = new Map();
  let fnOffset = XSTEP * 4;

  for (const node of graph.nodes) {
    const depth = isFinite(depthMap.get(node.id)) ? depthMap.get(node.id) : 0;
    const isFn   = node.kind === 'Function';
    const isWait = node.kind === 'WaitBlock';
    const cx = (isFn || isWait) ? centerX0 + fnOffset : centerX0;
    if (isFn || isWait) fnOffset += XSTEP * 3;
    positions.set(node.id, { id:node.id, kind:node.kind, centerX:cx, centerY:BASEY+depth*YSTEP, x:cx, y:BASEY+depth*YSTEP, width:0, height:0 });
  }

  // Function and WaitBlock body column alignment
  const fnXMap = new Map();
  for (const n of graph.nodes) {
    if (n.kind==='Function' || n.kind==='WaitBlock') fnXMap.set(n.id, positions.get(n.id).centerX);
  }
  for (const n of graph.nodes) {
    const mFun  = n.meta?.match(/fun-body-of=(\d+)/);
    const mWait = n.meta?.match(/wait-body-of=(\d+)/);
    const m = mFun || mWait;
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
    const firstLine = Math.min(...[...group].map(id => positions.get(id)?.id != null ? byId.get(id)?.line ?? Infinity : Infinity));
    const directive = Number.isFinite(firstLine) ? readBlockDirectiveForPreprocessedLine(firstLine, sourceInfo) : null;

    const label = directive?.label ?? state.label ?? '';
    const color = directive?.color ?? state.color ?? '';

    state.label = label;
    state.color = color;
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

    blockBoxes.push({ key, collapsed:state.collapsed, ownerKey, minX,maxX,minY,maxY, group, label, color });
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
  if (node.kind==='WaitBlock')
    // Stadium shape — ellipse with extra width for the trigger label
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

  // ── Parse variable name and value ───────────────────────────────────────────
  const fullText = node.text.trim();
  const stripped = fullText.replace(/^makes+/, '');
  const nameMatch = stripped.match(/^([A-Za-z_]w*)s+([[{][sS]*)/);
  const varName  = nameMatch ? nameMatch[1] : null;
  const rawValue = nameMatch ? nameMatch[2].trim() : stripped;
  const inner    = rawValue.replace(/^[[{]/, '').replace(/[]}]$/, '').trim();

  // ── Build rows ───────────────────────────────────────────────────────────────
  let rows = [];
  if (kind === 'list') {
    if (inner.includes(';')) {
      // IVX 2D syntax: [1,2,3; 4,5,6]
      rows = inner.split(';').map(rowStr =>
        smartSplit(rowStr.trim(), ',').map(s => s.trim()).filter(s => s !== '')
      );
      const maxCols = Math.max(...rows.map(r => r.length), 1);
      rows.forEach(r => { while (r.length < maxCols) r.push(''); });
    } else if (inner.trimStart().startsWith('[')) {
      // Nested [[1,2],[3,4]] syntax
      rows = smartSplit(inner, ',')
        .map(s => s.trim()).filter(s => s.startsWith('['))
        .map(r => smartSplit(r.replace(/^[/,'').replace(/]$/,''), ',').map(s => s.trim()));
      const maxCols = Math.max(...rows.map(r => r.length), 1);
      rows.forEach(r => { while (r.length < maxCols) r.push(''); });
    } else {
      rows = [smartSplit(inner, ',').map(s => s.trim())];
    }
  } else {
    const pairs = smartSplit(inner, ',');
    rows = [
      pairs.map(p => smartSplit(p, ':')[0]?.trim() ?? ''),
      pairs.map(p => smartSplit(p, ':').slice(1).join(':').trim()),
    ];
  }

  if (!rows.length || !rows[0].length) {
    Object.assign(pos, { x: cx-40, y: cy-15, width: 80, height: 30, edgeTop: cy-15, edgeBottom: cy+15 });
    return;
  }

  const numCols = Math.max(...rows.map(r => r.length), 1);
  const numRows = rows.length;

  // ── Column widths ────────────────────────────────────────────────────────────
  let colWs = Array.from({ length: numCols }, (_, c) =>
    Math.max(...rows.map(r => measureText(String(r[c] ?? '')) + 2 * CELL_PAD_X), 36)
  );
  let totalW = colWs.reduce((a, b) => a + b, 0);
  const MIN_W = Math.max(MAX_NODE_W / 3, 80);
  if (totalW < MIN_W) {
    const scale = MIN_W / totalW;
    colWs = colWs.map(w => w * scale);
    totalW = MIN_W;
  }

  // ── Geometry ─────────────────────────────────────────────────────────────────
  const BADGE_H  = varName ? 18 : 0;
  const totalH   = numRows * CELL_H;
  const topOfAll = cy - (BADGE_H + totalH) / 2;
  const gridY    = topOfAll + BADGE_H;
  const x0       = cx - totalW / 2;
  const g = el('g', {}, svg);

  // ── Variable name badge — just the name, no [] or {} ─────────────────────────
  if (varName) {
    const badgeColor = kind === 'list' ? '#1e3a5f' : '#7c2d12';
    const badgeEl = el('rect', { x: x0, y: topOfAll, width: totalW, height: BADGE_H,
      rx: 4, ry: 4, fill: badgeColor, stroke: '#6b7280', 'stroke-width': 1 }, g);
    badgeEl.dataset.nodeId = node.id;
    const lbl = el('text', { x: cx, y: topOfAll + BADGE_H/2 + 1,
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': 11, fill: kind === 'list' ? '#93c5fd' : '#fcd34d' }, g);
    lbl.textContent = varName;
    lbl.setAttribute('font-weight', '600');
    lbl.dataset.nodeId = node.id;
  }

  // ── Outer border ─────────────────────────────────────────────────────────────
  const borderColor = kind === 'list' ? '#4b5563' : '#92400e';
  const bg = el('rect', { x: x0, y: gridY, width: totalW, height: totalH,
    rx: 3, ry: 3, fill: 'none', stroke: borderColor, 'stroke-width': 1.5 }, g);
  title(bg, extractComment(node.meta));
  bg.dataset.nodeId = node.id;

  // ── Cells ────────────────────────────────────────────────────────────────────
  rows.forEach((row, ri) => {
    const isDictHeader = kind === 'dict' && ri === 0;
    const rowBg    = isDictHeader ? '#7c2d12' : ri % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.15)';
    const textFill = isDictHeader ? '#fcd34d' : '#e5e7eb';
    let curX = x0;
    for (let c = 0; c < numCols; c++) {
      const cw = colWs[c], ry2 = gridY + ri * CELL_H;
      el('rect', { x: curX, y: ry2, width: cw, height: CELL_H, fill: rowBg, stroke: 'none' }, g);
      if (c < numCols-1) el('line', { x1: curX+cw, y1: ry2, x2: curX+cw, y2: ry2+CELL_H, stroke: borderColor, 'stroke-width': 0.5 }, g);
      if (ri < numRows-1) el('line', { x1: curX, y1: ry2+CELL_H, x2: curX+cw, y2: ry2+CELL_H, stroke: borderColor, 'stroke-width': 0.5 }, g);
      const cellText = String(row[c] ?? '');
      if (cellText) {
        const t = el('text', { x: curX+cw/2, y: ry2+CELL_H/2+1,
          'text-anchor': 'middle', 'dominant-baseline': 'middle',
          'font-size': isDictHeader ? 11 : 12, fill: textFill }, g);
        if (isDictHeader) t.setAttribute('font-weight', '600');
        t.textContent = cellText;
        t.dataset.nodeId = node.id;
      }
      curX += cw;
    }
  });

  Object.assign(pos, {
    x: x0, y: topOfAll, width: totalW, height: BADGE_H + totalH,
    edgeTop: topOfAll, edgeBottom: gridY + totalH,
  });
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
    const customColor = (box.color || '').trim();
    const hasCustomColor = !!customColor;

    const shellFill = hasCustomColor ? customColor : 'rgba(255,255,255,0.025)';
    const shellFillOpacity = hasCustomColor ? 0.07 : 1;
    const shellStroke = hasCustomColor ? customColor : 'rgba(255,255,255,0.07)';
    const shellStrokeOpacity = hasCustomColor ? 0.45 : 1;

    const headerFill = hasCustomColor ? customColor : 'rgba(40,40,70,0.9)';
    const headerFillOpacity = hasCustomColor ? 0.24 : 1;
    const headerStroke = hasCustomColor ? customColor : 'rgba(255,255,255,0.07)';
    const headerStrokeOpacity = hasCustomColor ? 0.7 : 1;

    // All block chrome goes in one group tagged for back-insertion
    const g = el('g', {
      'data-block-bg':'1',
      'data-block-key': key,
      'data-block-label': (box.label || '').trim(),
      'data-block-color': customColor,
    }, svg);

    el('rect',{x,y:headerY,width:w,height:HEADER_H+CLEARANCE+contentH,rx:8,ry:8,
      fill:shellFill,'fill-opacity':shellFillOpacity,stroke:shellStroke,'stroke-opacity':shellStrokeOpacity,'stroke-width':1,
      style:'pointer-events:none;'},g);

    el('rect',{x,y:headerY,width:w,height:HEADER_H,rx:5,ry:5,
      fill:headerFill,'fill-opacity':headerFillOpacity,stroke:headerStroke,'stroke-opacity':headerStrokeOpacity,'stroke-width':1,'data-block-key':key,style:'cursor:grab'},g);

    const lbl = el('text',{x:x+8,y:headerY+HEADER_H-5,'text-anchor':'start','font-size':10,fill:hasCustomColor?'#e5e7eb':'#9ca3af','data-block-label-key':key,style:'cursor:text;user-select:none;'},g);
    const customLabel = (box.label || '').trim();
    lbl.textContent = customLabel || `Block ${key.split(',')[0]}…`;
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

  // Keep a compact snapshot for export paths.
  lastRenderedBlocks = blockBoxes.map(box => ({
    key: box.key,
    label: (box.label || '').trim(),
    color: (box.color || '').trim(),
    collapsed: !!box.collapsed,
    ownerKey: box.ownerKey,
    nodes: [...box.group],
    bounds: {
      minX: box.minX, maxX: box.maxX,
      minY: box.minY, maxY: box.maxY,
    },
  }));

  renderBlockBg(blockBoxes, positions);
  // Push the full-bg rects AND header rects to back so they sit behind nodes.
  // We mark them with a data attribute in renderBlockBg to make selection reliable.
  const bgEls = Array.from(svg.querySelectorAll('[data-block-bg]'));
  for (const r of bgEls) svg.insertBefore(r, svg.firstChild);

  renderEdges(graph, positions, hidden, [], blockBoxes);

  // Stash blockBoxes so block label/color editing can find them
  if (currentGraph) currentGraph.__blockBoxes = blockBoxes;

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
  // Block header right-click → color picker
  const blockKey2 = e.target?.getAttribute?.('data-block-key');
  if (blockKey2) {
    const state = blockState.get(blockKey2);
    showBlockColorPicker(e, blockKey2, state?.color ?? '');
    return;
  }

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

// ─── Block label + color write-back ──────────────────────────────────────────

// Find the note line that controls a block and rewrite it.
// The note line is the one immediately before the first node of the block
// (possibly separated by blank lines), following the same logic as
// readBlockDirectiveForPreprocessedLine.
function commitBlockDirectiveToSource(key, newLabel, newColor) {
  if (!currentGraph) return;
  const sourceInfo = (typeof srcEl !== 'undefined' && srcEl)
    ? buildPreprocessedToOriginalMap(srcEl.value) : null;
  if (!sourceInfo) return;

  const { originalLines, prepToOrig } = sourceInfo;

  // Find first preprocessed line belonging to this block
  const box = (currentGraph.__blockBoxes ?? []).find(b => b.key === key);
  if (!box) return;

  // Get the minimum graph line of nodes in this block
  const ids = key.split(',').map(Number);
  const lines = ids.map(id => currentGraph.nodes.find(n => n.id === id)?.line).filter(l => l != null);
  if (!lines.length) return;
  const firstPrepLine = Math.min(...lines);
  const origLine = (firstPrepLine >= 0 && firstPrepLine < prepToOrig.length)
    ? prepToOrig[firstPrepLine] : firstPrepLine;

  // Walk backwards to find the note line (skip blanks)
  let i = origLine - 1;
  while (i >= 0 && isBlankLine(originalLines[i])) i--;
  if (i < 0) return;

  // Verify it's a note line, or find the first in a stack
  let noteStart = i;
  while (noteStart - 1 >= 0 && /^note\b/i.test(String(originalLines[noteStart - 1]).trim())) {
    noteStart--;
  }
  if (!/^note\b/i.test(String(originalLines[noteStart]).trim())) return;

  // Also verify there are 2+ blank lines above the note (block separator)
  let blanksAbove = 0, j = noteStart - 1;
  while (j >= 0 && isBlankLine(originalLines[j])) { blanksAbove++; j--; }
  if (blanksAbove < 2) return;

  // Build new note line: "note [color] label"
  const parts = ['note'];
  const trimColor = (newColor || '').trim();
  const trimLabel = (newLabel || '').trim();
  if (trimColor) parts.push(trimColor);
  if (trimLabel) parts.push(trimLabel);
  originalLines[noteStart] = parts.join(' ');

  srcEl.value = originalLines.join('\n');
  updateHighlight();
  scheduleRender();

  // Also update blockState so UI is instant
  const state = blockState.get(key);
  if (state) { state.label = trimLabel; state.color = trimColor; }
}

// ─── Block label click-to-edit ────────────────────────────────────────────────

let activeBlockEdit = null;

function startBlockLabelEdit(key, labelEl, currentLabel, currentColor) {
  if (activeBlockEdit) activeBlockEdit.remove();

  // Get SVG position of the label element
  const bb = labelEl.getBBox();
  const fo = el('foreignObject', {
    x: bb.x - 4, y: bb.y - 2,
    width: Math.max(bb.width + 60, 120), height: bb.height + 8
  }, svg);

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = currentLabel;
  inp.placeholder = 'Block label…';
  Object.assign(inp.style, {
    width: '100%', height: '100%', background: '#1e1e2e',
    color: '#e5e7eb', border: '1px solid #89b4fa', borderRadius: '4px',
    padding: '1px 4px', fontSize: '11px', fontFamily: 'inherit', outline: 'none',
    boxSizing: 'border-box',
  });

  const commit = () => {
    const newLabel = inp.value.trim();
    fo.remove(); activeBlockEdit = null;
    commitBlockDirectiveToSource(key, newLabel, currentColor);
  };

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { fo.remove(); activeBlockEdit = null; }
  });
  inp.addEventListener('blur', commit);
  fo.appendChild(inp);
  activeBlockEdit = fo;
  setTimeout(() => { inp.focus(); inp.select(); }, 10);
}

// ─── Block color right-click picker ──────────────────────────────────────────

function showBlockColorPicker(e, key, currentColor) {
  e.preventDefault();
  // Remove any existing picker
  document.getElementById('block-color-picker-popup')?.remove();

  const popup = document.createElement('div');
  popup.id = 'block-color-picker-popup';
  Object.assign(popup.style, {
    position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px',
    background: '#1e1e2e', border: '1px solid #3a3a5c', borderRadius: '10px',
    padding: '12px', boxShadow: '0 8px 24px rgba(0,0,0,.6)',
    zIndex: '10000', display: 'flex', flexDirection: 'column', gap: '10px',
    minWidth: '180px', fontFamily: 'system-ui, sans-serif',
  });

  // Title
  const title = document.createElement('div');
  title.textContent = 'Block color';
  Object.assign(title.style, { fontSize: '11px', color: '#9ca3af', fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: '.06em' });
  popup.appendChild(title);

  // Color wheel input
  const wheelRow = document.createElement('div');
  Object.assign(wheelRow.style, { display: 'flex', alignItems: 'center', gap: '8px' });
  const wheel = document.createElement('input');
  wheel.type = 'color';
  wheel.value = currentColor && /^#/.test(currentColor) ? currentColor : '#4f46e5';
  Object.assign(wheel.style, { width: '48px', height: '48px', border: 'none',
    borderRadius: '6px', cursor: 'pointer', background: 'none' });
  wheelRow.appendChild(wheel);

  // Hex input
  const hexInp = document.createElement('input');
  hexInp.type = 'text';
  hexInp.value = wheel.value;
  hexInp.maxLength = 7;
  Object.assign(hexInp.style, { flex: '1', background: '#0f0f14', color: '#cdd6f4',
    border: '1px solid #3a3a5c', borderRadius: '4px', padding: '4px 6px',
    fontSize: '12px', fontFamily: 'monospace' });
  wheelRow.appendChild(hexInp);
  popup.appendChild(wheelRow);

  // Sync wheel ↔ hex
  wheel.addEventListener('input', () => { hexInp.value = wheel.value; });
  hexInp.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hexInp.value)) wheel.value = hexInp.value;
  });

  // Preset swatches
  const presets = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#db2777','#374151'];
  const swatchRow = document.createElement('div');
  Object.assign(swatchRow.style, { display: 'flex', flexWrap: 'wrap', gap: '5px' });
  for (const hex of presets) {
    const sw = document.createElement('div');
    Object.assign(sw.style, { width: '20px', height: '20px', borderRadius: '4px',
      background: hex, cursor: 'pointer', border: '2px solid transparent',
      transition: 'border-color .1s' });
    sw.addEventListener('mouseenter', () => sw.style.borderColor = '#fff');
    sw.addEventListener('mouseleave', () => sw.style.borderColor = 'transparent');
    sw.addEventListener('click', () => { wheel.value = hex; hexInp.value = hex; });
    swatchRow.appendChild(sw);
  }
  popup.appendChild(swatchRow);

  // Clear color option
  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear color';
  Object.assign(clearBtn.style, { background: 'none', border: '1px solid #3a3a5c',
    color: '#9ca3af', borderRadius: '5px', padding: '4px 8px', cursor: 'pointer',
    fontSize: '11px', fontFamily: 'inherit' });
  clearBtn.addEventListener('click', () => {
    const state = blockState.get(key);
    const label = state?.label ?? '';
    commitBlockDirectiveToSource(key, label, '');
    popup.remove();
  });
  popup.appendChild(clearBtn);

  // Apply button
  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  Object.assign(applyBtn.style, { background: '#1f4d6e', border: '1px solid #60a5fa',
    color: '#93c5fd', borderRadius: '5px', padding: '5px 12px', cursor: 'pointer',
    fontSize: '12px', fontFamily: 'inherit', fontWeight: '600' });
  applyBtn.addEventListener('click', () => {
    const state = blockState.get(key);
    const label = state?.label ?? '';
    commitBlockDirectiveToSource(key, label, hexInp.value.trim());
    popup.remove();
  });
  popup.appendChild(applyBtn);

  document.body.appendChild(popup);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('mousedown', function handler(ev) {
      if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('mousedown', handler); }
    });
  }, 0);
}

svg.addEventListener('click', e => {
  // FIX: reset cancelNextClick atomically so one stale flag can't eat two events
  if (cancelNextClick) { cancelNextClick=false; return; }

  // Block label text click → inline rename
  const labelKey = e.target?.getAttribute?.('data-block-label-key');
  if (labelKey) {
    const state = blockState.get(labelKey);
    startBlockLabelEdit(labelKey, e.target, state?.label ?? '', state?.color ?? '');
    return;
  }

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
const NODE_KEYWORDS = ['if', 'fork', 'loop', 'dot', 'take', 'say', 'give', 'fun', 'end', 'from', 'wait'];
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
        const { lineNum, incoming, nodeKey, content, outgoing, _funHeader, _funBodyOf, _waitHeader, _waitBodyOf } = pl;
        const indent = pl.indent;
        if (processedLine.has(lineNum)) continue;
        // Set fun-body-of / wait-body-of meta if in function or wait-block scope
        let meta = '';
        if (_funHeader) meta = 'fun-header';
        if (_funBodyOf !== undefined) meta = `fun-body-of=${_funBodyOf}`;
        if (_waitHeader) meta = 'wait-header';
        if (_waitBodyOf !== undefined) meta = `wait-body-of=${_waitBodyOf}`;
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
                const savedBeforeFun = getLastExec();
                flushUntil(indent, null);
                ctxStack.push(ctx);
                ctx = makeCtx(indent, node, savedBeforeFun);
                continue;
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
        const cond = E(node.condition);
        return lang.loopHead(cond) + '\n' + B(node.body) + (lang.blockEnd ? '\n' + lang.blockEnd() : '');
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
        return lang.use ? lang.use(E(node.key)) : `# use ${E(node.key)}`;
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
    use:       key => `_api_key = ${key}`,
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
      if (/\{[A-Za-z_]\w*\}/.test(v)) return '`' + v.replace(/`/g, '\\`') + '`';
      return escapeString(v);
    },
    op: op => {
      const M = { '=': '===', '!=': '!==', 'and': '&&', 'or': '||', 'not': '!',
                  'xor': '^', 'is': '===', 'in': 'in', '^': '**', '//': '/' };
      return M[op] ?? op;
    },
    assign:    (t, v, lazy) => lazy ? `let ${t} = typeof ${t} !== 'undefined' ? ${t} : ${v};` : `let ${t} = ${v};`,
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
    use:       key => `const _apiKey = ${key};`,
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
    assign:    (t, v, lazy) => lazy
      ? `let ${t}: any = typeof ${t} !== 'undefined' ? ${t} : ${v};`
      : `const ${t} = ${v};`,
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
    use:       key => `USE API KEY ${key}`,
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
      let out = renderProgram(ast, lang);
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

  ep.insertBefore(lensPanel, ep.children[1]);

  // ── Lens controls in graph panel ────────────────────────────────────────────
  const cpEl      = document.getElementById('cp');
  const exportWrap = document.getElementById('export-wrap');

  const lensWrap = document.createElement('div');
  lensWrap.id = 'lens-wrap';
  lensWrap.innerHTML = `
    <select class="gsel" id="lens-lang-sel">
      <option value="python">Python</option>
      <option value="javascript">JavaScript</option>
      <option value="typescript">TypeScript</option>
      <option value="pseudocode">Pseudocode</option>
    </select>
    <button class="gb" id="lens-btn">Lens</button>
  `;
  cpEl.insertBefore(lensWrap, exportWrap);
  const sep = document.createElement('div');
  sep.className = 'gs';
  cpEl.insertBefore(sep, exportWrap);

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
    editorSub.style.display = 'none';
    ep.style.gridTemplateRows = '1fr 6px 200px';
    lensPanel.style.display   = 'flex';
    lensPanel.style.height    = '';
    lensCode.contentEditable  = 'true';
    lensEdited = false;
    renderLens();
  }

  function closeLens() {
    lensOpen   = false;
    lensEdited = false;
    lensBtn.classList.remove('on');
    lensPanel.style.display  = 'none';
    lensCode.contentEditable = 'false';  // prevent focus stealing when hidden
    editorSub.style.display  = 'flex';
    ep.style.gridTemplateRows = '';
    lensConfirm.style.display = 'none';
    // Return focus to the source editor
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

// ── Apps Script transpiler + deployment ──────────────────────────────────────
//
// Converts WaitBlock AST nodes to Google Apps Script trigger functions.
// Called automatically from the Run button when WaitBlock nodes are present.

const AppsScriptTranspiler = (() => {

  // ── Value serializer: IVX runtime value → JS literal string ──────────────
  function jsLiteral(value) {
    if (value === null || value === undefined) return 'null';
    if (value === true)  return 'true';
    if (value === false) return 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(jsLiteral).join(', ') + ']';
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .filter(([k]) => !String(k).startsWith('__'))
        .map(([k, v]) => `${JSON.stringify(String(k))}: ${jsLiteral(v)}`);
      return '{' + entries.join(', ') + '}';
    }
    return JSON.stringify(String(value));
  }

  // ── AST node → JS string, resolving identifiers against globals snapshot ──
  function emitExpr(node, globals) {
    if (!node) return 'null';
    switch (node.type) {
      case 'NumberLit':  return String(node.value);
      case 'BoolLit':    return node.value === null ? 'null' : node.value ? 'true' : 'false';
      case 'StringLit':  return JSON.stringify(node.value);
      case 'ListLit':    return '[' + node.elements.map(e => emitExpr(e, globals)).join(', ') + ']';
      case 'DictLit':    return '{' + node.pairs.map(p =>
        `${emitExpr(p.key, globals)}: ${emitExpr(p.value, globals)}`).join(', ') + '}';
      case 'Identifier': {
        // If we have a snapshot value, bake it in as a literal
        if (globals && globals.has(node.name)) return jsLiteral(globals.get(node.name));
        return node.name;
      }
      case 'BinOp': {
        const opMap = { '=': '===', '!=': '!==', 'and': '&&', 'or': '||',
                        'not': '!', '^': '**', '//': 'Math.floor', 'xor': '^' };
        const op = opMap[node.op] ?? node.op;
        if (node.op === '//') return `Math.floor(${emitExpr(node.left, globals)} / ${emitExpr(node.right, globals)})`;
        return `${emitExpr(node.left, globals)} ${op} ${emitExpr(node.right, globals)}`;
      }
      case 'UnaryOp':
        return `!${emitExpr(node.operand, globals)}`;
      case 'Call':
        return `${node.name}(${node.args.map(a => emitExpr(a, globals)).join(', ')})`;
      case 'Invoke':
        return `${emitExpr(node.callee, globals)}(${node.args.map(a => emitExpr(a, globals)).join(', ')})`;
      case 'MemberAccess':
        return `${emitExpr(node.object, globals)}.${node.field}`;
      default:
        return '/* ? */';
    }
  }

  function emitStmt(node, globals, indent = '') {
    if (!node) return '';
    const E = n => emitExpr(n, globals);
    const S = (n, ind) => emitStmt(n, globals, ind ?? indent);
    const B = (stmts, ind) => (Array.isArray(stmts) ? stmts : []).map(s => emitStmt(s, globals, ind ?? indent + '  ')).join('\n');

    switch (node.type) {
      case 'Assign': {
        const target = node.target ? E(node.target) : node.name;
        return `${indent}var ${target} = ${E(node.expr)};`;
      }
      case 'Say':
        return `${indent}Logger.log(${E(node.expr)});`;
      case 'Gmail': {
        const to      = node.to      ? E(node.to)      : '""';
        const subject = node.subject ? E(node.subject) : '""';
        const body    = node.body    ? E(node.body)     : '""';
        return `${indent}GmailApp.sendEmail(${to}, ${subject}, ${body});`;
      }
      case 'If': {
        let out = `${indent}if (${E(node.condition)}) {\n${B(node.body)}\n${indent}}`;
        if (node.else_?.length) out += ` else {\n${B(node.else_)}\n${indent}}`;
        return out;
      }
      case 'Loop':
        return `${indent}while (${E(node.condition)}) {\n${B(node.body)}\n${indent}}`;
      case 'For':
        return `${indent}for (var ${node.iterVar} of ${node.target}) {\n${B(node.body)}\n${indent}}`;
      case 'Give':
        return `${indent}return ${E(node.expr)};`;
      case 'ExprStatement':
        return `${indent}${E(node.expr)};`;
      case 'SheetsOpen': {
        // Expand to Apps Script Sheets API calls
        const name = E(node.name);
        return `${indent}var _ss = SpreadsheetApp.openByName(${name});\n${indent}var _sheet = _ss.getActiveSheet();`;
      }
      default:
        return `${indent}// (${node.type})`;
    }
  }

  function transpileBodyToJS(stmts, globals) {
    if (!Array.isArray(stmts) || !stmts.length) return '  // (empty body)';
    return stmts.map(s => {
      try { return emitStmt(s, globals, '  '); }
      catch(e) { return `  // (could not transpile ${s?.type}: ${e.message})`; }
    }).filter(Boolean).join('\n');
  }

  // Transpile a single WaitBlock node to a .gs function + trigger registration
  function transpileWaitBlock(node, index, globals) {
    const fnName    = `ivxTrigger_${index}`;
    const trigger   = node.trigger;
    const recurring = node.recurring;

    const jsBody = transpileBodyToJS(node.body, globals);

    // Trigger installation
    let triggerSetup = '';
    if (trigger === 'time') {
      const timeStr = node.source?.value ?? '09:00';
      const [hh, mm] = timeStr.split(':');
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (recurring) {
        triggerSetup = `  ScriptApp.newTrigger('${fnName}')
    .timeBased()
    .atHour(${parseInt(hh,10)})
    .nearMinute(${parseInt(mm||'0',10)})
    .everyDays(1)
    .create();`;
      } else {
        // Build the target date string in the user's local timezone
        // so Apps Script schedules it correctly regardless of server timezone
        triggerSetup = `  // Target: ${timeStr} in ${tz}
  var _now = new Date();
  var _tzOffset = new Date().toLocaleString('en-US', {timeZone: '${tz}', hour12: false, hour: '2-digit', minute: '2-digit'});
  var _d = new Date();
  _d.setHours(${parseInt(hh,10)}, ${parseInt(mm||'0',10)}, 0, 0);
  // Adjust for timezone offset between UTC and ${tz}
  var _localNow = new Date(_now.toLocaleString('en-US', {timeZone: '${tz}'}));
  var _tzDiff = _now - _localNow;
  _d = new Date(_d.getTime() + _tzDiff);
  if (_d < new Date()) _d.setDate(_d.getDate() + 1);
  ScriptApp.newTrigger('${fnName}').timeBased().at(_d).create();`;
      }
    } else if (trigger === 'sheets') {
      const sheetName = globals && node.source?.type === 'Identifier' && globals.has(node.source.name)
        ? jsLiteral(globals.get(node.source.name))
        : (node.source ? emitExpr(node.source, globals) : '""');
      triggerSetup = `  var _ss = SpreadsheetApp.openByName(${sheetName});
  ScriptApp.newTrigger('${fnName}').forSpreadsheet(_ss).onEdit().create();`;
    } else if (trigger === 'email') {
      triggerSetup = `  ScriptApp.newTrigger('${fnName}')
    .timeBased().everyMinutes(${recurring ? 5 : 1}).create();`;
    }

    // One-shot self-deletion
    const deleteSelf = recurring ? '' : `
  // One-shot: remove this trigger after firing
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === '${fnName}')
    .forEach(t => ScriptApp.deleteTrigger(t));`;

    // Trigger-specific preamble
    let preamble = '';
    if (trigger === 'email') {
      const addr = node.source ? emitExpr(node.source, globals) : '""';
      preamble = `  var _threads = GmailApp.search('is:unread from:' + ${addr}, 0, 1);
  if (!_threads.length) return;
  var _msg = _threads[0].getMessages()[0];
  var request = { subject: _msg.getSubject(), from: _msg.getFrom(), body: _msg.getPlainBody() };
  _msg.markRead();`;
    } else if (trigger === 'sheets') {
      preamble = `  var request = e;`;
    }

    const fn = `function ${fnName}(e) {
${preamble}
${jsBody}
${deleteSelf}
}`;

    return { fnName, fn, triggerSetup };
  }

  // Build the full Apps Script project
  function buildProject(waitBlocks, globals) {
    const functions = [], setups = [];
    const services  = new Set();

    waitBlocks.forEach((node, i) => {
      const { fn, fnName, triggerSetup } = transpileWaitBlock(node, i, globals);
      functions.push(fn);
      if (triggerSetup) setups.push(triggerSetup);

      // Scan trigger type AND entire body recursively for every service used
      const scanNode = n => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(scanNode); return; }
        switch (n.type) {
          case 'Gmail':       services.add('gmail');  break;
          case 'SheetsOpen':  services.add('sheets'); break;
          case 'Save':        services.add('drive');  break;
        }
        // Recurse into all child arrays
        if (Array.isArray(n.body))    n.body.forEach(scanNode);
        if (Array.isArray(n.else_))   n.else_.forEach(scanNode);
        if (Array.isArray(n.params))  n.params.forEach(scanNode);
        if (n.expr)      scanNode(n.expr);
        if (n.condition) scanNode(n.condition);
        if (n.left)      scanNode(n.left);
        if (n.right)     scanNode(n.right);
      };

      // Trigger type adds its own service
      if (node.trigger === 'email')  services.add('gmail');
      if (node.trigger === 'sheets') services.add('sheets');

      // Scan body for everything else
      scanNode(node.body);
    });

    const oauthScopes = [
      'https://www.googleapis.com/auth/script.scriptapp',
      'https://www.googleapis.com/auth/script.projects',
    ];
    if (services.has('gmail'))  oauthScopes.push('https://www.googleapis.com/auth/gmail.modify');
    if (services.has('sheets')) oauthScopes.push('https://www.googleapis.com/auth/spreadsheets');
    if (services.has('drive'))  oauthScopes.push('https://www.googleapis.com/auth/drive.file');

    const setupFn = `function ivxSetupTriggers() {
  // Remove existing IVX triggers
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction().startsWith('ivxTrigger_'))
    .forEach(t => ScriptApp.deleteTrigger(t));
  // Install new triggers
${setups.join('\n')}
}`;

    const code = [
      '// Auto-generated by IVX — do not edit manually',
      '// Re-run your IVX program to regenerate',
      '',
      setupFn,
      '',
      ...functions,
    ].join('\n');

    // Scopes populated by body scanner above

    const manifest = JSON.stringify({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dependencies: {},
      exceptionLogging: 'STACKDRIVER',
      runtimeVersion: 'V8',
      oauthScopes,
    }, null, 2);

    return { code, manifest };
  }

  // Deploy to Apps Script REST API
  async function deploy(waitBlocks, globals, token) {
    if (!token) throw new Error('Not signed in to Google');

    const { code, manifest } = buildProject(waitBlocks, globals);

    const API    = 'https://script.googleapis.com/v1/projects';
    const DRIVE  = 'https://www.googleapis.com/drive/v3';
    const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

    // Get or create the persistent IVX script project
    let scriptId = await _loadScriptId(token, DRIVE);
    if (scriptId) {
      const check = await fetch(API + '/' + scriptId, { headers });
      if (!check.ok) scriptId = null;
    }
    if (!scriptId) {
      const res = await fetch(API, {
        method: 'POST', headers,
        body: JSON.stringify({ title: 'IVX Triggers' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error('Apps Script create failed: ' + (err?.error?.message ?? res.statusText));
      }
      scriptId = (await res.json()).scriptId;
      await _saveScriptId(scriptId, token, DRIVE, UPLOAD);
    }

    // Update project content
    const upRes = await fetch(API + '/' + scriptId + '/content', {
      method: 'PUT', headers,
      body: JSON.stringify({
        files: [
          { name: 'ivx_triggers', type: 'SERVER_JS', source: code },
          { name: 'appsscript',   type: 'JSON',       source: manifest },
        ],
      }),
    });
    if (!upRes.ok) {
      const err = await upRes.json().catch(() => ({}));
      if (err?.error?.code === 404) {
        await _saveScriptId(null, token, DRIVE, UPLOAD);
        throw new Error('Script project was deleted — run again to recreate');
      }
      throw new Error('Apps Script update failed: ' + (err?.error?.message ?? upRes.statusText));
    }

    return { scriptId, triggerCount: waitBlocks.length };
  }

  // Persist script ID in Drive as ivx_config.json
  async function _loadScriptId(token, DRIVE) {
    const h = { 'Authorization': 'Bearer ' + token };
    const q = encodeURIComponent("name='ivx_config.json' and trashed=false");
    const res = await fetch(DRIVE + '/files?q=' + q + '&fields=files(id)&spaces=drive', { headers: h });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.files || !data.files.length) return null;
    const content = await fetch(DRIVE + '/files/' + data.files[0].id + '?alt=media', { headers: h });
    if (!content.ok) return null;
    try { const j = await content.json(); return j.scriptId || null; } catch(e) { return null; }
  }

  async function _saveScriptId(scriptId, token, DRIVE, UPLOAD) {
    const h = { 'Authorization': 'Bearer ' + token };
    const body = JSON.stringify({ scriptId: scriptId });
    const q = encodeURIComponent("name='ivx_config.json' and trashed=false");
    const res = await fetch(DRIVE + '/files?q=' + q + '&fields=files(id)&spaces=drive', { headers: h });
    const data = res.ok ? await res.json() : {};
    if (data.files && data.files.length) {
      await fetch(UPLOAD + '/files/' + data.files[0].id + '?uploadType=media', {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body,
      });
    } else {
      const meta = JSON.stringify({ name: 'ivx_config.json', mimeType: 'application/json' });
      const boundary = 'ivxboundary';
      const form = '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + meta +
                   '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + body +
                   '\r\n--' + boundary + '--';
      await fetch(UPLOAD + '/files?uploadType=multipart', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
        body: form,
      });
    }
  }

  function extractWaitBlocks(ast) {
    const blocks = [];
    const walk = stmts => {
      if (!Array.isArray(stmts)) return;
      for (const stmt of stmts) {
        if (!stmt) continue;
        if (stmt.type === 'WaitBlock') blocks.push(stmt);
        if (Array.isArray(stmt.body))  walk(stmt.body);
        if (Array.isArray(stmt.else_)) walk(stmt.else_);
      }
    };
    walk(ast?.body);
    return blocks;
  }

  return { deploy, extractWaitBlocks, buildProject };
})();

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

  const meta = document.createElementNS('http://www.w3.org/2000/svg', 'metadata');
  meta.setAttribute('id', 'ivx-metadata');
  meta.textContent = JSON.stringify({
    format: 'ivx.graph.v1',
    exportedAt: new Date().toISOString(),
    blocks: lastRenderedBlocks,
  });
  clone.insertBefore(meta, clone.firstChild);

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
  const payload = {
    format: 'ivx.graph.v1',
    graph: map,
    blocks: lastRenderedBlocks,
  };
  downloadFile('graph.json', JSON.stringify(payload, null, 2), 'application/json');
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
const _KW_NODE     = new Set(['if','fork','loop','dot','con','take','say','give','fun','class','end','from','make','note','for','in','wait','del','ask','post','use','sheets','email','by']);
const _KW_FLOW     = new Set(['so','then','else']);
const _KW_OUTGOING = new Set(['prev','next','use']);
const _KW_LOGIC    = new Set(['not','and','or','xor','is','yes','no','none']);

// Tokenize a raw source line into typed spans, then emit HTML.
// Handles strings, numbers, lists, dicts, keywords — all before HTML escaping
// so bracket/quote characters are never corrupted by &amp; etc.
function highlightLine(line, allVars = new Set(), allClasses = new Set()) {
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
      if (allClasses.has(word))            cls = 'kw-classname';
      else if (isFunCall)                  cls = 'kw-funcall';
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
  const takeMatches = src.match(/\btake\s+(?:(?:int|flt|str|bin|list|dict)\s*\(\s*)?([A-Za-z_]\w*)/g);
  if (takeMatches) takeMatches.forEach(m => { const v = m.match(/([A-Za-z_]\w*)(?:\s*\))?$/); if (v) allVars.add(v[1]); });
  // Also collect lazy-declared variables (name?) so they color as vars
  const lazyMatches = src.match(/\b([A-Za-z_]\w*)\?/g);
  if (lazyMatches) lazyMatches.forEach(m => { allVars.add(m.slice(0, -1)); });

  // Collect declared class names so both declarations and constructor calls
  // share one visual identity.
  const allClasses = new Set();
  const classMatches = src.match(/\bclass\s+([A-Za-z_]\w*)/g);
  if (classMatches) classMatches.forEach(m => { const c = m.match(/class\s+([A-Za-z_]\w*)/); if (c) allClasses.add(c[1]); });

  return src.split('\n').map(line => highlightLine(line, allVars, allClasses)).join('\n');
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

  let interpGlobals = null;
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
    interpGlobals = interp.globals;
  } catch(e) {
    termError('Fatal: ' + (e.message ?? String(e)));
  }

  termInfo('─── run finished ───');
  termRun.textContent = '▶ Run';
  termRun.classList.remove('running');
  _running = false;

  // ── Deploy wait blocks to Apps Script ──────────────────────────────────────
  try {
    const parsed = parse(srcEl.value);
    const waitBlocks = AppsScriptTranspiler.extractWaitBlocks(parsed.ast);
    if (waitBlocks.length > 0 && driveToken) {
      termInfo(`⏳ Deploying ${waitBlocks.length} trigger${waitBlocks.length > 1 ? 's' : ''} to Google Apps Script…`);
      try {
        const { scriptId, triggerCount } = await AppsScriptTranspiler.deploy(
          waitBlocks, interpGlobals, driveToken
        );
        const recurring = waitBlocks.filter(b => b.recurring).length;
        const oneshot   = waitBlocks.filter(b => !b.recurring).length;
        const parts = [];
        if (oneshot)   parts.push(`${oneshot} one-shot`);
        if (recurring) parts.push(`${recurring} recurring`);
        termInfo(`✓ ${parts.join(', ')} trigger${triggerCount > 1 ? 's' : ''} deployed — open Apps Script to run ivxSetupTriggers() once`);
      } catch(e) {
        termError(`Apps Script deploy failed: ${e.message}`);
      }
    } else if (waitBlocks.length > 0 && !driveToken) {
      termInfo(`ℹ Sign in to Google to deploy ${waitBlocks.length} wait trigger${waitBlocks.length > 1 ? 's' : ''}`);
    } else if (waitBlocks.length === 0) {
      // Debug: check if parse found any WaitBlock nodes
      const allTypes = parsed.ast?.body?.map(n => n.type) ?? [];
      if (srcEl.value.includes('wait ')) {
        termInfo(`⚠ wait block detected in source but not parsed — node types: ${allTypes.join(', ')}`);
      }
    }
  } catch(e) {
    termError(`Apps Script setup error: ${e.message}`);
    console.error('Apps Script deploy error:', e);
  }

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

// ── Terminal minimize / restore ───────────────────────────────────────────────
(function() {
  const termEl      = document.getElementById('term');
  const termMinBtn  = document.getElementById('term-minimize');
  const ep          = document.getElementById('ep');
  const COLLAPSED_H = 28; // just the header bar
  let collapsed     = false;
  let savedRows     = '';  // remember last grid height before collapsing

  termMinBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    if (collapsed) {
      savedRows = ep.style.gridTemplateRows || '1fr 6px 200px';
      ep.style.gridTemplateRows = `1fr 6px ${COLLAPSED_H}px`;
      termEl.classList.add('collapsed');
      termMinBtn.textContent    = '▲';
      termMinBtn.title          = 'Restore terminal';
    } else {
      ep.style.gridTemplateRows = savedRows;
      termEl.classList.remove('collapsed');
      termMinBtn.textContent    = '—';
      termMinBtn.title          = 'Minimize terminal';
    }
  });
})();
const DRIVE_CLIENT_ID = '857056430546-3o2o9mhula9lkm1vcpidu61919h3umev.apps.googleusercontent.com';
const DRIVE_SCOPE     = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/script.projects',
].join(' ');
const DRIVE_FOLDER    = 'IVX';

let driveToken     = null;   // current access token
let driveFolderId  = null;   // ID of IVX/ folder in Drive
let driveCurrentId = null;   // ID of currently open file
let driveCurrentName = null; // name of currently open file
let driveUnsaved   = false;  // unsaved changes flag
let driveTokenClient = null; // GIS token client

const driveConnectBtn   = document.getElementById('drive-connect-btn');
const driveFileList     = document.getElementById('drive-file-list');
const driveSignedInEl   = document.getElementById('drive-hdr-signed-in');
const driveNewBtn       = document.getElementById('drive-new-btn');
const driveSaveBtn      = document.getElementById('drive-save-btn');
const driveSignoutBtn   = document.getElementById('drive-signout-btn');
const driveFilesBtn     = document.getElementById('drive-files-btn');
const driveFilename     = document.getElementById('drive-filename');

// ── Files dropdown toggle ─────────────────────────────────────────────────────
driveFilesBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = driveFileList.style.display === 'block';
  driveFileList.style.display = open ? 'none' : 'block';
  if (!open) driveListFiles();
});
document.addEventListener('click', () => { driveFileList.style.display = 'none'; });
driveFileList.addEventListener('click', e => e.stopPropagation());

// ── Auth ──────────────────────────────────────────────────────────────────────
function driveInit() {
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
      driveConnectBtn.style.display = 'none';
      driveSignedInEl.style.display = 'flex';
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
  driveConnectBtn.style.display = '';
  driveSignedInEl.style.display = 'none';
  driveFileList.style.display = 'none';
  driveFileList.innerHTML = '';
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
      item.addEventListener('click', () => { driveOpenFile(f.id, f.name); driveFileList.style.display = 'none'; });
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

window.addEventListener('load', driveInit);

// ── Bug report ────────────────────────────────────────────────────────────────
document.getElementById('bug-btn').addEventListener('click', () => {
  // Remove any existing modal
  document.getElementById('bug-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'bug-modal';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,.6)',
    zIndex: '20000', display: 'flex', alignItems: 'center', justifyContent: 'center',
  });

  const box = document.createElement('div');
  Object.assign(box.style, {
    background: '#1c1c28', border: '1px solid #3a3a5c', borderRadius: '10px',
    padding: '20px', width: '460px', maxWidth: '90vw',
    display: 'flex', flexDirection: 'column', gap: '12px',
    fontFamily: 'system-ui, sans-serif', boxShadow: '0 16px 48px rgba(0,0,0,.6)',
  });

  // Title
  const title = document.createElement('div');
  title.textContent = '🐛 Report a Bug';
  Object.assign(title.style, { fontSize: '15px', fontWeight: '700', color: '#cdd6f4' });
  box.appendChild(title);

  // Description label + textarea
  const lbl = document.createElement('label');
  lbl.textContent = 'What went wrong?';
  Object.assign(lbl.style, { fontSize: '12px', color: '#9ca3af' });
  box.appendChild(lbl);

  const desc = document.createElement('textarea');
  desc.placeholder = 'Describe the bug — what you did, what you expected, what happened instead…';
  desc.rows = 5;
  Object.assign(desc.style, {
    background: '#0f0f14', color: '#cdd6f4', border: '1px solid #3a3a5c',
    borderRadius: '6px', padding: '8px 10px', fontSize: '12px',
    fontFamily: 'inherit', resize: 'vertical', outline: 'none', width: '100%',
    boxSizing: 'border-box',
  });
  box.appendChild(desc);

  // Include source checkbox
  const srcRow = document.createElement('label');
  Object.assign(srcRow.style, { display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '12px', color: '#9ca3af', cursor: 'pointer' });
  const srcCheck = document.createElement('input');
  srcCheck.type = 'checkbox';
  srcCheck.checked = true;
  srcRow.appendChild(srcCheck);
  srcRow.appendChild(document.createTextNode('Include current program source'));
  box.appendChild(srcRow);

  // Buttons
  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, {
    background: 'none', border: '1px solid #3a3a5c', color: '#6b7280',
    borderRadius: '5px', padding: '6px 14px', cursor: 'pointer', fontSize: '12px',
    fontFamily: 'inherit',
  });
  cancelBtn.addEventListener('click', () => overlay.remove());

  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Open in Email';
  Object.assign(sendBtn.style, {
    background: '#1f4d6e', border: '1px solid #60a5fa', color: '#93c5fd',
    borderRadius: '5px', padding: '6px 14px', cursor: 'pointer', fontSize: '12px',
    fontFamily: 'inherit', fontWeight: '600',
  });

  sendBtn.addEventListener('click', () => {
    const userDesc  = desc.value.trim() || '(no description provided)';
    const ivxSource = srcCheck.checked && typeof srcEl !== 'undefined'
      ? srcEl.value.trim() : '';
    const browserInfo = `Browser: ${navigator.userAgent}`;
    const ivxVersion  = 'IVX Build v3';

    let body = `Bug Report\n${'─'.repeat(40)}\n\n${userDesc}\n\n`;
    body += `${browserInfo}\n${ivxVersion}\n`;
    if (ivxSource) body += `\nProgram Source:\n${'─'.repeat(40)}\n${ivxSource}\n`;

    const subject = encodeURIComponent('IVX Bug Report');
    const bodyEnc = encodeURIComponent(body);
    window.location.href = `mailto:iceboltstartup@gmail.com?subject=${subject}&body=${bodyEnc}`;
    overlay.remove();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(sendBtn);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Close on outside click
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  setTimeout(() => desc.focus(), 50);
});