// Reads the error codes a module raises from the arguments of its raise calls,
// for the protocol completeness gates. Where a call takes its code, the code
// must be a plain string literal, a conditional whose every result is one
// (JS a ? 'A' : 'B', Python 'A' if a else 'B'), or the bare `code` parameter
// inside a forwarding helper (const fail = (code) => ..., def _fail(code):).
// Anything else (a template, f-string, concatenation, method call, variable)
// is reported as dynamic, so the gate refuses it instead of missing a code.
// Comments are ignored. A text scan cannot follow aliases (const boom = fail),
// so a raise must call one of the given names directly.
const CODE = /^[A-Z][A-Z0-9_]*[A-Z0-9]$/;

function stringEnd(source, start) {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') index++;
    else if (source[index] === quote) return index + 1;
    else if (source[index] === '\n' && quote !== '`') break;
  }
  throw new Error(`unterminated string at ${start}`);
}

// The text between a call's parentheses, skipping strings.
function argumentsAt(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') { index = stringEnd(source, index) - 1; continue; }
    if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`unbalanced call at ${open}`);
}

// The source with comments blanked (newlines kept), so a commented-out call
// neither counts nor hides; docstrings are blanked too.
function withoutComments(source, python) {
  let out = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const triple = python && (source.startsWith('"""', index) || source.startsWith("'''", index));
    const comment = python ? char === '#' : source.startsWith('//', index) || source.startsWith('/*', index);
    if (triple || comment) {
      const close = triple ? source.slice(index, index + 3) : python || source[index + 1] === '/' ? '\n' : '*/';
      const found = source.indexOf(close, index + (triple ? 3 : python ? 1 : 2));
      if (found < 0 && close !== '\n') throw new Error(`unterminated ${triple ? 'string' : 'comment'} at ${index}`);
      const end = found < 0 ? source.length : close === '\n' ? found : found + close.length;
      out += source.slice(index, end).replace(/[^\n]/g, ' '); index = end - 1;
    } else if (char === '"' || char === "'" || char === '`') {
      const end = stringEnd(source, index);
      out += source.slice(index, end); index = end - 1;
    } else out += char;
  }
  return out;
}

// Replaces each string literal with a §n token; plain means no template or prefix (f, r, b).
function tokenize(text) {
  const values = []; let rest = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || char === "'" || char === '`') {
      const end = stringEnd(text, index);
      values.push({ value: text.slice(index + 1, end - 1), plain: char !== '`' && !/[A-Za-z]$/.test(text.slice(0, index)) });
      rest += ` §${values.length - 1} `; index = end - 1;
    } else rest += char;
  }
  return { values, rest };
}

// First index from start, outside brackets, where found(index) holds; -1 if none.
function scan(text, start, found) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (depth === 0 && found(index)) return index;
  }
  return -1;
}
const split = (text) => { const parts = []; let from = 0, at; while ((at = scan(text, from, (index) => text[index] === ',')) >= 0) { parts.push(text.slice(from, at)); from = at + 1; } return [...parts, text.slice(from)].filter((part, index, all) => part.trim() || index < all.length - 1); };

// JS a ? b : c, skipping ?. and ??; returns [b, c].
function ternary(text) {
  const question = (index) => text[index] === '?' && text[index + 1] !== '.' && text[index + 1] !== '?' && text[index - 1] !== '?';
  const at = scan(text, 0, question);
  if (at < 0) return null;
  let nested = 0;
  const colon = scan(text, at + 1, (index) => { if (question(index)) nested++; else if (text[index] === ':') { if (!nested) return true; nested--; } return false; });
  return colon < 0 ? null : [text.slice(at + 1, colon), text.slice(colon + 1)];
}
// Python b if a else c; returns [b, c].
function conditional(text) {
  const word = (name) => (index) => text.startsWith(name, index) && !/\w/.test(text[index - 1] ?? '') && !/\w/.test(text[index + name.length] ?? '');
  const at = scan(text, 0, word('if'));
  const otherwise = at < 0 ? -1 : scan(text, at + 2, word('else'));
  return otherwise < 0 ? null : [text.slice(0, at), text.slice(otherwise + 4)];
}

