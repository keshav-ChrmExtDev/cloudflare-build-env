export interface EnvVar {
  var_name: string;
  value: string;
  is_secret: boolean;
}

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Public prefixes are the only ones safe to keep readable on the dashboard.
export function defaultSecret(varName: string): boolean {
  return !/^(PUBLIC_|VITE_|NEXT_PUBLIC_|NUXT_PUBLIC_|REACT_APP_|EXPO_PUBLIC_|GATSBY_)/.test(varName);
}

export function parseEnv(input: string): { vars: EnvVar[]; skipped: number } {
  const lines = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const vars: EnvVar[] = [];
  let skipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) {
      skipped++;
      continue;
    }

    const varName = line.slice(0, eq).trim();
    const raw = line.slice(eq + 1).trim();
    let value: string;

    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0]!;
      let body = raw.slice(1);
      let closed = false;

      // A quoted value may continue on the next line.
      for (;;) {
        const end = closingQuote(body, quote);
        if (end !== -1) {
          body = body.slice(0, end);
          closed = true;
          break;
        }
        if (i + 1 >= lines.length) break;
        body += '\n' + lines[++i]!;
      }

      if (!closed) {
        skipped++;
        continue;
      }
      value = quote === '"' ? unescapeDouble(body) : body;
    } else {
      value = raw.replace(/\s+#.*$/, '').trim();
    }

    vars.push({ var_name: varName, value, is_secret: defaultSecret(varName) });
  }

  return { vars, skipped };
}

const PAIR_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const SECRET_CELL_RE = /^(secret|s|true|yes|1)$/i;

export function mergeEnv(current: EnvVar[], incoming: EnvVar[]): EnvVar[] {
  const next = current.map((row) => ({ ...row }));
  for (const item of incoming) {
    const existing = next.find((row) => row.var_name === item.var_name);
    if (existing) existing.value = item.value;
    else next.push({ ...item });
  }
  return next;
}

/**
 * Turns a clipboard payload pasted into any cell into rows: a whole .env file, a single
 * KEY=value line, or columns copied from a spreadsheet (tab-separated). Returns null for an
 * ordinary value so the browser pastes it into the cell as usual.
 */
export function parsePaste(input: string): EnvVar[] | null {
  const lines = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  if (lines.length === 0) return null;

  if (lines.some((line) => line.includes('\t'))) {
    return lines.map((line) => {
      const [name = '', value = '', type = ''] = line.split('\t');
      const varName = name.trim();
      const kind = type.trim();
      return {
        var_name: varName,
        value: unquote(value.trim()),
        is_secret: kind ? SECRET_CELL_RE.test(kind) : defaultSecret(varName),
      };
    });
  }

  if (!lines.every((line) => PAIR_RE.test(line))) return null;

  // A lone value such as "dGVzdA==" or "a=b" is not a .env line; two or more KEY=value lines are.
  const soleName = PAIR_RE.exec(lines[0]!)?.[1] ?? '';
  if (lines.length === 1 && soleName !== soleName.toUpperCase() && !soleName.includes('_')) {
    return null;
  }

  return parseEnv(lines.join('\n')).vars;
}

function unquote(value: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2]! : value;
}

export function validateRows(rows: EnvVar[]): string[] {
  const errors: string[] = [];
  const counts = new Map<string, number>();

  for (const row of rows) {
    const name = row.var_name.trim();
    const touched = name !== '' || row.value !== '';
    if (!touched) continue;

    if (!name) {
      errors.push('A row has a value but no name.');
      continue;
    }
    if (!NAME_RE.test(name)) {
      errors.push(`“${name}” is not a valid variable name.`);
    }
    if (row.value.includes('\n')) {
      errors.push(`“${name}” has a line break. Cloudflare's build variable field is single-line.`);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  for (const [name, count] of counts) {
    if (count > 1) errors.push(`“${name}” appears more than once.`);
  }

  return errors;
}

export function toPayload(rows: EnvVar[]): EnvVar[] {
  return rows
    .filter((row) => row.var_name.trim() !== '')
    .map((row) => ({ ...row, var_name: row.var_name.trim() }));
}

function closingQuote(value: string, quote: string): number {
  for (let i = 0; i < value.length; i++) {
    if (quote === '"' && value[i] === '\\') {
      i++;
      continue;
    }
    if (value[i] === quote) return i;
  }
  return -1;
}

function unescapeDouble(value: string): string {
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
  return value.replace(/\\(n|r|t|"|\\)/g, (_, char: string) => escapes[char] ?? char);
}
