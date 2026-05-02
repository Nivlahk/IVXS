"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Interpreter = exports.Env = void 0;

class Env {
    constructor(parent = null) {
        this.parent = parent;
        this.vars = new Map();
    }
    get(name) {
        if (this.vars.has(name)) return this.vars.get(name);
        if (this.parent) return this.parent.get(name);
        return undefined;
    }
    set(name, value) {
        if (this.vars.has(name)) { this.vars.set(name, value); return; }
        if (this.parent && this.parent.has(name)) { this.parent.set(name, value); return; }
        this.vars.set(name, value);
    }
    has(name) {
        if (this.vars.has(name)) return true;
        return this.parent?.has(name) ?? false;
    }
    child() { return new Env(this); }
}
exports.Env = Env;

class Interpreter {
    constructor(options = {}) {
        this.onOutput = options.onOutput ?? (v => console.log(v));
        this.onInput = options.onInput ?? (() => "");
        this.globals = new Env();
    }

    async run(nodes, edges) {
        let currentNode = nodes.find(n => n.kind === 'Start') || nodes[0];
        const visited = new Set();
        let safetyCounter = 0;

        while (currentNode && safetyCounter < 10000) {
            safetyCounter++;
            const text = (currentNode.text || "").trim();
            let nextLabel = undefined;

            // 1. Handle Decisions (if/loop conditions)
            if (currentNode.kind === 'Decision') {
                const condition = text;
                const result = this.evalCondition(condition);
                nextLabel = result ? 'yes' : 'no';
            } 
            // 2. Handle Assignments
            else if (currentNode.kind === 'Process') {
                const parts = text.split(/\s+/);
                if (parts.length >= 2) {
                    const name = parts[0].trim();
                    const valExpr = parts.slice(1).join(' ').trim();
                    this.globals.set(name, this.evalExpr(valExpr));
                }
            } 
            // 3. Handle Output
            else if (currentNode.kind === 'Output') {
                this.onOutput(this.evalExpr(text));
            }

            // Note: This is a streamlined version of the kh interpreter
            // designed to run inside the VS Code extension host.
            const nextEdge = edges.find(e => e.from === currentNode.id && (nextLabel === undefined || e.label === nextLabel));
            if (!nextEdge) break;
            
            currentNode = nodes.find(n => n.id === nextEdge.to);
        }
    }

    evalExpr(expr) {
        if (this.globals.has(expr)) return this.globals.get(expr);
        if (!isNaN(expr)) return Number(expr);
        // Basic math: x + 1
        if (expr.includes('+')) {
            const p = expr.split('+');
            return this.evalExpr(p[0].trim()) + this.evalExpr(p[1].trim());
        }
        return expr.replace(/['"]/g, '');
    }

    evalCondition(cond) {
        if (cond.includes('<')) {
            const p = cond.split('<');
            return this.evalExpr(p[0].trim()) < this.evalExpr(p[1].trim());
        }
        if (cond.includes('>')) {
            const p = cond.split('>');
            return this.evalExpr(p[0].trim()) > this.evalExpr(p[1].trim());
        }
        return !!this.evalExpr(cond);
    }
}
exports.Interpreter = Interpreter;
