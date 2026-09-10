// The arithmetic behind the calculator, worked out without a JavaScript engine.
//
// Asked for on 10 Sep 2026, in one line: "different calculator options for the
// teacher and if he want for the students also."
//
// A calculator has to read what a person typed, and on this product that means
// text arriving from a browser — which is the one kind of string this codebase
// refuses to run. `sanitizeInto` in mirrorScript.ts strips every script tag,
// every `on*` attribute and every `javascript:` URL out of a mirrored lesson
// before it is painted; handing the same class of string to eval() or
// new Function() here would open, inside the calculator, the exact door that
// sanitiser exists to keep shut. So this file tokenises the text, parses it
// into a tree, and walks the tree. There is no code path that can execute a
// string, and verify-mirror.mjs greps this file to make sure nobody adds one.
//
// It is also the foundation for the function plotter that comes next, which is
// why the shape is parse-once-evaluate-many: `compile()` turns a source string
// into a tree of closures and hands back a plain `(x) => number` that a plotter
// can call at several hundred sample points per frame without re-parsing,
// without allocating, and — the part that matters most — without ever throwing.
//
// Two kinds of wrong, deliberately kept apart:
//
//   a SYNTAX problem   `2+)`, `foo(3)`, `sin`  — throws ExpressionError with a
//                      sentence the tutor can act on. He mistyped; the whole
//                      point of a calculator is that it tells him where.
//   a MATHS problem    1/0, sqrt(-1), ln(0), tan(90°) — returns NaN. A plotter
//                      crossing an asymptote is not an error, it is a gap in a
//                      curve, and 800 gaps a frame must not be 800 exceptions.

