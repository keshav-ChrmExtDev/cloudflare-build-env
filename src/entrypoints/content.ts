import type { EnvVar } from '../lib/env';

type Row = {
  el: HTMLElement;
  name: HTMLInputElement;
  value: HTMLInputElement;
  typeButton: HTMLButtonElement;
  deleteButton: HTMLButtonElement;
};

type Request =
  | { type: 'cf-ping' }
  | { type: 'cf-clear' }
  | { type: 'cf-sync'; vars: EnvVar[] };

type Response = {
  ok: boolean;
  found: boolean;
  rows: number;
  log: string[];
  error?: string;
  warning?: string;
};

// Selectors for the Cloudflare dashboard DOM (Kumo design system).
// The build variables card shares its "Variables and secrets" title with the
// runtime variables card, so we identify it by any of these unique markers.
const BUILD_ROW = '[data-sentry-component="KumoBuildVariableEditorRow"]';
const BUILD_TABLE = '[data-sentry-source-file="WorkersBuildVariablesTable.tsx"]';
const EMPTY_ROW = '[data-sentry-component="SettingsEmptyRow"]';  // shown when 0 vars exist
const SETTINGS_CARD = '[data-sentry-component="SettingsCard"]';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isVisible(el: Element | null | undefined): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

async function waitFor<T>(
  check: () => T | null | undefined,
  timeout = 4000,
  interval = 100,
): Promise<T | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

function findCard(): HTMLElement | null {
  const cards = [...document.querySelectorAll<HTMLElement>(SETTINGS_CARD)];
  const titled = cards.filter((card) =>
    /variables and secrets/i.test(
      card.querySelector('[data-sentry-component="SettingsCardTitle"]')?.textContent ?? '',
    ),
  );

  // Identify the Build variables card (not the Runtime variables card that shares the same
  // title) by any of its unique markers — including the empty-state placeholder so the
  // extension works even when no variables have been added yet.
  return (
    titled.find(
      (card) =>
        card.querySelector(BUILD_ROW) ||
        card.querySelector(BUILD_TABLE) ||
        card.querySelector(EMPTY_ROW),
    ) ?? null
  );
}

function getRows(card: HTMLElement): Row[] {
  // Try known name-input selectors. Cloudflare has used several across dashboard versions.
  const nameInputs = [
    ...card.querySelectorAll<HTMLInputElement>(
      [
        'input[id^="buildvar-key"]',      // older dashboard
        'input[placeholder="Name"]',       // older dashboard
        'input[data-kumo-part="input"][placeholder*="name" i]', // Kumo design system
        'input[data-kumo-part="input"][aria-label*="name" i]',  // Kumo design system
      ].join(', '),
    ),
  ];
  const rows: Row[] = [];

  for (const name of nameInputs) {
    // Walk up to the row container — try every known wrapper component name.
    const el =
      name.closest<HTMLElement>(BUILD_ROW) ??
      name.closest<HTMLElement>('[data-sentry-component="InlineEditorRow"]') ??
      name.closest<HTMLElement>('[data-sentry-component="KumoBuildVariableEditorRow"]') ??
      name.closest<HTMLElement>('[data-kumo-component="InlineEditor"]') ??
      // Fallback: the nearest ancestor that also contains a value input.
      ((): HTMLElement | null => {
        let el: HTMLElement | null = name.parentElement;
        while (el && el !== card) {
          if (
            el.querySelector('input[id^="buildvar-value"], input[placeholder="Value"], input[data-kumo-part="input"]:not([id^="buildvar-key"])')
          )
            return el;
          el = el.parentElement;
        }
        return null;
      })();
    if (!el) continue;

    const value = el.querySelector<HTMLInputElement>(
      'input[id^="buildvar-value"], input[placeholder="Value"], input[data-kumo-part="input"]:not(:first-of-type)',
    );

    // Type toggle — try aria-label then data-kumo-component select triggers.
    const typeButton =
      el.querySelector<HTMLButtonElement>('button[aria-label="Type"]') ??
      el.querySelector<HTMLButtonElement>('[data-kumo-component="Select"] button') ??
      el.querySelector<HTMLButtonElement>('button[data-kumo-part="trigger"]');

    // Delete button — try aria-label then icon-only buttons at the end of the row.
    const deleteButton =
      el.querySelector<HTMLButtonElement>('button[aria-label="Delete"]') ??
      el.querySelector<HTMLButtonElement>('button[aria-label*="delete" i]') ??
      el.querySelector<HTMLButtonElement>('button[aria-label*="remove" i]') ??
      [...el.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => isVisible(b) && b.textContent?.trim() === '',
      ) ??
      null;

    if (value && typeButton && deleteButton) {
      rows.push({ el, name, value, typeButton, deleteButton });
    }
  }

  return rows;
}

