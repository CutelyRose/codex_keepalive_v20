import { escapeHtml } from '../core/utils';

const VALID_TONES = new Set(['neutral', 'blue', 'green', 'amber', 'red', 'violet']);

export class StatusPill extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['label', 'tone', 'dot'];
  }

  connectedCallback(): void {
    this.render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.render();
  }

  private render(): void {
    const label = this.getAttribute('label') || this.textContent || '';
    const requestedTone = this.getAttribute('tone') ?? 'neutral';
    const tone = VALID_TONES.has(requestedTone) ? requestedTone : 'neutral';
    const dot = this.hasAttribute('dot') ? '<span class="pill-dot" aria-hidden="true"></span>' : '';
    this.className = `status-pill tone-${tone}`;
    this.innerHTML = `${dot}<span>${escapeHtml(label)}</span>`;
  }
}

if (!customElements.get('ar-status-pill')) {
  customElements.define('ar-status-pill', StatusPill);
}