/** A problem with what was typed, in words a tutor can act on. */
export class ExpressionError extends Error {
  /** Where in the source it went wrong, or -1. Lets a caller point at the character. */
  readonly at: number;
  constructor(message: string, at = -1) {
    super(message);
    this.name = 'ExpressionError';
    this.at = at;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The names the engine knows
// ─────────────────────────────────────────────────────────────────────────

const DEG = Math.PI / 180;

// Trigonometry in degrees is computed from the reduced angle, with the right
// angles answered exactly.
//
// Math.cos(90 * DEG) is 6.1e-17, not 0, and Math.tan(90 * DEG) is 1.6e16, not
// undefined. Both are correct floating point and both are wrong on a
// whiteboard: a student who has just been taught that cos 90° = 0 should not
// watch the tutor's calculator disagree with him. Reducing first also keeps
// sin(1e9°) meaningful instead of surrendering to the loss of precision in a
// huge radian multiply.
function sinDeg(d: number): number {
  const r = ((d % 360) + 360) % 360;
  if (r % 90 === 0) return r === 90 ? 1 : r === 270 ? -1 : 0;
  return Math.sin(r * DEG);
}
function cosDeg(d: number): number {
  return sinDeg(d + 90);
}
function tanDeg(d: number): number {
  const r = ((d % 180) + 180) % 180;
  if (r === 0) return 0;
  if (r === 90) return NaN;   // an asymptote, which is honestly reported as "no value"
  return Math.tan(r * DEG);
}

// Radians out of the inverse trig functions, converted by multiplying before
// dividing: (Math.PI / 2) / DEG lands on 90.00000000000001, while
// (Math.PI / 2) * 180 / Math.PI lands on 90.
function toDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

/**
 * Factorial, of the kind a calculator needs.
 *
 * Anything that is not a whole number ≥ 0 is NaN rather than a throw — 0.5! is
 * a maths question (it wants the gamma function), not a typo. The ceiling at
 * 170 is not arbitrary: 171! overflows a double to Infinity anyway, so beyond
 * that the loop can only burn a tab's main thread to produce nothing. `1e9!`
 * used to be a frozen iPad.
 */
function factorial(n: number): number {
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n || n > 170) return NaN;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

interface FnSpec {
  /** Fewest and most values it will take. `max: Infinity` for min/max. */
  min: number;
  max: number;
  call: (args: number[], degrees: boolean) => number;
}

// A Map, not an object literal, and that is a security decision rather than a
// style one. `({}).constructor` is the Function constructor: a lookup table
// with Object.prototype behind it answers `FUNCTIONS['constructor']` with a
// real, callable function, which is precisely the primitive an attacker needs
// to reach `new Function` in an engine that promised never to touch it. A Map
// has no prototype chain to walk, so an unknown name is unknown, full stop.
const FUNCTIONS: ReadonlyMap<string, FnSpec> = new Map<string, FnSpec>([
  ['sin', { min: 1, max: 1, call: (a, deg) => (deg ? sinDeg(a[0]) : Math.sin(a[0])) }],
  ['cos', { min: 1, max: 1, call: (a, deg) => (deg ? cosDeg(a[0]) : Math.cos(a[0])) }],
  ['tan', { min: 1, max: 1, call: (a, deg) => (deg ? tanDeg(a[0]) : Math.tan(a[0])) }],
  ['asin', { min: 1, max: 1, call: (a, deg) => (deg ? toDeg(Math.asin(a[0])) : Math.asin(a[0])) }],
  ['acos', { min: 1, max: 1, call: (a, deg) => (deg ? toDeg(Math.acos(a[0])) : Math.acos(a[0])) }],
  ['atan', { min: 1, max: 1, call: (a, deg) => (deg ? toDeg(Math.atan(a[0])) : Math.atan(a[0])) }],
  // The hyperbolics take a real number, not an angle, so DEG/RAD must not touch
  // them. sinh(30) is the same number whichever way the toggle is set.
  ['sinh', { min: 1, max: 1, call: (a) => Math.sinh(a[0]) }],
  ['cosh', { min: 1, max: 1, call: (a) => Math.cosh(a[0]) }],
  ['tanh', { min: 1, max: 1, call: (a) => Math.tanh(a[0]) }],
  ['sqrt', { min: 1, max: 1, call: (a) => Math.sqrt(a[0]) }],
  ['cbrt', { min: 1, max: 1, call: (a) => Math.cbrt(a[0]) }],
  ['abs', { min: 1, max: 1, call: (a) => Math.abs(a[0]) }],
  // `ln` is natural and `log` is base ten, because that is what they mean in a
  // school exercise book. A tutor who writes log(100) is owed 2.
  ['ln', { min: 1, max: 1, call: (a) => Math.log(a[0]) }],
  ['log', { min: 1, max: 1, call: (a) => Math.log10(a[0]) }],
  ['log2', { min: 1, max: 1, call: (a) => Math.log2(a[0]) }],
  ['exp', { min: 1, max: 1, call: (a) => Math.exp(a[0]) }],
  ['floor', { min: 1, max: 1, call: (a) => Math.floor(a[0]) }],
  ['ceil', { min: 1, max: 1, call: (a) => Math.ceil(a[0]) }],
  // Half away from zero, which is the rule the textbook teaches: -2.5 rounds to
  // -3. Math.round rounds towards +∞ and would answer -2, and being marked
  // wrong by the tutor's own calculator is not a defensible outcome.
  ['round', {
    min: 1, max: 2,
    call: (a) => {
      const places = a.length > 1 ? Math.trunc(a[1]) : 0;
      if (!Number.isFinite(places) || Math.abs(places) > 15) return NaN;
      const scale = Math.pow(10, places);
      const scaled = a[0] * scale;
      return (Math.sign(scaled) * Math.round(Math.abs(scaled))) / scale;
    },
  }],
  ['sign', { min: 1, max: 1, call: (a) => Math.sign(a[0]) }],
  ['pow', { min: 2, max: 2, call: (a) => Math.pow(a[0], a[1]) }],
  ['min', { min: 1, max: Infinity, call: pickSmallest }],
  ['max', { min: 1, max: Infinity, call: pickLargest }],
]);

// Written out rather than Math.min(...args) because the spread allocates on
// every call, and min() inside a plotted expression is called once per sample.
function pickSmallest(args: number[]): number {
  let best = args[0];
  for (let i = 1; i < args.length; i++) {
    if (Number.isNaN(args[i])) return NaN;
    if (args[i] < best) best = args[i];
  }
  return best;
}
function pickLargest(args: number[]): number {
  let best = args[0];
  for (let i = 1; i < args.length; i++) {
    if (Number.isNaN(args[i])) return NaN;
    if (args[i] > best) best = args[i];
  }
  return best;
}

const CONSTANTS: ReadonlyMap<string, number> = new Map<string, number>([
  ['pi', Math.PI],
  ['e', Math.E],
  ['tau', Math.PI * 2],
]);

/** Every function name the engine answers to — for building a keypad, and for tests. */
export const FUNCTION_NAMES: readonly string[] = Array.from(FUNCTIONS.keys());

// ─────────────────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────────────────

export interface Token {
  kind: 'num' | 'name' | 'op';
  /** The text as written: the operator, the name, or the digits. */
  text: string;
  /** The parsed value. Meaningful for `num` only. */
  value: number;
  /** Where it starts in the source, so an error can point at it. */
  at: number;
  /**
   * Written as a symbol that already means "of what follows" — `√`. It takes
   * its value without brackets, the way it does on paper.
   */
  bare?: boolean;
}

// The characters a tutor actually produces. `×` and `÷` come off the iPad
// keyboard and out of pasted worksheets; `−` (U+2212) is what a word processor
// silently substitutes for a hyphen; `π` and `√` are what he would write on the
// board. Refusing them would be refusing his own notation back at him.
const ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  ['×', '*'], ['·', '*'], ['∙', '*'], ['⋅', '*'],
  ['÷', '/'], ['∕', '/'],
  ['−', '-'], ['–', '-'], ['—', '-'],
  ['π', 'pi'], ['τ', 'tau'], ['√', 'sqrt'],
  ['（', '('], ['）', ')'], ['％', '%'],
]);

