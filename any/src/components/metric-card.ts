import { escapeHtml } from '../core/utils';

export class MetricCard extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['label', 'value', 'hint', 'tone', 'icon'];
  }

  connectedCallback(): void {
    this.render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.render();
  }

  private render(): void {
    const label = this.getAttribute('label') ?? '';
    const value = this.getAttribute('value') ?? '0';
    const hint = this.getAttribute('hint') ?? '';
    const tone = this.getAttribute('tone') ?? 'blue';
    const icon = this.getAttribute('icon') ?? 'pulse';
    this.className = `metric-card metric-${escapeHtml(tone)}`;
    this.innerHTML = `
      <div class="metric-card-top">
        <span class="metric-label">${escapeHtml(label)}</span>
        <span class="metric-icon" aria-hidden="true">${metricIcon(icon)}</span>
      </div>
      <strong class="metric-value">${escapeHtml(value)}</strong>
      <span class="metric-hint">${escapeHtml(hint)}</span>
    `;
  }
}

function metricIcon(name: string): string {
  const paths: Record<string, string> = {
    pulse: '<path d="M3 12h3l2.2-5 3.2 10L14 11l1.6 3H21"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>',
    key: '<circle cx="8" cy="15" r="3"/><path d="m10.5 13.5 8-8M16 8l2 2M14 10l2 2"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.pulse}</svg>`;
}

if (!customElements.get('ar-metric-card')) {
  customElements.define('ar-metric-card', MetricCard);
}