// True when every result of the expression is a plain code literal; collects them all.
function codeExpression(text, values, codes) {
  const literal = /^§(\d+)$/.exec(text.trim());
  if (literal) {
    const item = values[Number(literal[1])];
    if (!item.plain || !CODE.test(item.value)) return false;
    codes.add(item.value);
    return true;
  }
  const branches = ternary(text) ?? conditional(text);
  if (!branches) return false;
  const results = branches.map((branch) => codeExpression(branch, values, codes));
  return results.every(Boolean);
}

// Bodies of top-level helpers named in names that take a code parameter, and their default codes.
function forwarders(source, names, codes, dynamic) {
  const bodies = [];
  const pattern = new RegExp(`^(?:(?:const|let)\\s+(${names})\\s*=\\s*\\(([^)]*)\\)\\s*=>|def\\s+(${names})\\(([^)]*)\\):)`, 'gm');
  for (const match of source.matchAll(pattern)) {
    const parameter = (match[2] ?? match[4]).split(',').map((item) => item.trim()).find((item) => /^code\b/.test(item));
    if (!parameter) continue;
    if (parameter !== 'code') {
      const fallback = /^code\s*=\s*(["'])([^"']*)\1$/.exec(parameter)?.[2];
      if (fallback && CODE.test(fallback)) codes.add(fallback); else dynamic.push(`${match[1] ?? match[3]}(${parameter})`);
    }
    const start = match.index + match[0].length;
    const length = source.slice(start).search(/\n(?=[^\s})\]])/);
    const end = length < 0 ? source.length : start + length;
    // The body may use code only to forward it once; any other use could rebind
    // it (code += ..., for code of ..., except ... as code).
    const body = source.slice(start, end);
    const uses = body.match(/(?<![\w.$])code(?![\w$])/g)?.length ?? 0;
    const forwards = body.match(new RegExp(`(?<![\\w.$])(?:${names})\\s*\\(\\s*code\\s*\\)`, 'g'))?.length ?? 0;
    if (uses !== 1 || forwards !== 1) dynamic.push(`${match[1] ?? match[3]}: code used other than forwarded once`);
    bodies.push([match.index, end]);
  }
  return bodies;
}

/**
 * raises: names whose single argument is the code (fail, AccountWriterError).
 * helpers: names whose optional second argument is the code (identifier).
 * Definitions (`def name(`, `class name(`, `function name(`) are skipped.
 */
export function raisedCodes(text, { raises, helpers = [] }) {
  const source = withoutComments(text, /^def \w+\(/m.test(text));
  const codes = new Set(); const dynamic = [];
  const names = [...raises, ...helpers].map((name) => name.replace(/[$]/g, '\\$')).join('|');
  const bodies = forwarders(source, names, codes, dynamic);
  // fail('A'), fail ('A'), fail?.('A') and a call split across lines.
  for (const match of source.matchAll(new RegExp(`(?<![\\w.$])(${names})\\s*(?:\\?\\.\\s*)?\\(`, 'g'))) {
    if (/(?:\bdef|\bclass|\bfunction)\s+$/.test(source.slice(Math.max(0, match.index - 12), match.index))) continue;
    const text = argumentsAt(source, match.index + match[0].length - 1);
    const { values, rest } = tokenize(text);
    const args = split(rest);
    // A spread argument (...list, *args, **kwargs) may carry any code.
    if (args.some((item) => /^\s*(?:\.\.\.|\*)/.test(item))) { dynamic.push(`${match[1]}(${text})`); continue; }
    const code = raises.includes(match[1]) ? (args.length === 1 ? args[0] : null) : (args.length <= 2 ? args[1] ?? '' : null);
    if (code === '') continue; // helper called with its default code
    if (code !== null && code.trim() === 'code' && bodies.some(([start, end]) => match.index > start && match.index < end)) continue;
    if (code === null || !codeExpression(code, values, codes)) dynamic.push(`${match[1]}(${text})`);
  }
  return { codes: [...codes].sort(), dynamic };
}