const OPERATORS = new Set(['+', '-', '*', '/', '^', '(', ')', ',', '!', '%']);

const isDigit = (ch: string) => ch >= '0' && ch <= '9';
const isLetter = (ch: string) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');

// A calculator line is a line. Anything past this is a paste accident, and the
// cap is also what keeps a parser built on recursion off the stack limit — a
// thousand nested brackets cannot arrive if a thousand characters cannot.
const MAX_SOURCE = 1000;

/** Split the source into tokens. Throws ExpressionError on a character it cannot read. */
export function tokenize(src: string): Token[] {
  if (src.length > MAX_SOURCE) {
    throw new ExpressionError('that expression is too long to work out', MAX_SOURCE);
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const raw = src[i];
    if (raw === ' ' || raw === '\t' || raw === '\n' || raw === '\r') { i++; continue; }

    // `2**3` is how somebody who writes code writes a power, and this tutor
    // does. Read before the aliases so it is not mistaken for two multiplies.
    if (raw === '*' && src[i + 1] === '*') {
      tokens.push({ kind: 'op', text: '^', value: 0, at: i });
      i += 2;
      continue;
    }

    const alias = ALIASES.get(raw);
    const ch = alias ?? raw;

    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1]))) {
      const start = i;
      let seenDot = false;
      while (i < src.length && (isDigit(src[i]) || src[i] === '.')) {
        if (src[i] === '.') {
          if (seenDot) {
            throw new ExpressionError(`'${src.slice(start, i + 1)}' has two decimal points in it`, i);
          }
          seenDot = true;
        }
        i++;
      }
      const text = src.slice(start, i);
      tokens.push({ kind: 'num', text, value: Number(text), at: start });
      continue;
    }

    if (isLetter(ch)) {
      const start = i;
      // A symbol standing in for a whole name — π, τ, √ — ends where it begins.
      // Scanning on would read `√16` as one name, `sqrt16`, and answer a tutor's
      // own handwriting with "I don't know what that is".
      if (alias) {
        i++;
        tokens.push({ kind: 'name', text: alias, value: 0, at: start, bare: raw === '√' });
        continue;
      }
      // Digits are allowed after the first letter so that `log2` is one name.
      // Names are never split into letters either: `xy` is one unknown name and
      // is reported as one, because a rule that split it would also turn `ans`
      // into a × n × s and quietly answer a question nobody asked.
      let text = '';
      while (i < src.length && (isLetter(src[i]) || isDigit(src[i]))) { text += src[i]; i++; }
      tokens.push({ kind: 'name', text: text.toLowerCase(), value: 0, at: start });
      continue;
    }

    if (OPERATORS.has(ch)) {
      tokens.push({ kind: 'op', text: ch, value: 0, at: i });
      i++;
      continue;
    }

    throw new ExpressionError(`I can't read '${raw}' in there`, i);
  }
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────
// The tree
// ─────────────────────────────────────────────────────────────────────────

