import { isSecretName } from "./core/secrets";

/** Stands in for a masked value. */
export const MASK = "***";

/** `TC_Kimlik_No`, `tcKimlikNo`, `TcKimlikNo` → `tckimlikno`: the form `maskFields` match. */
export const foldName = (name: string) =>
  name
    .replace(/[İı]/g, "i")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");

let names = new Set<string>();
let patterns: RegExp[] = [];

/** `init({ maskFields })`: names (exact, folded) or patterns (tested on the folded name). */
export function setMaskFields(fields: readonly (string | RegExp)[]) {
  names = new Set(
    fields.filter((f): f is string => typeof f === "string").map(foldName),
  );
  // Without g/y a pattern keeps no lastIndex between keys.
  patterns = fields
    .filter((f): f is RegExp => f instanceof RegExp)
    .map((p) => new RegExp(p.source, p.flags.replace(/[gy]/g, "")));
}

/** A credential by name, or a field the app asked to mask. */
export function isMaskedName(name: string) {
  if (isSecretName(name)) return true;
  if (!names.size && !patterns.length) return false;
  const folded = foldName(name);
  return names.has(folded) || patterns.some((p) => p.test(folded));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
/** Turkish mobile number, with or without the country code. */
const MOBILE = /^(90|0)?5\d{9}$/;

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** T.C. kimlik no: 11 digits, no leading zero, two check digits. */
function isTcKimlik(digits: string) {
  if (!/^[1-9]\d{10}$/.test(digits)) return false;
  let odd = 0;
  let even = 0;
  for (let i = 0; i < 9; i++) {
    if (i % 2) even += Number(digits[i]);
    else odd += Number(digits[i]);
  }
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  return (
    tenth === Number(digits[9]) &&
    (odd + even + tenth) % 10 === Number(digits[10])
  );
}

/** ISO 13616 IBAN with a valid mod-97 checksum. */
function isIban(text: string) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(text)) return false;
  let rest = 0;
  for (const char of text.slice(4) + text.slice(0, 4)) {
    const value = char >= "A" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

/** Card numbers (15-16 digits, major networks) pass Luhn; 13-digit epoch-ms timestamps do not qualify. */
const isCard = (digits: string) =>
  (digits.length === 15 || digits.length === 16) &&
  /^[2-6]/.test(digits) &&
  luhn(digits);

/**
 * Values that identify a person whatever the field is called: e-mail,
 * T.C. kimlik no, card number, IBAN, Turkish mobile number. Checksums keep
 * ordinary ids and amounts from matching.
 */
export function isPersonalValue(value: unknown): boolean {
  if (typeof value === "number")
    return (
      Number.isSafeInteger(value) &&
      value > 0 &&
      (isTcKimlik(String(value)) || isCard(String(value)))
    );
  if (typeof value !== "string" || value.length < 6 || value.length > 64)
    return false;
  const text = value.trim();
  if (EMAIL.test(text)) return true;
  const compact = text.replace(/[\s()+-]/g, "");
  if (/^\d+$/.test(compact))
    return isTcKimlik(compact) || isCard(compact) || MOBILE.test(compact);
  return isIban(compact.toUpperCase());
}
