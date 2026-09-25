// A hand-written MARKDOWN SUBSET for text cards. PURE parse, DOM-building
// render — shared the geoMatch way (window.mdParse/mdRender in the renderer,
// require() in scripts/test-markdown.js).
//
// Blocks: # ## ### headings, paragraphs, - / * / + and 1. lists, ``` fences.
// Inline: **bold** __bold__, *italic* _italic_, `code`, [text](https://…),
// {{token}}, and \ escapes. Anything else is TEXT.
//
// THE SAFETY RULE: nothing here ever parses HTML. The render builds elements
// with createElement and fills them with textContent, so `<script>` in a card
// is seven characters on screen. A link's target must be http(s) or it is
// shown as its text, and even then it opens through main's shell-safe
// openExternal — the caller wires the click; this module only builds the <a>.
(function (global: any) {
  type Inline =
    | { t: 'text'; v: string }
    | { t: 'b' | 'i'; c: Inline[] }
    | { t: 'code'; v: string }
    | { t: 'a'; href: string; c: Inline[] }
    | { t: 'token'; name: string };
  type Block =
    | { t: 'h'; level: number; c: Inline[] }
    | { t: 'p'; c: Inline[] }
    | { t: 'ul' | 'ol'; items: Inline[][] }
    | { t: 'pre'; v: string };

  const SAFE_HREF = /^https?:\/\/[^\s]+$/i;

  function safeHref(url: string): string | null {
    const u = url.trim();
    if (!SAFE_HREF.test(u)) return null;
    try {
      const p = new URL(u);
      return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null;
    } catch (_) {
      return null;
    }
  }

  function pushText(out: Inline[], v: string): void {
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.v += v;
    else if (v) out.push({ t: 'text', v });
  }

  /** Inline markup, left to right. An unmatched delimiter is plain text. */
  function inline(s: string): Inline[] {
    const out: Inline[] = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length && '\\`*_[]{}()#+-.!'.includes(s[i + 1])) {
        pushText(out, s[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '`') {
        const end = s.indexOf('`', i + 1);
        if (end > i) { out.push({ t: 'code', v: s.slice(i + 1, end) }); i = end + 1; continue; }
      }
      if (ch === '{' && s[i + 1] === '{') {
        const end = s.indexOf('}}', i + 2);
        const name = end > 0 ? s.slice(i + 2, end).trim() : '';
        if (name && name.length <= 80 && !/[{}\n]/.test(name)) { out.push({ t: 'token', name }); i = end + 2; continue; }
      }
      if ((ch === '*' || ch === '_') && s[i + 1] === ch) {
        let end = s.indexOf(ch + ch, i + 2);
        // `***` closes an italic and the bold around it: the bold's pair is the LAST two.
        while (end > 0 && s[end + 2] === ch) end += 1;
        if (end > i + 2) { out.push({ t: 'b', c: inline(s.slice(i + 2, end)) }); i = end + 2; continue; }
      }
      if (ch === '*' || ch === '_') {
        const end = s.indexOf(ch, i + 1);
        if (end > i + 1 && s[i + 1] !== ' ') { out.push({ t: 'i', c: inline(s.slice(i + 1, end)) }); i = end + 1; continue; }
      }
      if (ch === '[') {
        const close = s.indexOf('](', i + 1);
        // The target ends at ITS closing paren — balanced, so `(1)` inside stays in.
        let end = -1;
        for (let k = close + 2, depth = 0; close > 0 && k < s.length; k++) {
          if (s[k] === '(') depth++;
          else if (s[k] === ')' && depth-- === 0) { end = k; break; }
        }
        if (close > i && end > close) {
          const text = inline(s.slice(i + 1, close));
          const href = safeHref(s.slice(close + 2, end));
          if (href) out.push({ t: 'a', href, c: text });
          else for (const n of text) out.push(n); // unsafe target: keep the words, drop the link
          i = end + 1;
          continue;
        }
      }
      pushText(out, ch);
      i += 1;
    }
    return out;
  }

  function mdParse(src: unknown): Block[] {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out: Block[] = [];
    let para: string[] = [];
    const flush = (): void => {
      if (para.length) out.push({ t: 'p', c: inline(para.join(' ')) });
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush();
        const body: string[] = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
        out.push({ t: 'pre', v: body.join('\n') });
        continue;
      }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) { flush(); out.push({ t: 'h', level: h[1].length, c: inline(h[2].trim()) }); continue; }
      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ol = /^\s*\d{1,9}[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flush();
        const t = ul ? 'ul' : 'ol';
        const re = ul ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d{1,9}[.)]\s+(.*)$/;
        const items: Inline[][] = [];
        while (i < lines.length) {
          const m = re.exec(lines[i]);
          if (!m) break;
          items.push(inline(m[1]));
          i += 1;
        }
        i -= 1;
        out.push({ t, items } as Block);
        continue;
      }
      if (!line.trim()) { flush(); continue; }
      para.push(line.trim());
    }
    flush();
    return out;
  }

  /**
   * Blocks → a DocumentFragment, through createElement/textContent only.
   * `token(name, el)` fills a {{token}} span (e.g. with a metric's value);
   * `link(a, href)` wires a link's click. Both optional.
   */
  function mdRender(blocks: Block[], doc: any, hooks: any = {}): any {
    const frag = doc.createDocumentFragment();
    const inl = (parent: any, nodes: Inline[]): void => {
      for (const n of nodes) {
        if (n.t === 'text') parent.appendChild(doc.createTextNode(n.v));
        else if (n.t === 'code') {
          const c = doc.createElement('code');
          c.textContent = n.v;
          parent.appendChild(c);
        } else if (n.t === 'token') {
          const s = doc.createElement('span');
          s.className = 'md-token';
          s.setAttribute('data-token', n.name);
          s.textContent = '{{' + n.name + '}}';
          parent.appendChild(s);
          if (hooks.token) hooks.token(n.name, s);
        } else if (n.t === 'a') {
          const a = doc.createElement('a');
          a.setAttribute('href', n.href);
          a.setAttribute('rel', 'noopener noreferrer');
          inl(a, n.c);
          parent.appendChild(a);
          if (hooks.link) hooks.link(a, n.href);
        } else {
          const el = doc.createElement(n.t === 'b' ? 'strong' : 'em');
          inl(el, n.c);
          parent.appendChild(el);
        }
      }
    };
    for (const b of blocks) {
      let el: any;
      if (b.t === 'h') {
        el = doc.createElement('h' + (b.level + 2)); // # → h3: a card sits under the page's own headings
        el.className = 'md-h md-h' + b.level;
        inl(el, b.c);
      } else if (b.t === 'p') {
        el = doc.createElement('p');
        inl(el, b.c);
      } else if (b.t === 'pre') {
        el = doc.createElement('pre');
        const code = doc.createElement('code');
        code.textContent = b.v;
        el.appendChild(code);
      } else {
        el = doc.createElement(b.t);
        for (const item of b.items) {
          const li = doc.createElement('li');
          inl(li, item);
          el.appendChild(li);
        }
      }
      frag.appendChild(el);
    }
    return frag;
  }

  /** Every {{token}} name in a source, in order, once. */
  function mdTokens(src: unknown): string[] {
    const out: string[] = [];
    const walk = (nodes: Inline[]): void => {
      for (const n of nodes) {
        if (n.t === 'token' && !out.includes(n.name)) out.push(n.name);
        else if (n.t === 'b' || n.t === 'i' || n.t === 'a') walk(n.c);
      }
    };
    for (const b of mdParse(src)) {
      if (b.t === 'h' || b.t === 'p') walk(b.c);
      else if (b.t === 'ul' || b.t === 'ol') b.items.forEach(walk);
    }
    return out;
  }

  const api = { mdParse, mdRender, mdTokens, safeHref };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    global.mdParse = mdParse;
    global.mdRender = mdRender;
    global.mdTokens = mdTokens;
  }
})(typeof window !== 'undefined' ? window : globalThis);