export type ExprNode =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'unary'; op: '-' | '+'; a: ExprNode }
  | { t: 'postfix'; op: '!' | '%'; a: ExprNode }
  | { t: 'binary'; op: '+' | '-' | '*' | '/' | '^'; a: ExprNode; b: ExprNode }
  | { t: 'call'; name: string; args: ExprNode[] };

/**
 * Recursive descent, lowest precedence outwards:
 *
 *   sum      := product (('+' | '-') product)*
 *   product  := unary (('*' | '/') unary | unary)*      ← the bare one is implicit ×
 *   unary    := ('-' | '+') unary | power
 *   power    := postfix ('^' unary)?                    ← right-associative
 *   postfix  := primary ('!' | '%')*
 *   primary  := number | name | name '(' args ')' | '(' sum ')'
 *
 * The two shapes worth staring at:
 *
 *   `power` takes a *unary* on the right, which is what makes 2^3^2 come out
 *   512 and not 64, and what lets 2^-3 parse at all.
 *
 *   `unary` sits ABOVE `power`, which is what makes -2^2 come out -4. Putting
 *   it below would answer 4, and a tutor demonstrating why -2² is negative
 *   would be contradicted by his own screen.
 */
class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[], private readonly src: string) {}

  parse(): ExprNode {
    if (this.tokens.length === 0) throw new ExpressionError('there is nothing to work out', 0);
    const node = this.sum();
    const leftover = this.peek();
    if (leftover) {
      if (leftover.text === ')') {
        throw new ExpressionError("unexpected ')' — there is no open bracket for it to close", leftover.at);
      }
      throw new ExpressionError(`I don't know what to do with '${leftover.text}' there`, leftover.at);
    }
    return node;
  }

  private peek(): Token | undefined { return this.tokens[this.i]; }
  private previous(): Token | undefined { return this.tokens[this.i - 1]; }
  private isOp(text: string): boolean {
    const t = this.tokens[this.i];
    return !!t && t.kind === 'op' && t.text === text;
  }
  private take(): Token { return this.tokens[this.i++]; }

  private sum(): ExprNode {
    let left = this.product();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.take().text as '+' | '-';
      left = { t: 'binary', op, a: left, b: this.product() };
    }
    return left;
  }

  private product(): ExprNode {
    let left = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = this.take().text as '*' | '/';
        left = { t: 'binary', op, a: left, b: this.unary() };
        continue;
      }
      // Implicit multiplication: 2x, 3(x+1), 2sin(x), (a)(b).
      //
      // Only ever triggered by something that STARTS a value, never by an
      // operator, so `2 - 3` stays a subtraction. The right-hand side is parsed
      // at the unary level so that 2x^2 is 2(x²) rather than (2x)².
      const next = this.peek();
      if (next && (next.kind === 'num' || next.kind === 'name' || next.text === '(')) {
        const before = this.previous();
        // Two numbers touching is a typo, not a product. `12 34` silently
        // answering 408 is the kind of wrong answer that gets copied onto a
        // board and believed.
        if (before && before.kind === 'num' && next.kind === 'num') {
          throw new ExpressionError(
            `two numbers in a row — did you mean ${before.text}*${next.text}?`, next.at,
          );
        }
        left = { t: 'binary', op: '*', a: left, b: this.unary() };
        continue;
      }
      return left;
    }
  }

  private unary(): ExprNode {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.take().text as '-' | '+';
      return { t: 'unary', op, a: this.unary() };
    }
    return this.power();
  }

  private power(): ExprNode {
    const base = this.postfix();
    if (this.isOp('^')) {
      this.take();
      return { t: 'binary', op: '^', a: base, b: this.unary() };
    }
    return base;
  }

  private postfix(): ExprNode {
    let node = this.primary();
    while (this.isOp('!') || this.isOp('%')) {
      const op = this.take().text as '!' | '%';
      node = { t: 'postfix', op, a: node };
    }
    return node;
  }

  private primary(): ExprNode {
    const tok = this.peek();
    if (!tok) {
      const last = this.previous();
      throw new ExpressionError(
        last ? `the expression stops after '${last.text}'` : 'there is nothing to work out',
        this.src.length,
      );
    }

    if (tok.kind === 'num') {
      this.take();
      return { t: 'num', v: tok.value };
    }

    if (tok.text === '(') {
      this.take();
      const inner = this.sum();
      if (!this.isOp(')')) {
        throw new ExpressionError('a bracket was opened and never closed', tok.at);
      }
      this.take();
      return inner;
    }

    if (tok.text === ')') {
      throw new ExpressionError("unexpected ')' — there is no open bracket for it to close", tok.at);
    }

    if (tok.kind === 'name') {
      this.take();
      const spec = FUNCTIONS.get(tok.text);
      if (spec) return this.call(tok, spec);

      const constant = CONSTANTS.get(tok.text);
      if (constant !== undefined) return { t: 'num', v: constant };

      // A name nobody knows, with a bracket after it, is a function nobody
      // knows — say so, because "unknown function 'foo'" is actionable and a
      // silent multiply is not. A SINGLE letter is let through as a variable
      // instead, so that x(x+1) is the product a maths teacher means.
      if (this.isOp('(') && tok.text.length > 1) {
        throw new ExpressionError(`unknown function '${tok.text}'`, tok.at);
      }
      return { t: 'var', name: tok.text };
    }

    throw new ExpressionError(`I don't know what to do with '${tok.text}' there`, tok.at);
  }

  private call(name: Token, spec: FnSpec): ExprNode {
    if (!this.isOp('(')) {
      // `√16`. The radical sign already says "of what follows", so it takes a
      // unary — which makes √16+9 thirteen and √-4 undefined, both of which are
      // what the same marks mean written by hand. Every spelled-out function
      // still needs its brackets, because `sin 2x` has no such agreed reading.
      if (name.bare) return { t: 'call', name: name.text, args: [this.unary()] };
      throw new ExpressionError(`${name.text} needs brackets, like ${name.text}(30)`, name.at);
    }
    this.take();
    const args: ExprNode[] = [];
    if (!this.isOp(')')) {
      args.push(this.sum());
      while (this.isOp(',')) { this.take(); args.push(this.sum()); }
    }
    if (!this.isOp(')')) {
      throw new ExpressionError(`${name.text}( was opened and never closed`, name.at);
    }
    this.take();
    if (args.length < spec.min || args.length > spec.max) {
      const wanted = spec.max === Infinity
        ? `at least ${spec.min}`
        : spec.min === spec.max ? `${spec.min}` : `${spec.min} to ${spec.max}`;
      throw new ExpressionError(
        `${name.text} takes ${wanted} value${spec.min === 1 && spec.max === 1 ? '' : 's'}, not ${args.length}`,
        name.at,
      );
    }
    return { t: 'call', name: name.text, args };
  }
}

