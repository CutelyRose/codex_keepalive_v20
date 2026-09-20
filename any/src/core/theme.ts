import { STORAGE_KEYS } from './constants';

export type Theme = 'light' | 'dark';

const THEME_EVENT = 'anyrouter-theme-change';

function validTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

function defaultDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readStoredTheme(storage: Storage | undefined): Theme | undefined {
  if (!storage) return undefined;
  try {
    const value = storage.getItem(STORAGE_KEYS.theme);
    return validTheme(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function systemTheme(doc: Document): Theme {
  try {
    return doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Return the theme currently applied to the document. */
export function getTheme(doc: Document = defaultDocument() as Document): Theme {
  return doc.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Apply a theme without changing the user's persisted preference. */
export function applyTheme(theme: Theme, doc: Document = defaultDocument() as Document): Theme {
  const root = doc.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  doc.body?.classList.toggle('theme-dark', theme === 'dark');

  const themeColor = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor) themeColor.content = theme === 'dark' ? '#0d1320' : '#f5f7fb';
  return theme;
}

/** Initialize the UI from an explicit preference, then the OS preference. */
export function initializeTheme(
  doc: Document = defaultDocument() as Document,
  storage: Storage | undefined = defaultStorage(),
): Theme {
  const theme = readStoredTheme(storage) ?? systemTheme(doc);
  return applyTheme(theme, doc);
}

/** Persist and apply a theme, notifying other mounted surfaces in the window. */
export function setTheme(
  theme: Theme,
  doc: Document = defaultDocument() as Document,
  storage: Storage | undefined = defaultStorage(),
): Theme {
  if (storage) {
    try {
      storage.setItem(STORAGE_KEYS.theme, theme);
    } catch {
      // Private browsing and embedded documents can expose a read-only store.
    }
  }
  const previous = getTheme(doc);
  applyTheme(theme, doc);
  if (previous !== theme) {
    doc.defaultView?.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme } }));
  }
  return theme;
}

export function toggleTheme(
  doc: Document = defaultDocument() as Document,
  storage: Storage | undefined = defaultStorage(),
): Theme {
  return setTheme(getTheme(doc) === 'dark' ? 'light' : 'dark', doc, storage);
}

export function themeChangeEventName(): string {
  return THEME_EVENT;
}
