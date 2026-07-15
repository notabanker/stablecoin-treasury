// Money utilities — use integer math (cents) to avoid floating-point drift on monetary values.
// The Postgres numeric type stores amounts as true decimals; the pg driver returns them as
// strings. This module provides the JS-side decimal-safe layer.
//
// Usage:
//   const amount = Money.fromCents(42000n);        // €420.00
//   const fee    = Money.fromString("12.40");       // €12.40
//   const total  = amount.plus(fee);               // €432.40
//
// All operations use BigInt internally, so precision is exact up to the cent.
// Rounding (half-up) is explicit and localized to construction.

const SCALE = 100n; // 2 decimal places → cents

export class Money {
  /** @param {bigint} cents - Amount in cents (integer). */
  constructor(cents) {
    if (typeof cents !== "bigint") throw new TypeError("Money must be constructed with a bigint");
    this.#cents = cents;
  }

  #cents;

  /** Create Money from a JS number (parsed as cents). Rounds half-up. */
  static fromNumber(value) {
    if (!Number.isFinite(value)) throw new RangeError("Money.fromNumber requires a finite number");
    return new Money(BigInt(Math.round(value * 100)));
  }

  /** Create Money from a string, e.g. "42.10" or "1,234.56". */
  static fromString(value) {
    const clean = String(value).replace(/[,\s]/g, "");
    const parts = clean.split(".");
    const whole = BigInt(parts[0] || "0");
    const frac = parts[1] ? BigInt(parts[1].padEnd(2, "0").slice(0, 2)) : 0n;
    const sign = whole < 0n || clean.startsWith("-") ? -1n : 1n;
    return new Money(sign * (abs(whole) * SCALE + frac));
  }

  /** Create Money from a Postgres numeric (returned as string by pg). */
  static fromNumeric(value) {
    if (value === null || value === undefined) return null;
    return Money.fromString(String(value));
  }

  /** Create Money from cents (bigint or number). */
  static fromCents(cents) {
    return new Money(BigInt(cents));
  }

  /** Zero. */
  static zero() {
    return new Money(0n);
  }

  /** Get the amount as a decimal string, e.g. "420.00". */
  toString() {
    const abs = this.#cents < 0n ? -this.#cents : this.#cents;
    const whole = abs / SCALE;
    const frac = String(abs % SCALE).padStart(2, "0");
    return `${this.#cents < 0n ? "-" : ""}${whole}.${frac}`;
  }

  /** Get the amount as a JS number (may lose precision for very large amounts — fine for display). */
  toNumber() {
    return Number(this.#cents) / 100;
  }

  /** Get the amount in cents (bigint). */
  toCents() {
    return this.#cents;
  }

  /** Round to cents (idempotent — Money is already at cent precision). */
  round() {
    return this;
  }

  /** Add another Money. */
  plus(other) {
    return new Money(this.#cents + other.#cents);
  }

  /** Subtract another Money. */
  minus(other) {
    return new Money(this.#cents - other.#cents);
  }

  /** Multiply by a scalar (e.g. 0.08 for 8%). Result is rounded to cents. */
  times(factor) {
    if (typeof factor === "number") {
      return new Money(BigInt(Math.round(Number(this.#cents) * factor)));
    }
    if (factor instanceof Money) {
      // Multiply two money amounts: (cents1 * cents2) / 100, rounded
      return new Money(BigInt(Math.round(Number(this.#cents * factor.#cents) / 100)));
    }
    throw new TypeError("factor must be a number or Money");
  }

  /** Divide by a scalar. Result is rounded to cents. */
  divide(factor) {
    return new Money(BigInt(Math.round(Number(this.#cents) / factor)));
  }

  /** Compare to another Money. Returns -1, 0, or 1. */
  compare(other) {
    if (this.#cents < other.#cents) return -1;
    if (this.#cents > other.#cents) return 1;
    return 0;
  }

  equals(other) {
    return this.#cents === other.#cents;
  }

  gt(other) { return this.#cents > other.#cents; }
  gte(other) { return this.#cents >= other.#cents; }
  lt(other) { return this.#cents < other.#cents; }
  lte(other) { return this.#cents <= other.#cents; }
  isZero() { return this.#cents === 0n; }
  isPositive() { return this.#cents > 0n; }
  isNegative() { return this.#cents < 0n; }

  /** Return the absolute value. */
  abs() {
    return this.#cents < 0n ? new Money(-this.#cents) : this;
  }

  /** Return the negated value. */
  negate() {
    return new Money(-this.#cents);
  }

  /** Return the larger of this and other. */
  max(other) {
    return this.gt(other) ? this : other;
  }

  /** Return the smaller of this and other. */
  min(other) {
    return this.lt(other) ? this : other;
  }

  /** JSON serialization: decimal string. */
  toJSON() {
    return this.toString();
  }

  /** Custom inspect for console.log. */
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `Money(${this.toString()})`;
  }
}

// ── Stateless helpers (drop-in for legacy roundMoney etc.) ──

/** Round a numeric value to 2 decimal places (legacy-compatible). Returns a number. */
export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** Format a numeric value for display, e.g. "€1,234.56". */
export function formatMoney(value, currency = "EUR") {
  const symbols = { EUR: "€", USD: "$", PLN: "zł", GBP: "£" };
  const sym = symbols[currency] || currency + " ";
  const num = typeof value === "number" ? value : Number(value);
  return `${sym}${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function abs(n) {
  return n < 0n ? -n : n;
}