/** Read a source string into a tree. Throws ExpressionError on anything mistyped. */
export function parse(src: string): ExprNode {
  return new Parser(tokenize(src), src).parse();
}

// ─────────────────────────────────────────────────────────────────────────
// Working it out
// ─────────────────────────────────────────────────────────────────────────

export type Vars = Record<string, number>;
type Sampler = (vars: Vars) => number;

// Every result passes through here, and that is what turns a maths error into a
// value instead of an exception. 1/0 is Infinity to JavaScript and undefined to
// mathematics; ln(0) is -Infinity to JavaScript and undefined to mathematics.
// A plotter given Infinity has to special-case it in its own autoscaling, and a
// tutor shown "Infinity" for 1÷0 has been told something false. NaN is the one
// answer that is true in both places, and it is the only non-number a caller
// then has to check for.
function finite(value: number): number {
  return Number.isFinite(value) ? value : NaN;
}

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

function build(node: ExprNode, degrees: boolean): Sampler {
  switch (node.t) {
    case 'num': {
      const v = node.v;
      return () => v;
    }
    case 'var': {
      const name = node.name;
      // Read straight off the object, then filtered through finite(). A caller
      // handing in a plain `{}` brings Object.prototype with it, so `vars.x`
      // could in principle answer with a function; anything that is not a
      // finite number becomes NaN right here rather than travelling.
      return (vars) => finite(vars[name]);
    }
    case 'unary': {
      const a = build(node.a, degrees);
      return node.op === '-' ? (vars) => -a(vars) : a;
    }
    case 'postfix': {
      const a = build(node.a, degrees);
      // Percent is a hundredth, so 50% is 0.5 and 200*15% is 30. Deliberately
      // not the till-receipt behaviour where 200+10% means 220: that makes `+`
      // mean two different things depending on what follows it, which is the
      // reason two calculators can disagree about the same keystrokes.
      return node.op === '!'
        ? (vars) => finite(factorial(a(vars)))
        : (vars) => finite(a(vars) / 100);
    }
    case 'binary': {
      const a = build(node.a, degrees);
      const b = build(node.b, degrees);
      switch (node.op) {
        case '+': return (vars) => finite(a(vars) + b(vars));
        case '-': return (vars) => finite(a(vars) - b(vars));
        case '*': return (vars) => finite(a(vars) * b(vars));
        case '/': return (vars) => finite(a(vars) / b(vars));
        default: return (vars) => finite(Math.pow(a(vars), b(vars)));
      }
    }
    default: {
      const spec = FUNCTIONS.get(node.name);
      // Unreachable: the parser refuses a name that is not in the table. Kept
      // so that adding a node type later cannot silently produce `undefined()`.
      if (!spec) return () => NaN;
      const args = node.args.map((n) => build(n, degrees));
      const count = args.length;
      // One arguments array per node, reused on every call. Safe because the
      // arguments are fully evaluated before `call` runs and nothing here is
      // re-entrant — sin(cos(x)) is two nodes with two arrays, never one shared
      // one. A plotter sampling 800 points a frame would otherwise throw away
      // 48,000 arrays a second to say the same thing.
      const slot: number[] = new Array(count);
      const fn = spec.call;
      return (vars) => {
        for (let i = 0; i < count; i++) slot[i] = args[i](vars);
        return finite(fn(slot, degrees));
      };
    }
  }
}

