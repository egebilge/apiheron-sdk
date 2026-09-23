// Names are snake_cased first. Distinctive words also match glued to a prefix
// (`Mailparola`, `Iyssifre`); short ones need a word boundary (`compass`, `monkey`).
const SENSITIVE_NAME =
  /(password|passwd|sifre|parola|secret|token|conn(ection)?_?str(ing)?)$|(^|_)(pass|pwd|anahtar|authorization|credentials?|(base|api|service|server|internal|endpoint)_(url|uri|address|adres))$/;
/** `…_key` is a credential unless the qualifier says it is a lookup key. */
const KEY_NAME = /_key$/;
const LOOKUP_KEY =
  /(^|_)(primary|foreign|sort|cache|query|group|row|item|parent|partition|idempotency|storage|object|file|translation|i18n|message|resource|hot|short|cut)_key$/;
/** Flags and permissions like `hasToken` or `o_Btn_Anahtar` are not the value itself. */
export const FLAG_NAME =
  /^(has|is|use|show|with|needs?|require|can)_|(^|_)btn_|_yetkisi?$/;
/** Platform and numbered variants: `ApiKeyIOS`, `Kasa_sifre_10`. */
const VARIANT_SUFFIX = /(_(ios|android|web|test|prod|live|sandbox|\d+))+$/;

/** `ApiKeyIOS` → `api_key`: the form every name rule is written against. */
export const normalizeName = (name: string) =>
  name
    .replace(/\[\]$/, "")
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
