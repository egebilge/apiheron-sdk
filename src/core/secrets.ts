// Names are snake_cased first. Distinctive words also match glued to a prefix
// (`Mailparola`, `Iyssifre`), with a possessive, a plain-text marker or a
// glued number (`Sistemsifresi`, `ParolaClear`, `kasaSifre10`); short ones
// need a word boundary (`compass`, `monkey`).
const SENSITIVE_NAME =
  /(password|passwd|sifre(si)?|parola|secret|token|passphrase|passcode|apikey|conn(ection)?_?str(ing)?)s?(_?(clear|hash|confirmation|confirm|tekrar|repeat))?\d*$|(^|_)(pass|pwd|anahtar|auth|authorization|bearer|jwt|otp|cvv|cvc|dsn|cookies?|credentials?|session_?id|(base|api|service|server|internal|endpoint|database|db|webhook)_(url|uri|address|adres))$/;
/** `…_key` is a credential unless the qualifier says it is a lookup key. */
const KEY_NAME = /_key$/;
const LOOKUP_KEY =
  /(^|_)(primary|foreign|sort|cache|query|group|row|item|parent|partition|idempotency|storage|object|file|translation|i18n|message|resource|hot|short|cut)_key$/;
/** Flags and permissions like `hasToken` or `o_Btn_Anahtar` are not the value itself. */
export const FLAG_NAME =
  /^(has|is|use|show|with|needs?|require|can)_|(^|_)btn_|_yetkisi?$/;
/** Platform and numbered variants: `ApiKeyIOS`, `Kasa_sifre_10`. */
const VARIANT_SUFFIX = /(_(ios|android|web|test|prod|live|sandbox|\d+))+$/;

/**
 * `ApiKeyIOS` → `api_key`: the form every name rule is written against.
 * Folds what APIs do to the same name: `x-api-key`, `user[password]`,
 * `APIKey`, `şifre`, `ŞİFRE`.
 */
export const normalizeName = (name: string) =>
  name
    .replace(/\[\]$/, "")
    .replace(/İ/g, "I")
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[[\].\-\s]+/g, "_")
    .replace(/_+$/, "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(VARIANT_SUFFIX, "");

/** A normalized name that holds a credential or internal address itself. */
export const isCredentialName = (name: string) =>
  !FLAG_NAME.test(name) &&
  (SENSITIVE_NAME.test(name) ||
    (KEY_NAME.test(name) && !LOOKUP_KEY.test(name)));

/** Any field or query name, as written: does its value look like a secret? */
export const isSecretName = (name: string) =>
  isCredentialName(normalizeName(name));

const JWT = /^eyJ[\w-]{8,}\.[\w-]{4,}\.[\w-]*$/;
const AUTH_SCHEME = /^(bearer|basic)\s+[\w.~+/=-]{8,}$/i;

/** A value that is a credential whatever its field is called: a JWT, an `Authorization` header value. */
export const isSecretValue = (value: unknown) =>
  typeof value === "string" && (JWT.test(value) || AUTH_SCHEME.test(value));