export interface EvalOptions {
  /** Read angles as degrees rather than radians. Affects the trig functions only. */
  degrees?: boolean;
}

/**
 * Work out a tree once.
 *
 * Never throws: an unknown name, a division by zero and a root of a negative
 * all come back NaN. Anything calling this in a loop — a plotter — should use
 * `compile()` instead, which does the tree walk once and keeps the closures.
 */
export function evaluate(ast: ExprNode, vars: Vars = {}, opts: EvalOptions = {}): number {
  return build(ast, opts.degrees === true)(vars);
}

/** Every name in the tree that is not a function or a constant, in the order found. */
export function freeVariables(ast: ExprNode): string[] {
  const found: string[] = [];
  const walk = (node: ExprNode): void => {
    switch (node.t) {
      case 'var': if (!found.includes(node.name)) found.push(node.name); break;
      case 'unary': case 'postfix': walk(node.a); break;
      case 'binary': walk(node.a); walk(node.b); break;
      case 'call': node.args.forEach(walk); break;
      default: break;
    }
  };
  walk(ast);
  return found;
}

// `x2` is somebody reaching for x², and telling him so is the difference
// between a calculator that helps and one that sulks.
//
// `1e3` gets its own sentence. `e` is Euler's number here and always, so the
// digits after it become a name of their own — and a tutor who meant a thousand
// needs to be told how to write a thousand, not offered e³.
function unknownName(name: string): string {
  const scientific = /^e(\d+)$/.exec(name);
  if (scientific) return `I don't know what '${name}' is — e is 2.718…, so for scientific notation write 10^${scientific[1]}`;
  const squared = /^([a-z])(\d+)$/.exec(name);
  if (squared) return `I don't know what '${name}' is — did you mean ${squared[1]}^${squared[2]}?`;
  return `I don't know what '${name}' is`;
}

