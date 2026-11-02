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
  // Try known name-input selectors across Cloudflare dashboard versions.
  const nameInputs = [
    ...card.querySelectorAll<HTMLInputElement>(
      [
        'input[id^="buildvar-key"]',
        'input[placeholder="Name"]',
        'input[placeholder="Variable name" i]',
        'input[placeholder*="name" i]',
        'input[aria-label*="name" i]',
        'input[data-kumo-part="input"][placeholder*="name" i]',
        'input[data-kumo-part="input"][aria-label*="name" i]',
      ].join(', '),
    ),
  ];
  const rows: Row[] = [];

  for (const name of nameInputs) {
    // Walk up to the row container — try known wrapper component markers.
    const el =
      name.closest<HTMLElement>(BUILD_ROW) ??
      name.closest<HTMLElement>('[data-sentry-component="InlineEditorRow"]') ??
      name.closest<HTMLElement>('[data-sentry-component="KumoBuildVariableEditorRow"]') ??
      name.closest<HTMLElement>('[data-kumo-component="InlineEditor"]') ??
      // Fallback: the nearest ancestor containing both this input and a value input.
      ((): HTMLElement | null => {
        let parent: HTMLElement | null = name.parentElement;
        while (parent && parent !== card) {
          if (
            parent.querySelector(
              'input[id^="buildvar-value"], input[placeholder="Value"], input[placeholder*="value" i], input[data-kumo-part="input"]:not(:first-of-type)',
            )
          ) {
            return parent;
          }
          parent = parent.parentElement;
        }
        return null;
      })();
    if (!el) continue;

    const value = el.querySelector<HTMLInputElement>(
      [
        'input[id^="buildvar-value"]',
        'input[placeholder="Value"]',
        'input[placeholder*="value" i]',
        'input[aria-label*="value" i]',
        'input[data-kumo-part="input"]:not(:first-of-type)',
      ].join(', '),
    );

    // Type toggle button (Secret vs Variable)
    const typeButton =
      el.querySelector<HTMLButtonElement>('button[aria-label="Type"]') ??
      el.querySelector<HTMLButtonElement>('button[aria-label*="type" i]') ??
      el.querySelector<HTMLButtonElement>('[data-kumo-component="Select"] button') ??
      el.querySelector<HTMLButtonElement>('button[data-kumo-part="trigger"]') ??
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        /^(secret|variable|plain|encrypted)/i.test(b.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
      ) ??
      null;

    // Delete / remove button
    const deleteButton =
      el.querySelector<HTMLButtonElement>('button[aria-label="Delete"]') ??
      el.querySelector<HTMLButtonElement>('button[aria-label*="delete" i]') ??
      el.querySelector<HTMLButtonElement>('button[aria-label*="remove" i]') ??
      [...el.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => isVisible(b) && b !== typeButton && b.textContent?.trim() === '',
      ) ??
      null;

    if (value && typeButton && deleteButton) {
      rows.push({ el, name, value, typeButton, deleteButton });
    }
  }

  return rows;
}

function getAddButton(card: HTMLElement): HTMLButtonElement | null {
  // Empty state row button (e.g. SettingsEmptyRow)
  const emptyRowBtn = card.querySelector<HTMLButtonElement>(
    '[data-sentry-component="SettingsEmptyRow"] button, [data-kumo-component="Button"]',
  );
  if (emptyRowBtn && isVisible(emptyRowBtn)) {
    const text = emptyRowBtn.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (/^add(\s+(row|variable|secret))?$/i.test(text)) return emptyRowBtn;
  }

  // Old dashboard dedicated footer component
  const footer = card.querySelector<HTMLButtonElement>('[data-sentry-component="AddRowFooter"] button');
  if (footer && isVisible(footer)) return footer;

  // Normalized search across all visible buttons in the card
  return (
    [...card.querySelectorAll<HTMLButtonElement>('button')].find((btn) => {
      if (!isVisible(btn) || btn.disabled) return false;
      const text = btn.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const aria = btn.getAttribute('aria-label') ?? '';
      return /^add(\s+(row|variable|secret))?$/i.test(text) || /^add(\s+(row|variable|secret))?$/i.test(aria);
    }) ?? null
  );
}

function setInput(input: HTMLInputElement, value: string) {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  // Reset React / virtual DOM value tracker if present so synthetic change detection fires reliably
  const tracker = (input as unknown as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
  if (tracker) {
    tracker.setValue('');
  }
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

async function setType(row: Row, secret: boolean) {
  const wanted = secret ? 'Secret' : 'Variable';
  const current = row.typeButton.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  if (new RegExp(`^${wanted}`, 'i').test(current)) return;

  row.typeButton.click();
  const option = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLElement>('[role="option"], [data-kumo-component="Option"], [role="menuitem"]')].find(
        (el) => isVisible(el) && new RegExp(`^${wanted}`, 'i').test(el.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
      ),
    2500,
    50,
  );
  if (!option) throw new Error(`Could not find the dropdown option for ${wanted}.`);

  // Dispatch full pointer event sequence for Base UI / Radix triggers
  option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
  option.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, composed: true }));
  option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
  option.click();

  const changed = await waitFor(
    () => new RegExp(`^${wanted}`, 'i').test(row.typeButton.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
    1500,
    50,
  );
  if (!changed) throw new Error(`The row type did not change to ${wanted}.`);
}

async function confirmDelete(log: (line: string) => void): Promise<boolean> {
  const dialog = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [data-kumo-component="Dialog"]')].find(
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
      /^(delete|remove|confirm|yes|ok|proceed)/i.test(candidate.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
  );
  if (!button) return false;

  button.click();
  log('Confirmed deletion in dialog');
  await sleep(250);
  return true;
}

async function deleteAll(card: HTMLElement, log: (line: string) => void): Promise<number> {
  let deleted = 0;
  for (let guard = 0; guard < 250; guard++) {
    const named = getRows(card).filter((row) => row.name.value.trim() !== '');
    if (named.length === 0) return deleted;

    const target = named[named.length - 1];
    if (!target) return deleted;
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
          `Could not delete “${name}”. Complete the confirmation dialog in Cloudflare, then try again.`,
        );
      }
    }
    log(`Deleted ${name}`);
    deleted++;
    await sleep(50);
  }
  throw new Error('Stopped after deleting 250 variables to protect against runaway loops.');
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
      const lastRow = getRows(card).at(-1);
      if (!lastRow) throw new Error('Could not find newly created row in Variables and secrets.');
      row = lastRow;
    }

    await setType(row, variable.is_secret);
    setInput(row.name, variable.var_name);
    setInput(row.value, variable.value);
    await sleep(50);

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
