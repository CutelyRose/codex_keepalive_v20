import './styles/global.css';
import { initializeTheme } from './core/theme';
import { serverRequest } from './core/api-client';
import { loadServerKeys } from './core/store';
import './components/status-pill';
import './components/metric-card';
import { AppShell, icon } from './components/app-shell';
import { createLoginScreen } from './components/login-screen';

initializeTheme();

const root = document.querySelector<HTMLElement>('#app')!;
let starting = false;

async function openWorkspace(): Promise<void> {
  if (starting) return;
  starting = true;
  root.innerHTML = `<main class="access-status" id="main-content" role="status"><span class="brand-mark" aria-hidden="true">${icon('spark')}</span><p>正在连接工作区…</p></main>`;
  document.body.classList.remove('drawer-open');
  try {
    const session = await serverRequest<{ authenticated: boolean; passwordRequired: boolean }>('/api/auth/session');
    if (!session.authenticated) {
      document.title = '登录 · AnyRouter';
      root.replaceChildren(createLoginScreen());
      return;
    }
    const keys = await loadServerKeys();
    const app = document.createElement('ar-app') as AppShell;
    app.initialKeys = keys;
    app.passwordRequired = session.passwordRequired;
    document.title = 'AnyRouter 请求调度台';
    root.replaceChildren(app);
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 401) {
      root.replaceChildren(createLoginScreen());
      document.title = '登录 · AnyRouter';
      return;
    }
    root.innerHTML = `<main class="access-status" id="main-content"><span class="brand-mark" aria-hidden="true">${icon('spark')}</span><h1>暂时无法打开工作区</h1><p role="alert"></p><button class="button primary" type="button">重新连接</button></main>`;
    root.querySelector('p')!.textContent = error instanceof Error ? error.message : '服务连接失败';
    root.querySelector('button')!.addEventListener('click', () => void openWorkspace());
  } finally { starting = false; }
}

window.addEventListener('authentication-required', () => {
  if (root.querySelector('ar-app')) void openWorkspace();
});
window.addEventListener('authentication-changed', () => void openWorkspace());
void openWorkspace();