export interface CompileOptions extends EvalOptions {
  /** Values that stay fixed for the life of the compiled function, such as `ans`. */
  vars?: Vars;
  /** The name the returned function's argument feeds. Defaults to `x`. */
  variable?: string;
}

/**
 * Parse once, then evaluate as often as you like.
 *
 * This is the shape the plotter needs: `const f = compile('sin(x)/x')` and then
 * f(-10) … f(10) at whatever resolution the canvas is, per frame, per drag.
 * The parse, the name checking and the tree walk all happen here; the returned
 * function does arithmetic and nothing else, and cannot throw.
 *
 * Names are checked once, here, rather than at every sample. A typo is
 * something the tutor must be told about, and a plotter that only discovered it
 * at sample 400 would have drawn nothing and said nothing about why.
 */
export function compile(src: string, opts: CompileOptions = {}): (x: number) => number {
  const ast = parse(src);
  const variable = opts.variable ?? 'x';
  // Null-prototype, so a variable called `constructor` or `__proto__` is just a
  // missing name rather than an inherited surprise.
  const scope: Vars = Object.create(null) as Vars;
  if (opts.vars) {
    for (const key of Object.keys(opts.vars)) scope[key] = opts.vars[key];
  }
  for (const name of freeVariables(ast)) {
    if (name !== variable && !hasOwn(scope, name)) {
      throw new ExpressionError(unknownName(name));
    }
  }
  const fn = build(ast, opts.degrees === true);
  scope[variable] = 0;
  // One scope object, rewritten per sample rather than rebuilt. Sound because
  // evaluation is synchronous and takes no callbacks — there is no way for a
  // second sample to begin while the first is still reading.
  return (x: number): number => {
    scope[variable] = x;
    return fn(scope);
  };
}

export interface CalculateOptions extends EvalOptions {
  /** Named values the expression may use — a calculator supplies `ans` here. */
  vars?: Vars;
}

/**
 * The whole job for one line typed into a calculator.
 *
 * Throws ExpressionError for anything the person needs telling about (including
 * a name that was never given a value), and returns NaN for a question that
 * simply has no answer.
 */
export function calculate(src: string, opts: CalculateOptions = {}): number {
  const ast = parse(src);
  const vars = opts.vars ?? {};
  for (const name of freeVariables(ast)) {
    if (!hasOwn(vars, name)) throw new ExpressionError(unknownName(name));
  }
  return evaluate(ast, vars, opts);
}

/**
 * A number in the form a person would write it.
 *
 * Twelve significant figures, because that is enough for 1/3 to still read as a
 * third and few enough that 0.1 + 0.2 comes out 0.3 instead of
 * 0.30000000000000004 on a screen a class is watching.
 *
 * No thousands separators on purpose. The tutor is in India, where 1,000,000 is
 * grouped 10,00,000, and a calculator that argues with its user about how to
 * punctuate a number is a calculator with an opinion nobody asked for. The
 * digits are the answer.
 */
export function formatResult(value: number): string {
  if (!Number.isFinite(value)) return 'undefined';
  if (value === 0) return '0';
  return String(Number(value.toPrecision(12)));
}
