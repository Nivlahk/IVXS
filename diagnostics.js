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
   * Scans a single line of IVX code for syntax issues.
   * @param {string} line - The raw line text.
   * @returns {Object|null} Diagnostic object or null if valid.
   */
  function validateLine(line, lineNum) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('note ')) return null;

    // Tokenize roughly by whitespace (ignoring strings for now)
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;

    // Identify the primary keyword (ignoring incoming markers for now)
    let keyword = tokens[0].toLowerCase();
    let shiftedTokens = tokens;

    // Handle incoming keys (then, else) which might precede the node keyword
    if (['then', 'else'].includes(keyword)) {
      if (tokens.length > 1) {
        keyword = tokens[1].toLowerCase();
        shiftedTokens = tokens.slice(1);
      } else {
        // Just 'then' or 'else' on a line is structurally okay but needs context
        return null; 
      }
    }

    const rule = RULES[keyword];
    if (rule) {
      const error = rule.validate(shiftedTokens);
      if (error) {
        return {
          line: lineNum,
          message: error,
          severity: SEVERITY.ERROR,
          keyword: keyword
        };
      }
    }

    return null;
  }

  /**
   * Scans an entire source block.
   * @param {string} code - The full source text.
   * @returns {Array} List of diagnostic objects.
   */
  function getDiagnostics(code) {
    const lines = code.split('\n');
    const diagnostics = [];

    lines.forEach((line, i) => {
      const diag = validateLine(line, i + 1);
      if (diag) diagnostics.push(diag);
    });

    return diagnostics;
  }

  return { getDiagnostics, SEVERITY };
})();