function getAddButton(card: HTMLElement): HTMLButtonElement | null {
  // Old dashboard: dedicated footer component.
  const footer = card.querySelector<HTMLButtonElement>('[data-sentry-component="AddRowFooter"] button');
  if (footer && isVisible(footer)) return footer;

  // Normalise textContent: strip whitespace from nested spans/SVGs.
  const label = (btn: HTMLButtonElement) =>
    btn.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  return (
    [...card.querySelectorAll<HTMLButtonElement>('button')].find((btn) => {
      if (!isVisible(btn)) return false;
      const text = label(btn);
      return text === 'Add' || text === 'Add row' || text === 'Add variable';
    }) ?? null
  );
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function setType(row: Row, secret: boolean) {
  const wanted = secret ? 'Secret' : 'Variable';
  if ((row.typeButton.textContent?.trim() ?? '').startsWith(wanted)) return;

  row.typeButton.click();
  const option = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (el) => isVisible(el) && (el.textContent?.trim() ?? '').startsWith(wanted),
      ),
    2500,
    50,
  );
  if (!option) throw new Error(`Could not open the type menu to choose ${wanted}.`);

  option.click();
  const changed = await waitFor(
    () => (row.typeButton.textContent?.trim() ?? '').startsWith(wanted),
    1500,
    50,
  );
  if (!changed) throw new Error(`The row type did not change to ${wanted}.`);
}

async function confirmDelete(log: (line: string) => void): Promise<boolean> {
  const dialog = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].find(
        isVisible,
      ),
    1500,
    50,
  );
  if (!dialog) return false;

  const button = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) =>
      isVisible(candidate) &&
      !candidate.disabled &&
      /^(delete|remove|confirm|yes)/i.test(candidate.textContent?.trim() ?? ''),
  );
  if (!button) return false;

  button.click();
  log('Confirmed deletion');
  await sleep(250);
  return true;
}

async function deleteAll(card: HTMLElement, log: (line: string) => void): Promise<number> {
  let deleted = 0;
  for (let guard = 0; guard < 250; guard++) {
    const named = getRows(card).filter((row) => row.name.value.trim() !== '');
    if (named.length === 0) return deleted;

    const target = named[named.length - 1]!;
    const name = target.name.value.trim();
    const before = named.length;

    target.deleteButton.click();
    const quick = await waitFor(
      () => getRows(card).filter((row) => row.name.value.trim() !== '').length < before,
      800,
      100,
    );

    if (!quick) {
      const confirmed = await confirmDelete(log);
      const gone = await waitFor(
        () => getRows(card).filter((row) => row.name.value.trim() !== '').length < before,
        confirmed ? 8000 : 5000,
        100,
      );
      if (!gone) {
        throw new Error(
          `Could not delete “${name}”. Finish the dialog in Cloudflare, then try again.`,
        );
      }
    }
    log(`Deleted ${name}`);
    deleted++;
  }
  throw new Error('Stopped after deleting 250 variables.');
}

async function addRows(
  card: HTMLElement,
  vars: EnvVar[],
  log: (line: string) => void,
): Promise<number> {
  const drafts = getRows(card).filter((row) => row.name.value.trim() === '');

  for (const variable of vars) {
    let row = drafts.shift() ?? null;

    if (!row) {
      const add = getAddButton(card);
      if (!add) throw new Error('Could not find the Add button in Variables and secrets.');

      const before = getRows(card).length;
      add.click();
      const created = await waitFor(() => getRows(card).length > before, 4000, 100);
      if (!created) throw new Error('The Add button did not create a new row.');
      row = getRows(card).at(-1)!;
    }

    await setType(row, variable.is_secret);
    setInput(row.name, variable.var_name);
    setInput(row.value, variable.value);
    await sleep(40);

    if (row.name.value !== variable.var_name) {
      throw new Error(`Could not type the name ${variable.var_name}.`);
    }
    log(`Added ${variable.var_name}`);
  }
  return vars.length;
}

function sendProgress(message: string) {
  browser.runtime.sendMessage({ type: 'cf-progress', message }).catch(() => {});
}

async function run(type: 'cf-clear' | 'cf-sync', vars: EnvVar[]): Promise<Response> {
  const log: string[] = [];
  const report = (line: string) => {
    log.push(line);
    sendProgress(line);
  };

  try {
    const card = findCard();
    if (!card) {
      return {
        ok: false,
        found: false,
        rows: 0,
        log,
        error:
          'Could not find the Variables and secrets card. Open your Worker → Settings → Build and keep that page visible.',
      };
    }

    report('Found Variables and secrets');
    const deleted = await deleteAll(card, report);
    const added = type === 'cf-sync' ? await addRows(card, vars, report) : 0;

    report(deleted + added > 0 ? 'Done — review and save in Cloudflare.' : 'Nothing to do.');

    return {
      ok: true,
      found: true,
      rows: getRows(card).filter((row) => row.name.value.trim() !== '').length,
      log,
    };
  } catch (error) {
    return {
      ok: false,
      found: true,
      rows: 0,
      log,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function ping(): Response {
  const card = findCard();
  return {
    ok: true,
    found: Boolean(card),
    rows: card ? getRows(card).filter((row) => row.name.value.trim() !== '').length : 0,
    log: [],
  };
}

export default defineContentScript({
  matches: ['https://dash.cloudflare.com/*'],
  runAt: 'document_idle',
  main() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return;
      const request = message as Request;

      if (request.type === 'cf-ping') {
        sendResponse(ping());
        return;
      }

      if (request.type === 'cf-clear' || request.type === 'cf-sync') {
        const vars = request.type === 'cf-sync' ? request.vars : [];
        void run(request.type, vars).then(sendResponse);
        // Chrome keeps the message channel open when the listener returns true.
        return true as unknown as void;
      }
    });
  },
});
