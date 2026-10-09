// A multi-line SECRET (a PEM private key, a long token) — the masked control a
// `textarea` secret field gets, on the new-connection form and in the rail's
// "Replace". A password <input> cannot hold one: it drops the line breaks a PEM
// needs.
//
// Write-only, like a password field: never prefilled (the server sends
// `secretSet` booleans, never a value), the text drawn as discs
// (-webkit-text-security: Chromium, WebKit, Firefox 114+), copy and cut
// blocked, and spell-check, autocomplete and autocapitalize off — so the
// browser neither shows it to someone behind the user, nor sends it to a
// dictionary service, nor keeps it in form history.

import type { ClipboardEvent } from 'react';
import { Textarea, type TextareaProps } from '../../ui/Field';
import s from './Connections.module.css';

const refuse = (e: ClipboardEvent) => e.preventDefault();

export function SecretTextarea({ className, rows = 5, ...rest }: Omit<TextareaProps, 'autoComplete' | 'spellCheck' | 'onCopy' | 'onCut'>) {
  return (
    <Textarea
      {...rest}
      rows={rows}
      className={[s.mono, s.masked, className].filter(Boolean).join(' ')}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      translate="no"
      data-secret=""
      onCopy={refuse}
      onCut={refuse}
    />
  );
}
