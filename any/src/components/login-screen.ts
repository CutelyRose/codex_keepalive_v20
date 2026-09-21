import { icon } from './app-shell';
import { serverRequest } from '../core/api-client';
import { getTheme, toggleTheme } from '../core/theme';

export function createLoginScreen(): HTMLElement {
  const page = document.createElement('div');
  page.className = 'login-page';
  page.innerHTML = `
    <header class="login-header">
      <div class="brand-lockup"><span class="brand-mark" aria-hidden="true">${icon('spark')}</span><span class="brand-copy"><strong>AnyRouter</strong><small>Console</small></span></div>
      <button class="icon-button" type="button" data-login-theme></button>
    </header>
    <main class="login-layout" id="main-content" tabindex="-1">
      <section class="login-story" aria-labelledby="login-story-title">
        <span class="eyebrow">你的模型工作区</span>
        <h2 id="login-story-title">请求与保活，<br /><span>集中管理。</span></h2>
        <p>从一枚 Key 开始，管理模型请求、持续保活与成功通知。</p>
        <div class="login-visual" aria-hidden="true">
          <div class="login-visual-head"><span>${icon('pulse')} 双端调度</span><span>一个工作区</span></div>
          <div class="login-lanes">
            <div><span class="login-lane-icon">${icon('overview')}</span><strong>浏览器</strong><small>在页面中运行</small></div>
            <span class="login-lane-connector">${icon('plus')}</span>
            <div><span class="login-lane-icon python">${icon('tasks')}</span><strong>Python</strong><small>持续后台调度</small></div>
          </div>
          <div class="login-visual-foot"><span>${icon('key')} 共享凭据</span><span>${icon('heartbeat')} 自动保活</span><span>${icon('send')} 成功通知</span></div>
        </div>
      </section>
      <section class="login-card" aria-labelledby="login-heading">
        <span class="login-lock" aria-hidden="true">${icon('lock')}</span>
        <span class="eyebrow">工作区登录</span>
        <h1 id="login-heading">欢迎回来</h1>
        <p class="login-description">输入管理密码，继续管理你的任务。</p>
        <form id="login-form">
          <label class="field" for="login-password">管理密码</label>
          <div class="login-password-field field">
            <input id="login-password" name="password" type="password" autocomplete="current-password" maxlength="1024" placeholder="请输入管理密码" aria-describedby="login-hint login-error" required />
            <button class="text-button" type="button" data-show-password aria-label="显示密码" aria-pressed="false">显示</button>
          </div>
          <p id="login-hint" class="login-hint">使用部署时设置的管理密码。</p>
          <p id="login-error" class="login-error" role="alert" aria-live="polite"></p>
          <button class="button primary full" type="submit"><span>进入工作区</span>${icon('arrow')}</button>
        </form>
        <div class="login-card-note"><span aria-hidden="true">${icon('database')}</span><p>Key 随工作区保存，换个设备也能继续使用。</p></div>
      </section>
    </main>
    <footer class="login-footer"><span>AnyRouter Console</span><span>Responses &amp; Messages</span></footer>`;

  const form = page.querySelector<HTMLFormElement>('form')!;
  const password = page.querySelector<HTMLInputElement>('#login-password')!;
  const error = page.querySelector<HTMLElement>('#login-error')!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const visibility = page.querySelector<HTMLButtonElement>('[data-show-password]')!;
  visibility.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    visibility.textContent = show ? '隐藏' : '显示';
    visibility.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    visibility.setAttribute('aria-pressed', String(show));
  });
  const theme = page.querySelector<HTMLButtonElement>('[data-login-theme]')!;
  const updateTheme = (): void => {
    const dark = getTheme() === 'dark';
    theme.innerHTML = icon(dark ? 'sun' : 'moon');
    theme.setAttribute('aria-label', `切换到${dark ? '浅色' : '深色'}模式`);
    theme.setAttribute('aria-pressed', String(dark));
  };
  updateTheme();
  theme.addEventListener('click', () => { toggleTheme(); updateTheme(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || !form.reportValidity()) return;
    submit.disabled = true;
    submit.textContent = '正在登录…';
    form.setAttribute('aria-busy', 'true');
    error.textContent = '';
    password.removeAttribute('aria-invalid');
    try {
      await serverRequest('/api/auth/login', 'POST', { password: password.value });
      password.value = '';
      window.dispatchEvent(new Event('authentication-changed'));
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : '登录失败，请重试';
      password.setAttribute('aria-invalid', 'true');
      password.focus();
      password.select();
    } finally {
      submit.disabled = false;
      submit.innerHTML = `<span>进入工作区</span>${icon('arrow')}`;
      form.removeAttribute('aria-busy');
    }
  });
  return page;
}
