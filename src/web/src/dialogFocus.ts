import type { KeyboardEvent } from 'react';

// Native modal dialogs make the page inert, but can still tab into browser chrome.
export function wrapDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab') return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button, input, select, textarea, a[href], [tabindex]',
  )).filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length > 0);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first) {
    event.preventDefault();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
