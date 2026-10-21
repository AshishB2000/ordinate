// A comment's @mentions on screen (docs/notifications/00-design.md §5.1): a
// current reader is a chip "@Name" (their address only as its tooltip); anyone
// else is "@former member". The address never reaches the Markdown parser, so a
// mention is never a link or markup, an underscore in it never makes italics,
// and inside code or a link it reads as plain words. One case each.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CommentBody } from './CommentBody';

afterEach(cleanup);

const PEOPLE = { 'ann.lee@acme.com': 'Ann Lee', 'first_last@acme.com': 'First Last' };
const draw = (text: string, people: Record<string, string> = PEOPLE) => render(<CommentBody text={text} people={people} />).container;

describe('a comment body with mentions', () => {
  it('a current reader is a chip "@Name", the address only in its tooltip', () => {
    const c = draw('Look @(ann.lee@acme.com), the North figure');
    const chip = c.querySelector('span[title]');
    expect(chip?.textContent).toBe('@Ann Lee');
    expect(chip?.getAttribute('title')).toBe('ann.lee@acme.com');
    expect(c.textContent).toBe('Look @Ann Lee, the North figure');
  });

  it('someone who is not a current reader is "@former member", with no address anywhere', () => {
    const c = draw('ping @(gone@acme.com)');
    expect(c.textContent).toBe('ping @former member');
    expect(c.innerHTML).not.toContain('gone@acme');
  });

  it('a mention is never a link', () => {
    const c = draw('@(ann.lee@acme.com)');
    expect(c.querySelector('a')).toBeNull();
  });

  it('a <script>-shaped address is text: no element is built from it, and it is no mention', () => {
    const c = draw('@(<script>@x.com) hi');
    expect(c.querySelector('script')).toBeNull();
    expect(c.querySelector('span[title]')).toBeNull();
    expect(c.textContent).toContain('<script>');
  });

  it('an underscore in an address never pairs with a stray one before it', () => {
    const c = draw('order_total looks off @(first_last@acme.com)');
    expect(c.querySelector('em')).toBeNull();
    expect(c.textContent).toBe('order_total looks off @First Last');
  });

  it('bold around a mention keeps the chip inside the bold', () => {
    const c = draw('**see @(ann.lee@acme.com)**');
    expect(c.querySelector('strong span[title]')?.textContent).toBe('@Ann Lee');
  });

  it('inside a code span it reads as plain words, never the address', () => {
    const c = draw('`@(ann.lee@acme.com)` and `@(gone@acme.com)`');
    const codes = [...c.querySelectorAll('code')].map((x) => x.textContent);
    expect(codes).toEqual(['@Ann Lee', '@former member']);
  });

  it('inside link text it reads as plain words (no chip in a link)', () => {
    const c = draw('[ask @(ann.lee@acme.com)](https://example.com/x)');
    const a = c.querySelector('a');
    expect(a?.textContent).toBe('ask @Ann Lee');
    expect(a?.querySelector('span')).toBeNull();
  });

  it('a forged placeholder character in a body is dropped, and cannot become a mention', () => {
    const c = draw('0 plain');
    expect(c.querySelector('span[title]')).toBeNull();
    expect(c.textContent).toBe('0 plain');
  });

  it('\\@(…) is an escaped literal: shown as typed, without the backslash, and no chip', () => {
    const c = draw('write \\@(ann.lee@acme.com) to mention');
    expect(c.querySelector('span[title]')).toBeNull();
    expect(c.textContent).toBe('write @(ann.lee@acme.com) to mention');
  });

  it('an address typed in capitals is looked up lower-cased, as the server stores it', () => {
    expect(draw('@(Ann.Lee@ACME.com)').textContent).toBe('@Ann Lee');
  });

  it('the text card\'s {{token}} still reads as typed in a comment', () => {
    expect(draw('{{Revenue}} @(ann.lee@acme.com)').textContent).toBe('{{Revenue}} @Ann Lee');
  });
});
