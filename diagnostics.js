/**
 * ivx-diagnostics.js — IVX Static Analysis Engine
 * Provides real-time feedback on syntax, structure, and logic.
 * Licensed under the Apache License, Version 2.0
 */

'use strict';

const IVXDiagnostics = (() => {
  
  const SEVERITY = {
    ERROR: 'error',
    WARNING: 'warning',
    INFO: 'info'
  };

  // Block-initiating keywords that REQUIRE the next line to be indented further
  const BLOCK_INITIATORS = new Set(['if', 'loop', 'fun', 'fork', 'try', 'err', 'every']);

  const RULES = {
    'make': {
      validate: (tokens) => {
        if (tokens.length < 2) return "Missing variable name after 'make'";
        if (tokens.length < 3) return "Missing value or expression after 'make " + tokens[1] + "'";
        return null;
      }
    },
    'take': {
      validate: (tokens) => {
        if (tokens.length < 2) return "Missing variable name after 'take'";
        return null;
      }
    },
    'if': {
      validate: (tokens) => {
        if (tokens.length < 2) return "Missing condition after 'if'";
        return null;
      }
    },
    'loop': {
      validate: (tokens) => {
        if (tokens.length < 2) return "Missing condition after 'loop'";
        return null;
      }
    },
    'say': {
      validate: (tokens) => {
        if (tokens.length < 2) return "Missing expression after 'say'";
        return null;
      }
    },
    'print': {
      validate: (tokens) => {
        if (tokens.length < 2) return "Missing expression after 'print'";
        return null;
      }
    },
    'give': {
      validate: (tokens) => {
        if (tokens.length < 2) return "Missing expression after 'give'";
        return null;
      }
    },
    'fun': {
      validate: (tokens) => {
        if (tokens.length < 2) return "Missing function name after 'fun'";
        const sig = tokens.slice(1).join(' ');
        if (!sig.includes('(') || !sig.includes(')')) return "Malformed function signature. Expected 'fun name(params)'";
        return null;
      }
    },
    'wait': {
      validate: (tokens) => {
        if (tokens.length < 2) return "Missing duration or condition after 'wait'";
        return null;
      }
    }
  };

  /**
   * Helper to get indentation and tokens for a line.
   */
  function parseLineInfo(line, lineNum) {
    const rawTrimmed = line.trimStart();
    const indent = line.length - rawTrimmed.length;
    
    const commentIdx = rawTrimmed.indexOf('note ');
    const trimmed = (commentIdx >= 0 ? rawTrimmed.slice(0, commentIdx) : rawTrimmed).trim();
    
    if (!trimmed) return { line: lineNum, indent, tokens: [], keyword: null, isEmpty: true };

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    let keyword = tokens[0].toLowerCase();
    let shiftedTokens = tokens;

    // Normalize incoming keys
    if (['then', 'else'].includes(keyword)) {
      if (tokens.length > 1) {
        keyword = tokens[1].toLowerCase();
        shiftedTokens = tokens.slice(1);
      } else {
        // standalone else/then
        shiftedTokens = [];
      }
    }

    return {
      line: lineNum,
      indent,
      tokens: shiftedTokens,
      keyword,
      incoming: ['then', 'else'].includes(tokens[0].toLowerCase()) ? tokens[0].toLowerCase() : null,
      isEmpty: false
    };
  }

  /**
   * Scans an entire source block for both Syntax (Line) and Structure (Multi-line).
   * @param {string} code - The full source text.
   * @returns {Array} List of diagnostic objects.
   */
  function getDiagnostics(code) {
    const rawLines = code.split('\n');
    const diagnostics = [];
    
    // Pass 1: Parse all lines into info objects
    const lines = rawLines.map((l, i) => parseLineInfo(l, i + 1));
    const activeLines = lines.filter(l => !l.isEmpty);

    // Pass 2: Structural Analysis
    const ifStack = new Map(); // Track last 'if' at each indent level

    for (let i = 0; i < activeLines.length; i++) {
      const current = activeLines[i];
      const next = activeLines[i + 1];

      // --- 1. Line Syntax Check ---
      const rule = RULES[current.keyword];
      if (rule) {
        const error = rule.validate(current.tokens);
        if (error) {
          diagnostics.push({ line: current.line, message: error, severity: SEVERITY.ERROR });
        }
      }

      // --- 2. Orphan Check (else) ---
      if (current.incoming === 'else') {
        const matchingIf = ifStack.get(current.indent);
        if (!matchingIf) {
          diagnostics.push({ line: current.line, message: "Orphaned 'else' - no matching 'if' found at this indentation level", severity: SEVERITY.ERROR });
        }
      }

      // Update ifStack
      if (current.keyword === 'if') {
        ifStack.set(current.indent, current);
      } else if (current.incoming !== 'else' && current.indent <= (ifStack.get(current.indent)?.indent ?? -1)) {
        // If we dedented or stayed at same indent with a non-else, clear the 'if' for this level
        ifStack.delete(current.indent);
      }

      // --- 3. Empty Block Check ---
      if (BLOCK_INITIATORS.has(current.keyword)) {
        if (!next || next.indent <= current.indent) {
          diagnostics.push({ line: current.line, message: `Expected an indented block after '${current.keyword}'`, severity: SEVERITY.ERROR });
        }
      }
    }

    return diagnostics;
  }

  return { getDiagnostics, SEVERITY };
})();
